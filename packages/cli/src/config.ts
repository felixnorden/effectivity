/**
 * The generic engine config surface. A project keeps its settings in
 * `effectivity.config.ts` (or .mjs/.cjs), default-exporting the result of
 * `defineConfig(...)`:
 *
 * ```ts
 * import { defineConfig } from "@effectivity/cli"
 * import { cloudflarePlugin } from "@effectivity/cloudflare"
 *
 * export default defineConfig({
 *   plugins: [
 *     cloudflarePlugin({
 *       name: "effectivity-cms",
 *       r2: { bucket: "effectivity-cms" },
 *       d1: { name: "effectivity-auth" },
 *     }),
 *   ],
 * })
 * ```
 *
 * The CLI engine loads this file and runs every registration it lists, in
 * order, against the host IO the engine provides. Platform specifics are
 * arguments to plugin factories, never fields here.
 */
import type { AnyPluginRegistration } from "./plugin.ts"

export interface EffectivityConfig {
  /**
   * Ordered list of named plugin registrations. The engine keeps the order:
   * a platform operation runs on every registration that provides its
   * capability, in this order, and stops at the first failure.
   */
  readonly plugins?: ReadonlyArray<AnyPluginRegistration>
}

/** Engine defaults: no plugins, so help works and commands fail with a clear "No plugin registered". */
export const ENGINE_DEFAULTS: Required<EffectivityConfig> = {
  plugins: [],
}

/**
 * Vite-style entry: type-checks the config object and passes it through.
 * The engine resolves defaults afterwards via {@link ENGINE_DEFAULTS}.
 *
 * The parameter is typed as `EffectivityConfig` directly, not as a generic
 * constrained by it. A generic parameter suppresses the excess-property check
 * as soon as the object literal carries one known property (`plugins`), which
 * would let an unknown top-level field through.
 */
export const defineConfig = (config: EffectivityConfig): EffectivityConfig => config
