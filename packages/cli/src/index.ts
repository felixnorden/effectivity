/**
 * @effectivity/cli — an Effect-native command engine. A project keeps its
 * settings in `effectivity.config.ts` (Vite-style; see `defineConfig` in
 * `./config.ts`). The engine loads that file, captures the host IO and the
 * project root once, and runs each platform capability over the ordered
 * registrations a project lists — see `./plugin.ts` and `./dispatch.ts`.
 *
 * All Cloudflare orchestration lives in `@effectivity/cloudflare` behind its
 * plugin factory; nothing in this package knows about wrangler, R2, or D1.
 */

export { HostServices, PluginError, ProjectRoot, Sync, Dev, Build, Preview, Seed } from "./plugin.ts"
export type {
  AnyPluginRegistration,
  Capability,
  CommandDeclaration,
  CommandInput,
  DevOptions,
  FlagDeclaration,
  HostServicesShape,
  PluginRegistration,
  SeedOptions,
} from "./plugin.ts"
export { ENGINE_DEFAULTS, defineConfig } from "./config.ts"
export type { EffectivityConfig } from "./config.ts"
export { CONFIG_FILENAMES, findConfigFile, loadRawConfig } from "./loader.ts"
export type { LoadedConfig } from "./loader.ts"
export { boot, engineLayer } from "./engine.ts"
export type { Engine } from "./engine.ts"
export { dispatch, missingCapability } from "./dispatch.ts"
export { buildCli } from "./command.ts"
