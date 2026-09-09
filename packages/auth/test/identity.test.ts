import { Chunk, Effect, Layer, Option, Schema } from "effect"
import type { FileSystem, Path } from "effect"
import { expect, it } from "@effect/vitest"
import { BunHttpServer } from "@effect/platform-bun"
import {
  Etag,
  HttpPlatform,
  HttpRouter,
  HttpClient,
  HttpClientRequest,
  HttpServer,
  type HttpServerRequest as HttpReq,
} from "effect/unstable/http"
import { App, AuthenticationService } from "@effectivity/api"
import { BlobStore, type BlobStoreShape } from "@effectivity/core"
import { memoryAdapter } from "better-auth/adapters/memory"
import { authServiceLayer, makeIdentity, type IdentityConfig } from "../src/index.ts"

/** An in-memory better-auth database: one array per auth table. */
interface Db {
  [key: string]: Array<Record<string, unknown>>
  user: Array<Record<string, unknown>>
  session: Array<Record<string, unknown>>
  account: Array<Record<string, unknown>>
  verification: Array<Record<string, unknown>>
  apikey: Array<Record<string, unknown>>
  rateLimit: Array<Record<string, unknown>>
}

const memoryDb = (): Db => ({
  user: [],
  session: [],
  account: [],
  verification: [],
  apikey: [],
  rateLimit: [],
})

/** Identity config sharing one memory database across all instances. */
const baseConfig = (db: Db): IdentityConfig => ({
  baseURL: "http://localhost:3000",
  secret: "s".repeat(64),
  database: memoryAdapter(db),
  signUpEnabled: true,
})

/** Dispatch a JSON POST to the better-auth fetch handler. */
const post = (
  identity: ReturnType<typeof makeIdentity>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  identity.handler(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
      body: JSON.stringify(body),
    }),
  )

/** Sign up + promote one account to admin; returns its session cookie. */
const bootstrapAdmin = async (
  identity: ReturnType<typeof makeIdentity>,
  db: Db,
): Promise<string> => {
  await post(identity, "/api/auth/sign-up/email", {
    email: "admin@x.dev",
    password: "Passw0rd!",
    name: "Admin",
  })
  db.user[0]!.role = "admin"
  const signIn = await post(identity, "/api/auth/sign-in/email", {
    email: "admin@x.dev",
    password: "Passw0rd!",
  })
  return signIn.headers.get("set-cookie")!.split(";")[0]!
}

/** A bare HttpServerRequest-shaped object carrying the given headers. */
const requestWithHeaders = (headers: Record<string, string>): HttpReq.HttpServerRequest =>
  ({ headers }) as unknown as HttpReq.HttpServerRequest

it("admin sign-in yields a session cookie and getSession resolves the admin identity", async () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  const cookie = await bootstrapAdmin(identity, db)

  const session = await identity.api.getSession({ headers: new Headers({ cookie }) })
  expect(session?.user.email).toBe("admin@x.dev")
  expect(session?.user.role).toBe("admin")
})

it("admin can create a user account and the new user can sign in", async () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  const cookie = await bootstrapAdmin(identity, db)

  const created = await post(
    identity,
    "/api/auth/admin/create-user",
    {
      email: "user@x.dev",
      password: "Passw0rd!",
      name: "User",
      role: "user",
    },
    { cookie },
  )
  expect(created.status).toBe(200)

  const signIn = await post(identity, "/api/auth/sign-in/email", {
    email: "user@x.dev",
    password: "Passw0rd!",
  })
  expect(signIn.status).toBe(200)
  const session = await identity.api.getSession({
    headers: new Headers({ cookie: signIn.headers.get("set-cookie")!.split(";")[0]! }),
  })
  expect(session?.user.email).toBe("user@x.dev")
  expect(session?.user.role).toBe("user")
})

it("non-admin cannot create accounts", async () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  const cookie = await bootstrapAdmin(identity, db)
  await post(
    identity,
    "/api/auth/admin/create-user",
    {
      email: "user@x.dev",
      password: "Passw0rd!",
      name: "User",
    },
    { cookie },
  )
  const userSignIn = await post(identity, "/api/auth/sign-in/email", {
    email: "user@x.dev",
    password: "Passw0rd!",
  })
  const userCookie = userSignIn.headers.get("set-cookie")!.split(";")[0]!
  const usersBefore = db.user.length

  const forbidden = await post(
    identity,
    "/api/auth/admin/create-user",
    {
      email: "intruder@x.dev",
      password: "Passw0rd!",
      name: "Intruder",
    },
    { cookie: userCookie },
  )
  expect(forbidden.status).toBe(403)
  expect(db.user.length).toBe(usersBefore)
})

it.effect(
  "api key creation returns a usable key and the service authenticates a headless caller",
  () => {
    const db = memoryDb()
    const identity = makeIdentity(baseConfig(db))
    return Effect.gen(function* () {
      const cookie = yield* Effect.promise(() => bootstrapAdmin(identity, db))

      const keyResponse = yield* Effect.promise(
        () =>
          post(identity, "/api/auth/api-key/create", { name: "ci" }, { cookie }).then((r) =>
            r.json(),
          ) as Promise<{ key: string }>,
      )
      expect(keyResponse.key.startsWith("sk_")).toBe(true)

      const auth = yield* AuthenticationService
      const identityInfo = yield* auth.authenticate(
        requestWithHeaders({ "x-api-key": keyResponse.key }),
      )
      expect(identityInfo).toEqual(Option.some({ id: db.user[0]!.id, role: "admin" }))
    }).pipe(Effect.provide(authServiceLayer(makeIdentity(baseConfig(db)))))
  },
)

