import { defineConfig } from "../src/config.ts"

// @ts-expect-error cloudflare sections no longer exist on EffectivityConfig
export const bad = defineConfig({ cloudflare: { r2: { bucket: "x" } } })