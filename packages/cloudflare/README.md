# @effectivity/cloudflare

The Cloudflare Workers runtime library for effectivity. It owns three things:

- `cloudflarePlugin(config)` — a capability registration (`sync`/`dev`/`build`/
  `preview`/`seed`) over the Vite dev engine. All Cloudflare orchestration
  lives here, never in the CLI. The registration name is `config.name`
  (default `effectivity-cms`), so it also names the plugin's command group.
- `r2BlobStore` / `r2Layer` — the @effectivity/core `BlobStore` seam over an R2
  binding (etag token = the raw unquoted R2 etag, which the conditional API
  accepts; infra failures map to the seam's declared errors).
- `createComposition(env, settings)` and `makeWorker(settings)` — the composed
  worker: migrations + admin seed at first boot, `/auth/*` dispatched to the
  Better Auth handler, everything else through
  `HttpRouter.toWebHandler(App.routes(...))`.

The package is **library-only**. It holds no config, no worker entry, and no
generated artifacts. A runnable instance provides those; see
`packages/examples` for the reference instance.

## Instance contract

An instance writes four things by hand:

- `effectivity.config.ts` — `defineConfig({ plugins: [cloudflarePlugin(...)] })`.
- `src/index.ts` — the Worker entry: `export default makeWorker(settings)`,
  importing `settings` from the instance's own generated module.
- `vite.config.ts` — `defineConfig({ plugins: [cloudflare()] })`.
- `scripts/seed.sh` — the `seed` capability target.

`cloudflarePlugin`'s `sync` writes two artifacts into the instance root:
`wrangler.jsonc` (bindings only: R2 + D1 + observability, no vars) and
`src/runtime.generated.ts` (catalog root, auth origin, dev signing secret,
admin email). Secrets never enter those files: the admin password goes to
`.dev.vars` in dev and to wrangler secrets at deploy.

```ts
import { defineConfig } from "@effectivity/cli"
import { cloudflarePlugin } from "@effectivity/cloudflare"

export default defineConfig({
  plugins: [
    cloudflarePlugin({
      name: "effectivity-cms", // wrangler name; default "effectivity-cms"
      r2: { bucket: "effectivity-cms" },
      d1: { name: "effectivity-auth" }, // id: optional; placeholder until provisioned
      auth: {
        url: "https://cms.example.com", // public origin; default http://localhost:8787
        admin: { email: "admin@example.com", password: "…" }, // password: .dev.vars only
        // secret: "…", // optional; dev default is baked, prod overlays via secret
      },
      catalog: { root: "cms" },
    }),
  ],
})
```

`workerEntry` defaults to `src/index.ts`. Set it when the instance keeps the
entry elsewhere; the generated `wrangler.jsonc` `main` follows it.

Production may overlay any baked value with an `AUTH_URL`/`AUTH_SECRET`/
`AUTH_ADMIN_EMAIL`/`AUTH_ADMIN_PASSWORD` environment variable; a `wrangler
secret put` wins at runtime. The only required bindings are `BUCKET` (R2) and
`DB` (D1).

## Runbook

The instance owns the runbook. For the reference instance:

```sh
cd packages/examples
bun install
bun run cms dev [--port 8788]   # sync, write .dev.vars secrets, vite dev
bun run cms seed [--url URL]    # seed example content at a running worker
bun run cms build               # sync + vite build (worker bundle to dist/)
bun run cms preview             # vite preview (serves the built bundle)
bun run cms sync                # regenerate wrangler.jsonc + src/runtime.generated.ts
bun run cms init [dir]          # write a starter effectivity.config.ts in a new project
```

`dev` and `preview` do not return while the server runs. A registered plugin
placed after the Cloudflare plugin does not run for those two capabilities.
This is the engine's documented long-running-operation limitation.

## Behavior

- First request per isolate runs the migrations (`getMigrations` runs
  better-auth's schema diff against D1) and seeds the admin from the baked
  `auth.admin.email` plus `AUTH_ADMIN_PASSWORD` when no such user exists.
- Reads are public; writes authenticate via session cookie or `x-api-key`,
  with `If-Match` conditional semantics; `/openapi.json` is served.

## Tests

`bun run test` — pure Effect tests with fakes at the two host boundaries
(`ChildProcessSpawner`, `FileSystem`), plus compile-time proof that the
generated-artifact shapes are published from this package entry. The
workerd-based end-to-end tests live with the runnable instance
(`packages/examples`), where the emulated R2/D1 bindings and the committed
`wrangler.jsonc` are.

## Notes

- Version tokens are R2 etags, so they differ from the memory seam's counter
  values seen in other packages; they round-trip through `If-Match` on the
  same store, which is the contract.
- In-process events (core) do not fan out across Worker instances; v1 assumes
  a single instance (documented core limitation).
