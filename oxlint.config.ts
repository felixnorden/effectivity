import { defineConfig } from "oxlint"

export default defineConfig({
  categories: {
    correctness: "error",
    perf: "warn",
    pedantic: "warn"
  },
  rules: {
    "no-console": "warn"
  },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**"
  ]
})
