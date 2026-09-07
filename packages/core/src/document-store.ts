import { Chunk, Context, Effect, Option } from "effect"
import { BlobStore, type BlobObject, type BlobStoreShape } from "./blob-store.ts"
import { Catalog, type DocumentListing } from "./catalog.ts"
import { validateContent } from "./codec.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import * as Error_ from "./error.ts"
import { ChangeEvents } from "./events.ts"
import { Naming } from "./naming.ts"
import { ReferenceGraph, type ResolvedReference } from "./reference-graph.ts"

/**
 * The typed, user-facing facade composing every other component (D3/D4/D5):
 * document and asset CRUD with per-document atomic conditional writes,
 * integrity-preserving move/delete (refusal by default, explicit override),
 * and one change event per successful mutation after all key-level steps
 * commit. This is the only component that mutates storage through the seam.
 *
 * Multi-key operations are best-effort: each key-level step is individually
 * atomic, ordering is deterministic (destination written before source
 * removed), and there is no rollback — a mid-failure partial state is
 * reported deterministically (D4).
 */
export type DocumentStoreDeps =
  | BlobStore
  | Naming
  | Context.Reference<CatalogRootConfig>
  | ReferenceGraph
  | Catalog
  | ChangeEvents

/** A stored document (or asset) as bytes plus its version, read back from the seam. */
export interface StoredBlob {
  readonly bytes: Uint8Array
  readonly version: string
}

export interface DocumentStoreShape {
  create(
    path: string,
    bytes: Uint8Array,
  ): Effect.Effect<
    string,
    Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  read(
    path: string,
  ): Effect.Effect<Option.Option<StoredBlob>, Error_.InvalidArgument, DocumentStoreDeps>
  update(
    path: string,
    bytes: Uint8Array,
    opts?: { ifCurrent?: string },
  ): Effect.Effect<
    string,
    Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  move(
    from: string,
    to: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  deleteDocument(
    path: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  storeAsset(
    id: string,
    bytes: Uint8Array,
  ): Effect.Effect<string, Error_.PreconditionFailed | Error_.InvalidArgument, DocumentStoreDeps>
  getAsset(
    id: string,
  ): Effect.Effect<Option.Option<StoredBlob>, Error_.InvalidArgument, DocumentStoreDeps>
  deleteAsset(
    id: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  renameAsset(
    from: string,
    to: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
    DocumentStoreDeps
  >
  listDocuments(
    prefix: string,
  ): Effect.Effect<Chunk.Chunk<DocumentListing>, never, DocumentStoreDeps>
  documentReferences(
    doc: string,
  ): Effect.Effect<Chunk.Chunk<ResolvedReference>, Error_.InvalidArgument, DocumentStoreDeps>
}

/** Byte-fidelity comparison used for the byte-identical update no-op rule (D3). */
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index])

/** Read a blob, mapping exceptional failures to none. */
const safeGet = (store: BlobStoreShape, key: string): Effect.Effect<Option.Option<BlobObject>> =>
  Effect.match(BlobStore.get(store)(key), {
    onFailure: () => Option.none(),
    onSuccess: (blob) => blob,
  })

const create = Effect.fn("document-store.create")(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<
  string,
  Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const config = yield* CatalogRoot
  const events = yield* ChangeEvents
  const key = yield* naming.encodeDocumentPath(path)
  yield* validateContent(config.frontmatter, bytes)
  const meta = yield* BlobStore.put(store)(key, bytes, { ifAbsent: true })
  yield* events.publish({
    kind: "document",
    operation: "create",
    keys: [key],
    version: meta.version,
  })
  return meta.version
})

const read = Effect.fn("document-store.read")(function* (
  path: string,
): Effect.fn.Return<Option.Option<StoredBlob>, Error_.InvalidArgument, DocumentStoreDeps> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const key = yield* naming.encodeDocumentPath(path)
  const blob = yield* safeGet(store, key)
  return Option.map(blob, (object) => ({ bytes: object.body, version: object.version }))
})

