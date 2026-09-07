import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { classifyContent, parseDocument, validateContent } from "../src/codec.ts"
import * as Error_ from "../src/error.ts"
import { utf8 } from "./bytes.ts"

const Frontmatter = Schema.Struct({ title: Schema.String, tags: Schema.Array(Schema.String) })

const OptionalFrontmatter = Schema.Struct({
  title: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
})

const TextOnly = Schema.Struct({ title: Schema.String })

const bytes = (s: string): Uint8Array => utf8(s)

describe("codec", () => {
  it.effect("parses frontmatter-plus-body bytes into a typed document", () =>
    Effect.gen(function* () {
      const input = bytes("---\ntitle: Hello\ntags:\n  - a\n  - b\n---\n# Body\n\ntext")
      const doc = yield* parseDocument(Frontmatter, input)
      expect(doc.frontmatter.title).toBe("Hello")
      expect(doc.frontmatter.tags).toEqual(["a", "b"])
      expect(doc.body).toBe("# Body\n\ntext")
      expect(doc.hasFrontmatter).toBe(true)
      expect(doc.raw).toEqual(input)
    }),
  )

  it.effect("returns validationFailed when frontmatter does not match the schema", () =>
    Effect.gen(function* () {
      const input = bytes("---\ntitle: 42\n---\n# Body\n")
      const failure = yield* parseDocument(Frontmatter, input).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(Error_.ValidationFailed)
      expect(failure.issues.length).toBeGreaterThan(0)
    }),
  )

  it.effect("treats absent frontmatter as an empty model when the schema requires nothing", () =>
    Effect.gen(function* () {
      const input = bytes("# Just a body\n")
      const doc = yield* parseDocument(OptionalFrontmatter, input)
      expect(doc.hasFrontmatter).toBe(false)
      expect(doc.body).toBe("# Just a body\n")
      expect(doc.frontmatter).toEqual({})
    }),
  )

  it.effect("preserves the original bytes verbatim in the parsed value", () =>
    Effect.gen(function* () {
      const input = bytes("---\ntitle: |\n  block\n  text\n---\n# Body\n\n  indented\n")
      const doc = yield* parseDocument(TextOnly, input)
      expect(doc.raw).toEqual(input)
    }),
  )

  it.effect("validates candidate bytes for storage before they are accepted", () =>
    Effect.gen(function* () {
      const valid = yield* validateContent(Frontmatter, bytes("---\ntitle: T\ntags: []\n---\nok"))
      expect(valid.frontmatter.title).toBe("T")
      const failure = yield* validateContent(Frontmatter, bytes("---\ntitle: 1\n---\nbad")).pipe(
        Effect.flip,
      )
      expect(failure).toBeInstanceOf(Error_.ValidationFailed)
    }),
  )

  it.effect("classifies whether bytes are a valid document", () =>
    Effect.gen(function* () {
      const doc = yield* classifyContent(bytes("---\ntitle: T\ntags: []\n---\nhi"), Frontmatter)
      expect(doc).toBe(true)
    }),
  )

  it.effect("treats asset bytes as opaque and never classifies them as documents", () =>
    Effect.gen(function* () {
      const png = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ])
      const classified = yield* classifyContent(png, Frontmatter)
      expect(classified).toBe(false)
    }),
  )
})
