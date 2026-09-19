import { defineConfig } from "vitest/config"

/**
 * Node-environment tests. They spawn the TypeScript compiler to prove that the
 * consumer config file is covered by a type-check task; the default
 * `vitest.config.ts` runs the Worker tests in the Workers pool, where
 * `node:child_process` is not implemented.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/node/**/*.test.ts"],
  },
})
