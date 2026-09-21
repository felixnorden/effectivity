/**
 * The command surface: the engine command tree plus per-plugin groups built
 * by `buildCli(engine)`. Help, flag parsing, and dispatch are
 * framework-derived; these tests pin the tree shape and the typed flag
 * surface.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Layer } from "effect"
import { CliError, Command } from "effect/unstable/cli"
import { buildCli } from "../src/command.ts"
import { type Engine, engineLayer } from "../src/engine.ts"
import {
  makeCliTestLayer,
  makeTestEngine,
  type Recording,
  recordingRegistration,
} from "./helpers.ts"

const emptyRecords = (): Recording => ({ syncs: [], ports: [], urls: [] })

const run = (engine: Engine, args: ReadonlyArray<string>) =>
  Command.runWith(buildCli(engine), { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(makeCliTestLayer(args), engineLayer(engine))),
  )

describe("root command", () => {
  it.effect("completes without error when given --help", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords())])
    return run(engine, ["--help"])
  })
})

describe("subcommands", () => {
  it.effect("sync is recognized and completes with the stub handler", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords())])
    return run(engine, ["sync"])
  })

  it.effect("sync handler dispatches to the plugin", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([recordingRegistration("alpha", records)])
    return Effect.gen(function* () {
      yield* run(engine, ["sync"])
      expect(records.syncs).toEqual(["alpha"])
    })
  })

  it.effect("dev parses --port flag as integer", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([recordingRegistration("alpha", records)])
    return Effect.gen(function* () {
      yield* run(engine, ["dev", "--port", "9000"])
      expect(records.ports).toEqual([9000])
    })
  })

  it.effect("build is recognized and completes with the stub handler", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords())])
    return run(engine, ["build"])
  })

  it.effect("preview is recognized and completes with the stub handler", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords())])
    return run(engine, ["preview"])
  })

  it.effect("seed parses --url flag", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([recordingRegistration("alpha", records)])
    return Effect.gen(function* () {
      yield* run(engine, ["seed", "--url", "https://cms.example.com"])
      expect(records.urls).toEqual(["https://cms.example.com"])
    })
  })

  it.effect("unknown subcommand surfaces CliError, not a process exit", () => {
    const engine = makeTestEngine([recordingRegistration("alpha", emptyRecords())])
    return Effect.gen(function* () {
      const exit = yield* run(engine, ["not-a-command"]).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const found = Cause.findError(exit.cause)
        expect(found._tag).toBe("Success")
        if (found._tag === "Success") {
          expect(CliError.isCliError(found.success)).toBe(true)
        }
      }
    })
  })
})
