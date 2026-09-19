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
| `effectivity <plugin> <cmd>`   | run a command contributed by a registered plugin                           |

Every registered plugin also appears as a command group named after its
registration, so contributed commands are namespaced (`effectivity alpha hello`).
Two registrations may contribute the same local command name.

Shared flags: `--config <path>` to point at a config explicitly (default:
nearest `effectivity.config.{ts,mts,mjs,js,cjs}`, walking up from the
working directory).

Missing config is not an error: the engine falls back to an empty
registration list, so `--help` works anywhere and a platform command fails
naming the missing capability and the registered plugins. A
present-but-broken config is an error (nonzero exit, no silent fallback).

## Programmatic use

```ts
import { boot, engineLayer, HostServices } from "@effectivity/cli"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

const engine = await Effect.runPromise(
  boot().pipe(Effect.provide(HostServices.layer.pipe(Layer.provideMerge(BunServices.layer)))),
)
// engine.registrations, engine.host, engine.projectRoot
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

`defineConfig` type-checks the literal it receives: an unknown top-level
field is a compile error, `plugins` present or not.

Multiple plugins are allowed. The engine does not merge plugin layers. It
keeps `config.plugins` in order and runs every registration that provides the
dispatched capability, in that order; the first failure stops the run. A
duplicate capability provider is accepted: registration order is the only
control.

## Plugin contract

A registration is plain data. The engine keeps the list order and iterates it.

```ts
import { ProjectRoot, Sync, type HostServicesShape, type PluginRegistration } from "@effectivity/cli"
import { Effect, Layer } from "effect"

export const myPlugin = (): PluginRegistration<Sync> => ({
  name: "my-plugin",
  capabilities: (_host: HostServicesShape) =>
    Layer.succeed(
      Sync,
      Sync.of({
        sync: Effect.fn("myPlugin.sync")(function* () {
          const root = yield* ProjectRoot
          yield* Effect.log(`syncing ${root}`)
        }),
      }),
    ),
  commands: [],
})
```

A plugin package that also exports a Worker runtime should import this contract
from `@effectivity/cli/plugin`, not the package root: the root re-exports the
config loader (and esbuild), which must not enter the Worker bundle.

- **Capabilities** are typed service tags: `Sync`, `Dev`, `Build`, `Preview`,
  `Seed`. Each returns `Effect<void, PluginError>`; `Dev` takes `{ port }` and
  `Seed` takes `{ url }`.
- **`name`** is required and must be unique. It names the command group and
  the failure.
- **`capabilities(host)`** returns a layer with no requirements. `host` is
  `{ fs, spawner, stdio }`, captured once by the engine. Read the project root
  with `yield* ProjectRoot` at run time.
- **A subset is legal.** `R` is the exact capability set the plugin provides;
  a seed-only registration compiles.
- **Fan-out is ordered and fail-fast.** Every registration that provides the
  dispatched capability runs, in `config.plugins` order. The first failure
  stops the run; the error carries `plugin` and prefixes the message with the
  registration name.
- **Contributed commands** are plain data: `name`, `description`, `flags`
  (`string`/`boolean`/`integer`, optional default and alias), and a `handler`.
  They appear under the registration's group. A handler runs with its own
  registration's capabilities plus the engine host and project root, never
  another registration's capabilities.
- **A missing capability is a clear failure, not a silent no-op.** `seed` is
  mounted in every configuration; when no registration provides it, the
  command fails and names the capability and the registered plugins.

**Long-running operations.** `dev` and `preview` do not return while the
server runs. The first provider of one of those capabilities blocks every
later registration for that capability. The engine does not cancel,
parallelise, or reorder. Place the plugin that owns a long-running operation
last among those that handle it.

## Config loading

Like Vite's `vite.config.ts`, `effectivity.config.ts` is bundled with esbuild
and imported per command. The bundle is written to a `.effectivity/` scratch
dir inside the project (removed after load) so imports resolve against the
project's `node_modules`; the engine's own `defineConfig` and any plugin
factories (plus the Effect runtime they pull in) are inlined by the bundle.
Service-tag identity is string-keyed, so the inlined Effect copy
interoperates with the host CLI — match `PluginError` by `_tag`, never
`instanceof`.