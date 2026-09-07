import { describe, expect, it } from "@effect/vitest"
import { slugify } from "../src/slug.ts"

describe("slugify", () => {
  it("lowercases and turns whitespace into dashes", () => {
    expect(slugify("My Post")).toBe("my-post")
  })

  it("collapses separator runs of dots, underscores, and whitespace into one dash", () => {
    expect(slugify("My   Post.md")).toBe("my-post-md")
    expect(slugify("A_B C")).toBe("a-b-c")
  })

  it("drops non-alphanumeric characters and trims dashes", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
    expect(slugify("--leading--trailing--")).toBe("leading-trailing")
  })

  it("keeps unicode letters and digits", () => {
    expect(slugify("Ünïcode Café 2026")).toBe("ünïcode-café-2026")
  })

  it("produces an empty slug for separator-only input", () => {
    expect(slugify("---")).toBe("")
  })
})
