/**
 * `effectivity init`: writes a starter `effectivity.config.ts` in the
 * plugin-registration shape, then dispatches `sync` through the freshly
 * written config so a fresh init yields a runnable dev project immediately
 * (A10). All write I/O goes through the `FileSystem` service.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Command } from "effect/unstable/cli"
import { Effect, FileSystem, Layer } from "effect"
import { buildCli } from "../src/command.ts"
import { engineLayer } from "../src/engine.ts"
import { loadRawConfig } from "../src/loader.ts"
import { makeCliTestLayer, makeTestEngine, makeTestHost, recordingRegistration } from "./helpers.ts"

/** A FileSystem stub that records every write AND persists it to disk, so the
 * init->sync dispatch (which loads the just-written config via the real
 * esbuild loader) sees the file. */
const recordingFilesystem = (writes: Map<string, string>) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(writes.has(path) || existsSync(path)),
    makeDirectory: (path) =>
      Effect.sync(() => {
        mkdirSync(path, { recursive: true })
      }),
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.set(path, data)
        writeFileSync(path, data)
      }),
  })

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "effectivity-init-test-"))

/** Wire @effectivity/cli + @effectivity/cloudflare into a project-shaped node_modules. */
const linkPkgs = async (dir: string): Promise<void> => {
  const pkg = join(dir, "node_modules", "@effectivity")
  await mkdir(pkg, { recursive: true })
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
  await symlink(join(repoRoot, "packages", "cli"), join(pkg, "cli"), "dir")
  await symlink(join(repoRoot, "packages", "cloudflare"), join(pkg, "cloudflare"), "dir")
}

const runInit = (dir: string, writes: Map<string, string>) => {
  const host = makeTestHost(recordingFilesystem(writes))
  const engine = makeTestEngine(
    [recordingRegistration("stub", { syncs: [], ports: [], urls: [] })],
    host,
  )
  return Command.runWith(buildCli(engine), { version: "0.0.0" })(["init", dir]).pipe(
    Effect.provide(
      Layer.mergeAll(
        makeCliTestLayer(["init", dir], recordingFilesystem(writes)),
        engineLayer(engine),
      ),
    ),
  ).pipe(Effect.scoped)
}

describe("init command", () => {
  it("writes effectivity.config.ts, never cms.config.ts", async () => {
    const dir = await tempDir()
    await linkPkgs(dir)
    const writes = new Map<string, string>()
    await Effect.runPromise(runInit(dir, writes))
    expect(writes.has(join(dir, "effectivity.config.ts"))).toBe(true)
    expect(writes.has(join(dir, "cms.config.ts"))).toBe(false)
    await rm(dir, { recursive: true, force: true })
  })

  it("template imports cloudflarePlugin from @effectivity/cloudflare", async () => {
    const dir = await tempDir()
    await linkPkgs(dir)
    const writes = new Map<string, string>()
    await Effect.runPromise(runInit(dir, writes))
    const content = writes.get(join(dir, "effectivity.config.ts"))!
    expect(content).toContain('"@effectivity/cloudflare"')
    expect(content).toContain("cloudflarePlugin")
    await rm(dir, { recursive: true, force: true })
  })

  it("template calls defineConfig with a plugins array", async () => {
    const dir = await tempDir()
    await linkPkgs(dir)
    const writes = new Map<string, string>()
    await Effect.runPromise(runInit(dir, writes))
    const content = writes.get(join(dir, "effectivity.config.ts"))!
    expect(content).toContain("defineConfig({")
    expect(content).toContain("plugins:")
    expect(content).toContain("cloudflarePlugin(")
    await rm(dir, { recursive: true, force: true })
  })

  it("dispatches sync after writing (artifact parity, A10)", async () => {
    const dir = await tempDir()
    await linkPkgs(dir)
    const writes = new Map<string, string>()
    await Effect.runPromise(runInit(dir, writes))
    // The written config registers the real cloudflare plugin; the
    // init->sync dispatch regenerates both artifacts through it.
    expect(writes.has(join(dir, "wrangler.jsonc"))).toBe(true)
    expect(writes.has(join(dir, "src", "runtime.generated.ts"))).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it("skips writing when effectivity.config.ts already exists", async () => {
    const dir = await tempDir()
    await linkPkgs(dir)
    const existing = [
      "// custom hand-authored config — never overwritten by init",
      'import { defineConfig } from "@effectivity/cli"',
      'import { cloudflarePlugin } from "@effectivity/cloudflare"',
      "export default defineConfig({ plugins: [cloudflarePlugin({",
      '  r2: { bucket: "custom-bucket" },',
      '  d1: { name: "custom-auth" },',
      "})] })",
      "",
    ].join("\n")
    writeFileSync(join(dir, "effectivity.config.ts"), existing)
    const writes = new Map<string, string>()
    await Effect.runPromise(runInit(dir, writes))

    // init warned and did NOT write the template over it.
    expect(writes.has(join(dir, "effectivity.config.ts"))).toBe(false)
    const onDisk = readFileSync(join(dir, "effectivity.config.ts"), "utf8")
    expect(onDisk).toContain("custom hand-authored")
    expect(onDisk).not.toContain("admin-seed-password-0123")
    await rm(dir, { recursive: true, force: true })
  })
})

describe("consumer config loading", () => {
  it("the real packages/cloudflare effectivity.config.ts loads via loadRawConfig", async () => {
    const configPath = join(
      fileURLToPath(new URL("../..", import.meta.url)),
      "cloudflare",
      "effectivity.config.ts",
    )
    const loaded = await loadRawConfig(configPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.config.plugins).toHaveLength(1)
  })
})