import { Chunk, Context, Effect, Layer, Option } from "effect"
import {
  BlobStore,
  type BlobMeta,
  type BlobObject,
  type BlobStoreShape,
  type PutMeta,
} from "./blob-store.ts"
import { Catalog, type CatalogShape, type DocumentListing } from "./catalog.ts"
import { validateContent } from "./codec.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import * as Error_ from "./error.ts"
import { ChangeEvents, type ChangeEventShape } from "./events.ts"
import { Naming, type NamingShape } from "./naming.ts"
import {
  ReferenceGraph,
  type ReferenceGraphShape,
  type ResolvedReference,
} from "./reference-graph.ts"

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
/**
 * The facade's layer-resolved dependencies. `DocumentStore.layer` captures
 * these once at layer creation, so the service methods carry no requirements
 * of their own.
 */
export interface DocumentStoreDeps {
  readonly store: BlobStoreShape
  readonly naming: NamingShape
  readonly config: CatalogRootConfig
  readonly refs: ReferenceGraphShape
  readonly catalog: CatalogShape
  readonly events: ChangeEventShape
}

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
    Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument
  >
  read(path: string): Effect.Effect<Option.Option<StoredBlob>, Error_.InvalidArgument>
  update(
    path: string,
    bytes: Uint8Array,
    opts?: { ifCurrent?: string },
  ): Effect.Effect<
    string,
    Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument
  >
  move(
    from: string,
    to: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
  >
  deleteDocument(
    path: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
  >
  storeAsset(
    id: string,
    bytes: Uint8Array,
    opts?: { ifCurrent?: string; contentType?: string },
  ): Effect.Effect<string, Error_.PreconditionFailed | Error_.InvalidArgument>
  getAsset(id: string): Effect.Effect<Option.Option<StoredBlob>, Error_.InvalidArgument>
  deleteAsset(
    id: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
  >
  renameAsset(
    from: string,
    to: string,
    opts?: { override?: boolean },
  ): Effect.Effect<
    void,
    Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
  >
  listDocuments(prefix: string): Effect.Effect<Chunk.Chunk<DocumentListing>>
  documentReferences(
    doc: string,
  ): Effect.Effect<Chunk.Chunk<ResolvedReference>, Error_.InvalidArgument>
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
  deps: DocumentStoreDeps,
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<
  string,
  Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument
> {
  const key = yield* deps.naming.encodeDocumentPath(path)
  yield* validateContent(deps.config.frontmatter, bytes)
  const meta = yield* deps.store.put(key, bytes, { ifAbsent: true })
  yield* deps.events.publish({
    kind: "document",
    operation: "create",
    keys: [key],
    version: meta.version,
  })
  return meta.version
})

const read = Effect.fn("document-store.read")(function* (
  deps: DocumentStoreDeps,
  path: string,
): Effect.fn.Return<Option.Option<StoredBlob>, Error_.InvalidArgument> {
  const key = yield* deps.naming.encodeDocumentPath(path)
  const blob = yield* safeGet(deps.store, key)
  return Option.map(blob, (object) => ({ bytes: object.body, version: object.version }))
})

const update = Effect.fn("document-store.update")(function* (
  deps: DocumentStoreDeps,
  path: string,
  bytes: Uint8Array,
  opts?: { ifCurrent?: string },
): Effect.fn.Return<
  string,
  Error_.PreconditionFailed | Error_.ValidationFailed | Error_.InvalidArgument
> {
  const key = yield* deps.naming.encodeDocumentPath(path)
  yield* validateContent(deps.config.frontmatter, bytes)
  const current = yield* safeGet(deps.store, key)
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
  const meta = yield* deps.store.put(key, bytes, { ifCurrent: guard.value })
  yield* deps.events.publish({
    kind: "document",
    operation: "update",
    keys: [key],
    version: meta.version,
  })
  return meta.version
})

const move = Effect.fn("document-store.move")(function* (
  deps: DocumentStoreDeps,
  from: string,
  to: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
> {
  const fromKey = yield* deps.naming.encodeDocumentPath(from)
  const toKey = yield* deps.naming.encodeDocumentPath(to)
  if (!opts?.override) {
    const verdict = yield* deps.refs.wouldMoveBreakReferences(fromKey, toKey)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "move would break references",
        refs: Array.from(verdict.broken).map((ref) => ref.assetKey),
      })
    }
  }
  const source = yield* safeGet(deps.store, fromKey)
  if (Option.isNone(source)) {
    return yield* new Error_.PreconditionFailed({
      key: fromKey,
      expected: Option.some("existing version"),
      actual: Option.none(),
    })
  }
  const meta = yield* deps.store.put(toKey, source.value.body, { ifAbsent: true })
  yield* deps.store.del(fromKey)
  yield* deps.events.publish({
    kind: "document",
    operation: "move",
    keys: [fromKey, toKey],
    version: meta.version,
  })
  return undefined
})

