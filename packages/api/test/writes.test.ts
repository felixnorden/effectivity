import { Effect, HashMap, Layer, Option, Schema } from "effect"
import { expect, layer } from "@effect/vitest"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { BlobStore, type BlobStoreShape } from "@effectivity/core"
import { alwaysAuthenticated } from "./doubles/auth.ts"
import { serve } from "./harness.ts"
import { MemoryBlobStore } from "./memory-blob.ts"

/** Encode a UTF-8 string to bytes (ASCII-safe test bodies). */
const utf8 = (text: string): Uint8Array =>
  Uint8Array.from([...text].map((char) => char.codePointAt(0) ?? 0))

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

/** Dispatch a markdown PUT with optional If-Match, returning the response. */
const putDoc = (client: HttpClient.HttpClient, path: string, body: string, ifMatch?: string) => {
  let request = HttpClientRequest.put(path).pipe(HttpClientRequest.bodyText(body, "text/markdown"))
  if (ifMatch !== undefined) {
    request = HttpClientRequest.setHeader(request, "if-match", ifMatch)
  }
  return client.execute(request)
}

/** Dispatch an asset PUT with opaque bytes and optional If-Match. */
const putAsset = (
  client: HttpClient.HttpClient,
  path: string,
  bytes: Uint8Array,
  ifMatch?: string,
) => {
  let request = HttpClientRequest.put(path).pipe(
    HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
  )
  if (ifMatch !== undefined) {
    request = HttpClientRequest.setHeader(request, "if-match", ifMatch)
  }
  return client.execute(request)
}

/** Dispatch a DELETE and return the response. */
const del = (client: HttpClient.HttpClient, path: string) =>
  client.execute(HttpClientRequest.delete(path))

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig, alwaysAuthenticated("user")))(
  "document writes",
  (it) => {
    it.effect("stores the body on creation and returns the version", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* putDoc(client, "/documents/guides/start", doc("Guide", "# Guide"))
        expect(response.status).toBe(201)
        const body = yield* response.json
        expect(body).toEqual({ version: "1" })

        const back = yield* client.get("/documents/guides/start")
        expect(back.status).toBe(200)
        const text = yield* back.text
        expect(text).toBe(doc("Guide", "# Guide"))
        expect(back.headers["etag"]).toBe("1")
      }),
    )

    it.effect("rejects invalid frontmatter with 422", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* putDoc(
          client,
          "/documents/guides/start",
          `---\ntitle: 123\n---\n# nope`,
        )
        expect(response.status).toBe(422)
        const body = yield* response.json
        expect((body as { _tag: string })._tag).toBe("ValidationFailed")
      }),
    )

    it.effect("removes a document and returns 204", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        yield* putDoc(client, "/documents/start", doc("Start", "# Start"))
        const response = yield* del(client, "/documents/start")
        expect(response.status).toBe(204)
        const back = yield* client.get("/documents/start")
        expect(back.status).toBe(404)
      }),
    )
  },
)

