/**
 * Missing-capability behaviour: every platform command is always mounted, and
 * running one whose capability no registration provides fails with a
 * PluginError that names the capability and lists the registered plugin names.
 * A registration that provides a subset (seed included) is legal.
 */
import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { buildCli } from "../src/command.ts"
import { type Engine, engineLayer } from "../src/engine.ts"
import { PluginError } from "../src/plugin.ts"
import {
  capturingConsole,
  makeCliTestLayer,
  makeTestEngine,
  type Recording,
  recordingRegistration,
} from "./helpers.ts"

const emptyRecords = (): Recording => ({ syncs: [], ports: [], urls: [] })

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

describe("missing capability", () => {
  it.effect("seed fails naming the missing capability and the registered plugins", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords(), ["sync"])])
    return Effect.gen(function* () {
      const failure = yield* run(engine, ["seed"]).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(PluginError)
      expect(failure.message).toContain("seed")
      expect(failure.message).toContain("alpha")
    })
  })

  it.effect("sync fails the same way when a registration provides only seed", () => {
    const engine = makeTestEngine([recordingRegistration("beta", emptyRecords(), ["seed"])])
    return Effect.gen(function* () {
      const failure = yield* run(engine, ["sync"]).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(PluginError)
      expect(failure.message).toContain("sync")
      expect(failure.message).toContain("beta")
    })
  })

  it.effect(
    "the failure names the capability and lists no plugins when the collection is empty",
    () => {
      const engine = makeTestEngine([])
      return Effect.gen(function* () {
        const failure = yield* run(engine, ["build"]).pipe(Effect.flip)
        expect(failure).toBeInstanceOf(PluginError)
        expect(failure.message).toContain("build")
        expect(failure.message).toContain("(none)")

        const output: string[] = []
        yield* run(engine, ["--help"], output)
        const help = output.join("")
        for (const command of ["sync", "dev", "build", "preview", "seed", "init"]) {
          expect(help).toContain(command)
        }
      })
    },
  )

  it.effect("the seed command is present in help when no registration provides seed", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords(), ["sync"])])
    const output: string[] = []
    return Effect.gen(function* () {
      yield* run(engine, ["--help"], output)
      expect(output.join("")).toContain("seed")
    })
  })
})
