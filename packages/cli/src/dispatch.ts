/**
 * Capability dispatch: one place that answers "who provides this capability,
 * what do we do when nobody does, and who failed". The registration collection
 * is data, so the engine — not Layer composition — owns the routing.
 *
 * The generator itself is generic, so `Effect.fn` preserves the tag's
 * identifier and shape plus `A`. `Context.Key<Identifier, Shape>` is the tag
 * type a `Context.Service` has (`Sync` is `Key<Sync, { sync(): ... }>`); a
 * single `Key<Service, Service>` parameter does not unify with it.
 */
import { Context, Effect, Layer, Option, Scope } from "effect"
import type { Engine } from "./engine.ts"
import { type AnyPluginRegistration, PluginError } from "./plugin.ts"

export const missingCapability = (
  capabilityName: string,
  registrations: ReadonlyArray<AnyPluginRegistration>,
): string =>
  `no registered plugin provides the "${capabilityName}" capability (registered plugins: ${
    registrations.length === 0 ? "(none)" : registrations.map((registration) => registration.name).join(", ")
  })`

const attributeFailure =
  (pluginName: string) =>
  <A, R>(effect: Effect.Effect<A, PluginError, R>): Effect.Effect<A, PluginError, R> =>
    Effect.mapError(
      effect,
      (error) =>
        new PluginError({
          message: `${pluginName}: ${error.message}`,
          plugin: error.plugin ?? pluginName,
        }),
    )

/**
 * Run the capability on EVERY registration that provides it, in registration
 * order, and stop at the first failure. The loop body is sequential by
 * construction: `yield*` on the previous registration completes before the
 * next iteration starts, so a long-running provider blocks the later ones
 * exactly as the design documents. No concurrency, no cancellation, no
 * reordering is added.
 */
export const dispatch = Effect.fn("dispatch")(function* <Identifier, Shape, A>(
  engine: Engine,
  tag: Context.Key<Identifier, Shape>,
  capabilityName: string,
  run: (service: Shape) => Effect.Effect<A, PluginError>,
): Effect.fn.Return<A, PluginError, Scope.Scope> {
  let provided = false
  for (const registration of engine.registrations) {
    const context = yield* Layer.build(registration.capabilities(engine.host))
    const service = Context.getOption(context, tag)
    if (Option.isNone(service)) continue
    provided = true
    yield* run(service.value).pipe(attributeFailure(registration.name)) // stops here on failure
  }
  if (!provided) {
    return yield* new PluginError({
      message: missingCapability(capabilityName, engine.registrations),
    })
  }
  return undefined as A
})
