/**
 * @effectivity/cloudflare — Cloudflare Workers runtime package.
 *
 * The R2 byte adapter feeds @effectivity/core over a Workers R2 binding, and
 * the Worker entry dispatches the /auth namespace to the Better Auth handler
 * and serves everything else through the api app (R2-backed catalog, D1-
 * backed identity, migrations + admin seed at first boot).
 */

export { r2BlobStore } from "./r2-blob-store.ts"
export { r2Layer } from "./r2-layer.ts"
export { createComposition, type WorkerEnv } from "./composition.ts"
export { cloudflarePlugin } from "./plugin.ts"
export type { CloudflarePluginConfig, ResolvedCloudflareConfig } from "./plugin.ts"

import { createComposition } from "./composition.ts"

/**
 * The Worker object. env is stable per isolate after the first request, so
 * the composition (migrations, seed, auth instance, app handler) is built
 * once and reused.
 */
let composition: ReturnType<typeof createComposition> | undefined

export default {
  fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    composition ??= createComposition(env)
    return composition.fetch(request)
  },
}
