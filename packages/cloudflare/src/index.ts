/**
 * @effectivity/cloudflare — Cloudflare Workers runtime library.
 *
 * The R2 byte adapter feeds @effectivity/core over a Workers R2 binding, and
 * `createComposition` / `makeWorker` serve the api app (R2-backed catalog,
 * D1-backed identity, migrations + admin seed at first boot) with the
 * `/auth` namespace dispatched to Better Auth.
 *
 * This package is library-only. A runnable instance owns its
 * `effectivity.config.ts`, worker entry, and generated settings; see
 * `packages/examples` for the reference instance.
 */

export { r2BlobStore } from "./r2-blob-store.ts"
export { r2Layer } from "./r2-layer.ts"
export { createComposition, type WorkerEnv } from "./composition.ts"
export { makeWorker, type Worker } from "./worker.ts"
export { cloudflarePlugin } from "./plugin.ts"
export type { CloudflarePluginConfig, ResolvedCloudflareConfig } from "./plugin.ts"
export type { RuntimeSettings, WranglerR2Binding, WranglerD1Binding } from "./artifacts.ts"
