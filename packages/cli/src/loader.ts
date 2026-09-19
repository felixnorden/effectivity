/**
 * Vite-style config loading: find `effectivity.config.{ts,mts,mjs,js,cjs}`
 * (walking up from the working directory like Vite and wrangler do), bundle
 * TypeScript configs with esbuild, and import them. The config module may
 * import `@effectivity/cli` for `defineConfig` and plugin factories from any
 * platform package; the bundle is discarded after load.
 *
 * A MISSING config is NOT an error (A7): `loadRawConfig` returns `null` so
 * the engine falls back to defaults (help works anywhere). A PRESENT but
 * broken config rejects — the caller surfaces the error and exits nonzero.
 */
import { build } from "esbuild"
import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { EffectivityConfig } from "./config.ts"

/** Candidate names, in priority order (same family as `vite.config.*`). */
export const CONFIG_FILENAMES = [
  "effectivity.config.ts",
  "effectivity.config.mts",
  "effectivity.config.mjs",
  "effectivity.config.js",
  "effectivity.config.cjs",
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

export interface LoadedConfig<T = EffectivityConfig> {
  readonly config: T
  /** Absolute path of the config file that was loaded. */
  readonly file: string
  /** Directory of the config file: project root for all generated artifacts. */
  readonly dir: string
}

/**
 * Load a project config file. `explicit` is a path relative to `startDir`;
 * when omitted the config is discovered by walking up. Returns `null` when no
 * config file exists (engine defaults); rejects when a config file is found
 * but fails to build/parse (never silently falls back, A7).
 *
 * The config is returned raw: no defaults are applied here — the engine
 * merges `ENGINE_DEFAULTS` instead (the config's `plugins` list is read
 * as-is).
 */
export const loadRawConfig = async (
  explicit?: string,
  startDir: string = process.cwd(),
): Promise<LoadedConfig<EffectivityConfig> | null> => {
  const file = explicit !== undefined ? resolve(startDir, explicit) : findConfigFile(startDir)
  if (file === undefined) {
    return null
  }
  let loaded: unknown
  if (/\.(js|mjs|cjs)$/.test(file)) {
    // Plain JS configs import directly; cache-bust in case the file changed.
    loaded = await import(pathToFileURL(file).href + `?t=${Date.now()}`)
  } else {
    // Bundle into a scratch dir inside the project. The config's imports of
    // @effectivity/cli and platform plugin factories (and the Effect runtime
    // they pull in) are bundled inline, so the emitted module is
    // self-contained: service-tag identity is string-keyed, which keeps the
    // inlined copy interoperable with the host CLI (verified).
    const scratch = join(dirname(file), ".effectivity")
    try {
      await mkdir(scratch, { recursive: true })
      const outfile = join(scratch, "effectivity.config.mjs")
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
    throw new Error(`effectivity.config at ${file} must default-export an EffectivityConfig object`)
  }
  return { config: raw as EffectivityConfig, file, dir: dirname(file) }
}