layer(
  serve(
    blobOf(storeWith([["docs/guides/start", doc("Guide", "# v1")]])),
    CatalogConfig,
    alwaysAuthenticated("user"),
  ),
)("document conditional writes", (it) => {
  it.effect("honors a fresh If-Match and rejects a stale one", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const fresh = yield* putDoc(client, "/documents/guides/start", doc("Guide", "# v2"), "seed")
      expect(fresh.status).toBe(200)
      const freshBody = yield* fresh.json
      expect(freshBody).toEqual({ version: "1" })

      const stale = yield* putDoc(
        client,
        "/documents/guides/start",
        doc("Guide", "# stale"),
        "seed",
      )
      expect(stale.status).toBe(412)
      const staleBody = yield* stale.json
      expect(staleBody).toEqual({
        _tag: "PreconditionFailed",
        key: "docs/guides/start",
        expected: { _tag: "Some", value: "seed" },
        actual: { _tag: "Some", value: "1" },
      })
    }),
  )
})

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig, alwaysAuthenticated("user")))(
  "asset writes",
  (it) => {
    it.effect("stores bytes on upload and removes them on delete", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const put = yield* putAsset(client, "/assets/images/logo.png", utf8("png-bytes"))
        expect(put.status).toBe(201)
        const putBody = yield* put.json
        expect(putBody).toEqual({ version: "1" })

        const back = yield* client.get("/assets/images/logo.png")
        expect(back.status).toBe(200)
        const bytes = yield* back.arrayBuffer
        expect(new Uint8Array(bytes)).toEqual(utf8("png-bytes"))

        const remove = yield* del(client, "/assets/images/logo.png")
        expect(remove.status).toBe(204)
        const gone = yield* client.get("/assets/images/logo.png")
        expect(gone.status).toBe(404)
      }),
    )
  },
)

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig, alwaysAuthenticated("user")))(
  "asset writes",
  (it) => {
    it.effect("creates without If-Match and updates conditionally with one", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const create = yield* putAsset(client, "/assets/a.txt", utf8("v1"))
        expect(create.status).toBe(201)
        const created = yield* create.json
        expect(created).toEqual({ version: "1" })

        const update = yield* putAsset(client, "/assets/a.txt", utf8("v2"), "1")
        expect(update.status).toBe(200)
        const updated = yield* update.json
        expect(updated).toEqual({ version: "2" })

        const back = yield* client.get("/assets/a.txt")
        expect(back.status).toBe(200)
        expect(yield* back.text).toBe("v2")
        expect(back.headers["etag"]).toBe("2")
      }),
    )

    it.effect("refuses a stale or unknown If-Match with 412", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const create = yield* putAsset(client, "/assets/b.txt", utf8("v1"))
        const created = (yield* create.json) as { version: string }
        const current = created.version

        // the current version accepts and bumps
        const ok = yield* putAsset(client, "/assets/b.txt", utf8("v2"), current)
        expect(ok.status).toBe(200)

        // the previous version is stale now; an unknown one never matches
        const past = yield* putAsset(client, "/assets/b.txt", utf8("v3"), current)
        expect(past.status).toBe(412)
        const future = yield* putAsset(client, "/assets/b.txt", utf8("v3"), "99")
        expect(future.status).toBe(412)

        const back = yield* client.get("/assets/b.txt")
        expect(yield* back.text).toBe("v2") // failed writes stored nothing
      }),
    )

    it.effect("refuses re-creating an existing asset without If-Match", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const create = yield* putAsset(client, "/assets/c.txt", utf8("v1"))
        expect(create.status).toBe(201)
        const again = yield* putAsset(client, "/assets/c.txt", utf8("v2"))
        expect(again.status).toBe(412)
      }),
    )

    it.effect("retains the uploaded content type and serves it back on reads", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const put = yield* client.execute(
          HttpClientRequest.put("/assets/img.png").pipe(
            HttpClientRequest.bodyUint8Array(utf8("blob"), "image/png"),
          ),
        )
        expect(put.status).toBe(201)
        const back = yield* client.get("/assets/img.png")
        expect(back.status).toBe(200)
        expect(back.headers["content-type"]).toBe("image/png")
        expect(yield* back.text).toBe("blob")
      }),
    )

    it.effect("refuses a media type outside the accepted set with 415", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const put = yield* client.execute(
          HttpClientRequest.put("/assets/x.xml").pipe(
            HttpClientRequest.bodyUint8Array(utf8("xml"), "application/xml"),
          ),
        )
        expect(put.status).toBe(415)
        const back = yield* client.get("/assets/x.xml")
        expect(back.status).toBe(404)
      }),
    )
  },
)

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig))("write auth gate", (it) => {
  it.effect("rejects an anonymous write with 401 and stores nothing", () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const response = yield* putDoc(client, "/documents/guides/start", doc("Guide", "# Guide"))
      expect(response.status).toBe(401)
      const body = yield* response.json
      expect((body as { _tag: string })._tag).toBe("Unauthorized")

      const back = yield* client.get("/documents/guides/start")
      expect(back.status).toBe(404)
    }),
  )
})

layer(serve(blobOf(MemoryBlobStore.make()), CatalogConfig, alwaysAuthenticated("user")))(
  "admin gate",
  (it) => {
    it.effect("rejects a non-admin session on the provisioning endpoint", () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.put("/admin/users").pipe(
            HttpClientRequest.bodyText(
              JSON.stringify({ email: "x@y.dev", role: "user" }),
              "application/json",
            ),
          ),
        )
        expect(response.status).toBe(403)
        const body = yield* response.json
        expect(body).toEqual({ _tag: "Forbidden", message: "admin role required" })
      }),
    )
  },
)
