/**
 * @effectivity/examples — the reference Worker instance.
 *
 * The runtime is library-only (`@effectivity/cloudflare`); this entry binds it
 * to the instance's generated settings. `effectivity sync` writes
 * `src/runtime.generated.ts` from `effectivity.config.ts`.
 */
import { makeWorker } from "@effectivity/cloudflare"
import { settings } from "./runtime.generated.ts"

export default makeWorker(settings)