const update = Effect.fn("document-store.update")(function* (
  path: string,
  bytes: Uint8Array,
  opts?: { ifCurrent?: string },
): Effect.fn.Return<
  string,
  Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const config = yield* CatalogRoot
  const events = yield* ChangeEvents
  const key = yield* naming.encodeDocumentPath(path)
  yield* validateContent(config.frontmatter, bytes)
  const current = yield* safeGet(store, key)
  const guard: Option.Option<string> =
    opts?.ifCurrent !== undefined
      ? Option.some(opts.ifCurrent)
      : Option.isSome(current)
        ? Option.some(current.value.version)
        : Option.none()
  if (Option.isNone(guard)) {
    return yield* new Error_.PreconditionFailed({
      key,
      expected: Option.some("existing version"),
      actual: Option.none(),
    })
  }
  if (
    Option.isSome(current) &&
    guard.value === current.value.version &&
    bytesEqual(current.value.body, bytes)
  ) {
    return current.value.version // byte-identical no-op: no rewrite, no version bump (D3)
  }
  const meta = yield* BlobStore.put(store)(key, bytes, { ifCurrent: guard.value })
  yield* events.publish({
    kind: "document",
    operation: "update",
    keys: [key],
    version: meta.version,
  })
  return meta.version
})

const move = Effect.fn("document-store.move")(function* (
  from: string,
  to: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const refs = yield* ReferenceGraph
  const events = yield* ChangeEvents
  const fromKey = yield* naming.encodeDocumentPath(from)
  const toKey = yield* naming.encodeDocumentPath(to)
  if (!opts?.override) {
    const verdict = yield* refs.wouldMoveBreakReferences(fromKey, toKey)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "move would break references",
        refs: Array.from(verdict.broken).map((ref) => ref.assetKey),
      })
    }
  }
  const source = yield* safeGet(store, fromKey)
  if (Option.isNone(source)) {
    return yield* new Error_.PreconditionFailed({
      key: fromKey,
      expected: Option.some("existing version"),
      actual: Option.none(),
    })
  }
  const meta = yield* BlobStore.put(store)(toKey, source.value.body, { ifAbsent: true })
  yield* BlobStore.del(store)(fromKey)
  yield* events.publish({
    kind: "document",
    operation: "move",
    keys: [fromKey, toKey],
    version: meta.version,
  })
  return undefined
})

const deleteDocument = Effect.fn("document-store.deleteDocument")(function* (
  path: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const refs = yield* ReferenceGraph
  const events = yield* ChangeEvents
  const key = yield* naming.encodeDocumentPath(path)
  if (!opts?.override) {
    const verdict = yield* refs.wouldDocumentDeleteOrphanAssets(key)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "document delete would orphan assets",
        refs: Array.from(verdict.orphanedAssets),
      })
    }
  }
  const current = yield* safeGet(store, key)
  if (Option.isNone(current)) {
    return undefined // already absent: idempotent no-op
  }
  yield* BlobStore.del(store)(key)
  yield* events.publish({
    kind: "document",
    operation: "delete",
    keys: [key],
    version: current.value.version,
  })
  return undefined
})

const storeAsset = Effect.fn("document-store.storeAsset")(function* (
  id: string,
  bytes: Uint8Array,
): Effect.fn.Return<string, Error_.PreconditionFailed | Error_.InvalidArgument, DocumentStoreDeps> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const events = yield* ChangeEvents
  const key = yield* naming.encodeAssetKey(id)
  const meta = yield* BlobStore.put(store)(key, bytes, { ifAbsent: true })
  yield* events.publish({ kind: "asset", operation: "store", keys: [key], version: meta.version })
  return meta.version
})

