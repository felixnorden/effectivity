import { Layer } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { BlobStore, CatalogRootConfig } from "@effectivity/core"
import { Api } from "./api.ts"
import { AuthenticationService } from "./auth-service.ts"
import { AdminApiHandlers } from "./handlers/admin.ts"
import { AssetsApiHandlers } from "./handlers/assets.ts"
import { DocumentsApiHandlers } from "./handlers/documents.ts"
import { ReferencesApiHandlers } from "./handlers/references.ts"
import { AuthGateLayer } from "./middleware/auth.ts"
import { Wiring } from "./wiring.ts"

/**
 * The runnable app: routing, endpoint handlers, and error mapping over the
 * wired core services. A runtime composes this with an `HttpServer` layer
 * (bun adapter, Node, a Worker fetch loop) via `HttpRouter.serve`.
 *
 * Reads are public; every write endpoint is gated by the auth gate, which
 * consults the caller-provided `AuthenticationService` (the real identity
 * core lands in @effectivity/auth). The admin group additionally enforces
 * the admin role inside its handler.
 */
export const App = {
  routes: <Bucket>(
    blobStoreLayer: Layer.Layer<BlobStore, never, Bucket>,
    config: CatalogRootConfig,
    authLayer: Layer.Layer<AuthenticationService, never, Bucket>,
  ): Layer.Layer<
    HttpRouter.HttpRouter | Etag.Generator | HttpPlatform.HttpPlatform,
    never,
    Bucket
  > =>
    HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
      Layer.provide(DocumentsApiHandlers),
      Layer.provide(AssetsApiHandlers),
      Layer.provide(ReferencesApiHandlers),
      Layer.provide(AdminApiHandlers),
      Layer.provide(AuthGateLayer),
      Layer.provide(authLayer),
      Layer.provide(Wiring.layer(blobStoreLayer, config)),
    ) as Layer.Layer<
      HttpRouter.HttpRouter | Etag.Generator | HttpPlatform.HttpPlatform,
      never,
      Bucket
    >,
}
