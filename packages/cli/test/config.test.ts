import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { findConfigFile, loadRawConfig } from "../src/loader.ts"

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "effectivity-cli-test-"))

describe("findConfigFile", () => {
  it("walks up from a nested cwd and returns undefined in an empty tree", async () => {
    const dir = await tempDir()
    const empty = await tempDir()
    try {
      const nested = join(dir, "a", "b", "c")
      await mkdir(nested, { recursive: true })
      await writeFile(join(dir, "effectivity.config.ts"), "export default {}\n")
      expect(findConfigFile(nested)).toBe(join(dir, "effectivity.config.ts"))
      expect(findConfigFile(join(nested, "deeper", "still"))).toBe(
        join(dir, "effectivity.config.ts"),
      )
      // A separate tree with no config: walk-up exhausts and returns undefined.
      await mkdir(join(empty, "deep"), { recursive: true })
      expect(findConfigFile(join(empty, "deep"))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe("loadRawConfig", () => {
  it("bundles a TS config importing defineConfig, returns it raw, cleans scratch", async () => {
    const dir = await tempDir()
    try {
      // A real project has @effectivity/cli installed; mirror that with a
      // symlink so the esbuild bundle resolves and inlines defineConfig.
      const pkg = join(dir, "node_modules", "@effectivity")
      await mkdir(pkg, { recursive: true })
      const cliRoot = join(fileURLToPath(new URL("..", import.meta.url)))
      await symlink(cliRoot, join(pkg, "cli"), "dir")
      await writeFile(
        join(dir, "effectivity.config.ts"),
        [
          'import { defineConfig } from "@effectivity/cli"',
          "export default defineConfig({ plugins: [] })",
          "",
        ].join("\n"),
      )
      const loaded = await loadRawConfig(undefined, dir)
      expect(loaded).not.toBeNull()
      expect(loaded!.file).toBe(join(dir, "effectivity.config.ts"))
      expect(loaded!.dir).toBe(dir)
      expect(loaded!.config.plugins).toEqual([])
      // The scratch bundle directory is removed after load.
      await expect(
        (await import("node:fs/promises")).stat(join(dir, ".effectivity")),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null (not an error) when no config exists", async () => {
    const dir = await tempDir()
    try {
      expect(await loadRawConfig(undefined, dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
