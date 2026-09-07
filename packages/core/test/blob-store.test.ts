import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore } from "../src/blob-store.ts"
import * as Error_ from "../src/error.ts"
import { MemoryBlobStore } from "./blob-store.memory.ts"

describe("blob store", () => {
  it.effect("head returns none for a key that does not exist when storage is empty", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      const result = yield* BlobStore.head(store)("missing-key")
      expect(result).toEqual(Option.none())
    }),
  )

  it.effect("get returns the exact stored bytes and its version when a key exists", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      const meta = yield* BlobStore.put(store)("a", new Uint8Array([1, 2, 3]))
      const result = yield* BlobStore.get(store)("a")
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.body).toEqual(new Uint8Array([1, 2, 3]))
        expect(result.value.version).toBe(meta.version)
      }
    }),
  )

  it.effect("get returns none (not an error) for a missing key when storage has other keys", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      yield* BlobStore.put(store)("a", new Uint8Array([1]))
      const result = yield* BlobStore.get(store)("missing")
      expect(result).toEqual(Option.none())
    }),
  )

  it.effect("put store-if-absent fails with preconditionFailed when the key already exists", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      yield* BlobStore.put(store)("k", new Uint8Array([1]))
      const failure = yield* BlobStore.put(store)("k", new Uint8Array([2]), {
        ifAbsent: true,
      }).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Error_.PreconditionFailed)
      expect(failure.key).toBe("k")
      const still = yield* BlobStore.get(store)("k")
      expect(Option.isSome(still)).toBe(true)
      if (Option.isSome(still)) {
        expect(still.value.body).toEqual(new Uint8Array([1]))
      }
    }),
  )

  it.effect(
    "put store-only-if-current fails with preconditionFailed when the version is stale",
    () =>
      Effect.gen(function* () {
        const store = MemoryBlobStore.make()
        const meta1 = yield* BlobStore.put(store)("k", new Uint8Array([1]))
        yield* BlobStore.put(store)("k", new Uint8Array([2]))
        const failure = yield* BlobStore.put(store)("k", new Uint8Array([3]), {
          ifCurrent: meta1.version,
        }).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(Error_.PreconditionFailed)
        const latest = yield* BlobStore.get(store)("k")
        expect(Option.isSome(latest)).toBe(true)
        if (Option.isSome(latest)) {
          expect(latest.value.body).toEqual(new Uint8Array([2]))
        }
      }),
  )

  it.effect(
    "put store-only-if-current succeeds and bumps the version when the version matches",
    () =>
      Effect.gen(function* () {
        const store = MemoryBlobStore.make()
        const meta1 = yield* BlobStore.put(store)("k", new Uint8Array([1]))
        const meta2 = yield* BlobStore.put(store)("k", new Uint8Array([2]), {
          ifCurrent: meta1.version,
        })
        expect(meta2.version).not.toBe(meta1.version)
        const latest = yield* BlobStore.get(store)("k")
        expect(Option.isSome(latest)).toBe(true)
        if (Option.isSome(latest)) {
          expect(latest.value.body).toEqual(new Uint8Array([2]))
          expect(latest.value.version).toBe(meta2.version)
        }
      }),
  )

  it.effect(
    "conditional get fails with preconditionFailed when the current version does not match",
    () =>
      Effect.gen(function* () {
        const store = MemoryBlobStore.make()
        const meta1 = yield* BlobStore.put(store)("k", new Uint8Array([1]))
        yield* BlobStore.put(store)("k", new Uint8Array([2]))
        const failure = yield* BlobStore.get(store)("k", { ifCurrent: meta1.version }).pipe(
          Effect.flip,
        )
        expect(failure).toBeInstanceOf(Error_.PreconditionFailed)
      }),
  )

  it.effect("del removes a key and reports which keys existed", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      yield* BlobStore.put(store)("a", new Uint8Array([1]))
      yield* BlobStore.put(store)("b", new Uint8Array([2]))
      const removed = yield* BlobStore.del(store)("a")
      expect(removed).toBe(true)
      const keys = yield* BlobStore.list(store)("")
      expect(Array.from(keys).sort()).toEqual(["b"])
      const removedAgain = yield* BlobStore.del(store)("a")
      expect(removedAgain).toBe(false)
    }),
  )

  it.effect("list returns all keys under a prefix in one chunk (no pagination)", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      yield* BlobStore.put(store)("docs/a.md", new Uint8Array([1]))
      yield* BlobStore.put(store)("docs/b.md", new Uint8Array([2]))
      yield* BlobStore.put(store)("assets/i.png", new Uint8Array([3]))
      yield* BlobStore.put(store)("other/x", new Uint8Array([4]))
      const keys = yield* BlobStore.list(store)("docs/")
      expect(Array.from(keys).sort()).toEqual(["docs/a.md", "docs/b.md"])
    }),
  )

  it.effect("head returns metadata without transferring the body", () =>
    Effect.gen(function* () {
      const store = MemoryBlobStore.make()
      const meta = yield* BlobStore.put(store)("k", new Uint8Array([1, 2, 3]))
      const result = yield* BlobStore.head(store)("k")
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.version).toBe(meta.version)
        expect("body" in result.value).toBe(false)
      }
    }),
  )
})