const getAsset = Effect.fn("document-store.getAsset")(function* (
  id: string,
): Effect.fn.Return<Option.Option<StoredBlob>, Error_.InvalidArgument, DocumentStoreDeps> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const key = yield* naming.encodeAssetKey(id)
  const blob = yield* safeGet(store, key)
  return Option.map(blob, (object) => ({ bytes: object.body, version: object.version }))
})

const deleteAsset = Effect.fn("document-store.deleteAsset")(function* (
  id: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const refs = yield* ReferenceGraph
  const events = yield* ChangeEvents
  const key = yield* naming.encodeAssetKey(id)
  if (!opts?.override) {
    const verdict = yield* refs.wouldAssetDeleteBeReferenced(key)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "asset delete still referenced",
        refs: Array.from(verdict.referencers),
      })
    }
  }
  const current = yield* safeGet(store, key)
  if (Option.isNone(current)) {
    return undefined // already absent: idempotent no-op
  }
  yield* BlobStore.del(store)(key)
  yield* events.publish({
    kind: "asset",
    operation: "delete",
    keys: [key],
    version: current.value.version,
  })
  return undefined
})

const renameAsset = Effect.fn("document-store.renameAsset")(function* (
  from: string,
  to: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument,
  DocumentStoreDeps
> {
  const store = yield* BlobStore
  const naming = yield* Naming
  const refs = yield* ReferenceGraph
  const events = yield* ChangeEvents
  const fromKey = yield* naming.encodeAssetKey(from)
  const toKey = yield* naming.encodeAssetKey(to)
  if (!opts?.override) {
    const verdict = yield* refs.wouldAssetDeleteBeReferenced(fromKey)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "asset rename still referenced",
        refs: Array.from(verdict.referencers),
      })
    }
  }
  const source = yield* safeGet(store, fromKey)
  if (Option.isNone(source)) {
    return yield* new Error_.PreconditionFailed({
      key: fromKey,
      expected: Option.some("existing version"),
      actual: Option.none(),
    })
  }
  const meta = yield* BlobStore.put(store)(toKey, source.value.body, { ifAbsent: true })
  yield* BlobStore.del(store)(fromKey)
  yield* events.publish({
    kind: "asset",
    operation: "rename",
    keys: [fromKey, toKey],
    version: meta.version,
  })
  return undefined
})

const listDocuments = Effect.fn("document-store.listDocuments")(function* (
  prefix: string,
): Effect.fn.Return<Chunk.Chunk<DocumentListing>, never, DocumentStoreDeps> {
  const catalog = yield* Catalog
  return yield* catalog.listDocuments(prefix)
})

const documentReferences = Effect.fn("document-store.documentReferences")(function* (
  doc: string,
): Effect.fn.Return<Chunk.Chunk<ResolvedReference>, Error_.InvalidArgument, DocumentStoreDeps> {
  const naming = yield* Naming
  const refs = yield* ReferenceGraph
  const key = yield* naming.encodeDocumentPath(doc)
  return yield* refs.documentReferences(key)
})

/**
 * Concrete store shape with the caller's frontmatter model `F`. The schema is
 * read from `CatalogRoot` at runtime; `F` only types the read result, and the
 * single cast below is sound because `Core.layer` supplies a `Schema<F>`.
 */
/** The concrete store shape; all methods pull their services from the context. */
export const documentStoreShape: DocumentStoreShape = {
  create,
  read,
  update,
  move,
  deleteDocument,
  storeAsset,
  getAsset,
  deleteAsset,
  renameAsset,
  listDocuments,
  documentReferences,
}

/**
 * The facade service key: `yield* DocumentStore` resolves to the concrete
 * shape. Storage and validation are separate concerns: mutations are
 * validated against the wired schema inside the store, while typed parsing of
 * read bytes is a caller-side codec call (`parseDocument(schema, bytes)`),
 * generic over the schema the caller already owns.
 */
export const DocumentStore = Context.Service<DocumentStoreShape>(
  "effectivity/document-store/DocumentStore",
)
