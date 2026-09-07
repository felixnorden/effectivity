import { Effect, Fiber, HashMap, Layer, Option, Schema, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { BlobStore, type BlobStoreShape } from "../src/blob-store.ts"
import { Catalog } from "../src/catalog.ts"
import { parseDocument } from "../src/codec.ts"
import { Core, type CoreProvides } from "../src/core.ts"
import { DocumentStore } from "../src/document-store.ts"
import { ChangeEvents, type ChangeEvent } from "../src/events.ts"
import { ReferenceGraph } from "../src/reference-graph.ts"
import { MemoryBlobStore } from "./blob-store.memory.ts"
import { utf8 } from "./bytes.ts"

const Frontmatter = Schema.Struct({ title: Schema.String })

const CatalogConfig = { root: "docs/", frontmatter: Frontmatter }

/** Drive every facade test through the single public composition entry. */
const withStore = <A, E>(
  store: BlobStoreShape,
  effect: Effect.Effect<A, E, CoreProvides>,
): Effect.Effect<A, E, never> =>
  effect.pipe(Effect.provide(Core.layer(Layer.succeed(BlobStore, store), CatalogConfig)))

const failureTag = <A, E extends { _tag?: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<string | undefined, never, R> =>
  Effect.match(effect, {
    onFailure: (error) => error._tag,
    onSuccess: () => undefined,
  })

const docBytes = (title: string, body: string): Uint8Array =>
  utf8(`---\ntitle: ${title}\n---\n${body}`)

const isSome = (option: Option.Option<unknown>): boolean => Option.isSome(option)

describe("document store", () => {
  it.effect(
    "create stores caller-authored bytes and returns the version; read returns them byte-identically",
    () =>
      withStore(
        MemoryBlobStore.make(),
        Effect.gen(function* () {
          const store = yield* DocumentStore
          const bytes = docBytes("T", "# B")
          const version = yield* store.create("docs/a.md", bytes)
          expect(typeof version).toBe("string")
          const read = yield* store.read("docs/a.md")
          expect(isSome(read)).toBe(true)
          if (Option.isSome(read)) {
            expect(Array.from(read.value.bytes)).toEqual(Array.from(bytes))
            expect(read.value.version).toBe(version)
            // typed decoding is a caller-side codec call, generic on the schema
            const doc = yield* parseDocument(Frontmatter, read.value.bytes)
            expect(doc.body).toBe("# B")
            expect(doc.frontmatter.title).toBe("T")
          }
        }),
      ),
  )

  it.effect("create fails with validationFailed for invalid frontmatter and stores nothing", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* DocumentStore
        const tag = yield* failureTag(
          store.create("docs/bad.md", utf8("---\ntags: [x]\n---\nno title")),
        )
        expect(tag).toBe("ValidationFailed")
        const blob = yield* BlobStore
        expect(yield* BlobStore.head(blob)("docs/bad.md")).toEqual(Option.none())
      }),
    ),
  )

  it.effect("create fails with preconditionFailed when the document already exists", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const store = yield* DocumentStore
        yield* store.create("docs/a.md", docBytes("A", "first"))
        const tag = yield* failureTag(store.create("docs/a.md", docBytes("A", "second")))
        expect(tag).toBe("PreconditionFailed")
      }),
    ),
  )

  it.effect(
    "update is a guarded conditional replace and fails with preconditionFailed on a stale version",
    () =>
      withStore(
        MemoryBlobStore.make(),
        Effect.gen(function* () {
          const store = yield* DocumentStore
          const version = yield* store.create("docs/a.md", docBytes("A", "first"))
          const tag = yield* failureTag(
            store.update("docs/a.md", docBytes("A", "second"), { ifCurrent: `${version}-stale` }),
          )
          expect(tag).toBe("PreconditionFailed")
          const read = yield* store.read("docs/a.md")
          if (Option.isSome(read)) {
            const doc = yield* parseDocument(Frontmatter, read.value.bytes)
            expect(doc.body).toBe("first")
          }
        }),
      ),
  )

  it.effect(
    "byte-identical update is a no-op that does not replace the object or bump the version",
    () =>
      withStore(
        MemoryBlobStore.make(),
        Effect.gen(function* () {
          const store = yield* DocumentStore
          const bytes = docBytes("A", "same")
          const version = yield* store.create("docs/a.md", bytes)
          const versionAfter = yield* store.update("docs/a.md", bytes, { ifCurrent: version })
          expect(versionAfter).toBe(version)
        }),
      ),
  )

  it.effect("move refuses when integrity would break, and succeeds with override", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const blob = yield* BlobStore
        yield* BlobStore.put(blob)("assets/from/a.png", utf8("png"))
        const store = yield* DocumentStore
        yield* store.create("docs/from/a.md", docBytes("A", "![img](a.png)"))
        const tag = yield* failureTag(store.move("docs/from/a.md", "docs/to/a.md"))
        expect(tag).toBe("IntegrityViolation")
        expect(yield* BlobStore.head(blob)("docs/to/a.md")).toEqual(Option.none())
        yield* store.move("docs/from/a.md", "docs/to/a.md", { override: true })
        expect(isSome(yield* BlobStore.head(blob)("docs/to/a.md"))).toBe(true)
        expect(yield* BlobStore.head(blob)("docs/from/a.md")).toEqual(Option.none())
      }),
    ),
  )

  it.effect(
    "deleteDocument refuses when it would orphan a sole-referenced asset, and succeeds with override",
    () =>
      withStore(
        MemoryBlobStore.make(),
        Effect.gen(function* () {
          const blob = yield* BlobStore
          yield* BlobStore.put(blob)("assets/a.png", utf8("png"))
          const store = yield* DocumentStore
          yield* store.create("docs/a.md", docBytes("A", "![x](assets/a.png)"))
          const tag = yield* failureTag(store.deleteDocument("docs/a.md"))
          expect(tag).toBe("IntegrityViolation")
          expect(isSome(yield* BlobStore.head(blob)("assets/a.png"))).toBe(true)
          yield* store.deleteDocument("docs/a.md", { override: true })
          expect(yield* BlobStore.head(blob)("docs/a.md")).toEqual(Option.none())
          expect(isSome(yield* BlobStore.head(blob)("assets/a.png"))).toBe(true)
        }),
      ),
  )

  it.effect("asset delete refuses while still referenced, and succeeds when unreferenced", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const blob = yield* BlobStore
        yield* BlobStore.put(blob)("assets/a.png", utf8("png"))
        const store = yield* DocumentStore
        yield* store.create("docs/a.md", docBytes("A", "![x](assets/a.png)"))
        const tag = yield* failureTag(store.deleteAsset("a.png"))
        expect(tag).toBe("IntegrityViolation")
        yield* store.deleteDocument("docs/a.md", { override: true })
        yield* store.deleteAsset("a.png")
        expect(yield* BlobStore.head(blob)("assets/a.png")).toEqual(Option.none())
      }),
    ),
  )

  it.effect("emits one change event per successful mutation after all key-level steps commit", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* DocumentStore
          const events = yield* ChangeEvents
          const stream = yield* events.subscribe
          const collected = yield* Effect.forkScoped(
            stream.pipe(Stream.take(1), Stream.runCollect),
            {
              startImmediately: true,
            },
          )
          const version = yield* store.create("docs/a.md", docBytes("A", "body"))
          const received = yield* Fiber.join(collected)
          expect(received).toEqual([
            { kind: "document", operation: "create", keys: ["docs/a.md"], version },
          ])
        }),
      ),
    ),
  )

  it.effect("emits no event for a refused mutation or a read", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.scoped(
        Effect.gen(function* () {
          const blob = yield* BlobStore
          yield* BlobStore.put(blob)("assets/from/a.png", utf8("png"))
          const store = yield* DocumentStore
          yield* store.create("docs/from/a.md", docBytes("A", "![img](a.png)"))
          const events = yield* ChangeEvents
          const stream = yield* events.subscribe
          const collected = yield* Effect.forkScoped(
            stream.pipe(Stream.take(1), Stream.runCollect),
            {
              startImmediately: true,
            },
          )
          yield* failureTag(store.move("docs/from/a.md", "docs/to/a.md"))
          yield* store.read("docs/from/a.md")
          const probe: ChangeEvent = {
            kind: "document",
            operation: "update",
            keys: ["docs/probe.md"],
            version: "p9",
          }
          yield* events.publish(probe)
          const received = yield* Fiber.join(collected)
          expect(received).toEqual([probe])
        }),
      ),
    ),
  )

  it.effect("catalog and reference queries are delegated to the read models", () =>
    withStore(
      MemoryBlobStore.make(),
      Effect.gen(function* () {
        const blob = yield* BlobStore
        yield* BlobStore.put(blob)("assets/a.png", utf8("png"))
        const store = yield* DocumentStore
        yield* store.create("docs/a.md", docBytes("A", "![x](assets/a.png)"))
        const viaFacade = yield* store.listDocuments("docs/")
        const catalog = yield* Catalog
        const direct = yield* catalog.listDocuments("docs/")
        expect(Array.from(viaFacade)).toEqual(Array.from(direct))
        const refsViaFacade = yield* store.documentReferences("docs/a.md")
        const refs = yield* ReferenceGraph
        const refsDirect = yield* refs.documentReferences("docs/a.md")
        expect(Array.from(refsViaFacade)).toEqual(Array.from(refsDirect))
      }),
    ),
  )

  it.effect(
    "multi-key ops are best-effort: destination-before-source, deterministic partial state",
    () =>
      withStore(
        MemoryBlobStore.make(HashMap.empty(), {
          failDelOn: ["docs/from/a.md"],
        }),
        Effect.gen(function* () {
          const blob = yield* BlobStore
          const store = yield* DocumentStore
          yield* store.create("docs/from/a.md", docBytes("A", "body"))
          const tag = yield* failureTag(
            store.move("docs/from/a.md", "docs/to/a.md", { override: true }),
          )
          expect(tag).toBe("PreconditionFailed")
          // destination written, source retained (no rollback), ordering deterministic
          expect(isSome(yield* BlobStore.head(blob)("docs/to/a.md"))).toBe(true)
          expect(isSome(yield* BlobStore.head(blob)("docs/from/a.md"))).toBe(true)
        }),
      ),
  )
})
