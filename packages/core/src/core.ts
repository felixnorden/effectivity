import { Context, Effect, Layer } from "effect"
import { BlobStore } from "./blob-store.ts"
import { Catalog } from "./catalog.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import { DocumentStore, type DocumentStoreShape, documentStoreShape } from "./document-store.ts"
import { ChangeEvents } from "./events.ts"
import { Naming } from "./naming.ts"
import { ReferenceGraph } from "./reference-graph.ts"

/**
 * The services the wired store group provides to consumers: the facade, the
 * read models, the caller's blob layer (kept visible so `Effect.provide`
 * cancels facade requirements), and the config reference (the facade and read
 * models still require it at runtime).
 */
export type CoreProvides =
  | DocumentStoreShape
  | Naming
  | Catalog
  | ReferenceGraph
  | ChangeEvents
  | Context.Reference<CatalogRootConfig>
  | BlobStore

/**
 * The single composition entry point of `@effectivity/core`. The runtime only
 * supplies the byte seam (`BlobStore` layer, e.g. a real adapter in
 * production) and the root config (logical root + caller frontmatter schema);
 * core wires Naming, the read models (Catalog, ReferenceGraph), ChangeEvents,
 * config, and the facade over them. `src/` still ships no adapter — the
 * adapter layer is an argument, never a core artifact.
 *
 * One schema per logical catalog root. Roots with several document types
 * use a `Schema.Union` frontmatter schema in a single instance, or separate
 * instances with disjoint roots; every instance carries its own integrity
 * graph and event bus (see README).
 */
export const Core = {
  layer: <Bucket>(
    blobStoreLayer: Layer.Layer<BlobStore, never, Bucket>,
    config: CatalogRootConfig,
  ) => {
    const configLayer = Layer.succeed(CatalogRoot, config)
    const infra = Layer.provideMerge(
      Layer.merge(
        Layer.merge(Naming.layer, configLayer),
        Layer.merge(ReferenceGraph.layer, Catalog.layer),
      ),
      ChangeEvents.layer,
    )
    const storeLayer = Layer.effect(
      DocumentStore,
      Effect.sync(() => documentStoreShape),
    )

    // provideMerge (not provide): consumer effects still require BlobStore and
    // the config reference, so they must stay visible for `Effect.provide` to
    // cancel them. The composed layer keeps only the blob layer's own
    // requirements (`Bucket`) open.
    //
    // The single boundary cast: this rc does not thread the `Context.Reference`
    // output of `configLayer` through merged `Layer` unions, so the type-level
    // output would silently drop the config service (runtime is correct — the
    // layer is merged in). The cast re-declares the full output for callers.
    return Layer.mergeAll(configLayer, infra, storeLayer).pipe(
      Layer.provideMerge(blobStoreLayer),
    ) as Layer.Layer<CoreProvides, never, Bucket>
  },
}
