# @effectivity/api

A runtime-agnostic HTTP surface for @effectivity/core. Declarative `HttpApi`
app (documents, assets, references, admin, OpenAPI) with conditional writes
(`If-Match`), reads public and writes gated by an auth-interface; the package
never imports an auth library.

The package ships routing, handlers, error mapping, and the
`AuthenticationService` contract. A runtime supplies:

- a `BlobStore` layer (e.g. the R2 adapter in `@effectivity/cloudflare` or a
  memory seam in tests),
- a `CatalogRootConfig` (root path + frontmatter schema),
- an `AuthenticationService` layer (the D1 identity core in
  `@effectivity/auth`, or a double in tests).

## Wire it

```ts
import { Layer } from "effect"
import { Schema } from "effect"
import { BlobStore } from "@effectivity/core"
import { App } from "@effectivity/api"
import { authServiceLayer } from "@effectivity/auth"

const config = { root: "cms", frontmatter: Schema.Struct({ title: Schema.String }) }

// R2-backed store layer (cloudflare package) + D1-backed auth layer
App.routes(r2Layer(env.BUCKET), config, authServiceLayer(identity))
// -> Layer<HttpRouter | Etag.Generator | HttpPlatform.HttpPlatform, never, never>
```

`App.routes` is the sole composition entry: it wires the core services, the
api-local parse service, the auth gate middleware, and the caller's auth
layer. Serve it with `HttpRouter.serve(...)` on the bun/node adapters, or
`HttpRouter.toWebHandler(...)` inside a Worker fetch loop (the cloudflare
package does exactly this).

## Wire semantics

| Request                                   | Behavior                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /documents/*`, `GET /assets/*`       | public reads; `/*` with no suffix lists, with a suffix reads                                           |
| `GET /references`                         | per-document reference report (src, resolved asset, absolute url, present/dangling/type)               |
| `GET /documents/x?view=model`             | parsed frontmatter + body + `references[]` (per-image src, asset, absolute url, status)                |
| `GET /documents/x?resolve=urls`           | raw markdown with image srcs and doc-to-doc links rewritten to absolute urls in place (etag unchanged) |
| `PUT /documents/x` (no `If-Match`)        | create → 201 `{ version }`                                                                             |
| `PUT /documents/x` (`If-Match`)           | conditional update → 200 `{ version }`; stale → 412; missing → 412                                     |
| `DELETE /documents/x`                     | idempotent 204; integrity refusals → 409                                                               |
| `PUT /assets/*`, `DELETE /assets/*`       | binary asset writes, same `If-Match` semantics; upload content type retained and served back           |
| `PUT /admin/users`, `DELETE /admin/users` | admin-provisioned accounts (group-level gate + role check inside)                                      |
| `GET /openapi.json`                       | OpenAPI document                                                                                       |

Errors are core classes mapped to the wire payload-for-payload
(`BlobNotFound` → 404, `PreconditionFailed` → 412 with `Option` fields
encoded as `{ _tag: "Some" | "None" }` JSON, `IntegrityViolation` → 409,
`Unauthorized` → 401, `Forbidden` → 403).

## The auth gate

Writes require an `AuthenticationService` that resolves one request to an
`AuthIdentity { id, role: "admin" | "user" }` (`Option.none` = anonymous).
`@effectivity/auth` implements it over Better Auth; `test/doubles/auth.ts`
provides deterministic doubles for read-path tests. The gate is a non-security
`HttpApiMiddleware` — no auth library behavior leaks past
`AuthenticationService`.

## Tests

`bun --bun vitest run` — documents, assets/references, and writes suites
(24 tests) run against a memory blob seam through a real HTTP server.
Resolved asset urls are checked against the request origin of the in-process
server, and content-type retention is verified per upload.
