/**
 * The engine: config discovery, host capture, and the project root. The engine
 * is generic — it has no Cloudflare concepts. It loads
 * `effectivity.config.ts`, keeps the ordered registration collection as data,
 * captures the host surface and the project root once, and lets the command
 * surface dispatch each platform operation over the registrations.
 */
import { Effect, Layer } from "effect"
import { loadRawConfig } from "./loader.ts"
import {
  type AnyPluginRegistration,
  HostServices,
  type HostServicesShape,
  PluginError,
  ProjectRoot,
} from "./plugin.ts"

export interface Engine {
  readonly registrations: ReadonlyArray<AnyPluginRegistration>
  readonly host: HostServicesShape
  /** The config's directory, or `cwd` when no config was found. */
  readonly projectRoot: string
}

/** Reject a nameless or duplicated registration with a message that names the position. */
const validateRegistrations = Effect.fn("validateRegistrations")(function* (
  registrations: ReadonlyArray<AnyPluginRegistration>,
): Effect.fn.Return<void, PluginError> {
  const seen = new Map<string, number>()
  for (const [index, registration] of registrations.entries()) {
    const name = registration?.name
    if (typeof name !== "string" || name.length === 0) {
      return yield* new PluginError({
        message: `plugin registration at position ${index} is missing a name; every registration requires a unique name`,
      })
    }
    const first = seen.get(name)
    if (first !== undefined) {
      return yield* new PluginError({
        message: `duplicate plugin registration name "${name}" at positions ${first} and ${index}; registration names must be unique`,
      })
    }
    seen.set(name, index)
  }
})

/**
 * Load the config and capture the host and root once. A broken config
 * propagates as a `PluginError` (never a bare `Cause.UnknownError`); a missing
 * config is not an error.
 */
export const boot = Effect.fn("boot")(function* (
  explicitConfig?: string,
  cwd: string = process.cwd(),
): Effect.fn.Return<Engine, PluginError, HostServices> {
  const host = yield* HostServices // from HostServices.layer, provided at the entry
  const loaded = yield* Effect.tryPromise({
    try: () => loadRawConfig(explicitConfig, cwd),
    catch: (cause) =>
      new PluginError({ message: `could not load effectivity.config.ts: ${String(cause)}` }),
  })
  const registrations = loaded === null ? [] : loaded.config.plugins ?? []
  yield* validateRegistrations(registrations)
  return {
    registrations,
    host,
    projectRoot: loaded === null ? cwd : loaded.dir,
  }
})

/** The one outer provision: host IO + the project root (a reference key). */
export const engineLayer = (engine: Engine): Layer.Layer<HostServices> =>
  Layer.merge(
    Layer.succeed(HostServices, engine.host),
    Layer.succeed(ProjectRoot, engine.projectRoot),
  )
