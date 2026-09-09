import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"

/**
 * Runs the adapter tests inside the Workers runtime (workerd) with the local
 * R2/D1 emulators, per the Workers vitest integration. The test file imports
 * the `BUCKET` binding from `cloudflare:test`. Only the admin password is
 * injected as a binding: catalog origin, signing secret, and admin email come
 * from the baked runtime settings (src/runtime.generated.ts), and the password
 * is never baked — in dev it lives in .dev.vars, here in the pool bindings.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          AUTH_ADMIN_PASSWORD: "admin-seed-password-0123",
        },
      },
    }),
  ],
})