const deleteDocument = Effect.fn("document-store.deleteDocument")(function* (
  deps: DocumentStoreDeps,
  path: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
> {
  const key = yield* deps.naming.encodeDocumentPath(path)
  if (!opts?.override) {
    const verdict = yield* deps.refs.wouldDocumentDeleteOrphanAssets(key)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "document delete would orphan assets",
        refs: Array.from(verdict.orphanedAssets),
      })
    }
  }
  const current = yield* safeGet(deps.store, key)
  if (Option.isNone(current)) {
    return undefined // already absent: idempotent no-op
  }
  yield* deps.store.del(key)
  yield* deps.events.publish({
    kind: "document",
    operation: "delete",
    keys: [key],
    version: current.value.version,
  })
  return undefined
})

const storeAsset = Effect.fn("document-store.storeAsset")(function* (
  deps: DocumentStoreDeps,
  id: string,
  bytes: Uint8Array,
  opts?: { ifCurrent?: string; contentType?: string },
): Effect.fn.Return<string, Error_.PreconditionFailed | Error_.InvalidArgument> {
  const key = yield* deps.naming.encodeAssetKey(id)
  const meta: PutMeta = opts?.contentType === undefined ? {} : { contentType: opts.contentType }
  const expected = opts?.ifCurrent
  let blobMeta: BlobMeta
  if (expected === undefined) {
    // Create-only (If-None-Match): store when absent, refuse when present.
    blobMeta = yield* deps.store.put(key, bytes, { ifAbsent: true }, meta)
  } else {
    // Conditional update (If-Match): the caller's version must be current.
    const current = yield* safeGet(deps.store, key)
    if (Option.isNone(current)) {
      return yield* new Error_.PreconditionFailed({
        key,
        expected: Option.some(expected),
        actual: Option.none(),
      })
    }
    if (expected === current.value.version && bytesEqual(current.value.body, bytes)) {
      return current.value.version // byte-identical no-op: no rewrite, no version bump (D3)
    }
    blobMeta = yield* deps.store.put(key, bytes, { ifCurrent: expected }, meta)
  }
  yield* deps.events.publish({
    kind: "asset",
    operation: "store",
    keys: [key],
    version: blobMeta.version,
  })
  return blobMeta.version
})

const getAsset = Effect.fn("document-store.getAsset")(function* (
  deps: DocumentStoreDeps,
  id: string,
): Effect.fn.Return<Option.Option<StoredBlob>, Error_.InvalidArgument> {
  const key = yield* deps.naming.encodeAssetKey(id)
  const blob = yield* safeGet(deps.store, key)
  return Option.map(blob, (object) => ({ bytes: object.body, version: object.version }))
})

