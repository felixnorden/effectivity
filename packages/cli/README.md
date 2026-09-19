# @effectivity/cli

A generic, Effect-native command engine for effectivity instances. One
config file (`effectivity.config.ts`) lists named platform plugin
registrations; the engine loads it, captures the host IO and project root
once, and runs each platform capability over the registrations in order.
The engine itself has zero Cloudflare concepts — `@effectivity/cloudflare`
owns all wrangler/vite orchestration behind its `cloudflarePlugin` factory.

## Why

The worker reads its runtime settings from the config object, not from
environment variables. `effectivity sync` goes through the registered plugin
and generates two artifacts from `effectivity.config.ts`:

- `wrangler.jsonc` — bindings-only Workers config (R2 + D1 + observability).
  No vars; you never hand-write `CMS_ROOT`/`AUTH_*` into it.
- `src/runtime.generated.ts` — the settings module baked into the worker
  bundle (catalog root, auth origin, dev signing secret, admin email).

Secrets stay off the bundle: the admin password goes to `.dev.vars` in dev
and to wrangler secrets at deploy. Production can overlay any baked value
with an `AUTH_URL`/`AUTH_SECRET`/`AUTH_ADMIN_*` environment variable; the
only required worker bindings are `BUCKET` (R2) and `DB` (D1).

## Usage

```sh
cd <project>            # where effectivity.config.ts lives (or run from a subdir)
effectivity --help      # or: bun x effectivity
```

| command                        | effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `effectivity sync`             | regenerate `wrangler.jsonc` + `src/runtime.generated.ts` through the plugin |
| `effectivity dev [--port N]`   | sync, write `.dev.vars` secrets, start the Vite dev server (workerd HMR)   |
| `effectivity build`            | sync + `vite build` (worker bundle)                                        |
| `effectivity preview`          | `vite preview` for the built bundle                                        |
| `effectivity seed [--url URL]` | run the project's `scripts/seed.sh` against a running worker               |
| `effectivity init [dir]`       | write a starter `effectivity.config.ts` (never overwrites) and sync        |

Shared flags: `--config <path>` to point at a config explicitly (default:
nearest `effectivity.config.{ts,mts,mjs,js,cjs}`, walking up from the
working directory).

Missing config is not an error: the engine falls back to an empty
registration list, so `--help` works anywhere and a platform command fails
naming the missing capability and the registered plugins. A
present-but-broken config is an error (nonzero exit, no silent fallback).

## Programmatic use

```ts
import { defineConfig, loadRawConfig, boot, engineLayer } from "@effectivity/cli"

const config = defineConfig({ plugins: [...] })
const engine = await Effect.runPromise(boot().pipe(Effect.provide(HostServices.layer)))
// engine.registrations + engine.host + engine.projectRoot
```

## Config reference

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

Multiple plugins are allowed; `Layer.merge` is keyed by service tag, so the
last plugin in the list shadows earlier ones for the same service
(last-write-wins).

## Config loading

Like Vite's `vite.config.ts`, `effectivity.config.ts` is bundled with esbuild
and imported per command. The bundle is written to a `.effectivity/` scratch
dir inside the project (removed after load) so imports resolve against the
project's `node_modules`; the engine's own `defineConfig` and any plugin
factories (plus the Effect runtime they pull in) are inlined by the bundle.
Service-tag identity is string-keyed, so the inlined Effect copy
interoperates with the host CLI — match `PluginError` by `_tag`, never
`instanceof`.