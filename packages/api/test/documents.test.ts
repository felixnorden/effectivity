import { Effect, HashMap, Layer, Option, Schema } from "effect"
import { expect, layer } from "@effect/vitest"
import { HttpClient } from "effect/unstable/http"
import { BlobStore, type BlobStoreShape } from "@effectivity/core"
import { MemoryBlobStore } from "./memory-blob.ts"
import { serve } from "./harness.ts"

/** Encode a string to UTF-8 bytes without depending on ambient globals. */
const utf8 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((char) => char.charCodeAt(0)))

/** A valid markdown source for the configured frontmatter schema. */
const doc = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}`

const Frontmatter = Schema.Struct({ title: Schema.String })
const CatalogConfig = { root: "cms", frontmatter: Frontmatter }

interface Entry {
  readonly body: Uint8Array
  readonly version: string
  readonly meta: { version: string; size: number; contentType: Option.Option<string> }
}

/** Seed the memory seam with documents keyed by storage key. */
const seed = (docs: ReadonlyArray<readonly [string, string]>): HashMap.HashMap<string, Entry> =>
  HashMap.fromIterable(
    docs.map(([key, body]) => {
      const bytes = utf8(body)
      return [
        key,
        {
          body: bytes,
          version: "seed",
          meta: { version: "seed", size: bytes.length, contentType: Option.none() },
        },
      ] as const
    }),
  )

const storeWith = (docs: ReadonlyArray<readonly [string, string]>): BlobStoreShape =>
  MemoryBlobStore.make(seed(docs))
const blobOf = (store: BlobStoreShape): Layer.Layer<BlobStore, never, never> =>
  Layer.succeed(BlobStore, store)

const doGet = (client: HttpClient.HttpClient, path: string) => client.get(path)

layer(
  serve(
    blobOf(
      storeWith([
        ["docs/start", doc("Start", "# Start")],
        ["docs/guides/start", doc("Guide", "# Guide")],
      ]),
    ),
    CatalogConfig,
  ),
)("documents read surface", (it) => {
  it.effect("lists catalog entries with path, title, and folder metadata", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual([
        { path: "guides/start", title: "Guide", folder: "guides" },
        { path: "start", title: "Start", folder: "" },
      ])
    }),
  )

  it.effect("filters the listing by the folder query", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents?folder=guides")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual([{ path: "guides/start", title: "Guide", folder: "guides" }])
    }),
  )

  it.effect("returns the original markdown with metadata headers when the key exists", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/guides/start")
      expect(response.status).toBe(200)
      const text = yield* response.text
      expect(text).toBe(`---\ntitle: Guide\n---\n# Guide`)
      expect(response.headers["content-type"]?.startsWith("text/markdown")).toBe(true)
      expect(response.headers["etag"]).toBe("seed")
    }),
  )

  it.effect("returns the parsed model when view=model selects it", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/guides/start?view=model")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual({
        frontmatter: { title: "Guide" },
        body: "# Guide",
        hasFrontmatter: true,
        references: [],
      })
    }),
  )

  it.effect("returns an unchanged body when resolve=urls finds no image references", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/guides/start?resolve=urls")
      expect(response.status).toBe(200)
      expect(yield* response.text).toBe(doc("Guide", "# Guide"))
    }),
  )
})

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig))("documents read edge cases", (it) => {
  it.effect("yields 404 with the missing-document payload for an absent key", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/nope")
      expect(response.status).toBe(404)
      const body = yield* response.json
      expect(body).toEqual({ _tag: "BlobNotFound", key: "docs/nope" })
    }),
  )

  it.effect("serves the openapi document at /openapi.json", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/openapi.json")
      expect(response.status).toBe(200)
      const body = yield* response.json
      const paths = (body as { paths?: Record<string, unknown> }).paths
      expect(paths).toBeDefined()
      expect(paths?.["/documents/*"]).toBeDefined()
      expect(paths?.["/openapi.json"]).toBeUndefined()
    }),
  )
})
