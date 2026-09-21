/**
 * Artifact-shape ownership: `RuntimeSettings`, `WranglerR2Binding`, and
 * `WranglerD1Binding` describe generated artifacts that only this package
 * reads or writes, so they are published here and no longer by
 * `@effectivity/cli`. The `satisfies` clauses below are compile-time proof
 * that the shapes are importable from this package entry.
 */
import { describe, expect, it } from "@effect/vitest"
import type { RuntimeSettings, WranglerD1Binding, WranglerR2Binding } from "@effectivity/cloudflare"

const settings = {
  catalog: { root: "cms" },
  auth: { url: "http://localhost:8787", secret: "s", admin: { email: "a@example.com" } },
} as const satisfies RuntimeSettings

const r2Binding = {
  binding: "BUCKET",
  bucket_name: "effectivity-cms",
} as const satisfies WranglerR2Binding

const d1Binding = {
  binding: "DB",
  database_name: "effectivity-auth",
  database_id: "00000000-0000-0000-0000-000000000000",
} as const satisfies WranglerD1Binding

describe("artifact shapes", () => {
  it("are importable from the package entry and describe the generated artifacts", () => {
    expect(settings.catalog.root).toBe("cms")
    expect(r2Binding.bucket_name).toBe("effectivity-cms")
    expect(d1Binding.database_name).toBe("effectivity-auth")
  })

  it("are not runtime exports of the engine entry", async () => {
    const cli = await import("@effectivity/cli")
    expect(cli).not.toHaveProperty("RuntimeSettings")
    expect(cli).not.toHaveProperty("WranglerR2Binding")
    expect(cli).not.toHaveProperty("WranglerD1Binding")
  })
})
