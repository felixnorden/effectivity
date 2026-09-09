# @effectivity/cli

Vite-style configuration, generation, and operations for an effectivity CMS
instance. One config file (`cms.config.ts`) is the source of truth; the CLI
derives the deployable surface from it and drives wrangler underneath.

## Why

The worker reads its runtime settings from the config object, not from
environment variables. `bun run cms sync` generates two artifacts from
`cms.config.ts`:

- `wrangler.jsonc` — bindings-only Workers config (R2 + D1 + observability).
  No vars; you never hand-write `CMS_ROOT`/`AUTH_*` into it.
- `src/runtime.generated.ts` — the settings module baked into the worker
  bundle (catalog root, auth origin, dev signing secret, admin email).

Secrets stay off the bundle: the admin password goes to `.dev.vars` in dev
and `wrangler secret put` at deploy. Production can overlay any baked value
with an `AUTH_URL`/`AUTH_SECRET`/`AUTH_ADMIN_*` environment variable; the
only required worker bindings are `BUCKET` (R2) and `DB` (D1).

## Usage

```sh
cd <project>            # where cms.config.ts lives (or run from a subdir)
bun x effectivity help
```

| command                                                          | effect                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `effectivity sync`                                               | regenerate `wrangler.jsonc` + `src/runtime.generated.ts`                                     |
| `effectivity dev [--port 8788]`                                  | sync, write `.dev.vars` secrets, `wrangler dev`                                              |
| `effectivity provision`                                          | create R2 bucket + D1 database; record D1 id in `cms.state.json`                             |
| `effectivity deploy [--dry-run] [--provision] [--force-secrets]` | sync, set secrets, validate, deploy                                                          |
| `effectivity seed [--url URL]`                                   | run the project's `scripts/seed.sh` against a running worker (`ORIGIN` pinned to `auth.url`) |
| `effectivity init [dir]`                                         | write a starter `cms.config.ts` (never overwrites) and sync                                  |
| `effectivity help`                                               | command overview                                                                             |

Shared flags: `--config <path>` to point at a config explicitly (default:
nearest `cms.config.{ts,mts,mjs,js,cjs}`, walking up from the working
directory).

### Deploy behavior

- `--provision` creates the resources once; the real D1 database id is
  persisted in `cms.state.json` (gitignored) and wins over `cms.config.ts`.
- Secrets are walked interactively: missing values prompt, a still-dev
  `AUTH_SECRET` is replaced with a fresh 64-hex random, and existing worker
  secrets ask before being overwritten (`--force-secrets` skips the prompt).
- `deploy` always runs `wrangler deploy --dry-run` first and refuses to
  deploy if the bundle fails validation.

## Programmatic use

```ts
import { defineConfig, loadConfig, sync, generateWranglerConfig } from "@effectivity/cli"

const config = defineConfig({ catalog: { root: "cms" } })
const { config: resolved, dir } = await loadConfig()
await sync(dir, resolved)
```

## Config reference

```ts
import { defineConfig } from "@effectivity/cli"

export default defineConfig({
  name: "my-cms", // wrangler name; default "effectivity-cms"
  catalog: { root: "cms" }, // R2 catalog root; default "cms"
  auth: {
    url: "https://cms.example.com", // public origin; default http://localhost:8787
    secret: "…", // optional; dev default is baked, prod overlays via secret
    admin: {
      email: "admin@example.com", // boot seed; default admin@effectivity.local
      password: "…", // optional; .dev.vars (dev) / secret put (deploy)
    },
  },
  cloudflare: {
    r2: { bucket: "my-cms" }, // default "effectivity-cms"
    d1: { name: "my-cms-auth" }, // default "effectivity-auth"
    // id: "…",                         // optional; deploy --provision fills it via state
  },
})
```

## Config loading

Like Vite's `vite.config.ts`, `cms.config.ts` is bundled with esbuild and
imported per command. The bundle is written to a `.cms/` scratch dir inside
the project (removed after load) so imports resolve against the project's
`node_modules`; the CLI's own `defineConfig` is inlined by the bundle.
