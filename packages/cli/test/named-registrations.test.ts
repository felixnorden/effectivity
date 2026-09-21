/**
 * Named plugin registrations, exercised through the real CLI entry as a
 * subprocess. The config file is text handed to the loader, so these cases
 * compile before and after the contract change and fail only on behavior:
 * every registered plugin appears as a namespaced command group, and boot
 * rejects a nameless or duplicated registration with a message that names the
 * offending position.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url))
const cliEntry = join(repoRoot, "packages", "cli", "src", "cli.ts")

/** A project-shaped node_modules: @effectivity/cli and effect resolve by symlink. */
const tempProject = async (config: string | null): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "effectivity-named-test-"))
  const pkg = join(dir, "node_modules", "@effectivity")
  await mkdir(pkg, { recursive: true })
  await symlink(join(repoRoot, "packages", "cli"), join(pkg, "cli"), "dir")
  await symlink(
    join(repoRoot, "packages", "cli", "node_modules", "effect"),
    join(dir, "node_modules", "effect"),
    "dir",
  )
  if (config !== null) {
    await writeFile(join(dir, "effectivity.config.ts"), config)
  }
  return dir
}

const runCli = (
  dir: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn("bun", [cliEntry, ...args], { cwd: dir })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })

/**
 * Stub registrations built from the inlined `effect` copy: the host runtime
 * executes the bundled config through string-keyed service tags, so the
 * no-op capability implementations interoperate with the host CLI.
 */
const STUB_HEADER = [
  'import { defineConfig, Sync, Dev, Build, Preview, Seed } from "@effectivity/cli"',
  'import { Effect, Layer } from "effect"',
  "",
  "const registration = (name?: string) => ({",
  "  name,",
  "  capabilities: () =>",
  "    Layer.mergeAll(",
  "      Layer.succeed(Sync, Sync.of({ sync: Effect.void })),",
  "      Layer.succeed(Dev, Dev.of({ dev: () => Effect.void })),",
  "      Layer.succeed(Build, Build.of({ build: Effect.void })),",
  "      Layer.succeed(Preview, Preview.of({ preview: Effect.void })),",
  "      Layer.succeed(Seed, Seed.of({ seed: () => Effect.void })),",
  "    ),",
  "  commands: [],",
  "})",
  "",
].join("\n")

const configWith = (entries: string): string =>
  `${STUB_HEADER}export default defineConfig({ plugins: [${entries}] })\n`

describe("named plugin registrations", () => {
  it("lists a command group for each registered plugin in the root help", async () => {
    const dir = await tempProject(configWith('registration("alpha"), registration("beta")'))
    try {
      const { code, stdout } = await runCli(dir, ["--help"])
      expect(code).toBe(0)
      expect(stdout).toContain("alpha")
      expect(stdout).toContain("beta")
      for (const engineCommand of ["sync", "dev", "build", "preview", "seed", "init"]) {
        expect(stdout).toContain(engineCommand)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("describes a registered plugin's group when its name is passed", async () => {
    const dir = await tempProject(configWith('registration("alpha")'))
    try {
      const { code, stdout } = await runCli(dir, ["alpha", "--help"])
      expect(code).toBe(0)
      expect(stdout).toContain("alpha")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("fails naming the position when a registration has no name", async () => {
    const dir = await tempProject(configWith('registration("alpha"), registration()'))
    try {
      const { code, stderr } = await runCli(dir, ["sync"])
      expect(code).not.toBe(0)
      expect(stderr).toContain("1")
      expect(stderr.toLowerCase()).toContain("name")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("fails naming both positions when two registrations share a name", async () => {
    const dir = await tempProject(configWith('registration("alpha"), registration("alpha")'))
    try {
      const { code, stderr } = await runCli(dir, ["--help"])
      expect(code).not.toBe(0)
      expect(stderr).toContain("alpha")
      expect(stderr).toContain("0")
      expect(stderr).toContain("1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("lists the engine commands when no config file exists anywhere above", async () => {
    const dir = await tempProject(null)
    try {
      const { code, stdout } = await runCli(dir, ["--help"])
      expect(code).toBe(0)
      for (const engineCommand of ["sync", "dev", "build", "preview", "seed", "init"]) {
        expect(stdout).toContain(engineCommand)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
