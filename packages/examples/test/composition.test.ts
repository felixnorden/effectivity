import { env } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { makeIdentity } from "@effectivity/auth"
import { createComposition } from "@effectivity/cloudflare"
import { settings } from "../src/runtime.generated.ts"

/**
 * End-to-end composition tests against the emulated bindings (Workers vitest
 * pool): worker dispatch, session/API-key-gated writes, migrations at first
 * boot, and the OpenAPI document. Storage is shared within the file, so every
 * test uses distinct keys and the seed is idempotent.
 */

// Runtime settings come from the baked module; the pool injects only the
// admin password (never baked). Cast keeps the type honest about overlays.
const poolEnv = env as typeof env & {
  readonly AUTH_URL?: string
  readonly AUTH_SECRET?: string
  readonly AUTH_ADMIN_EMAIL?: string
  readonly AUTH_ADMIN_PASSWORD?: string
}

const baseURL = poolEnv.AUTH_URL ?? settings.auth.url
const ADMIN = {
  email: poolEnv.AUTH_ADMIN_EMAIL ?? settings.auth.admin.email,
  password: poolEnv.AUTH_ADMIN_PASSWORD ?? "admin-seed-password-0123",
}

/** A valid markdown source for the configured frontmatter schema. */
const doc = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}`

const jsonPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      ...headers,
    },
    body: JSON.stringify(body),
  })

const put = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`${baseURL}${path}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown", ...headers },
    body,
  })

/** Sign in as admin through the identity handler; returns the session cookie. */
const adminCookie = async (): Promise<string> => {
  const identity = makeIdentity({
    baseURL: poolEnv.AUTH_URL ?? settings.auth.url,
    secret: poolEnv.AUTH_SECRET ?? settings.auth.secret,
    database: env.DB,
    basePath: "/auth",
  })
  const response = await identity.handler(
    jsonPost("/auth/sign-in/email", {
      email: ADMIN.email,
      password: ADMIN.password,
    }),
  )
  expect(response.status).toBe(200)
  const setCookie = response.headers.get("set-cookie")
  expect(setCookie).toBeDefined()
  return setCookie!.split(";")[0]!
}

describe("composed worker", () => {
  it("dispatches /auth/* to the identity handler and everything else to the api app", async () => {
    const app = createComposition(env, settings)

    const auth = await app.fetch(
      jsonPost("/auth/sign-in/email", {
        email: ADMIN.email,
        password: ADMIN.password,
      }),
    )
    expect(auth.status).toBe(200)
    expect(await auth.json()).toMatchObject({ user: { email: ADMIN.email } })

    // The api app owns the rest of the surface; a missing document is its
    // 404 shape, not an auth response.
    const api = await app.fetch(new Request(`${baseURL}/documents/nope`))
    expect(api.status).toBe(404)
    expect((await api.json()) as { _tag?: string }).toHaveProperty("_tag", "BlobNotFound")

    const auth404 = await app.fetch(new Request(`${baseURL}/auth/nope`))
    expect(auth404.status).toBe(404)
    const api404 = await app.fetch(new Request(`${baseURL}/nope`))
    expect(api404.status).toBe(404)
  })

  it("rejects anonymous writes and accepts them once signed in", async () => {
    const app = createComposition(env, settings)

    const anonymous = await app.fetch(put("/documents/session-x", doc("X", "# X")))
    expect(anonymous.status).toBe(401)

    const cookie = await adminCookie()
    const created = await app.fetch(
      put("/documents/session-x", doc("X", "# X"), { cookie, origin: baseURL }),
    )
    expect(created.status).toBe(201)
    const body = (await created.json()) as { version: string }
    expect(typeof body.version).toBe("string")
    expect(body.version.length).toBeGreaterThan(0)

    // The version token round-trips through conditional writes on the same
    // store: a fresh If-Match updates, a stale one is refused.
    const updated = await app.fetch(
      put("/documents/session-x", doc("X", "# X v2"), {
        cookie,
        origin: baseURL,
        "if-match": body.version,
      }),
    )
    expect(updated.status).toBe(200)
    const stale = await app.fetch(
      put("/documents/session-x", doc("X", "# X v3"), {
        cookie,
        origin: baseURL,
        "if-match": "stale-version",
      }),
    )
    expect(stale.status).toBe(412)

    const back = await app.fetch(new Request(`${baseURL}/documents/session-x`))
    expect(back.status).toBe(200)
    expect(await back.text()).toBe(doc("X", "# X v2"))
  })

  it("headless callers write with an API key", async () => {
    const identity = makeIdentity({
      baseURL: poolEnv.AUTH_URL ?? settings.auth.url,
      secret: poolEnv.AUTH_SECRET ?? settings.auth.secret,
      database: env.DB,
      basePath: "/auth",
    })

    const app = createComposition(env, settings)
    const cookie = await adminCookie()

    // Promote a dedicated service account, then issue it a key admin-side.
    const created = await identity.handler(
      jsonPost(
        "/auth/admin/create-user",
        {
          email: "svc@effectivity.local",
          password: "svc-password-0123",
          name: "Service",
          role: "user",
        },
        { cookie },
      ),
    )
    expect(created.status).toBe(200)
    const user = (await created.json()) as { user: { id: string } }
    const keyResponse = await identity.api.createApiKey({
      body: { userId: user.user.id },
      headers: new Headers({ cookie, origin: baseURL }),
    })

    const written = await app.fetch(
      put("/documents/api-key-y", doc("Y", "# Y"), {
        "x-api-key": keyResponse.key,
        origin: baseURL,
      }),
    )
    expect(written.status).toBe(201)
    const back = await app.fetch(new Request(`${baseURL}/documents/api-key-y`))
    expect(await back.text()).toBe(doc("Y", "# Y"))
  })

  it("migrations run at first boot and seed the admin account", async () => {
    const app = createComposition(env, settings)
    await app.fetch(new Request(`${baseURL}/documents/other`))

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','session','account','verification','apikey')",
    ).all()
    const names = (tables.results ?? []).map((row) => (row as { name: string }).name).sort()
    expect(names).toEqual(["account", "apikey", "session", "user", "verification"])

    const admin = await env.DB.prepare("SELECT role FROM user WHERE email = ?")
      .bind(ADMIN.email)
      .first()
    expect(admin).not.toBeNull()
    expect((admin as { role: string }).role).toBe("admin")
  })

  it("serves the OpenAPI document", async () => {
    const app = createComposition(env, settings)
    const response = await app.fetch(new Request(`${baseURL}/openapi.json`))
    expect(response.status).toBe(200)
    const spec = (await response.json()) as { paths: Record<string, unknown> }
    expect(spec.paths).toHaveProperty("/documents/*")
    expect(spec.paths).toHaveProperty("/assets/*")
    expect(spec.paths).toHaveProperty("/references")
  })
})
