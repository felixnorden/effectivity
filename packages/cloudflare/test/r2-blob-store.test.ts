import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { BlobStore, PreconditionFailed } from "@effectivity/core"
import { r2BlobStore } from "../src/r2-blob-store.ts"

/**
 * The R2 adapter against the emulated binding (Workers vitest pool). Each
 * test gets an isolated bucket; the core seam oracle
 * (`packages/core/test/blob-store.test.ts`) is the behavioral contract.
 */

const store = () => r2BlobStore(env.BUCKET)
const bytes = (...values: Array<number>): Uint8Array => Uint8Array.from(values)

describe("r2 blob store", () => {
  it("put stores an object and head reports its version and metadata", async () => {
    const s = store()
    const put = await Effect.runPromise(
      BlobStore.put(s)("docs/start", bytes(1, 2, 3), undefined, {
        contentType: "text/markdown",
      }),
    )
    expect(put.version.length).toBeGreaterThan(0)

    const head = await Effect.runPromise(BlobStore.head(s)("docs/start"))
    expect(Option.isSome(head)).toBe(true)
    if (Option.isSome(head)) {
      expect(head.value.version).toBe(put.version)
      expect(head.value.size).toBe(3)
      expect(head.value.contentType).toEqual(Option.some("text/markdown"))
    }
  })

  it("head returns none for a missing key", async () => {
    const s = store()
    const head = await Effect.runPromise(BlobStore.head(s)("missing"))
    expect(head).toEqual(Option.none())
  })

  it("put with ifAbsent stores on first and raises PreconditionFailed on second", async () => {
    const s = store()
    await Effect.runPromise(BlobStore.put(s)("k", bytes(1), { ifAbsent: true }))
    const failure = await Effect.runPromise(
      BlobStore.put(s)("k", bytes(2), { ifAbsent: true }).pipe(Effect.flip),
    )
    expect(failure).toBeInstanceOf(PreconditionFailed)
    expect(failure.key).toBe("k")

    const still = await Effect.runPromise(BlobStore.get(s)("k"))
    expect(Option.isSome(still)).toBe(true)
    if (Option.isSome(still)) {
      expect(still.value.body).toEqual(bytes(1))
    }
  })

  it("put with ifCurrent honors the version and rejects a stale one", async () => {
    const s = store()
    const v1 = await Effect.runPromise(BlobStore.put(s)("k", bytes(1)))
    const v2 = await Effect.runPromise(BlobStore.put(s)("k", bytes(2), { ifCurrent: v1.version }))
    expect(v2.version).not.toBe(v1.version)

    const stale = await Effect.runPromise(
      BlobStore.put(s)("k", bytes(3), { ifCurrent: v1.version }).pipe(Effect.flip),
    )
    expect(stale).toBeInstanceOf(PreconditionFailed)
    expect(stale.expected).toEqual(Option.some(v1.version))
    expect(stale.actual).toEqual(Option.some(v2.version))
  })

  it("get with ifCurrent returns the body on match and fails on mismatch", async () => {
    const s = store()
    const v1 = await Effect.runPromise(BlobStore.put(s)("k", bytes(1, 2, 3)))
    await Effect.runPromise(BlobStore.put(s)("k", bytes(9)))

    const stale = await Effect.runPromise(
      BlobStore.get(s)("k", { ifCurrent: v1.version }).pipe(Effect.flip),
    )
    if (!(stale instanceof PreconditionFailed)) {
      throw new Error("expected PreconditionFailed")
    }
    expect(stale.actual).toEqual(Option.some(expect.any(String)))
    const actualVersion = Option.getOrNull(stale.actual)

    const latest = await Effect.runPromise(BlobStore.get(s)("k", { ifCurrent: actualVersion! }))
    expect(Option.isSome(latest)).toBe(true)
    if (Option.isSome(latest)) {
      expect(latest.value.body).toEqual(bytes(9))
    }
  })

  it("get returns none (not an error) for a missing key", async () => {
    const s = store()
    const result = await Effect.runPromise(BlobStore.get(s)("missing"))
    expect(result).toEqual(Option.none())
  })

  it("list returns every key under a prefix across page boundaries", async () => {
    const s = r2BlobStore(env.BUCKET, 2)
    for (const [i, key] of ["0", "1", "2", "3", "4"].entries()) {
      await Effect.runPromise(BlobStore.put(s)(`list/${key}`, bytes(i)))
    }
    await Effect.runPromise(BlobStore.put(s)("other/x", bytes(0)))

    const keys = await Effect.runPromise(BlobStore.list(s)("list/"))
    expect(Array.from(keys).sort()).toEqual(["list/0", "list/1", "list/2", "list/3", "list/4"])
  })

  it("del reports whether the key existed and honors conditions", async () => {
    const s = store()
    await Effect.runPromise(BlobStore.put(s)("k", bytes(1)))
    expect(await Effect.runPromise(BlobStore.del(s)("k"))).toBe(true)
    expect(await Effect.runPromise(BlobStore.del(s)("k"))).toBe(false)

    await Effect.runPromise(BlobStore.put(s)("k2", bytes(1)))
    const put = await Effect.runPromise(BlobStore.put(s)("k2", bytes(2)))
    const stale = await Effect.runPromise(
      BlobStore.del(s)("k2", { ifCurrent: "stale-version" }).pipe(Effect.flip),
    )
    expect(stale).toBeInstanceOf(PreconditionFailed)
    await Effect.runPromise(BlobStore.del(s)("k2", { ifCurrent: put.version }))
    expect(await Effect.runPromise(BlobStore.head(s)("k2"))).toEqual(Option.none())
  })
})
