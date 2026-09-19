/**
 * Contributed commands: a registration declares plain-data commands, each
 * mounted under a group named after its registration and satisfied from its
 * OWN capability implementations. Two registrations may contribute the same
 * local name. Until this slice the group renders with no subcommands, so
 * every case below fails on behavior.
 */
import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { buildCli } from "../src/command.ts"
import { type Engine, engineLayer } from "../src/engine.ts"
import {
  type Capability,
  type CommandInput,
  type FlagDeclaration,
  PluginError,
  Sync,
} from "../src/plugin.ts"
import { capturingConsole, makeCliTestLayer, makeTestEngine } from "./helpers.ts"
import type { AnyPluginRegistration } from "../src/plugin.ts"

const run = (engine: Engine, args: ReadonlyArray<string>, output: string[] = []) =>
  Command.runWith(buildCli(engine), { version: "0.0.0" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeCliTestLayer(args),
        Layer.succeed(Console.Console, capturingConsole(output)),
        engineLayer(engine),
      ),
    ),
  )

/** A registration contributing one `hello` command over an empty capability layer. */
const commandRegistration = (
  name: string,
  handler: (input: CommandInput) => Effect.Effect<void, PluginError, Capability>,
  flags: ReadonlyArray<FlagDeclaration> = [],
): AnyPluginRegistration => ({
  name,
  capabilities: () => Layer.empty as Layer.Layer<Capability>,
  commands: [{ name: "hello", description: `hello from ${name}`, flags, handler }],
})

/** A registration whose `hello` command runs its own Sync capability. */
const markerRegistration = (name: string, observed: string[]): AnyPluginRegistration => ({
  name,
  capabilities: () =>
    Layer.succeed(
      Sync,
      Sync.of({
        sync: Effect.fn(`${name}.sync`)(function* () {
          observed.push(name)
          yield* Effect.void
        }),
      }),
    ),
  commands: [
    {
      name: "hello",
      description: `hello from ${name}`,
      flags: [],
      handler: Effect.fn(`${name}.hello`)(function* () {
        const sync = yield* Sync
        yield* sync.sync()
      }),
    },
  ],
})

describe("contributed commands", () => {
  it.effect("a contributed command runs when its registration declares one", () => {
    const ran: string[] = []
    const engine = makeTestEngine([
      commandRegistration("alpha", () =>
        Effect.sync(() => {
          ran.push("alpha")
        }),
      ),
    ])
    return Effect.gen(function* () {
      yield* run(engine, ["alpha", "hello"])
      expect(ran).toEqual(["alpha"])
    })
  })

  it.effect("two registrations may contribute the same local name", () => {
    const ran: string[] = []
    const engine = makeTestEngine([
      commandRegistration("alpha", () =>
        Effect.sync(() => {
          ran.push("alpha")
        }),
      ),
      commandRegistration("beta", () =>
        Effect.sync(() => {
          ran.push("beta")
        }),
      ),
    ])
    return Effect.gen(function* () {
      yield* run(engine, ["alpha", "hello"])
      expect(ran).toEqual(["alpha"])
      yield* run(engine, ["beta", "hello"])
      expect(ran).toEqual(["alpha", "beta"])

      const output: string[] = []
      yield* run(engine, ["--help"], output)
      const help = output.join("")
      expect(help).toContain("alpha")
      expect(help).toContain("beta")
    })
  })

  it.effect("a handler reads its own registration's capability, not another's", () => {
    const observed: string[] = []
    const engine = makeTestEngine([
      markerRegistration("alpha", observed),
      markerRegistration("beta", observed),
    ])
    return Effect.gen(function* () {
      yield* run(engine, ["alpha", "hello"])
      expect(observed).toEqual(["alpha"])
    })
  })

  it.effect("a command's declared flags reach its handler, with the default applied", () => {
    const inputs: string[] = []
    const engine = makeTestEngine([
      commandRegistration(
        "alpha",
        (input) =>
          Effect.sync(() => {
            inputs.push(String(input.message))
          }),
        [{ name: "message", kind: "string", description: "greeting", default: "hi" }],
      ),
    ])
    return Effect.gen(function* () {
      yield* run(engine, ["alpha", "hello", "--message", "there"])
      expect(inputs).toEqual(["there"])
      yield* run(engine, ["alpha", "hello"])
      expect(inputs).toEqual(["there", "hi"])
    })
  })

  it.effect("a contributed command that fails reports its registration's name", () => {
    const engine = makeTestEngine([
      commandRegistration("alpha", () =>
        Effect.fail(new PluginError({ message: "boom" })),
      ),
    ])
    return Effect.gen(function* () {
      const failure = yield* run(engine, ["alpha", "hello"]).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(PluginError)
      expect((failure as PluginError).plugin).toBe("alpha")
    })
  })
})
