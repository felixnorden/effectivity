# effectivity

A markdown CMS you embed in your own Worker. Documents are markdown files
with typed frontmatter. Images are binary assets. The library keeps a
reference graph between the two, so deleting an asset or moving a document
fails when it would break a link.

The domain code has no runtime dependency. It talks to a small byte store,
which is R2 in production, an in-memory fake in tests, or your own adapter.
Reads are public. Writes need a session cookie or an API key, and use HTTP
`If-Match` so two writers cannot silently overwrite each other.

## What you get

- Markdown documents in a logical folder tree over a flat key space.
- Frontmatter validated against an Effect `Schema` you own.
- Byte-for-byte round trips. An unchanged document keeps its original bytes.
- A document-to-asset reference graph with integrity checks on move and delete.
- Catalog and reference read models derived on demand, so they never go stale.
- Typed errors for every failure, including `ValidationFailed`,
  `PreconditionFailed`, and `IntegrityViolation`.
- Change events on successful mutations.
- An HTTP API with OpenAPI, plus Better Auth for email and password sessions,
  admin-provisioned accounts, and API keys.

## Quick start

The repository ships a runnable reference instance in `packages/examples`.

```sh
bun install
cd packages/examples
bun run cms dev        # http://localhost:8788, workerd with HMR
```

`dev` runs `sync` first, writes the admin password to `.dev.vars`, then
starts the Vite dev server. The first request creates the auth schema in D1
and seeds the admin account. In a second terminal, load example content:

```sh
bun run cms seed
```

Sign in and write a document. The `origin` header must match `AUTH_URL`,
which is `http://localhost:8787` in the example config.

```sh
curl -c /tmp/cj.txt -X POST -H "content-type: application/json" \
  -H "origin: http://localhost:8787" \
  --data '{"email":"admin@effectivity.local","password":"admin-seed-password-0123"}' \
  http://localhost:8788/auth/sign-in/email

curl -b /tmp/cj.txt -X PUT -H "content-type: text/markdown" \
  -H "origin: http://localhost:8787" \
  --data $'---\ntitle: Hello\n---\n# Hello world' \
  http://localhost:8788/documents/hello
```

The command set:

| command | effect |
| --- | --- |
| `effectivity dev [--port N]` | sync, write dev secrets, start the Vite dev server. Port 8788 by default |
| `effectivity seed [--url URL]` | run `scripts/seed.sh` against a running worker |
| `effectivity build` | sync and build the worker bundle to `dist/` |
| `effectivity preview` | serve the built bundle |
| `effectivity sync` | regenerate `wrangler.jsonc` and `src/runtime.generated.ts` |
| `effectivity init [dir]` | write a starter `effectivity.config.ts` |
| `effectivity <plugin> <cmd>` | run a command a plugin contributes |

`effectivity --help` works with no config file present.

## Configure an instance

An instance owns `effectivity.config.ts`, a Worker entry, a Vite config, and
a seed script. The config registers platform plugins.

```ts
import { defineConfig } from "@effectivity/cli"
import { cloudflarePlugin } from "@effectivity/cloudflare"

export default defineConfig({
  plugins: [
    cloudflarePlugin({
      name: "effectivity-cms",
      r2: { bucket: "effectivity-cms" },
      d1: { name: "effectivity-auth" },
      auth: {
        url: "http://localhost:8787",
        admin: {
          email: "admin@effectivity.local",
          password: "admin-seed-password-0123",
        },
      },
      catalog: { root: "cms" },
    }),
  ],
})
```

The Worker entry binds the generated settings to the runtime.

```ts
import { makeWorker } from "@effectivity/cloudflare"
import { settings } from "./runtime.generated.ts"

export default makeWorker(settings)
```

`effectivity sync` reads the config and writes two files:

- `wrangler.jsonc` holds bindings only. You never hand-write `CMS_ROOT` or
  `AUTH_*` values into it.
- `src/runtime.generated.ts` bakes the non-secret settings into the bundle.
  Those are the catalog root, the auth origin, the dev signing secret, and
  the admin email.

