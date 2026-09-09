import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { resolveConfig } from "../src/config.ts"
import {
  d1IdOf,
  generateRuntimeModule,
  generateWranglerConfig,
  mergeDevVars,
} from "../src/generate.ts"
import { findConfigFile, loadConfig } from "../src/loader.ts"

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "effectivity-cli-test-"))

describe("resolveConfig", () => {
  it("fills local-dev defaults", () => {
    const config = resolveConfig({})
    expect(config.name).toBe("effectivity-cms")
    expect(config.catalog.root).toBe("cms")
    expect(config.auth.url).toBe("http://localhost:8787")
    expect(config.auth.secret).toBe("dev-secret-0123456789abcdef0123456789abcdef")
    expect(config.auth.admin.email).toBe("admin@effectivity.local")
    expect(config.auth.admin.password).toBeUndefined()
    expect(config.cloudflare.r2.bucket).toBe("effectivity-cms")
    expect(config.cloudflare.d1.name).toBe("effectivity-auth")
    expect(config.cloudflare.d1.id).toBeUndefined()
  })

  it("passes overrides through without touching defaults", () => {
    const config = resolveConfig({
      name: "docs",
      catalog: { root: "site" },
      auth: {
        url: "https://cms.example.com",
        admin: { email: "a@example.com", password: "hunter2" },
      },
      cloudflare: { r2: { bucket: "docs-cms" }, d1: { name: "docs-auth", id: "abc-123" } },
    })
    expect(config.name).toBe("docs")
    expect(config.catalog.root).toBe("site")
    expect(config.auth.url).toBe("https://cms.example.com")
    expect(config.auth.admin.email).toBe("a@example.com")
    expect(config.auth.admin.password).toBe("hunter2")
    expect(config.cloudflare.r2.bucket).toBe("docs-cms")
    expect(config.cloudflare.d1.name).toBe("docs-auth")
    expect(config.cloudflare.d1.id).toBe("abc-123")
  })
})

describe("generateRuntimeModule", () => {
  it("bakes settings but never the admin password", () => {
    const config = resolveConfig({ auth: { admin: { password: "hunter2" } } })
    const text = generateRuntimeModule(config)
    expect(text).toContain('"root": "cms"')
    expect(text).toContain('"url": "http://localhost:8787"')
    expect(text).toContain('"email": "admin@effectivity.local"')
    expect(text).toContain("as const")
    expect(text).not.toContain("hunter2")
    expect(text).not.toMatch(/"password":/)
  })
})

describe("generateWranglerConfig", () => {
  const parseJsonc = (text: string): unknown => {
    // Strip // comments (the emitted header) and parse the rest.
    const stripped = text.replaceAll(/^\s*\/\/.*$/gm, "")
    return JSON.parse(stripped)
  }

  it("emits bindings only — no vars, real d1 id", () => {
    const config = resolveConfig({ cloudflare: { d1: { id: "real-id-42" } } })
    const parsed = parseJsonc(generateWranglerConfig(config, config.cloudflare.d1.id!))
    expect(parsed).toMatchObject({
      name: "effectivity-cms",
      main: "src/index.ts",
      r2_buckets: [{ binding: "BUCKET", bucket_name: "effectivity-cms" }],
      d1_databases: [
        { binding: "DB", database_name: "effectivity-auth", database_id: "real-id-42" },
      ],
    })
    expect(parsed).not.toHaveProperty("vars")
  })
})

describe("d1IdOf", () => {
  it("prefers deploy state over config over placeholder", () => {
    const config = resolveConfig({ cloudflare: { d1: { id: "from-config" } } })
    expect(d1IdOf(config, { d1Id: "from-state" })).toBe("from-state")
    expect(d1IdOf(config, {})).toBe("from-config")
    expect(d1IdOf(resolveConfig({}), {})).toBe("00000000-0000-0000-0000-000000000000")
  })
})

describe("mergeDevVars", () => {
  it("creates and merges, preserving hand-written keys", async () => {
    const dir = await tempDir()
    try {
      const first = await mergeDevVars(dir, { AUTH_SECRET: "s1", CUSTOM: "c1" })
      expect(first).toContain("AUTH_SECRET=s1")
      const second = await mergeDevVars(dir, { AUTH_SECRET: "s2", AUTH_ADMIN_PASSWORD: "p2" })
      expect(second).toContain("AUTH_SECRET=s2")
      expect(second).toContain("AUTH_ADMIN_PASSWORD=p2")
      expect(second).toContain("CUSTOM=c1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("findConfigFile", () => {
  it("walks up from a nested cwd and returns undefined in an empty tree", async () => {
    const dir = await tempDir()
    const empty = await tempDir()
    try {
      const nested = join(dir, "a", "b", "c")
      await mkdir(nested, { recursive: true })
      await writeFile(join(dir, "cms.config.ts"), "export default {}\n")
      expect(findConfigFile(nested)).toBe(join(dir, "cms.config.ts"))
      expect(findConfigFile(join(nested, "deeper", "still"))).toBe(join(dir, "cms.config.ts"))
      // A separate tree with no config: walk-up exhausts and returns undefined.
      await mkdir(join(empty, "deep"), { recursive: true })
      expect(findConfigFile(join(empty, "deep"))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe("loadConfig", () => {
  it("bundles a TS config that imports defineConfig, resolves defaults, cleans scratch", async () => {
    const dir = await tempDir()
    try {
      // A real project has @effectivity/cli installed; mirror that with a
      // symlink so the esbuild bundle resolves and inlines defineConfig.
      const pkg = join(dir, "node_modules", "@effectivity")
      await mkdir(pkg, { recursive: true })
      const cliRoot = join(fileURLToPath(new URL("..", import.meta.url)))
      await symlink(cliRoot, join(pkg, "cli"), "dir")
      await writeFile(
        join(dir, "cms.config.ts"),
        [
          'import { defineConfig } from "@effectivity/cli"',
          "export default defineConfig({",
          '  name: "loaded",',
          '  catalog: { root: "docs" },',
          '  auth: { url: "https://cms.example.com", admin: { password: "pw" } },',
          "})",
          "",
        ].join("\n"),
      )
      const { config, file, dir: configDir } = await loadConfig(undefined, dir)
      expect(file).toBe(join(dir, "cms.config.ts"))
      expect(configDir).toBe(dir)
      expect(config.name).toBe("loaded")
      expect(config.catalog.root).toBe("docs")
      expect(config.auth.url).toBe("https://cms.example.com")
      expect(config.auth.admin.password).toBe("pw")
      expect(config.cloudflare.r2.bucket).toBe("effectivity-cms")
      // The scratch bundle directory is removed after load.
      await expect(
        (await import("node:fs/promises")).stat(join(dir, ".cms")),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
