import { Effect, HashSet, Layer, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore, type BlobStoreShape } from "../src/blob-store.ts"
import { ReferenceGraph } from "../src/reference-graph.ts"
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
          { assetKey: "assets/a.png", status: "present", sourceLine: 1 },
          { assetKey: "assets/missing.png", status: "dangling", sourceLine: 2 },
          { assetKey: "assets/b.txt", status: "wrong-typed", sourceLine: 3 },
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
            { assetKey: "assets/to/a.png", status: "dangling", sourceLine: 1 },
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
