/**
 * Vite-style config loading: find `cms.config.{ts,mts,mjs,js,cjs}` (walking
 * up from the working directory like Vite and wrangler do), bundle TypeScript
 * configs with esbuild, import them, and normalize into the full resolved
 * shape. The config module may import `@effectivity/cli` for `defineConfig`
 * and anything else the author needs; the bundle is discarded after load.
 */
import { build } from "esbuild"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveConfig, type CmsConfig, type ResolvedCmsConfig } from "./config.ts"

/** Candidate names, in priority order (same family as `vite.config.*`). */
export const CONFIG_FILENAMES = [
  "cms.config.ts",
  "cms.config.mts",
  "cms.config.mjs",
  "cms.config.js",
  "cms.config.cjs",
]

/** Find the nearest config file at or above `startDir`(inclusive). */
export const findConfigFile = (startDir: string): string | undefined => {
  let dir = resolve(startDir)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        return candidate
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

export interface LoadedConfig {
  readonly config: ResolvedCmsConfig
  /** Absolute path of the config file that was loaded. */
  readonly file: string
  /** Directory of the config file: project root for all generated artifacts. */
  readonly dir: string
}

/**
 * Load and resolve a project config. `explicit` is a path relative to
 * `startDir`; when omitted the config is discovered by walking up.
 */
export const loadConfig = async (
  explicit?: string,
  startDir: string = process.cwd(),
): Promise<LoadedConfig> => {
  const file = explicit !== undefined ? resolve(startDir, explicit) : findConfigFile(startDir)
  if (file === undefined) {
    throw new Error(
      `no cms.config.{ts,mts,mjs,js,cjs} found in ${startDir} or its parents — run \`effectivity init\` first`,
    )
  }
  let loaded: unknown
  if (/\.(js|mjs|cjs)$/.test(file)) {
    // Plain JS configs import directly; cache-bust in case the file changed.
    loaded = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
  } else {
    // Bundle into a scratch dir inside the project. The config's import of
    // @effectivity/cli (and anything else it pulls in) is bundled inline, so
    // the emitted module is self-contained: importing it needs only the
    // project's own dependencies, resolved from the config file at build time.
    const scratch = join(dirname(file), ".cms")
    try {
      await mkdir(scratch, { recursive: true })
      const outfile = join(scratch, "cms.config.mjs")
      await build({
        entryPoints: [file],
        outfile,
        bundle: true,
        format: "esm",
        platform: "node",
        logLevel: "silent",
      })
      loaded = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  const raw = (loaded as { readonly default?: unknown }).default
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`cms.config at ${file} must default-export a CmsConfig object`)
  }
  return { config: resolveConfig(raw as CmsConfig), file, dir: dirname(file) }
}
