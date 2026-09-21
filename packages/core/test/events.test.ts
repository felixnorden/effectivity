import { Duration, Effect, Fiber, Option, PubSub, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { ChangeEvent, ChangeEvents } from "../src/events.ts"

const updateEvent: ChangeEvent = {
  kind: "document",
  operation: "update",
  keys: ["docs/a.md"],
  version: "v2",
}

const deleteEvent: ChangeEvent = {
  kind: "asset",
  operation: "delete",
  keys: ["images/logo.png"],
  version: "v3",
}

describe("change events", () => {
  it.layer(ChangeEvents.layer)("delivery", (it) => {
    it.effect("publishes one event per successful mutation with the expected fields", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* ChangeEvents
          const stream = yield* events.subscribe
          const collected = yield* Effect.forkScoped(
            stream.pipe(Stream.take(1), Stream.runCollect),
            {
              startImmediately: true,
            },
          )
          yield* events.publish(updateEvent)
          const received = yield* Fiber.join(collected)
          expect(received).toEqual([updateEvent])
        }),
      ),
    )

    it.effect("delivers events to multiple subscribers (broadcast)", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* ChangeEvents
          const streamA = yield* events.subscribe
          const streamB = yield* events.subscribe
          const a = yield* Effect.forkScoped(streamA.pipe(Stream.take(1), Stream.runCollect), {
            startImmediately: true,
          })
          const b = yield* Effect.forkScoped(streamB.pipe(Stream.take(1), Stream.runCollect), {
            startImmediately: true,
          })
          yield* events.publish(deleteEvent)
          const [receivedA, receivedB] = yield* Effect.all([Fiber.join(a), Fiber.join(b)])
          expect(receivedA).toEqual([deleteEvent])
          expect(receivedB).toEqual([deleteEvent])
        }),
      ),
    )
  })

  it.live("bounded stream backpressures rather than dropping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.bounded<ChangeEvent>(1)
        const events = ChangeEvents.of({
          subscribe: Effect.succeed(Stream.fromPubSub(pubsub)),
          publish: (event) => Effect.asVoid(PubSub.publish(pubsub, event)),
        })
        // slow consumer: subscribed, never takes — fills the bounded capacity
        yield* PubSub.subscribe(pubsub)
        yield* events.publish(updateEvent)
        const second = yield* Effect.timeoutOption(events.publish(deleteEvent), Duration.millis(50))
        expect(second).toEqual(Option.none())
      }),
    ),
  )

  it("rejects an event with an unknown operation via schema validation", () => {
    const decoded = Schema.decodeUnknownResult(ChangeEvent)({
      kind: "document",
      operation: "bogus",
      keys: ["docs/a.md"],
      version: "v2",
    })
    expect(Result.isFailure(decoded)).toBe(true)
  })
})
