import { defineConfig } from "@effectivity/cli"

// Pre-refactor shape kept on purpose: the `cloudflare` field no longer exists
// on `EffectivityConfig`, so this fixture must fail the config-check project.
export default defineConfig({ cloudflare: { r2: { bucket: "x" } } })
