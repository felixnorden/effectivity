import { Context, Effect, Layer } from "effect"
import {
  Core,
  type CoreProvides,
  type CatalogRootConfig,
  type BlobStore,
  type ParsedDocument,
  parseDocument,
  type ValidationFailed,
} from "@effectivity/core"

/**
 * The api-local parse service: typed document parsing bound to the caller's
 * frontmatter schema, so handlers never carry the schema value themselves.
 * Generic over nothing — the parsed model is `unknown`, and handlers project
 * the fields they need with runtime checks.
 */
export interface ParseShape {
  readonly parse: (bytes: Uint8Array) => Effect.Effect<ParsedDocument<unknown>, ValidationFailed>
}

export class Parse extends Context.Service<Parse, ParseShape>()("effectivity/api/Parse") {}

/**
 * The core wiring layer. Accepts the caller's blob layer + root config,
 * composes `Core.layer`, and adds the schema-bound parse service. Everything a
 * handler group needs comes from here; the runtime only supplies bytes and
 * config.
 */
export const Wiring = {
  layer: <Bucket>(
    blobStoreLayer: Layer.Layer<BlobStore, never, Bucket>,
    config: CatalogRootConfig,
  ): Layer.Layer<CoreProvides | Parse, never, Bucket> =>
    Core.layer(blobStoreLayer, config).pipe(
      Layer.provideMerge(
        Layer.effect(
          Parse,
          Effect.sync(() =>
            Parse.of({
              parse: (bytes) => parseDocument(config.frontmatter, bytes),
            }),
          ),
        ),
      ),
    ) as Layer.Layer<CoreProvides | Parse, never, Bucket>,
}
