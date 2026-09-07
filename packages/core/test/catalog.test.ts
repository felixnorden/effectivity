import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore, type BlobStoreShape } from "../src/blob-store.ts"
import { Catalog } from "../src/catalog.ts"
import { Core, type CoreProvides } from "../src/core.ts"
import { MemoryBlobStore } from "./blob-store.memory.ts"
import { utf8 } from "./bytes.ts"

const Frontmatter = Schema.Struct({ title: Schema.String })
const CatalogConfig = { root: "docs/", frontmatter: Frontmatter }

const withCatalog = <A, E>(
  store: BlobStoreShape,
  effect: Effect.Effect<A, E, CoreProvides>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Core.layer(Layer.succeed(BlobStore, store), CatalogConfig)))

describe("catalog", () => {
  it.effect("lists documents under a logical prefix with derived metadata", () =>
    withCatalog(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\nhello world"))
        yield* BlobStore.put(store)(
          "docs/sub/b.md",
          utf8("---\ntitle: B\n---\none two\n\nthree four five"),
        )
        const catalog = yield* Catalog
        const listings = yield* catalog.listDocuments("docs/")
        const byPath = new Map(Array.from(listings).map((l) => [l.path, l]))
        expect(Array.from(byPath.keys()).sort()).toEqual(["a.md", "sub/b.md"])
        expect(byPath.get("a.md")?.metadata.slug).toBe("a")
        expect(byPath.get("a.md")?.metadata.wordCount).toBe(2)
        expect(byPath.get("sub/b.md")?.metadata.slug).toBe("b")
      }),
    ),
  )

  it.effect("groups flat keys into the logical folder hierarchy", () =>
    withCatalog(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\ntop"))
        yield* BlobStore.put(store)("docs/sub/b.md", utf8("---\ntitle: B\n---\nnested"))
        const catalog = yield* Catalog
        const listings = yield* catalog.listDocuments("docs/")
        const paths = Array.from(listings)
          .map((listing) => listing.path)
          .sort()
        expect(paths).toEqual(["a.md", "sub/b.md"])
      }),
    ),
  )

  it.effect("lists assets under a logical prefix, separated from documents", () =>
    withCatalog(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("assets/img/a.png", utf8("png-a"))
        yield* BlobStore.put(store)("assets/img/b.jpg", utf8("jpg-b"))
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\nbody"))
        const catalog = yield* Catalog
        const assets = yield* catalog.listAssets("assets/img/")
        expect(Array.from(assets).sort()).toEqual(["assets/img/a.png", "assets/img/b.jpg"])
      }),
    ),
  )

  it.effect("computes derived metadata as a pure function with no storage writes", () =>
    withCatalog(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)("docs/a.md", utf8("---\ntitle: A\n---\nbody text"))
        const catalog = yield* Catalog
        const first = yield* catalog.derivedMetadata("docs/a.md")
        const second = yield* catalog.derivedMetadata("docs/a.md")
        expect(first).toEqual(second)
        if (Option.isSome(first)) {
          expect(first.value.slug).toBe("a")
        }
        const keysAfter = yield* BlobStore.list(store)("docs/")
        expect(Array.from(keysAfter)).toEqual(["docs/a.md"])
      }),
    ),
  )

  it.effect("derives slug from filename and summary metrics from the raw body", () =>
    withCatalog(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* BlobStore
        yield* BlobStore.put(store)(
          "docs/My Post.md",
          utf8("---\ntitle: My Post\n---\none two\n\nthree four five"),
        )
        const catalog = yield* Catalog
        const metadata = yield* catalog.derivedMetadata("docs/My Post.md")
        expect(metadata).toEqual(
          Option.some({
            slug: "my-post",
            wordCount: 5,
            lineCount: 2,
            readingTimeMinutes: 1,
          }),
        )
      }),
    ),
  )
})
