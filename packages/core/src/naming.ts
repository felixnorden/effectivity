import { Context, Effect, Layer, Option } from "effect"
import * as Error_ from "./error.ts"

/**
 * Pure, bijective mapping between logical folder-tree document/asset names and
 * the flat storage key space.
 *
 * Two reserved top-level regions keep document and asset keys disjoint by
 * construction:
 *   - documents live under `docs/`
 *   - assets live under `assets/`
 *
 * Within a region, each "/"-separated segment is escaped by doubling the escape
 * character `~`, so any segment (including ones with a leading dot or
 * underscore) round-trips exactly. A lone `~` in a key is malformed and yields
 * `None`/`InvalidArgument` on decode. `classifyKey` decides a key's region from
 * its prefix and rejects anything outside both regions.
 */
export const DOC_REGION = "docs/"
export const ASSET_REGION = "assets/"
export const ESCAPE = "~"

/** Escape a single segment: `~` -> `~~` (injective, so decode is unambiguous). */
const escapeSegment = (segment: string): string => segment.replace(/~/g, "~~")

/** Inverse of {@link escapeSegment}; returns null when a lone `~` is present. */
const unescapeSegment = (segment: string): string | null => {
  let out = ""
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === "~") {
      if (segment[i + 1] !== "~") {
        return null
      }
      out += "~"
      i++
    } else {
      out += char
    }
  }
  return out
}

/** Validate a normalized relative path and return its segments. */
const toEncodedRelative = Effect.fn("naming.toEncodedRelative")(function* (
  rel: string,
  report: string,
): Effect.fn.Return<string, Error_.InvalidArgument> {
  if (rel === "") {
    return yield* new Error_.InvalidArgument({ value: report, reason: "empty path" })
  }
  if (rel.startsWith("/") || rel.endsWith("/")) {
    return yield* new Error_.InvalidArgument({ value: report, reason: "path is not normalized" })
  }
  const segments = rel.split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return yield* new Error_.InvalidArgument({
        value: report,
        reason: `invalid segment: ${JSON.stringify(segment)}`,
      })
    }
  }
  return segments.map(escapeSegment).join("/")
})

/** Encode a logical document path (region-qualified, e.g. `docs/guides/a.md`). */
export const encodeDocumentPath = Effect.fn("naming.encodeDocumentPath")(function* (
  path: string,
): Effect.fn.Return<string, Error_.InvalidArgument> {
  const rel = path.startsWith(DOC_REGION) ? path.slice(DOC_REGION.length) : path
  const encoded = yield* toEncodedRelative(rel, path)
  return DOC_REGION + encoded
})

/** Decode a document key back to its logical path; none when not a document key. */
export const decodeDocumentKey = Effect.fn("naming.decodeDocumentKey")(function* (
  key: string,
): Effect.fn.Return<Option.Option<string>, Error_.InvalidArgument> {
  if (!key.startsWith(DOC_REGION)) {
    return Option.none()
  }
  return yield* Effect.sync(() =>
    Option.map(decodeRelative(key.slice(DOC_REGION.length)), (rel) => DOC_REGION + rel),
  )
})

/** Encode an asset identifier to its key under the asset region. */
export const encodeAssetKey = Effect.fn("naming.encodeAssetKey")(function* (
  id: string,
): Effect.fn.Return<string, Error_.InvalidArgument> {
  const encoded = yield* toEncodedRelative(id, id)
  return ASSET_REGION + encoded
})

/** Decode an asset key back to its bare identifier; none when not an asset key. */
export const decodeAssetKey = Effect.fn("naming.decodeAssetKey")(function* (
  key: string,
): Effect.fn.Return<Option.Option<string>, Error_.InvalidArgument> {
  if (!key.startsWith(ASSET_REGION)) {
    return Option.none()
  }
  return yield* Effect.sync(() => decodeRelative(key.slice(ASSET_REGION.length)))
})

/** Decode the region-relative part of a key; none when malformed or empty. */
const decodeRelative = (rel: string): Option.Option<string> => {
  if (rel === "") {
    return Option.none()
  }
  const decoded: Array<string> = []
  for (const segment of rel.split("/")) {
    const value = unescapeSegment(segment)
    if (value === null) {
      return Option.none()
    }
    decoded.push(value)
  }
  return Option.some(decoded.join("/"))
}

/** Classify a key as a document, asset, or neither, from its reserved prefix. */
export const classifyKey = (key: string): Option.Option<"document" | "asset"> =>
  key.startsWith(DOC_REGION)
    ? Option.some("document")
    : key.startsWith(ASSET_REGION)
      ? Option.some("asset")
      : Option.none()

export interface NamingShape {
  encodeDocumentPath(path: string): Effect.Effect<string, Error_.InvalidArgument>
  decodeDocumentKey(key: string): Effect.Effect<Option.Option<string>, Error_.InvalidArgument>
  encodeAssetKey(id: string): Effect.Effect<string, Error_.InvalidArgument>
  decodeAssetKey(key: string): Effect.Effect<Option.Option<string>, Error_.InvalidArgument>
  classifyKey(key: string): Option.Option<"document" | "asset">
}

export class Naming extends Context.Service<Naming, NamingShape>()("effectivity/naming/Naming") {
  static readonly layer = Layer.succeed(
    Naming,
    Naming.of({
      encodeDocumentPath,
      decodeDocumentKey,
      encodeAssetKey,
      decodeAssetKey,
      classifyKey,
    }),
  )
}
