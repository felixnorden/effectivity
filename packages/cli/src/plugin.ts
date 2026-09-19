/**
 * The plugin contract: typed capability services, the engine-provided host
 * surface, and the registration record a project lists in its
 * `effectivity.config.ts`. `ProjectRoot` is the single context channel —
 * capabilities yield it instead of receiving a `projectRoot` argument.
 *
 * Capabilities are ordinary typed keys, never reference keys, so they carry
 * type information through layers and effects. A registration supplies the
 * capabilities it implements (a subset is legal, including only `Seed`) and
 * the commands it contributes; the engine iterates the registrations in order.
 */
import { Context, Effect, FileSystem, Layer, Schema, Stdio } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

/** Options for the `dev` capability: the port the dev server listens on. */
export interface DevOptions {
  readonly port: number
}

/** Options for the `seed` capability: the base URL of the running worker. */
export interface SeedOptions {
  readonly url: string
}

/** The failure type every capability returns. The engine fills `plugin` when a
 * capability fails and prefixes `message` with the registration name. */
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  /** The failing registration's name; the engine adds it when a capability fails. */
  plugin: Schema.optional(Schema.String),
}) {}

/**
 * The project root: the config file's directory. Capabilities yield it instead
 * of receiving a `projectRoot` argument. Provides `process.cwd()` when no
 * engine has set a root, so help works without a config file.
 *
 * NOTE on the declared service signatures: `Context.Reference` keys carry
 * the type-level identifier `never` in this effect version, so a declared
 * `R = ProjectRoot` requirement can never be eliminated by `Effect.provide`
 * (tsgo: "This Effect requires a service that is missing... `ProjectRoot`").
 * Capabilities therefore declare `R = never` and READ the root by yielding
 * `ProjectRoot`; the engine always provides the key (its layer shadows the
 * default). This is the plan's agreed fallback when "tsgo disagrees".
 */
export class ProjectRoot extends Context.Reference<string>("@effectivity/cli/ProjectRoot", {
  defaultValue: () => process.cwd(),
}) {}

/** The engine-provided host surface: provided once, at the outer boundary. */
export interface HostServicesShape {
  readonly fs: FileSystem.FileSystem
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly stdio: Stdio.Stdio
}

/** The engine-captured host surface, provided once at the outer boundary.
 * Registrations receive it as an argument, never as an `RIn`. */
export class HostServices extends Context.Service<HostServices, HostServicesShape>()(
  "@effectivity/cli/HostServices"
) {
  /**
   * The canonical constructor: the aggregate host surface, built from the
   * platform services the process already has. `boot` reads it from the
   * context, and `engineLayer` re-provides the captured value to plugins.
   */
  static readonly layer = Layer.effect(
    HostServices,
    Effect.gen(function* () {
      return HostServices.of({
        fs: yield* FileSystem.FileSystem,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        stdio: yield* Stdio.Stdio,
      })
    })
  )
}

// Capability identifiers are ordinary typed keys, never reference keys.

/** Regenerate the platform's manufactured artifacts from the config. */
export class Sync extends Context.Service<Sync, { sync(): Effect.Effect<void, PluginError> }>()(
  "@effectivity/cli/Sync"
) {}

/** Sync, then run the dev server. Long-running: it does not return while the
 * server runs, so later registrations do not run for this capability. */
export class Dev extends Context.Service<Dev, { dev(options: DevOptions): Effect.Effect<void, PluginError> }>()(
  "@effectivity/cli/Dev"
) {}

/** Sync, then build the deployable bundle. */
export class Build extends Context.Service<Build, { build(): Effect.Effect<void, PluginError> }>()(
  "@effectivity/cli/Build"
) {}

/** Serve the built bundle. Long-running. */
export class Preview extends Context.Service<Preview, { preview(): Effect.Effect<void, PluginError> }>()(
  "@effectivity/cli/Preview"
) {}

/** Populate a running instance with example data. */
export class Seed extends Context.Service<Seed, { seed(options: SeedOptions): Effect.Effect<void, PluginError> }>()(
  "@effectivity/cli/Seed"
) {}

export type Capability = Sync | Dev | Build | Preview | Seed
// Deliberately no static `layer` on the capability tags: their implementations
// always come from a registration's `capabilities(host)`. A default layer here
// would reintroduce the deleted diagnostic layer and make dispatch's
// missing-capability failure unreachable.

export interface FlagDeclaration {
  readonly name: string
  readonly kind: "string" | "boolean" | "integer"
  readonly description: string
  readonly optional?: boolean
  readonly default?: string | number | boolean
  readonly alias?: string
}

export type CommandInput = Readonly<Record<string, unknown>>

export interface CommandDeclaration<R extends Capability = Capability> {
  readonly name: string
  readonly description: string
  readonly flags: ReadonlyArray<FlagDeclaration>
  readonly handler: (input: CommandInput) => Effect.Effect<void, PluginError, R>
}

/**
 * A registration is plain data. `capabilities` is applied to the engine-built
 * host, so the returned layer has NO requirement — the host arrives as an
 * argument, not as an RIn. R is the exact capability set this plugin provides;
 * Layer's ROut is contravariant, so a layer providing a subset cannot be
 * declared as providing more. Every capability is optional: R may be any
 * subset of Capability, including only Seed.
 */
export interface PluginRegistration<R extends Capability = Capability> {
  readonly name: string
  readonly capabilities: (host: HostServicesShape) => Layer.Layer<R, never, never>
  readonly commands: ReadonlyArray<CommandDeclaration<R>>
}

/** The engine-facing element type: the collection is heterogeneous. */
export type AnyPluginRegistration = PluginRegistration<any>
