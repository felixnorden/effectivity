import { Chunk, Effect, HashMap, Option, Order } from "effect"
import {
  BlobStore,
  type BlobMeta,
  type BlobObject,
  type BlobStoreShape,
  type GetCondition,
  type PutCondition,
  type PutMeta,
} from "@effectivity/core"
import * as ApiError from "../src/error.ts"

interface Entry {
  readonly body: Uint8Array
  readonly version: string
  readonly meta: BlobMeta
}

/**
 * In-test double implementing only the BlobStore seam, with the same
 * contract semantics as the core suite's memory store. Lives under test/; the
 * shipped src/ tree never imports it. Versions are plain incrementing
 * counters, so guarded writes can be exercised deterministically.
 */
export class MemoryBlobStore {
  static readonly make = (
    seed: HashMap.HashMap<string, Entry> = HashMap.empty(),
  ): BlobStoreShape => {
    let state = seed
    let counter = 0

    return BlobStore.of({
      head: (key) => Effect.sync(() => Option.map(HashMap.get(state, key), (e) => e.meta)),

      get: Effect.fn("ApiMemoryBlobStore.get")(function* (
        key: string,
        cond?: GetCondition,
      ): Effect.fn.Return<Option.Option<BlobObject>, ApiError.PreconditionFailed> {
        const existing = HashMap.get(state, key)
        if (Option.isNone(existing)) {
          return Option.none<BlobObject>()
        }
        const entry = existing.value
        if (cond?.ifCurrent !== undefined && entry.version !== cond.ifCurrent) {
          return yield* new ApiError.PreconditionFailed({
            key,
            expected: Option.some(cond.ifCurrent),
            actual: Option.some(entry.version),
          })
        }
        return Option.some({ key, version: entry.version, meta: entry.meta, body: entry.body })
      }),

      put: Effect.fn("ApiMemoryBlobStore.put")(function* (
        key: string,
        body: Uint8Array,
        cond?: PutCondition,
        meta?: PutMeta,
      ): Effect.fn.Return<BlobMeta, ApiError.PreconditionFailed> {
        const existing = HashMap.get(state, key)
        if (cond?.ifAbsent === true && Option.isSome(existing)) {
          return yield* new ApiError.PreconditionFailed({
            key,
            expected: Option.none(),
            actual: Option.map(existing, (e) => e.version),
          })
        }
        if (cond?.ifCurrent !== undefined) {
          const matches = Option.isSome(existing) && existing.value.version === cond.ifCurrent
          if (!matches) {
            return yield* new ApiError.PreconditionFailed({
              key,
              expected: Option.some(cond.ifCurrent),
              actual: Option.map(existing, (e) => e.version),
            })
          }
        }
        counter += 1
        const version = String(counter)
        const stored: BlobMeta = {
          version,
          size: body.length,
          contentType:
            meta?.contentType === undefined ? Option.none() : Option.some(meta.contentType),
        }
        state = HashMap.set(state, key, { body, version, meta: stored })
        return stored
      }),

      del: Effect.fn("ApiMemoryBlobStore.del")(function* (
        key: string,
        cond?: PutCondition,
      ): Effect.fn.Return<boolean, ApiError.PreconditionFailed> {
        const existing = HashMap.get(state, key)
        if (cond?.ifCurrent !== undefined) {
          const matches = Option.isSome(existing) && existing.value.version === cond.ifCurrent
          if (!matches) {
            return yield* new ApiError.PreconditionFailed({
              key,
              expected: Option.some(cond.ifCurrent),
              actual: Option.map(existing, (e) => e.version),
            })
          }
        }
        if (Option.isNone(existing)) {
          return false
        }
        state = HashMap.remove(state, key)
        return true
      }),

      list: (prefix) =>
        Effect.sync(() => {
          const keys = Array.from(HashMap.keys(state)).filter((k) => k.startsWith(prefix))
          return Chunk.fromArrayUnsafe(keys.sort(Order.String))
        }),
    })
  }
}