Secrets stay out of both. The admin password goes to `.dev.vars` in dev and
to a wrangler secret at deploy. Production can overlay any baked value with
`AUTH_URL`, `AUTH_SECRET`, `AUTH_ADMIN_EMAIL`, or `AUTH_ADMIN_PASSWORD`. The
only required bindings are the `BUCKET` R2 binding and the `DB` D1 binding.

## HTTP API

The Worker serves a JSON API with an OpenAPI document at `/openapi.json`.

| route | auth | does |
| --- | --- | --- |
| `GET /documents` | public | list documents. `?folder=` filters |
| `GET /documents/{path}` | public | raw markdown, or `?view=model` for the parsed model and references |
| `PUT /documents/{path}` | yes | create without `If-Match`, update with it |
| `DELETE /documents/{path}` | yes | idempotent. Returns 409 when references would break |
| `GET /assets`, `GET /assets/{id}` | public | asset listing and bytes |
| `PUT` / `DELETE /assets/{id}` | yes | same conditional rules. The upload content type is kept |
| `GET /references` | public | per-document reference report |
| `POST /auth/sign-in/email` | public | sets a session cookie |
| `POST /auth/api-key/create` | yes | issues a key for headless clients |

The full table, error codes, and a longer curl walkthrough live in
[packages/examples/README.md](packages/examples/README.md).

## How it fits together

This is a Bun workspace monorepo.

- `packages/core` [`@effectivity/core`](packages/core/README.md) is the
  domain library. Documents, assets, catalog, reference graph, change events.
  It ships interfaces and services, no adapter.
- `packages/api` [`@effectivity/api`](packages/api/README.md) is the HTTP
  API. A declarative Effect `HttpApi` app with conditional writes and an
  auth gate.
- `packages/auth` [`@effectivity/auth`](packages/auth/README.md) is the
  Better Auth identity core behind the write gate.
- `packages/cli` [`@effectivity/cli`](packages/cli/README.md) is the
  command engine. It loads `effectivity.config.ts` and dispatches platform
  capabilities to plugins.
- `packages/cloudflare`
  [`@effectivity/cloudflare`](packages/cloudflare/README.md) is the
  Cloudflare runtime library. The plugin, the R2 `BlobStore` adapter, and
  the composed Worker.
- `packages/examples`
  [`@effectivity/examples`](packages/examples/README.md) is the reference
  runnable instance.

A request reaches the Worker through `@effectivity/cloudflare`. Paths under
`/auth` go to Better Auth. Everything else goes through `@effectivity/api`,
which reads and writes documents in `@effectivity/core` over the R2 byte
adapter.

The engine itself has no Cloudflare concepts. A plugin registers capabilities
such as `sync`, `dev`, `build`, `preview`, and `seed`, and the engine runs
every registration that provides the dispatched capability, in config order,
stopping at the first failure. `dev` and `preview` do not return while the
server runs, so a plugin placed after the Cloudflare plugin does not run for
those two commands. Each package README covers its own contract.

## Workspace scripts

Root scripts run across packages through Turbo.

```sh
bun install
bun run lint        # oxlint
bun run fmt         # oxfmt
bun run typecheck   # tsc and the Effect language service
bun run test        # vitest
bun run check       # lint, typecheck, and test
```

## Dependency versions

Shared versions live once in the root `package.json` under `catalog`, and
packages reference them with the `catalog:` protocol.

```json
// root package.json
{ "catalog": { "effect": "4.0.0-rc.112" } }

// packages/core/package.json
{ "dependencies": { "effect": "catalog:" } }
```

Change the version in the root catalog, then run `bun install`.

## Tooling

- [Effect](https://effect.website) for typed functional programming.
- oxlint and oxfmt for linting and formatting.
- TypeScript 7 via `tsc`, and
  [@effect/tsgo](https://github.com/Effect-TS/tsgo) for editor support.
- Turbo for task running and caching.

## Status

This is v1. The core, api, auth, and cloudflare packages have tests. Two
limits are known and documented. Change events do not cross Worker isolates,
so v1 assumes one instance. `dev` and `preview` block later plugins that
provide the same capability. The design records live in `.qrspi/`.
