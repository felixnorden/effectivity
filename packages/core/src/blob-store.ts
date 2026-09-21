import { Chunk, Context, Effect, Option, Schema } from "effect"
import * as Error_ from "./error.ts"

/**
 * The byte-level seam between @effectivity/core and any runtime blob store,
 * modeled on documented R2/S3 object-store semantics.
 *
 * Flat key space of opaque byte blobs; per-key atomicity only, no cross-key
 * transactions. Writes are conditional (store-if-absent, store-only-if-current)
 * and reads can be conditional (current-version). List returns all matching
 * keys in one result — no pagination in v1. Missing keys are reported via
 * `Option.none`, never via the error channel; precondition violations are a
 * distinct typed error.
 */
export const Version = Schema.String
export type Version = typeof Version.Type

/** Lightweight metadata returned with every blob (version is always present). */
export const BlobMeta = Schema.Struct({
  version: Version,
  size: Schema.Finite,
  contentType: Schema.Option(Schema.String),
})
export type BlobMeta = typeof BlobMeta.Type

/** Write-side metadata accepted by `put` — only the content type is retained. */
export interface PutMeta {
  readonly contentType?: string
}

export interface BlobObject {
  readonly key: string
  readonly version: Version
  readonly meta: BlobMeta
  readonly body: Uint8Array
}

/** Conditional write guards, mirroring R2/S3 If-None-Match / If-Match. */
export interface PutCondition {
  readonly ifAbsent?: true // store-if-absent (If-None-Match: *)
  readonly ifCurrent?: Version // store-only-if-current (If-Match)
}

/** Conditional read guard (If-Match). */
export interface GetCondition {
  readonly ifCurrent?: Version
}

/**
 * The service shape. All mutating ops are per-key atomic; nothing spans keys.
 */
export interface BlobStoreShape {
  head(key: string): Effect.Effect<Option.Option<BlobMeta>, Error_.BlobNotFound>
  get(
    key: string,
    cond?: GetCondition,
  ): Effect.Effect<Option.Option<BlobObject>, Error_.BlobNotFound | Error_.PreconditionFailed>
  put(
    key: string,
    body: Uint8Array,
    cond?: PutCondition,
    meta?: PutMeta,
  ): Effect.Effect<BlobMeta, Error_.PreconditionFailed>
  del(key: string, cond?: PutCondition): Effect.Effect<boolean, Error_.PreconditionFailed>
  list(prefix: string): Effect.Effect<Chunk.Chunk<string>, never>
}

/**
 * Two-stage service class form per the Effect AGENTS conventions. Static
 * accessors let callers use `BlobStore.head(store)(key)` style against the
 * service shape (the value `yield* BlobStore` resolves to).
 */
export class BlobStore extends Context.Service<BlobStore, BlobStoreShape>()(
  "effectivity/blob-store/BlobStore",
) {
  static readonly head = (store: BlobStoreShape): BlobStoreShape["head"] => store.head
  static readonly get = (store: BlobStoreShape): BlobStoreShape["get"] => store.get
  static readonly put = (store: BlobStoreShape): BlobStoreShape["put"] => store.put
  static readonly del = (store: BlobStoreShape): BlobStoreShape["del"] => store.del
  static readonly list = (store: BlobStoreShape): BlobStoreShape["list"] => store.list
}
