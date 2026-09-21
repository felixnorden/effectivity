import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"

/**
 * Schema-typed change-event model (D11): one typed event per logical,
 * successful mutation, published after all key-level steps of that mutation
 * have committed. Covers only this package's own mutations — no watcher, no
 * polling, no events for storage-level changes by external writers (D5).
 */
const DocumentEvent = Schema.Struct({
  kind: Schema.Literal("document"),
  operation: Schema.Literals(["create", "update", "move", "delete"]),
  keys: Schema.Array(Schema.String),
  version: Schema.String,
})

const AssetEvent = Schema.Struct({
  kind: Schema.Literal("asset"),
  operation: Schema.Literals(["store", "delete", "rename"]),
  keys: Schema.Array(Schema.String),
  version: Schema.String,
})

export const ChangeEvent = Schema.Union([DocumentEvent, AssetEvent])
export type ChangeEvent = typeof ChangeEvent.Type

export interface ChangeEventShape {
  readonly subscribe: Effect.Effect<Stream.Stream<ChangeEvent>>
  readonly publish: (event: ChangeEvent) => Effect.Effect<void>
}

/**
 * In-process broadcast surface for change events. Backed by a `PubSub`; a
 * caller subscribes to an Effect `Stream` and receives one event per publish.
 * The surface lifetime is the provided layer's — `Layer.effect` acquires the
 * `PubSub` in the layer's scope.
 */
export class ChangeEvents extends Context.Service<ChangeEvents, ChangeEventShape>()(
  "effectivity/events/ChangeEvents",
) {
  static readonly layer = Layer.effect(
    ChangeEvents,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ChangeEvent>()
      return ChangeEvents.of({
        subscribe: Effect.succeed(Stream.fromPubSub(pubsub)),
        publish: (event) => Effect.asVoid(PubSub.publish(pubsub, event)),
      })
    }),
  )
}
