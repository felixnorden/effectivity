import { Effect, HashSet, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore, type BlobStoreShape } from "../src/blob-store.ts"
import {
  ReferenceGraph,
  resolveLinkTarget,
  rewriteDocLinks,
  rewriteImageRefs,
} from "../src/reference-graph.ts"
import { Core, type CoreProvides } from "../src/core.ts"
import { MemoryBlobStore } from "./blob-store.memory.ts"
import { utf8 } from "./bytes.ts"

const Frontmatter = Schema.Struct({ title: Schema.String })
const CatalogConfig = { root: "docs/", frontmatter: Frontmatter }

const withGraph = <A, E>(
  store: BlobStoreShape,
  effect: Effect.Effect<A, E, CoreProvides>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Core.layer(Layer.succeed(BlobStore, store), CatalogConfig)))

describe("reference graph", () => {
  it("resolveLinkTarget resolves catalog paths, folder-relative, region, and asset targets", () => {
    const doc = (target: string) => resolveLinkTarget("docs/guides/authoring", target)
    expect(doc("guides/content-model")).toEqual(
      Option.some({ kind: "doc", path: "guides/content-model" }),
    )
    expect(doc("./content-model")).toEqual(
      Option.some({ kind: "doc", path: "guides/content-model" }),
    )
    expect(doc("../start")).toEqual(Option.some({ kind: "doc", path: "start" }))
    expect(doc("docs/start")).toEqual(Option.some({ kind: "doc", path: "start" }))
    expect(doc("/guides/content-model")).toEqual(
      Option.some({ kind: "doc", path: "guides/content-model" }),
    )
    expect(doc("guides/content-model#intro")).toEqual(
      Option.some({ kind: "doc", path: "guides/content-model", fragment: "intro" }),
    )
    expect(doc("assets/logo.txt")).toEqual(Option.some({ kind: "asset", id: "logo.txt" }))
    expect(doc("https://example.com/x")).toEqual(Option.none())
    expect(doc("mailto:a@b.dev")).toEqual(Option.none())
    expect(doc("#local-anchor")).toEqual(Option.none())
    expect(doc("../../escape")).toEqual(Option.none())
  })

  it("rewriteDocLinks rewrites links but never image markup, externals, or prose", () => {
    const body =
      "![img](assets/a.png)\n\n[Guide](guides/content-model)\n\n[Site](https://example.com) and [More](./sub)\n\nprose mentions guides/content-model stay\n"
    const out = rewriteDocLinks(body, (target) =>
      target === "guides/content-model"
        ? "http://o/documents/guides/content-model"
        : target === "./sub"
          ? "http://o/documents/guides/sub"
          : target === "assets/a.png"
            ? "http://o/assets/a.png"
            : target,
    )
    expect(out).toBe(
      "![img](assets/a.png)\n\n[Guide](http://o/documents/guides/content-model)\n\n[Site](https://example.com) and [More](http://o/documents/guides/sub)\n\nprose mentions guides/content-model stay\n",
    )
  })

  it("rewriteImageRefs rewrites only image srcs, preserving alt, titles, and prose", () => {
    const body = `Before\n\n![logo](assets/a.png "wide")\n\n![x](pic.png)\n\nsee assets/a.png in prose\n`
    const out = rewriteImageRefs(body, (src) =>
      src === "assets/a.png"
        ? "https://cdn.example/assets/a.png"
        : src === "pic.png"
          ? "https://cdn.example/guides/pic.png"
          : src,
    )
    expect(out).toBe(
      `Before\n\n![logo](https://cdn.example/assets/a.png "wide")\n\n![x](https://cdn.example/guides/pic.png)\n\nsee assets/a.png in prose\n`,
    )
  })
  it.effect("classifies every image reference as present, dangling, or wrong-typed", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/a.png", utf8("fake png bytes - not a document"))
        yield* BlobStore.put(store)("assets/b.txt", utf8("---\ntitle: B\n---\nhello"))
        yield* BlobStore.put(store)(
          "docs/post.md",
          utf8(
            "---\ntitle: Post\n---\n![pic](assets/a.png)\n![miss](assets/missing.png)\n![text](assets/b.txt)",
          ),
        )
        const graph = yield* ReferenceGraph
        const refs = yield* graph.documentReferences("docs/post.md")
        expect(Array.from(refs)).toEqual([
          { src: "assets/a.png", assetKey: "assets/a.png", status: "present", sourceLine: 1 },
          {
            src: "assets/missing.png",
            assetKey: "assets/missing.png",
            status: "dangling",
            sourceLine: 2,
          },
          { src: "assets/b.txt", assetKey: "assets/b.txt", status: "wrong-typed", sourceLine: 3 },
        ])
      }),
    ),
  )

  it.effect("finds referencers of an asset across the tree", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/a.png", utf8("png"))
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\n![x](assets/a.png)"))
        yield* BlobStore.put(store)("docs/b.md", utf8("---\ntitle: B\n---\n![y](assets/a.png)"))
        const graph = yield* ReferenceGraph
        const referencers = yield* graph.referencersOf("assets/a.png")
        expect(HashSet.size(referencers)).toBe(2)
        expect(HashSet.has(referencers, "docs/a.md")).toBe(true)
        expect(HashSet.has(referencers, "docs/b.md")).toBe(true)
      }),
    ),
  )

  it.effect("verdict: move is refused when it would break a reference at the destination", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/from/a.png", utf8("png"))
        yield* BlobStore.put(store)("docs/from/a.md", utf8("---\ntitle: A\n---\n![img](a.png)"))
        const graph = yield* ReferenceGraph
        const verdict = yield* graph.wouldMoveBreakReferences("docs/from/a.md", "docs/to/a.md")
        expect(verdict.status).toBe("refused")
        if (verdict.status === "refused") {
          expect(Array.from(verdict.broken)).toEqual([
            { src: "a.png", assetKey: "assets/to/a.png", status: "dangling", sourceLine: 1 },
          ])
        }
      }),
    ),
  )

  it.effect("verdict: move is allowed when references still resolve from the destination", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/a.png", utf8("png"))
        yield* BlobStore.put(store)(
          "docs/from/a.md",
          utf8("---\ntitle: A\n---\n![img](assets/a.png)"),
        )
        const graph = yield* ReferenceGraph
        const verdict = yield* graph.wouldMoveBreakReferences("docs/from/a.md", "docs/to/a.md")
        expect(verdict.status).toBe("allowed")
      }),
    ),
  )

  it.effect("verdict: asset delete is refused while still referenced", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/a.png", utf8("png"))
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\n![x](assets/a.png)"))
        const graph = yield* ReferenceGraph
        const verdict = yield* graph.wouldAssetDeleteBeReferenced("assets/a.png")
        expect(verdict.status).toBe("refused")
        if (verdict.status === "refused") {
          expect(Array.from(verdict.referencers)).toEqual(["docs/a.md"])
        }
      }),
    ),
  )

  it.effect("verdict: asset delete is allowed when unreferenced", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/orphan.png", utf8("png"))
        const graph = yield* ReferenceGraph
        const verdict = yield* graph.wouldAssetDeleteBeReferenced("assets/orphan.png")
        expect(verdict.status).toBe("allowed")
      }),
    ),
  )

  it.effect("verdict: document delete is refused when it is the sole referencer of an asset", () =>
    withGraph(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/a.png", utf8("png"))
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\n![x](assets/a.png)"))
        const graph = yield* ReferenceGraph
        const verdict = yield* graph.wouldDocumentDeleteOrphanAssets("docs/a.md")
        expect(verdict.status).toBe("refused")
        if (verdict.status === "refused") {
          expect(Array.from(verdict.orphanedAssets)).toEqual(["assets/a.png"])
        }
      }),
    ),
  )
})
