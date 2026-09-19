/**
 * The plugin contract: the typed capability tags, the registration shape, and
 * the `ProjectRoot` reference channel. A registration supplies exactly the
 * capabilities it declares; its layer carries no IO requirement because the
 * host arrives as an argument.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { Build, Dev, Preview, ProjectRoot, Seed, Sync } from "../src/plugin.ts"
import { makeTestHost, recordingRegistration } from "./helpers.ts"

describe("capability tags", () => {
  it("each capability has its own namespaced identity string", () => {
    expect(Sync.key).toBe("@effectivity/cli/Sync")
    expect(Dev.key).toBe("@effectivity/cli/Dev")
    expect(Build.key).toBe("@effectivity/cli/Build")
    expect(Preview.key).toBe("@effectivity/cli/Preview")
    expect(Seed.key).toBe("@effectivity/cli/Seed")
  })
})

describe("PluginRegistration", () => {
  it.effect("a registration provides exactly the capabilities it declares", () =>
    Effect.gen(function* () {
      const registration = recordingRegistration(
        "alpha",
        { syncs: [], ports: [], urls: [] },
        ["sync", "seed"],
      )
      const context = yield* Layer.build(registration.capabilities(makeTestHost()))
      expect(Option.isSome(Context.getOption(context, Sync))).toBe(true)
      expect(Option.isSome(Context.getOption(context, Seed))).toBe(true)
      expect(Option.isNone(Context.getOption(context, Dev))).toBe(true)
      expect(Option.isNone(Context.getOption(context, Build))).toBe(true)
      expect(Option.isNone(Context.getOption(context, Preview))).toBe(true)
    }))

  it("a registration's capability layer declares no requirements", () => {
    const registration = recordingRegistration("alpha", { syncs: [], ports: [], urls: [] })
    const layer: Layer.Layer<any, never, never> = registration.capabilities(makeTestHost())
    expect(layer).toBeDefined()
  })
})

describe("ProjectRoot", () => {
  it.effect("returns its default when not provided", () =>
    Effect.gen(function* () {
      const root = yield* ProjectRoot
      expect(root).toBe(process.cwd())
    }))

  it.effect("is provided from a layer when the engine sets a root", () =>
    Effect.gen(function* () {
      const root = yield* ProjectRoot
      expect(root).toBe("/tmp")
    }).pipe(Effect.provide(Layer.succeed(ProjectRoot, "/tmp"))))
})
