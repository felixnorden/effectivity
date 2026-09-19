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

const names = (registrations: ReadonlyArray<AnyPluginRegistration>): string =>
  registrations.length === 0 ? "(none)" : registrations.map((registration) => registration.name).join(", ")

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

/** Slice 1 scope: run the FIRST registration that provides the capability. */
export const dispatch = Effect.fn("dispatch")(function* <Identifier, Shape, A>(
  engine: Engine,
  tag: Context.Key<Identifier, Shape>,
  capabilityName: string,
  run: (service: Shape) => Effect.Effect<A, PluginError>,
): Effect.fn.Return<A, PluginError, Scope.Scope> {
  for (const registration of engine.registrations) {
    const context = yield* Layer.build(registration.capabilities(engine.host))
    const service = Context.getOption(context, tag)
    if (Option.isSome(service)) {
      return yield* run(service.value).pipe(attributeFailure(registration.name))
    }
  }
  return yield* new PluginError({
    message: `no registered plugin provides the "${capabilityName}" capability (registered plugins: ${names(engine.registrations)})`,
  })
})
