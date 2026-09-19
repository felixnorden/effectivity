/**
 * The composed Worker: migrations + admin seed at first boot, the /auth
 * namespace dispatched to Better Auth, everything else through the api app
 * over the R2 byte adapter and the D1-backed identity core.
 *
 * The identity instance and app handler are built only after the boot
 * (migrations + seed) so Better Auth's schema validation never observes an
 * un-migrated database. The composition is pure construction over `env` and
 * the caller-provided `settings`; `makeWorker` memoizes one instance per
 * isolate.
 */
import { Effect, Layer, Schema } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import type { CatalogRootConfig } from "@effectivity/core"
import { App } from "@effectivity/api"
import type { RuntimeSettings } from "./artifacts.ts"
import {
  authServiceLayer,
  getMigrations,
  makeIdentity,
  type IdentityConfig,
} from "@effectivity/auth"
import { r2Layer } from "./r2-layer.ts"

/** Platform service for a Web runtime with no file system: file responses are
 * not part of the api surface, so they surface as 501 instead of hanging on
 * missing FileSystem/Path services. */
const HttpPlatformWeb = Layer.succeed(
  HttpPlatform.HttpPlatform,
  HttpPlatform.HttpPlatform.of({
    platform: "web",
    compression: HttpPlatform.makeCompressionWeb({
      algorithms: ["gzip", "deflate"],
      transform: (algorithm) => (stream) =>
        algorithm === "br" || algorithm === "zstd"
          ? stream
          : stream.pipeThrough(new CompressionStream(algorithm)),
    }),
    fileResponse: (path) =>
      Effect.succeed(HttpServerResponse.raw(`file serving unavailable: ${path}`, { status: 501 })),
    fileWebResponse: (file) =>
      Effect.succeed(
        HttpServerResponse.raw(`file serving unavailable: ${String(file)}`, { status: 501 }),
      ),
  }),
)

/** The Worker bindings and environment overlays the runtime reads. Only
 * `BUCKET` and `DB` are required; the `AUTH_*` fields overlay the baked
 * settings (production: wrangler secrets). */
export interface WorkerEnv {
  readonly BUCKET: R2Bucket
  readonly DB: D1Database
  /** overlay: public origin for auth cookies/CSRF; falls back to the baked settings. */
  readonly AUTH_URL?: string
  /** overlay: Better Auth signing secret; falls back to the baked dev default (prod: `wrangler secret put`). */
  readonly AUTH_SECRET?: string
  /** overlay: first admin email; falls back to the baked settings. */
  readonly AUTH_ADMIN_EMAIL?: string
  /** overlay: first admin password; never baked — .dev.vars in dev, wrangler secret in prod. */
  readonly AUTH_ADMIN_PASSWORD?: string
}

/** Build the composed Worker for one environment from one instance's baked
 * settings: `/auth/*` goes to Better Auth, everything else through the api app
 * over the R2 byte adapter and the D1-backed identity core. Migrations and the
 * admin seed run before the first request is served; `makeWorker` memoizes the
 * result per isolate. */
export const createComposition = (env: WorkerEnv, settings: RuntimeSettings) => {
  const authConfig = (): IdentityConfig => ({
    baseURL: env.AUTH_URL ?? settings.auth.url,
    secret: env.AUTH_SECRET ?? settings.auth.secret,
    database: env.DB,
    basePath: "/auth",
  })

  const catalogConfig: CatalogRootConfig = {
    root: settings.catalog.root,
    // Documents require a frontmatter schema at wiring time; the v1 catalog
    // schema is a single title field.
    frontmatter: Schema.Struct({ title: Schema.String }),
  }

  /** Create the auth schema and provision the first admin, once per isolate. */
  let bootPromise: Promise<void> | undefined
  const boot = (): Promise<void> => (bootPromise ??= bootOnce())
  const bootOnce = async (): Promise<void> => {
    const { runMigrations } = await getMigrations(authConfig())
    await runMigrations()
    const { AUTH_ADMIN_PASSWORD: password } = env
    const email = env.AUTH_ADMIN_EMAIL ?? settings.auth.admin.email
    if (email !== undefined && password !== undefined) {
      const existing = await env.DB.prepare("SELECT id FROM user WHERE email = ?")
        .bind(email)
        .first()
      if (existing === null) {
        // Registration is closed on the serving instance; the bootstrap
        // instance signs the first admin up, then the role flips via D1.
        const seeder = makeIdentity({ ...authConfig(), signUpEnabled: true })
        const { user } = await seeder.api.signUpEmail({
          body: { email, password, name: email.split("@")[0]! },
        })
        await env.DB.prepare("UPDATE user SET role = ? WHERE id = ?").bind("admin", user.id).run()
      }
    }
  }

  interface Ready {
    readonly identity: ReturnType<typeof makeIdentity>
    readonly appHandler: { readonly handler: (request: Request) => Promise<Response> }
  }

  /** One identity instance serves the /auth namespace AND the api write gate,
   * so cookie sessions and API keys resolve against the same D1 schema.
   * Built at composition time: better-auth init is environment-independent
   * (its schema validation warns on a not-yet-migrated database, which the
   * boot below repairs before any request is served). */
  const identity = makeIdentity(authConfig())

  let ready: Ready | undefined
  const ensureReady = async (): Promise<Ready> => {
    await boot()
    let current = ready
    if (current === undefined) {
      const { handler } = HttpRouter.toWebHandler(
        App.routes(r2Layer(env.BUCKET), catalogConfig, authServiceLayer(identity)).pipe(
          Layer.provideMerge(Etag.layer),
          Layer.provideMerge(HttpPlatformWeb),
        ),
        { disableLogger: true },
      )
      // Boundary cast: the declared handler type carries FileSystem/Path from
      // HttpApiBuilder's per-endpoint typing, but the runtime path never
      // touches them (proven by the pool suite and wrangler dev smoke). The
      // Worker fetch loop has no such services to provide.
      current = {
        identity,
        appHandler: { handler: handler as (request: Request) => Promise<Response> },
      }
      ready = current
    }
    return current
  }

  return {
    /** Migrations + seed are awaited before the first request is served. */
    fetch: async (request: Request): Promise<Response> => {
      const { identity, appHandler } = await ensureReady()
      const url = new URL(request.url)
      if (url.pathname.startsWith("/auth")) {
        return identity.handler(request)
      }
      return appHandler.handler(request)
    },
  }
}
