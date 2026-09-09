import { Effect, HashMap, Layer, Option, Schema } from "effect"
import { expect, layer } from "@effect/vitest"
import { HttpClient } from "effect/unstable/http"
import { BlobStore, type BlobStoreShape } from "@effectivity/core"
import { MemoryBlobStore } from "./memory-blob.ts"
import { serve } from "./harness.ts"

/** Encode a UTF-8 string to bytes (ASCII-safe test bodies; oxfmt/tsgo stay happy). */
const utf8 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((char) => char.charCodeAt(0)))

/** A valid markdown source for the configured frontmatter schema. */
const doc = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}`

/** An image reference for the frontmatter-schema test documents. */
const image = (src: string): string => `![alt](${src})`

const Frontmatter = Schema.Struct({ title: Schema.String })
const CatalogConfig = { root: "cms", frontmatter: Frontmatter }

interface Entry {
  readonly body: Uint8Array
  readonly version: string
  readonly meta: { version: string; size: number; contentType: Option.Option<string> }
}

const entryFor = (body: Uint8Array, contentType: Option.Option<string>): Entry => ({
  body,
  version: "seed",
  meta: { version: "seed", size: body.length, contentType },
})

/** Seed the memory seam with keyed entries (content type preserved per entry). */
const seed = (
  docs: ReadonlyArray<readonly [string, string]>,
  assets?: ReadonlyArray<readonly [string, string, string]>,
): HashMap.HashMap<string, Entry> => {
  const docEntries = docs.map(([key, body]) => [key, entryFor(utf8(body), Option.none())] as const)
  const assetEntries = (assets ?? []).map(
    ([key, body, contentType]) => [key, entryFor(utf8(body), Option.some(contentType))] as const,
  )
  return HashMap.fromIterable([...docEntries, ...assetEntries])
}

const blobOf = (store: BlobStoreShape): Layer.Layer<BlobStore, never, never> =>
  Layer.succeed(BlobStore, store)

const doGet = (client: HttpClient.HttpClient, path: string) => client.get(path)

const PNG = "\u0089PNG\r\n\u001A\nfakedata"

layer(
  serve(
    blobOf(
      MemoryBlobStore.make(
        seed(
          [["docs/start", doc("Start", `${image("images/logo.png")} and ${image("missing.png")}`)]],
          [
            ["assets/branding/banner.png", "banner-bytes", "image/png"],
            ["assets/images/logo.png", PNG, "image/png"],
          ],
        ),
      ),
    ),
    CatalogConfig,
  ),
)("assets read surface", (it) => {
  it.effect("lists assets grouped by folder with paths and metadata", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/assets")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual([
        { path: "branding/banner.png", folder: "branding" },
        { path: "images/logo.png", folder: "images" },
      ])
    }),
  )

  it.effect("filters the asset listing by the folder query", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/assets?folder=images")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual([{ path: "images/logo.png", folder: "images" }])
    }),
  )

  it.effect("returns the stored bytes with content type when the key exists", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/assets/images/logo.png")
      expect(response.status).toBe(200)
      const body = yield* response.arrayBuffer
      expect(new Uint8Array(body)).toEqual(utf8(PNG))
      expect(response.headers["content-type"]?.startsWith("image/png")).toBe(true)
      expect(response.headers["etag"]).toBe("seed")
    }),
  )

  it.effect("yields 404 with the typed payload when the key is missing", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/assets/images/nope.png")
      expect(response.status).toBe(404)
      const body = yield* response.json
      expect(body).toEqual({ _tag: "BlobNotFound", key: "assets/images/nope.png" })
    }),
  )
})

layer(
  serve(
    blobOf(
      MemoryBlobStore.make(
        seed(
          [
            [
              "docs/start",
              doc(
                "Start",
                `${image("present.png")} ${image("dangling.png")} ${image("wrong.png")}`,
              ),
            ],
            ["docs/plain", doc("Plain", "no images here")],
          ],
          [
            ["assets/present.png", "real-bytes", "image/png"],
            ["assets/wrong.png", doc("Titled", "parses as a document"), "text/plain"],
          ],
        ),
      ),
    ),
    CatalogConfig,
  ),
)("references read surface", (it) => {
  it.effect("returns the graph read model with present, dangling, and wrong-typed references", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/references")
      expect(response.status).toBe(200)
      const body = yield* response.json
      expect(body).toEqual([
        {
          document: "start",
          references: [
            {
              src: "present.png",
              asset: "present.png",
              url: expect.stringMatching(/^https?:\/\/[^/]+\/assets\/present\.png$/),
              status: "present",
              sourceLine: 1,
            },
            {
              src: "dangling.png",
              asset: "dangling.png",
              url: expect.stringMatching(/^https?:\/\/[^/]+\/assets\/dangling\.png$/),
              status: "dangling",
              sourceLine: 1,
            },
            {
              src: "wrong.png",
              asset: "wrong.png",
              url: expect.stringMatching(/^https?:\/\/[^/]+\/assets\/wrong\.png$/),
              status: "wrong-typed",
              sourceLine: 1,
            },
          ],
        },
      ])
    }),
  )
})

layer(
  serve(
    blobOf(
      MemoryBlobStore.make(
        seed(
          [
            [
              "docs/guides/sub",
              doc(
                "Sub",
                `${image("pic.png")} and ${image("assets/logo.png")} and [Guide](guides/content-model)`,
              ),
            ],
          ],
          [["assets/logo.png", "logo", "image/png"]],
        ),
      ),
    ),
    CatalogConfig,
  ),
)("document model view", (it) => {
  it.effect("resolves embedded image srcs to absolute asset urls", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/guides/sub?view=model")
      expect(response.status).toBe(200)
      const body = (yield* response.json) as {
        body: string
        references: Array<{ src: string; asset: string; url: string; status: string }>
      }
      expect(body.body).toContain("![alt](pic.png)")
      expect(body.references).toEqual([
        {
          src: "pic.png",
          asset: "guides/pic.png",
          url: expect.stringMatching(/^https?:\/\/[^/]+\/assets\/guides\/pic\.png$/),
          status: "dangling",
        },
        {
          src: "assets/logo.png",
          asset: "logo.png",
          url: expect.stringMatching(/^https?:\/\/[^/]+\/assets\/logo\.png$/),
          status: "present",
        },
      ])
    }),
  )

  it.effect("rewrites image srcs and doc-to-doc links to absolute urls with resolve=urls", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* doGet(client, "/documents/guides/sub?resolve=urls")
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]?.startsWith("text/markdown")).toBe(true)
      const text = yield* response.text
      expect(text).toMatch(/!\[alt\]\(https?:\/\/[^/]+\/assets\/guides\/pic\.png\)/)
      expect(text).toMatch(/!\[alt\]\(https?:\/\/[^/]+\/assets\/logo\.png\)/)
      expect(text).toMatch(/\[Guide\]\(https?:\/\/[^/]+\/documents\/guides\/content-model\)/)
      expect(text).not.toContain("(pic.png)")
      expect(text).not.toContain("(assets/logo.png)")
      expect(text).not.toContain("(guides/content-model)")
      expect(text).toContain("title: Sub")
      expect(response.headers["etag"]).toBe("seed")
    }),
  )
})
