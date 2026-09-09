/**
 * @effectivity/cli — configure, generate, and run an effectivity CMS instance.
 *
 * A project keeps its settings in `cms.config.ts` (Vite-style; see
 * `defineConfig` in `./config.ts`). The CLI loads that file the way Vite
 * loads `vite.config.ts`, then derives the deployable surface:
 *
 * - `wrangler.jsonc`  — bindings-only Workers config (R2 + D1 + observability)
 * - `src/runtime.generated.ts` — the settings object baked into the worker
 *   bundle, so catalog/auth origins and the dev signing secret are NOT env
 *   vars an operator must set by hand.
 *
 * Secrets stay off the bundle: the admin password goes to `.dev.vars` (dev)
 * or `wrangler secret put` (deploy); production overlays any baked value by
 * setting `AUTH_SECRET` / `AUTH_URL` / `AUTH_ADMIN_*` in an environment.
 */

export {
  defineConfig,
  resolveConfig,
  DEFAULT_SECRET,
  DEFAULT_ADMIN_PASSWORD,
  type CmsConfig,
  type ResolvedCmsConfig,
} from "./config.ts"
export { findConfigFile, loadConfig, type LoadedConfig } from "./loader.ts"
export {
  sync,
  generateRuntimeModule,
  generateWranglerConfig,
  readState,
  writeState,
  runtimeModulePath,
  wranglerConfigPath,
  statePath,
  type CmsState,
} from "./generate.ts"
export {
  syncCommand,
  devCommand,
  provisionCommand,
  deployCommand,
  seedCommand,
  initCommand,
} from "./commands.ts"
