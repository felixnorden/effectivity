/**
 * The Worker adapter: binds an app composition to one instance's generated
 * settings. The instance owns its `runtime.generated.ts` module (written by
 * `effectivity sync`) and passes it here, so one library serves any number of
 * deployments.
 *
 * `env` is stable per isolate after the first request, so the composition
 * (migrations, seed, auth instance, app handler) is built once and reused.
 */
import type { RuntimeSettings } from "./artifacts.ts"
import { createComposition, type WorkerEnv } from "./composition.ts"

/** The Worker object shape the runtime calls: one `fetch` entry. */
export interface Worker {
  fetch(request: Request, env: WorkerEnv): Promise<Response>
}

/** Bind one instance's generated settings to a Worker. `env` is stable per
 * isolate after the first request, so the composition (migrations, seed, auth
 * instance, app handler) is built once and reused. */
export const makeWorker = (settings: RuntimeSettings): Worker => {
  let composition: ReturnType<typeof createComposition> | undefined
  return {
    fetch(request: Request, env: WorkerEnv): Promise<Response> {
      composition ??= createComposition(env, settings)
      return composition.fetch(request)
    },
  }
}
