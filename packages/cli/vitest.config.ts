import { defineConfig } from "vitest/config"

// Plain vitest (no Workers pool): the CLI is host-side tooling.
export default defineConfig({
  test: {
    environment: "node",
  },
})
