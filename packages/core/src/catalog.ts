import { Chunk, Context, Effect, Layer, Option, Schema } from "effect"
import { BlobStore, type BlobObject, type BlobStoreShape } from "./blob-store.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import { parseDocument } from "./codec.ts"
import { DOC_REGION } from "./naming.ts"
import { slugify } from "./slug.ts"

/**
 * The derived document listing read model (D10, D6). Enumerates documents and
 * assets under a logical folder-tree prefix and computes derived metadata on
 * the fly from current stored bytes. Metadata is a pure function of the
 * document's filename, validated frontmatter, and raw body; it is never stored
 * or embedded, so it cannot go stale.
 *
 * Read-only: only reads via the seam, never writes, never caches (D6).
 */
export interface DerivedMetadata {
  readonly slug: string // from the filename (D6)
  readonly wordCount: number // from the raw body
  readonly lineCount: number // from the raw body (non-empty lines)
  readonly readingTimeMinutes: number // body-derived summary metric
}

export interface DocumentListing {
  readonly key: string // storage key
  readonly path: string // logical path (region-relative, so folders group by delimiter)
  readonly metadata: DerivedMetadata
}

export interface CatalogShape {
  listDocuments(
    prefix: string,
  ): Effect.Effect<
    Chunk.Chunk<DocumentListing>,
    never,
    BlobStore | Context.Reference<CatalogRootConfig>
  >
  listAssets(
    prefix: string,
  ): Effect.Effect<Chunk.Chunk<string>, never, BlobStore | Context.Reference<CatalogRootConfig>>
  derivedMetadata(
    docKey: string,
  ): Effect.Effect<
    Option.Option<DerivedMetadata>,
    never,
    BlobStore | Context.Reference<CatalogRootConfig>
  >
}

/** The filename without its final extension; extension-less names pass through. */
const basenameWithoutExtension = (filename: string): string => {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? filename.slice(0, dot) : filename
}

/** Pure derivation: slug from the filename, body metrics from the raw body (D6). */
const deriveMetadata = (docKey: string, body: string): DerivedMetadata => {
  const filename = docKey.slice(docKey.lastIndexOf("/") + 1)
  const wordCount = (body.match(/\S+/g) ?? []).length
  const lineCount = body.split("\n").filter((line) => line.trim() !== "").length
  return {
    slug: slugify(basenameWithoutExtension(filename)),
    wordCount,
    lineCount,
    readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 200)),
  }
}

/** Read a blob, mapping exceptional failures to none (missing ⇔ no body). */
const safeGet = (store: BlobStoreShape, key: string): Effect.Effect<Option.Option<BlobObject>> =>
  Effect.match(BlobStore.get(store)(key), {
    onFailure: () => Option.none(),
    onSuccess: (blob) => blob,
  })

/** The markdown body of a stored document; missing or invalid documents yield none. */
const documentBody = (
  store: BlobStoreShape,
  docKey: string,
  frontmatter: Schema.ConstraintDecoder<unknown>,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const blob = yield* safeGet(store, docKey)
    if (Option.isNone(blob)) {
      return Option.none()
    }
    const split = yield* Effect.match(parseDocument(frontmatter, blob.value.body), {
      onFailure: () => Option.none<string>(),
      onSuccess: (doc) => Option.some(doc.body),
    })
    return split
  })

const listDocuments = Effect.fn("catalog.listDocuments")(function* (
  prefix: string,
): Effect.fn.Return<
  Chunk.Chunk<DocumentListing>,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const config = yield* CatalogRoot
  const keys = yield* BlobStore.list(store)(prefix)
  const listings: Array<DocumentListing> = []
  for (const key of keys) {
    const body = yield* documentBody(store, key, config.frontmatter)
    if (Option.isSome(body)) {
      const path = key.startsWith(DOC_REGION) ? key.slice(DOC_REGION.length) : key
      listings.push({ key, path, metadata: deriveMetadata(key, body.value) })
    }
  }
  return Chunk.fromIterable(listings)
})

const listAssets = Effect.fn("catalog.listAssets")(function* (
  prefix: string,
): Effect.fn.Return<Chunk.Chunk<string>, never, BlobStore | Context.Reference<CatalogRootConfig>> {
  const store = yield* BlobStore
  return yield* BlobStore.list(store)(prefix)
})

const derivedMetadata = Effect.fn("catalog.derivedMetadata")(function* (
  docKey: string,
): Effect.fn.Return<
  Option.Option<DerivedMetadata>,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const config = yield* CatalogRoot
  const body = yield* documentBody(store, docKey, config.frontmatter)
  return Option.map(body, (text) => deriveMetadata(docKey, text))
})

export class Catalog extends Context.Service<Catalog, CatalogShape>()(
  "effectivity/catalog/Catalog",
) {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      yield* BlobStore
      yield* CatalogRoot
      return Catalog.of({ listDocuments, listAssets, derivedMetadata })
    }),
  )
}
