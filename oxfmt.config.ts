import { defineConfig } from "oxfmt"

export default defineConfig({
  semi: false,
  quote: "double",
  printWidth: 100,
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/worker-configuration.d.ts",
  ],
})
