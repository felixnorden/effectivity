import { describe, expect, it } from "@effect/vitest"
import { version } from "../src/index"

describe("effectivity-core", () => {
  it("exposes a version", () => {
    expect(version).toBe("0.0.1")
  })
})