it.effect("revoked or unknown api keys resolve anonymous", () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  return Effect.gen(function* () {
    const cookie = yield* Effect.promise(() => bootstrapAdmin(identity, db))

    const keyResponse = yield* Effect.promise(
      () =>
        post(identity, "/api/auth/api-key/create", { name: "ci" }, { cookie }).then((r) =>
          r.json(),
        ) as Promise<{ key: string; id: string }>,
    )
    yield* Effect.promise(async () => {
      const revoked = await post(
        identity,
        "/api/auth/api-key/delete",
        { keyId: keyResponse.id },
        { cookie },
      )
      expect(revoked.status).toBe(200)
    })

    const auth = yield* AuthenticationService
    const revokedInfo = yield* auth.authenticate(
      requestWithHeaders({ "x-api-key": keyResponse.key }),
    )
    expect(revokedInfo).toEqual(Option.none())
    const unknownInfo = yield* auth.authenticate(
      requestWithHeaders({ "x-api-key": "sk_does-not-exist" }),
    )
    expect(unknownInfo).toEqual(Option.none())
  }).pipe(Effect.provide(authServiceLayer(makeIdentity(baseConfig(db)))))
})

it.effect("an expired session cookie resolves anonymous instead of crashing", () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  return Effect.gen(function* () {
    const cookie = yield* Effect.promise(() => bootstrapAdmin(identity, db))

    // Expire every session server-side; the cookie itself still looks plausible.
    yield* Effect.promise(async () => {
      for (const row of db.session) row.expiresAt = new Date(Date.now() - 60_000)
      const session = await identity.api.getSession({ headers: new Headers({ cookie }) })
      expect(session).toBeNull()
    })

    const auth = yield* AuthenticationService
    const identityInfo = yield* auth.authenticate(requestWithHeaders({ cookie }))
    expect(identityInfo).toEqual(Option.none())
  }).pipe(Effect.provide(authServiceLayer(makeIdentity(baseConfig(db)))))
})

// ---------------------------------------------------------------------------
// Cross-package conformance: the auth service gate on real @effectivity/api writes.
// ---------------------------------------------------------------------------

/** Minimal BlobStore double: create/read/delete/head/list, in-memory. */
const blobDouble = (): BlobStoreShape => {
  const blobs = new Map<string, { body: Uint8Array; version: string }>()
  let counter = 0
  return BlobStore.of({
    head: (key: string) => {
      const entry = blobs.get(key)
      return Effect.sync(() =>
        entry === undefined
          ? Option.none()
          : Option.some({
              version: entry.version,
              size: entry.body.length,
              contentType: Option.none(),
            }),
      )
    },
    get: (key: string) => {
      const entry = blobs.get(key)
      return Effect.sync(() =>
        entry === undefined
          ? Option.none()
          : Option.some({
              key,
              version: entry.version,
              meta: { version: entry.version, size: entry.body.length, contentType: Option.none() },
              body: entry.body,
            }),
      )
    },
    put: (key: string, body: Uint8Array) =>
      Effect.sync(() => {
        counter += 1
        const version = String(counter)
        blobs.set(key, { body, version })
        return { version, size: body.length, contentType: Option.none() }
      }),
    del: (key: string) =>
      Effect.sync(() => {
        const existed = blobs.delete(key)
        return existed
      }),
    list: (prefix: string) =>
      Effect.sync(() =>
        Chunk.fromIterable([...blobs.keys()].filter((k) => k.startsWith(prefix)).sort()),
      ),
  })
}

const CatalogConfig = { root: "cms", frontmatter: Schema.Struct({ title: Schema.String }) }

/** Serve the api app over the bun adapter with the real auth service. */
const serve = (identity: ReturnType<typeof makeIdentity>) =>
  HttpRouter.serve(
    App.routes(Layer.succeed(BlobStore, blobDouble()), CatalogConfig, authServiceLayer(identity)),
  ).pipe(Layer.provideMerge(BunHttpServer.layerTest)) as Layer.Layer<
    | HttpRouter.HttpRouter
    | Etag.Generator
    | HttpPlatform.HttpPlatform
    | HttpServer.HttpServer
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient,
    never,
    never
  >

it.effect("a headless caller carrying only the api key can write through the api app", () => {
  const db = memoryDb()
  const identity = makeIdentity(baseConfig(db))
  return Effect.gen(function* () {
    const cookie = yield* Effect.promise(() => bootstrapAdmin(identity, db))
    const keyResponse = yield* Effect.promise(
      () =>
        post(identity, "/api/auth/api-key/create", { name: "ci" }, { cookie }).then((r) =>
          r.json(),
        ) as Promise<{ key: string }>,
    )

    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.put("/documents/start").pipe(
        HttpClientRequest.bodyText("---\ntitle: Start\n---\n# Start", "text/markdown"),
        HttpClientRequest.setHeader("x-api-key", keyResponse.key),
      ),
    )
    expect(response.status).toBe(201)
    const body = yield* response.json
    expect(body).toEqual({ version: "1" })
  }).pipe(Effect.provide(serve(makeIdentity(baseConfig(db)))))
})

it.effect("an anonymous write is rejected through the api app", () =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.put("/documents/start").pipe(
        HttpClientRequest.bodyText("---\ntitle: Start\n---\n# Start", "text/markdown"),
      ),
    )
    expect(response.status).toBe(401)
  }).pipe(Effect.provide(serve(makeIdentity(baseConfig(memoryDb()))))),
)
