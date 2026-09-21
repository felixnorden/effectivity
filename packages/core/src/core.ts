import { Layer } from "effect"
import { BlobStore } from "./blob-store.ts"
import { Catalog } from "./catalog.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import { DocumentStore } from "./document-store.ts"
import { ChangeEvents } from "./events.ts"
import { Naming } from "./naming.ts"
import { ReferenceGraph } from "./reference-graph.ts"

/**
 * The services the wired store group provides to consumers: the facade, the
 * read models, and the caller's blob layer (kept visible so effects can still
 * talk to the seam directly). The config reference stays internal: the read
 * models and facade capture it when their layers are built.
 */
export type CoreProvides =
  | DocumentStore
  | Naming
  | Catalog
  | ReferenceGraph
  | ChangeEvents
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

    // Read models capture BlobStore + CatalogRoot when their layers are
    // created, so their method signatures carry no requirements. BlobStore
    // stays in the output so consumers can still use the seam directly.
    const readModels = Layer.merge(Catalog.layer, ReferenceGraph.layer).pipe(
      Layer.provide(configLayer),
      Layer.provideMerge(blobStoreLayer),
    )

    // The facade captures the read models + Naming + ChangeEvents + config at
    // creation. Its output has no requirements of its own.
    const facade = DocumentStore.layer.pipe(
      Layer.provide(readModels),
      Layer.provide(configLayer),
      Layer.provide(Naming.layer),
      Layer.provide(ChangeEvents.layer),
    )

    // Expose every service the caller may use. The same layer values feed both
    // the facade and the output, so the shared instances are built once.
    return Layer.mergeAll(configLayer, Naming.layer, ChangeEvents.layer, readModels, facade)
  },
}
