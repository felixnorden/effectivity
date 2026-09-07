import { Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { add, addEffect, version } from "../src/index"

describe("core", () => {
  it("has a version", () => {
    expect(version).toBe("0.0.1")
  })

  it("adds numbers", () => {
    expect(add(1, 2)).toBe(3)
  })

  it.effect("adds numbers inside an Effect", () =>
    addEffect(2, 3).pipe(Effect.map((n) => expect(n).toBe(5))),
  )
})
