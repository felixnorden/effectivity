import { defineConfig } from "../src/config.ts"

// @ts-expect-error cloudflare sections no longer exist on EffectivityConfig
export const bad = defineConfig({ cloudflare: { r2: { bucket: "x" } } })

// An unknown top-level field is rejected even when `plugins` is present: the
// parameter is typed directly, so excess-property checking applies.
// @ts-expect-error unknown top-level field
export const badWithPlugins = defineConfig({
  plugins: [],
  cloudflare: { r2: { bucket: "x" } },
})
