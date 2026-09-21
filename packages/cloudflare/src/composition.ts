/**
 * The composed Worker: migrations + admin seed at first boot, the /auth
 * namespace dispatched to Better Auth, everything else through the api app
 * over the R2 byte adapter and the D1-backed identity core.
 *
 * The composition is pure construction over `env` and the caller-provided
 * `settings`. The identity instance is built at composition time (better-auth
 * init is environment-independent); migrations and the admin seed run at the
 * first request, before the api app is built, so better-auth's schema
 * validation never observes an un-migrated database. `makeWorker` memoizes one
 * instance per isolate.
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

/** The namespace Better Auth owns; every other path goes to the api app. */
const AUTH_PREFIX = "/auth"

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

/** Better Auth config for one environment: the overlay wins over the baked
 * setting. The database is always the D1 binding. */
const authConfig = (env: WorkerEnv, settings: RuntimeSettings): IdentityConfig => ({
  baseURL: env.AUTH_URL ?? settings.auth.url,
  secret: env.AUTH_SECRET ?? settings.auth.secret,
  database: env.DB,
  basePath: AUTH_PREFIX,
})

/** Catalog wiring for one instance. Documents require a frontmatter schema at
 * wiring time; the v1 catalog schema is a single title field. */
const catalogConfig = (settings: RuntimeSettings): CatalogRootConfig => ({
  root: settings.catalog.root,
  frontmatter: Schema.Struct({ title: Schema.String }),
})

/** Provision the first admin when the overlays supply both the email and the
 * password and no user has that email yet. A second call is a no-op. */
const seedAdmin = Effect.fn("seedAdmin")(function* (
  env: WorkerEnv,
  settings: RuntimeSettings,
  config: IdentityConfig,
) {
  const { AUTH_ADMIN_PASSWORD: password } = env
  const email = env.AUTH_ADMIN_EMAIL ?? settings.auth.admin.email
  if (email === undefined || password === undefined) return

  const existing = yield* Effect.promise(() =>
    env.DB.prepare("SELECT id FROM user WHERE email = ?").bind(email).first(),
  )
  if (existing !== null) return

  // Registration is closed on the serving instance; the bootstrap instance
  // signs the first admin up, then the role flips via D1.
  const seeder = makeIdentity({ ...config, signUpEnabled: true })
  const { user } = yield* Effect.promise(() =>
    seeder.api.signUpEmail({ body: { email, password, name: email.split("@")[0]! } }),
  )
  yield* Effect.promise(() =>
    env.DB.prepare("UPDATE user SET role = ? WHERE id = ?").bind("admin", user.id).run(),
  )
})

/** Create the auth schema, then seed the first admin. Callers memoize the run:
 * better-auth's migration runner is safe to repeat, the seed is idempotent. */
const bootstrap = Effect.fn("bootstrap")(function* (
  env: WorkerEnv,
  settings: RuntimeSettings,
  config: IdentityConfig,
) {
  const { runMigrations } = yield* Effect.promise(() => getMigrations(config))
  yield* Effect.promise(() => runMigrations())
  yield* seedAdmin(env, settings, config)
})

/** The composed app handler: a plain Request-in, Response-out function. */
interface AppHandler {
  readonly handler: (request: Request) => Promise<Response>
}

/** Build the api app over the R2 byte adapter and the D1-backed identity core.
 * One identity instance serves the /auth namespace AND the api write gate, so
 * cookie sessions and API keys resolve against the same D1 schema. */
const makeAppHandler = (
  bucket: R2Bucket,
  catalog: CatalogRootConfig,
  identity: ReturnType<typeof makeIdentity>,
): AppHandler => {
  const { handler } = HttpRouter.toWebHandler(
    App.routes(r2Layer(bucket), catalog, authServiceLayer(identity)).pipe(
      Layer.provideMerge(Etag.layer),
      Layer.provideMerge(HttpPlatformWeb),
    ),
    { disableLogger: true },
  )
  return { handler }
}

/** Memoize an async starter: the first call starts the work, every later call
 * reuses the same promise (resolved or rejected). */
const once = <A>(start: () => Promise<A>): (() => Promise<A>) => {
  let pending: Promise<A> | undefined
  return () => (pending ??= start())
}

/** Build the composed Worker for one environment from one instance's baked
 * settings: `/auth/*` goes to Better Auth, everything else through the api app
 * over the R2 byte adapter and the D1-backed identity core. Migrations and the
 * admin seed run before the first request is served; `makeWorker` memoizes the
 * result per isolate. */
export const createComposition = (env: WorkerEnv, settings: RuntimeSettings) => {
  const config = authConfig(env, settings)
  const identity = makeIdentity(config)

  // Boot once per isolate, then build the app handler. The handler is built
  // after the boot so better-auth never validates its schema against an
  // un-migrated database.
  const composed = once(async () => {
    await Effect.runPromise(bootstrap(env, settings, config))
    return makeAppHandler(env.BUCKET, catalogConfig(settings), identity)
  })

  return {
    /** Migrations + seed are awaited before the first request is served. */
    fetch: async (request: Request): Promise<Response> => {
      const appHandler = await composed()
      return new URL(request.url).pathname.startsWith(AUTH_PREFIX)
        ? identity.handler(request)
        : appHandler.handler(request)
    },
  }
}
