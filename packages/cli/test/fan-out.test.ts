/**
 * Fan-out dispatch: a platform operation runs on every registration that
 * provides its capability, in registration order, and stops at the first
 * failure with the failing registration's name. Slice 1 ran only the first
 * provider, so these cases fail until the loop changes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { dispatch } from "../src/dispatch.ts"
import { Dev, PluginError, Sync } from "../src/plugin.ts"
import { makeTestEngine, type Recording, recordingRegistration } from "./helpers.ts"
import type { AnyPluginRegistration } from "../src/plugin.ts"

const emptyRecords = (): Recording => ({ syncs: [], ports: [], urls: [] })

/** A sync-only registration that records its call, then either succeeds or fails. */
const syncRegistration = (
  name: string,
  records: Recording,
  outcome: "ok" | "fail",
): AnyPluginRegistration => ({
  name,
  capabilities: () =>
    Layer.succeed(
      Sync,
      Sync.of({
        sync: Effect.fn(`${name}.sync`)(function* () {
          records.syncs.push(name)
          if (outcome === "fail") {
            return yield* new PluginError({ message: `${name} exploded` })
          }
          yield* Effect.void
        }),
      }),
    ),
  commands: [],
})

describe("fan-out dispatch", () => {
  it.effect("sync invokes every registration that provides it, in registration order", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([
      syncRegistration("alpha", records, "ok"),
      syncRegistration("beta", records, "ok"),
    ])
    return Effect.gen(function* () {
      yield* dispatch(engine, Sync, "sync", (capability) => capability.sync())
      expect(records.syncs).toEqual(["alpha", "beta"])
    })
  })

  it.effect("sync is not invoked on a later registration when an earlier one fails", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([
      syncRegistration("alpha", records, "fail"),
      syncRegistration("beta", records, "ok"),
    ])
    return Effect.gen(function* () {
      const failure = yield* dispatch(engine, Sync, "sync", (capability) => capability.sync()).pipe(
        Effect.flip,
      )
      expect(failure.message).toContain("alpha exploded")
      expect(failure.message).toContain("alpha")
      expect(records.syncs).toEqual(["alpha"])
    })
  })

  it.effect("dev passes the port to every registration that provides dev", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([
      recordingRegistration("alpha", records, ["dev"]),
      recordingRegistration("beta", records, ["dev"]),
    ])
    return Effect.gen(function* () {
      yield* dispatch(engine, Dev, "dev", (capability) => capability.dev({ port: 9999 }))
      expect(records.ports).toEqual([9999, 9999])
    })
  })

  it.effect("the failure names the failing registration when the second registration fails", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([
      syncRegistration("alpha", records, "ok"),
      syncRegistration("beta", records, "fail"),
    ])
    return Effect.gen(function* () {
      const failure = yield* dispatch(engine, Sync, "sync", (capability) => capability.sync()).pipe(
        Effect.flip,
      )
      expect(failure.plugin).toBe("beta")
      expect(records.syncs).toEqual(["alpha", "beta"])
    })
  })
})
