import { Layer } from "effect"
import { BlobStore } from "@effectivity/core"
import { r2BlobStore } from "./r2-blob-store.ts"

/**
 * Provide the core byte seam over a Workers R2 binding. The Worker entry
 * resolves the binding from its environment and supplies it here; the layer
 * itself never touches `env` so tests can inject the emulated bucket.
 */
export const r2Layer = (
  bucket: R2Bucket,
  pageSize?: number,
): Layer.Layer<BlobStore, never, never> => Layer.succeed(BlobStore, r2BlobStore(bucket, pageSize))
