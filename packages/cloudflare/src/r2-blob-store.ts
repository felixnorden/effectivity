import { Chunk, Effect, Option, Schema } from "effect"
import {
  BlobStore,
  BlobNotFound,
  PreconditionFailed,
  type BlobMeta,
  type BlobObject,
  type BlobStoreShape,
  type GetCondition,
  type PutCondition,
  type PutMeta,
} from "@effectivity/core"

/**
 * The R2 byte adapter: implements the @effectivity/core `BlobStore` seam over
 * a Workers R2 binding, following the core suite's behavioral oracle
 * (`packages/core/test/blob-store.test.ts`).
 *
 * Mapping decisions:
 * - The seam's `Version` token is the R2 object's `etag` (unquoted). The R2
 *   conditional API (`etagMatches`/`etagDoesNotMatch`) only accepts the
 *   unquoted form and throws a TypeError on the quoted RFC `httpEtag`, and a
 *   conditional operation must feed that same token back, so the token is the
 *   raw etag end to end.
 * - A failed `put` condition surfaces as R2's `null` return, not an error;
 *   the adapter re-checks with `head` and converts it to the core
 *   `PreconditionFailed` with expected/actual versions.
 * - Conditional `get`/`del` first `head` to distinguish "missing" from
 *   "version mismatch" (R2's `onlyIf` returns null for both). This keeps the
 *   seam contract exact at the cost of one extra head per guarded op.
 * - `list` loops R2's page API (1000-object pages, `cursor`/`truncated`) into
 *   the seam's single-result contract. The page size is injectable for tests.
 */

/** Internal list-failure tag; the seam's `list` has no error channel, so infra failures die. */
class StoreListFailure extends Schema.TaggedError<StoreListFailure>()("StoreListFailure", {
  message: Schema.String,
}) {}

/** Default R2 list page size (R2's own cap). */
const LIST_PAGE_SIZE = 1000

const optionOf = <A>(value: A | null | undefined): Option.Option<A> =>
  value === undefined || value === null ? Option.none() : Option.some(value)

const contentTypeOf = (meta?: R2HTTPMetadata): Option.Option<string> => optionOf(meta?.contentType)

const metaFrom = (object: {
  etag: string
  size: number
  httpMetadata?: R2HTTPMetadata
}): BlobMeta => ({
  version: object.etag,
  size: object.size,
  contentType: contentTypeOf(object.httpMetadata),
})

/**
 * Build the seam over a bucket. `pageSize` lets tests force list paging with
 * fewer than 1000 keys.
 */
export const r2BlobStore = (
  bucket: R2Bucket,
  pageSize: number = LIST_PAGE_SIZE,
): BlobStoreShape => {
  const head = (key: string): Effect.Effect<Option.Option<BlobMeta>, BlobNotFound> =>
    Effect.tryPromise({
      try: async () => {
        const object = await bucket.head(key)
        return Option.map(optionOf(object), metaFrom)
      },
      catch: () => new BlobNotFound({ key }),
    })

  const get = (
    key: string,
    cond?: GetCondition,
  ): Effect.Effect<Option.Option<BlobObject>, BlobNotFound | PreconditionFailed> =>
    Effect.tryPromise({
      try: async () => {
        if (cond?.ifCurrent !== undefined) {
          const current = await bucket.head(key)
          if (current === null) {
            return Option.none()
          }
          if (current.etag !== cond.ifCurrent) {
            throw new PreconditionFailed({
              key,
              expected: Option.some(cond.ifCurrent),
              actual: Option.some(current.etag),
            })
          }
        }
        const object = await bucket.get(key)
        if (object === null) {
          return Option.none()
        }
        const bytes = new Uint8Array(await object.arrayBuffer())
        return Option.some({
          key,
          version: object.etag,
          meta: metaFrom(object),
          body: bytes,
        })
      },
      catch: (error) => (error instanceof PreconditionFailed ? error : new BlobNotFound({ key })),
    })

  const put = (
    key: string,
    body: Uint8Array,
    cond?: PutCondition,
    meta?: PutMeta,
  ): Effect.Effect<BlobMeta, PreconditionFailed> =>
    Effect.tryPromise({
      try: async () => {
        const expectedEtag =
          cond !== undefined && cond.ifCurrent !== undefined ? cond.ifCurrent : undefined
        const onlyIf: R2Conditional | undefined =
          cond?.ifAbsent === true
            ? { etagDoesNotMatch: "*" }
            : expectedEtag !== undefined
              ? { etagMatches: expectedEtag }
              : undefined
        const contentType = meta?.contentType
        const object = await bucket.put(key, body, {
          onlyIf,
          httpMetadata: contentType === undefined ? undefined : { contentType },
        })
        if (object === null) {
          const current = await bucket.head(key)
          throw new PreconditionFailed({
            key,
            expected: expectedEtag === undefined ? Option.none() : Option.some(expectedEtag),
            actual: Option.map(optionOf(current), (c) => c.etag),
          })
        }
        return metaFrom(object)
      },
      catch: (error) =>
        error instanceof PreconditionFailed
          ? error
          : new PreconditionFailed({ key, expected: Option.none(), actual: Option.none() }),
    })

  const del = (key: string, cond?: PutCondition): Effect.Effect<boolean, PreconditionFailed> =>
    Effect.tryPromise({
      try: async () => {
        const current = await bucket.head(key)
        if (current === null) {
          return false
        }
        if (cond?.ifCurrent !== undefined && current.etag !== cond.ifCurrent) {
          throw new PreconditionFailed({
            key,
            expected: Option.some(cond.ifCurrent),
            actual: Option.some(current.etag),
          })
        }
        await bucket.delete(key)
        return true
      },
      catch: (error) =>
        error instanceof PreconditionFailed
          ? error
          : new PreconditionFailed({ key, expected: Option.none(), actual: Option.none() }),
    })

  const list = (prefix: string): Effect.Effect<Chunk.Chunk<string>, never> =>
    Effect.tryPromise({
      try: async () => {
        const keys: Array<string> = []
        let cursor: string | undefined
        do {
          const page = await bucket.list({ prefix, limit: pageSize, cursor })
          for (const object of page.objects) {
            keys.push(object.key)
          }
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor !== undefined)
        return Chunk.fromIterable(keys)
      },
      catch: (error) =>
        new StoreListFailure({ message: error instanceof Error ? error.message : String(error) }),
    }).pipe(Effect.orDie)

  return BlobStore.of({ head, get, put, del, list })
}
