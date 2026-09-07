import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore } from "../src/blob-store.ts"
import { Catalog } from "../src/catalog.ts"
import { parseDocument } from "../src/codec.ts"
import { Core } from "../src/core.ts"
import { DocumentStore } from "../src/document-store.ts"
import { ChangeEvents, type ChangeEvent } from "../src/events.ts"
import { ReferenceGraph } from "../src/reference-graph.ts"
import { MemoryBlobStore } from "./blob-store.memory.ts"
import { utf8 } from "./bytes.ts"

const Post = Schema.Struct({
  kind: Schema.Literals(["post"] as const),
  title: Schema.String,
  tags: Schema.Array(Schema.String),
})
type Post = typeof Post.Type

const Page = Schema.Struct({ kind: Schema.Literals(["page"] as const), navTitle: Schema.String })
type Page = typeof Page.Type

const Root = Schema.Union([Page, Post])

type Root = typeof Root.Type

const postConfig = { root: "docs/", frontmatter: Post }

/** Wire exactly like a production caller: blob layer + config, nothing else. */
const wire = (config: { root: string; frontmatter: Schema.ConstraintDecoder<unknown> }) =>
  Core.layer(Layer.succeed(BlobStore, MemoryBlobStore.make()), config)

describe("core wiring", () => {
  it.effect("one root, one caller schema: writes validated, typed reads via parseDocument", () =>
    Effect.gen(function* () {
      const store = yield* DocumentStore
      const version = yield* store.create(
        "docs/a.md",
        utf8("---\nkind: post\ntitle: T\ntags: [x]\n---\nbody"),
      )
      expect(typeof version).toBe("string")
      const stored = yield* store.read("docs/a.md") // storage read: bytes + version
      expect(stored._tag).toBe("Some")
      // the schema value is the type witness: no casts, no second config
      if (stored._tag === "Some") {
        const doc = yield* parseDocument(Post, stored.value.bytes)
        expect(doc.frontmatter.title).toBe("T")
        expect(doc.frontmatter.tags).toEqual(["x"])
        expect(doc.body).toBe("body")
      }
    }).pipe(Effect.provide(wire(postConfig))),
  )

  it.effect("a union frontmatter schema serves several document types in one root (D7)", () =>
    Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.create("docs/p.md", utf8("---\nkind: page\nnavTitle: P\n---\npp"))
      yield* store.create("docs/q.md", utf8("---\nkind: post\ntitle: Q\ntags: []\n---\nqq"))
      const stored = yield* store.read("docs/p.md")
      if (stored._tag === "Some") {
        // narrowing by the discriminant is caller-side, typed by the one schema
        const doc = yield* parseDocument(Root, stored.value.bytes)
        const title: string =
          doc.frontmatter.kind === "page" ? doc.frontmatter.navTitle : doc.frontmatter.title
        expect(title).toBe("P")
      }
    }).pipe(
      Effect.provide(
        Core.layer(Layer.succeed(BlobStore, MemoryBlobStore.make()), {
          root: "docs/",
          frontmatter: Root,
        }),
      ),
    ),
  )

  it.effect("read models and events are reachable through the same wired context", () =>
    Effect.gen(function* () {
      const store = yield* DocumentStore
      void store
      const catalog = yield* Catalog
      const refs = yield* ReferenceGraph
      const events = yield* ChangeEvents
      expect(typeof catalog.listDocuments).toBe("function")
      expect(typeof refs.documentReferences).toBe("function")
      const probe: ChangeEvent = {
        kind: "document",
        operation: "create",
        keys: ["k"],
        version: "v",
      }
      yield* events.publish(probe)
    }).pipe(Effect.provide(wire(postConfig))),
  )
})
