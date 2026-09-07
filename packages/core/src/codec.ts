import { Effect, Option, Result, Schema } from "effect"
import { load } from "js-yaml"
import * as Error_ from "./error.ts"

/**
 * Content semantics for documents: splitting stored bytes into a frontmatter
 * region and a raw markdown body, YAML-decoding the frontmatter and validating
 * it against the caller-supplied schema, and projecting a typed document value.
 *
 * Read-path only: bytes are authoritative and nothing here re-serializes
 * markdown or writes to storage (D8). js-yaml is used only for decoding, so its
 * normalization can never alter stored bytes. Asset bytes are opaque and are
 * never parsed by this module beyond a classification check.
 */
export interface ParsedDocument<A> {
  readonly raw: Uint8Array // authoritative bytes, kept verbatim (D8)
  readonly body: string // raw markdown body (no frontmatter fence)
  readonly frontmatter: A // validated against the caller schema
  readonly hasFrontmatter: boolean
}

const FENCE = "---"

/** UTF-8 decode without relying on ambient globals (TextDecoder is untyped here). */
const utf8Decode = (bytes: Uint8Array): string => {
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0
    if (b0 < 0x80) {
      out += String.fromCodePoint(b0)
      i += 1
    } else if (b0 < 0xe0) {
      out += String.fromCodePoint(((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f))
      i += 2
    } else if (b0 < 0xf0) {
      out += String.fromCodePoint(
        ((b0 & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f),
      )
      i += 3
    } else {
      const codepoint =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f)
      out += String.fromCodePoint(codepoint)
      i += 4
    }
  }
  return out
}

/**
 * Split stored bytes at a leading `---\n ... \n---\n` fence. Bytes without a
 * leading fence yield `frontmatterYaml: none` and the full text as body.
 */
export const splitFrontmatter = Effect.fn("codec.splitFrontmatter")(function* (
  bytes: Uint8Array,
): Effect.fn.Return<
  { readonly body: string; readonly frontmatterYaml: Option.Option<string> },
  Error_.ValidationFailed
> {
  const text = utf8Decode(bytes)
  const lines = text.split("\n")
  if (lines[0]?.trimEnd() !== FENCE) {
    return { body: text, frontmatterYaml: Option.none() }
  }
  let fence = 1
  while (fence < lines.length && lines[fence]?.trimEnd() !== FENCE) {
    fence++
  }
  if (fence >= lines.length) {
    return yield* new Error_.ValidationFailed({
      path: "frontmatter",
      issues: ["unterminated frontmatter fence"],
    })
  }
  return {
    body: lines.slice(fence + 1).join("\n"),
    frontmatterYaml: Option.some(lines.slice(1, fence).join("\n")),
  }
})

/**
 * YAML-decode the frontmatter region and validate it against the caller's
 * schema. Absent frontmatter decodes as the empty object, so it validates only
 * when the schema requires nothing (D7).
 */
const decodeFrontmatter = Effect.fn("codec.decodeFrontmatter")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(schema: S, yaml: Option.Option<string>): Effect.fn.Return<S["Type"], Error_.ValidationFailed> {
  const value: unknown = Option.isSome(yaml)
    ? yield* Effect.try({
        try: () => load(yaml.value),
        catch: (error) =>
          new Error_.ValidationFailed({
            path: "frontmatter",
            issues: [`invalid yaml: ${String(error)}`],
          }),
      })
    : {}
  const result = Schema.decodeUnknownResult(schema)(value)
  if (Result.isFailure(result)) {
    return yield* new Error_.ValidationFailed({
      path: "frontmatter",
      issues: [result.failure.message],
    })
  }
  return result.success
})

/** Parse stored bytes into a typed document validated against the schema. */
export const parseDocument = Effect.fn("codec.parseDocument")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(
  schema: S,
  bytes: Uint8Array,
): Effect.fn.Return<ParsedDocument<S["Type"]>, Error_.ValidationFailed> {
  const split = yield* splitFrontmatter(bytes)
  const frontmatter = yield* decodeFrontmatter(schema, split.frontmatterYaml)
  return {
    raw: bytes,
    body: split.body,
    frontmatter,
    hasFrontmatter: Option.isSome(split.frontmatterYaml),
  }
})

/**
 * Validate candidate bytes before they are accepted for storage — the gate the
 * DocumentStore applies before `put`. Same parse path as {@link parseDocument}.
 */
export const validateContent = parseDocument

/** True iff bytes parse as a valid document against the schema. Never fails. */
export const classifyContent = <S extends Schema.ConstraintDecoder<unknown>>(
  bytes: Uint8Array,
  schema: S,
): Effect.Effect<boolean, never> =>
  Effect.match(parseDocument(schema, bytes), {
    onFailure: () => false,
    onSuccess: () => true,
  })
