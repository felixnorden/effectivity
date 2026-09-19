/**
 * Shared test doubles for the CLI suite: the full runner environment
 * (`FileSystem | Path | Terminal | ChildProcessSpawner | Stdio`) per the
 * Command.ts JSDoc pattern, a recording registration stub, and an engine
 * builder over a test host.
 */
import { Console, Context, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { Engine } from "../src/engine.ts"
import {
  Build,
  Dev,
  type HostServicesShape,
  Preview,
  Seed,
  Sync,
} from "../src/plugin.ts"
import type { AnyPluginRegistration } from "../src/plugin.ts"

/** A Console service that collects log/error output, so help output can be asserted. */
export const capturingConsole = (output: string[]): Console.Console =>
  Object.assign(Object.create(console) as Console.Console, {
    log: (...args: ReadonlyArray<unknown>) => {
      output.push(args.map(String).join(" "))
    },
    error: (...args: ReadonlyArray<unknown>) => {
      output.push(args.map(String).join(" "))
    },
  })

/** The shared CLI runner test layer: deterministic stdio/terminal/noop fs. */
export const makeCliTestLayer = (
  args: ReadonlyArray<string>,
  fs: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({}),
) =>
  Layer.mergeAll(
    fs,
    Path.layer,
    Stdio.layerTest({ args: Effect.succeed(args) }),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused")),
    ),
  )

/** Build a layer into a value for the engine host (no requirements, no errors). */
const layerValue = <I, A>(layer: Layer.Layer<I>, tag: Context.Key<I, A>): A =>
  Context.get(Effect.runSync(Effect.scoped(Layer.build(layer))), tag)

/** The engine host surface for tests: a noop file system, a spawner that dies if used. */
export const makeTestHost = (
  fs: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({}),
): HostServicesShape => ({
  fs: layerValue(fs, FileSystem.FileSystem),
  spawner: ChildProcessSpawner.make(() => Effect.die("unexpected spawn in test host")),
  stdio: layerValue(Stdio.layerTest({}), Stdio.Stdio),
})

/** The engine literal every test builds from: registrations, host, and root. */
export const makeTestEngine = (
  registrations: ReadonlyArray<AnyPluginRegistration>,
  host: HostServicesShape = makeTestHost(),
  projectRoot = "/tmp",
): Engine => ({ registrations, host, projectRoot })

export interface Recording {
  readonly syncs: string[]
  readonly ports: number[]
  readonly urls: string[]
}

export type CapabilityName = "sync" | "dev" | "build" | "preview" | "seed"

const allCapabilities: ReadonlyArray<CapabilityName> = ["sync", "dev", "build", "preview", "seed"]

/** A registration whose capability implementations record their calls. */
export const recordingRegistration = (
  name: string,
  records: Recording,
  provide: ReadonlyArray<CapabilityName> = allCapabilities,
): AnyPluginRegistration => {
  const layers: Array<Layer.Layer<any>> = []
  if (provide.includes("sync")) {
    layers.push(
      Layer.succeed(
        Sync,
        Sync.of({
          sync: Effect.fn(`${name}.sync`)(function* () {
            records.syncs.push(name)
            yield* Effect.void
          }),
        }),
      ),
    )
  }
  if (provide.includes("dev")) {
    layers.push(
      Layer.succeed(
        Dev,
        Dev.of({
          dev: Effect.fn(`${name}.dev`)(function* (options) {
            records.ports.push(options.port)
            yield* Effect.void
          }),
        }),
      ),
    )
  }
  if (provide.includes("build")) {
    layers.push(
      Layer.succeed(
        Build,
        Build.of({
          build: Effect.fn(`${name}.build`)(function* () {
            yield* Effect.void
          }),
        }),
      ),
    )
  }
  if (provide.includes("preview")) {
    layers.push(
      Layer.succeed(
        Preview,
        Preview.of({
          preview: Effect.fn(`${name}.preview`)(function* () {
            yield* Effect.void
          }),
        }),
      ),
    )
  }
  if (provide.includes("seed")) {
    layers.push(
      Layer.succeed(
        Seed,
        Seed.of({
          seed: Effect.fn(`${name}.seed`)(function* (options) {
            records.urls.push(options.url)
            yield* Effect.void
          }),
        }),
      ),
    )
  }
  return {
    name,
    capabilities: () => layers.reduce((acc, layer) => Layer.merge(acc, layer), Layer.empty as Layer.Layer<any>),
    commands: [],
  }
}
