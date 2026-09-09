import { Layer } from "effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { BunHttpServer } from "@effect/platform-bun"
import { Etag, HttpPlatform, HttpRouter, HttpClient, HttpServer } from "effect/unstable/http"
import type { BlobStore, CatalogRootConfig } from "@effectivity/core"
import { App } from "../src/app.ts"
import type { AuthenticationService } from "../src/auth-service.ts"
import { alwaysAnonymous } from "./doubles/auth.ts"

/**
 * Test server harness: serve the api app on the bun adapter in-process
 * (ephemeral port) and dispatch via the provided `HttpClient` against the
 * running server. One server per `layer()` suite. Provision the auth service
 * explicitly for write tests; reads default to an anonymous double (reads
 * never consult it).
 */
export const serve = <Bucket>(
  blobStoreLayer: Layer.Layer<BlobStore, never, Bucket>,
  config: CatalogRootConfig,
  authLayer: Layer.Layer<AuthenticationService, never, never> = alwaysAnonymous,
): Layer.Layer<
  | HttpRouter.HttpRouter
  | Etag.Generator
  | HttpPlatform.HttpPlatform
  | HttpServer.HttpServer
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient,
  never,
  never
> =>
  HttpRouter.serve(App.routes(blobStoreLayer, config, authLayer)).pipe(
    Layer.provideMerge(BunHttpServer.layerTest),
  ) as Layer.Layer<
    | HttpRouter.HttpRouter
    | Etag.Generator
    | HttpPlatform.HttpPlatform
    | HttpServer.HttpServer
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient,
    never,
    never
  >
