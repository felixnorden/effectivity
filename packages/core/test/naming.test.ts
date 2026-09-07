import { Effect, Option } from "effect"
import { FastCheck } from "effect/testing"
import { describe, expect, it } from "@effect/vitest"
import {
  ASSET_REGION,
  DOC_REGION,
  classifyKey,
  decodeAssetKey,
  decodeDocumentKey,
  encodeAssetKey,
  encodeDocumentPath,
} from "../src/naming.ts"
import * as Error_ from "../src/error.ts"

describe("naming", () => {
  it("round-trips a logical document path to its key and back", () => {
    const paths = ["docs/guides/intro.md", "docs/home.md", "docs/.hidden", "docs/My Folder/a~b.md"]
    for (const path of paths) {
      const key = Effect.runSync(encodeDocumentPath(path))
      expect(key.startsWith(DOC_REGION)).toBe(true)
      expect(Effect.runSync(decodeDocumentKey(key))).toEqual(Option.some(path))
    }
  })

  it("never produces a document key that collides with an asset key", () => {
    const docKey = Effect.runSync(encodeDocumentPath("docs/logo"))
    const assetKey = Effect.runSync(encodeAssetKey("logo.png"))
    expect(docKey).not.toBe(assetKey)
    expect(docKey.startsWith(DOC_REGION)).toBe(true)
    expect(assetKey.startsWith(ASSET_REGION)).toBe(true)
    expect(classifyKey(docKey)).toEqual(Option.some("document"))
    expect(classifyKey(assetKey)).toEqual(Option.some("asset"))
  })

  it("classifies a key as document, asset, or unknown", () => {
    const docKey = Effect.runSync(encodeDocumentPath("docs/a.md"))
    const assetKey = Effect.runSync(encodeAssetKey("img/x.png"))
    expect(classifyKey(docKey)).toEqual(Option.some("document"))
    expect(classifyKey(assetKey)).toEqual(Option.some("asset"))
    expect(classifyKey("other/x")).toEqual(Option.none())
  })

  it("rejects a malformed logical name with invalidArgument", () => {
    const bad = ["", "docs/a/", "docs//a", "docs/../a", "docs/."]
    for (const value of bad) {
      const failure = Effect.runSync(Effect.flip(encodeDocumentPath(value)))
      expect(failure).toBeInstanceOf(Error_.InvalidArgument)
      expect(failure.value).toBe(value)
    }
  })

  it("maps an asset identifier to its key under the asset region", () => {
    const id = "img/hero.png"
    const key = Effect.runSync(encodeAssetKey(id))
    expect(key.startsWith(ASSET_REGION)).toBe(true)
    expect(Effect.runSync(decodeAssetKey(key))).toEqual(Option.some(id))
  })

  it.prop(
    "round-trips any single-segment document name",
    {
      name: FastCheck.array(
        FastCheck.constantFrom("a", "b", "c", "d", "0", "1", "~", ".", "_", "-"),
        { minLength: 1 },
      )
        .map((chars) => chars.join(""))
        .filter((s) => s !== "." && s !== ".."),
    },
    ({ name }) => {
      const key = Effect.runSync(encodeDocumentPath(`docs/${name}`))
      expect(Effect.runSync(decodeDocumentKey(key))).toEqual(Option.some(`docs/${name}`))
    },
  )
})
