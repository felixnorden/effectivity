# @effectivity/auth

The identity core behind @effectivity/api's write gate: Better Auth
(email/password sessions, admin-provisioned accounts, API keys for headless
callers) implementing the api package's `AuthenticationService` contract.

Runtime-agnostic — the environment only supplies config: base URL, signing
secret, and a database. Better Auth accepts the raw `D1Database` binding
directly (its bundled dialect detects it), a server connection, or the
built-in memory adapter for tests; this package never imports a concrete
driver.

## Wire it

```ts
import {
  makeIdentity,
  authServiceLayer,
  getMigrations,
  type IdentityConfig,
} from "@effectivity/auth"

const config: IdentityConfig = {
  baseURL: env.AUTH_URL, // public origin (cookie/CSRF scope)
  secret: env.AUTH_SECRET, // >= 32 chars outside tests
  database: env.DB, // D1 binding, pool connection, or memory adapter
  basePath: "/auth", // auth namespace prefix
}

// one instance serves the /auth namespace AND the api write gate
const identity = makeIdentity(config)

// boot: create the schema, then seed the first admin (idempotent)
const { runMigrations } = await getMigrations(config)
await runMigrations()

// api package integration
authServiceLayer(identity) // -> Layer<AuthenticationService>
```

`getMigrations` builds better-auth options from the same config (plugins
included), so the migrated schema always matches the plugins the instance
serves. The first admin is provisioned by signing up on a bootstrap instance
with open registration, then flipping `user.role` to `admin` via the
database.

## Authentication surface

- Email/password sign-in → session cookie.
- Admin plugin: `POST /auth/admin/create-user` provisions accounts (role
  checked server-side).
- API keys (`sk_` prefix): `POST /auth/api-key/create` with an admin session;
  the key authenticates through the `x-api-key` header.
- One resolution path (`identity.api.getSession`) covers both cookies and
  keys (`enableSessionForAPIKeys`), so `AuthenticationService.authenticate`
  has a single code path. Invalid keys resolve anonymous, never as failures.

## Tests

`bun --bun vitest run` — identity behaviors plus cross-package conformance:
the api app served over the bun adapter with the real auth service
(8 tests).