const deleteAsset = Effect.fn("document-store.deleteAsset")(function* (
  deps: DocumentStoreDeps,
  id: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
> {
  const key = yield* deps.naming.encodeAssetKey(id)
  if (!opts?.override) {
    const verdict = yield* deps.refs.wouldAssetDeleteBeReferenced(key)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "asset delete still referenced",
        refs: Array.from(verdict.referencers),
      })
    }
  }
  const current = yield* safeGet(deps.store, key)
  if (Option.isNone(current)) {
    return undefined // already absent: idempotent no-op
  }
  yield* deps.store.del(key)
  yield* deps.events.publish({
    kind: "asset",
    operation: "delete",
    keys: [key],
    version: current.value.version,
  })
  return undefined
})

const renameAsset = Effect.fn("document-store.renameAsset")(function* (
  deps: DocumentStoreDeps,
  from: string,
  to: string,
  opts?: { override?: boolean },
): Effect.fn.Return<
  void,
  Error_.PreconditionFailed | Error_.IntegrityViolation | Error_.InvalidArgument
> {
  const fromKey = yield* deps.naming.encodeAssetKey(from)
  const toKey = yield* deps.naming.encodeAssetKey(to)
  if (!opts?.override) {
    const verdict = yield* deps.refs.wouldAssetDeleteBeReferenced(fromKey)
    if (verdict.status === "refused") {
      return yield* new Error_.IntegrityViolation({
        reason: "asset rename still referenced",
        refs: Array.from(verdict.referencers),
      })
    }
  }
  const source = yield* safeGet(deps.store, fromKey)
  if (Option.isNone(source)) {
    return yield* new Error_.PreconditionFailed({
      key: fromKey,
      expected: Option.some("existing version"),
      actual: Option.none(),
    })
  }
  const meta = yield* deps.store.put(toKey, source.value.body, { ifAbsent: true })
  yield* deps.store.del(fromKey)
  yield* deps.events.publish({
    kind: "asset",
    operation: "rename",
    keys: [fromKey, toKey],
    version: meta.version,
  })
  return undefined
})

const listDocuments = Effect.fn("document-store.listDocuments")(function* (
  deps: DocumentStoreDeps,
  prefix: string,
): Effect.fn.Return<Chunk.Chunk<DocumentListing>> {
  return yield* deps.catalog.listDocuments(prefix)
})

const documentReferences = Effect.fn("document-store.documentReferences")(function* (
  deps: DocumentStoreDeps,
  doc: string,
): Effect.fn.Return<Chunk.Chunk<ResolvedReference>, Error_.InvalidArgument> {
  const key = yield* deps.naming.encodeDocumentPath(doc)
  return yield* deps.refs.documentReferences(key)
})

/**
 * The facade service. `DocumentStore.layer` resolves every dependency once at
 * layer creation and closes over it, so the service methods carry no
 * requirements — callers depend on the facade, not on its implementation.
 */
export class DocumentStore extends Context.Service<DocumentStore, DocumentStoreShape>()(
  "effectivity/document-store/DocumentStore",
) {
  static readonly layer = Layer.effect(
    DocumentStore,
    Effect.gen(function* () {
      const deps: DocumentStoreDeps = {
        store: yield* BlobStore,
        naming: yield* Naming,
        config: yield* CatalogRoot,
        refs: yield* ReferenceGraph,
        catalog: yield* Catalog,
        events: yield* ChangeEvents,
      }
      return DocumentStore.of({
        create: (path, bytes) => create(deps, path, bytes),
        read: (path) => read(deps, path),
        update: (path, bytes, opts) => update(deps, path, bytes, opts),
        move: (from, to, opts) => move(deps, from, to, opts),
        deleteDocument: (path, opts) => deleteDocument(deps, path, opts),
        storeAsset: (id, bytes, opts) => storeAsset(deps, id, bytes, opts),
        getAsset: (id) => getAsset(deps, id),
        deleteAsset: (id, opts) => deleteAsset(deps, id, opts),
        renameAsset: (from, to, opts) => renameAsset(deps, from, to, opts),
        listDocuments: (prefix) => listDocuments(deps, prefix),
        documentReferences: (doc) => documentReferences(deps, doc),
      })
    }),
  )
}
