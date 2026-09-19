/**
 * Vite dev/build/preview for the reference Worker. The Cloudflare plugin
 * loads bindings, main, compatibility_date and compat flags from the
 * generated wrangler.jsonc; dev runs the Worker in workerd with HMR.
 */
import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [cloudflare()],
})