/**
 * The engine lifecycle: config discovery, boot (host capture + registration
 * validation + project root), the engine layer, and dispatch's routing. Tests
 * use stub registrations at the engine boundary; real bundling is covered in
 * the loadRawConfig cases.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { dispatch } from "../src/dispatch.ts"
import { boot, engineLayer } from "../src/engine.ts"
import { findConfigFile, loadRawConfig } from "../src/loader.ts"
import { HostServices, ProjectRoot, Sync } from "../src/plugin.ts"
import { makeTestEngine, makeTestHost, type Recording, recordingRegistration } from "./helpers.ts"

const tempDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "effectivity-engine-test-"))

const emptyRecords = (): Recording => ({ syncs: [], ports: [], urls: [] })

/** A real-project-shaped node_modules: @effectivity/cli resolves through a symlink. */
const linkCliPkg = async (dir: string): Promise<void> => {
  const pkg = join(dir, "node_modules", "@effectivity")
  await mkdir(pkg, { recursive: true })
  const cliRoot = join(fileURLToPath(new URL("..", import.meta.url)))
  await symlink(cliRoot, join(pkg, "cli"), "dir")
}

/** Write a config whose `plugins` array is the given JavaScript source. */
const writeConfig = async (dir: string, plugins: string): Promise<void> => {
  await linkCliPkg(dir)
  await writeFile(
    join(dir, "effectivity.config.ts"),
    [
      'import { defineConfig } from "@effectivity/cli"',
      `export default defineConfig({ plugins: [${plugins}] })`,
      "",
    ].join("\n"),
  )
}

/** Provide the test host surface so `boot` can run. */
const withHost = <A, E>(effect: Effect.Effect<A, E, HostServices>) =>
  effect.pipe(Effect.provide(Layer.succeed(HostServices, makeTestHost())))

describe("findConfigFile", () => {
  it("discovers effectivity.config.ts by walking up from a nested directory", async () => {
    const dir = await tempDir()
    try {
      const nested = join(dir, "a", "b", "c")
      await mkdir(nested, { recursive: true })
      await writeFile(join(dir, "effectivity.config.ts"), "export default {}\n")
      expect(findConfigFile(nested)).toBe(join(dir, "effectivity.config.ts"))
      expect(findConfigFile(join(nested, "deeper", "still"))).toBe(
        join(dir, "effectivity.config.ts"),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns undefined when no config file exists in any ancestor", async () => {
    const dir = await tempDir()
    try {
      await mkdir(join(dir, "deep"), { recursive: true })
      expect(findConfigFile(join(dir, "deep"))).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("loadRawConfig", () => {
  it("bundles a TS config and resolves its plugins array", async () => {
    const dir = await tempDir()
    try {
      await writeConfig(dir, '{ name: "alpha", capabilities: () => null, commands: [] }')
      const loaded = await loadRawConfig(undefined, dir)
      expect(loaded).not.toBeNull()
      expect(loaded!.config.plugins).toHaveLength(1)
      expect(loaded!.dir).toBe(dir)
      expect(loaded!.file).toBe(join(dir, "effectivity.config.ts"))
      // The scratch bundle directory is removed after load.
      await expect(
        (await import("node:fs/promises")).stat(join(dir, ".effectivity")),
      ).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when no config file exists anywhere above", async () => {
    const dir = await tempDir()
    try {
      expect(await loadRawConfig(undefined, dir)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("engineLayer", () => {
  it.effect("provides ProjectRoot with the project root argument", () =>
    Effect.gen(function* () {
      const root = yield* ProjectRoot
      expect(root).toBe("/tmp/proj")
    }).pipe(Effect.provide(engineLayer(makeTestEngine([], makeTestHost(), "/tmp/proj")))),
  )
})

describe("dispatch", () => {
  it.effect("runs the first registration that provides the capability", () => {
    const records = emptyRecords()
    const engine = makeTestEngine([
      recordingRegistration("alpha", records, ["seed"]),
      recordingRegistration("beta", records, ["sync"]),
    ])
    return Effect.gen(function* () {
      yield* dispatch(engine, Sync, "sync", (capability) => capability.sync)
      expect(records.syncs).toEqual(["beta"])
    })
  })
})

describe("boot", () => {
  it("missing config is not an error: falls back to an empty registration list", async () => {
    const dir = await tempDir()
    try {
      const engine = await Effect.runPromise(withHost(boot(undefined, dir)))
      expect(engine.registrations).toEqual([])
      expect(engine.projectRoot).toBe(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("loads a real config and provides its directory as projectRoot", async () => {
    const dir = await tempDir()
    try {
      await writeConfig(dir, '{ name: "alpha", capabilities: () => null, commands: [] }')
      const engine = await Effect.runPromise(withHost(boot(undefined, dir)))
      expect(engine.registrations).toHaveLength(1)
      expect(engine.registrations[0]!.name).toBe("alpha")
      expect(engine.projectRoot).toBe(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("present-but-broken config rejects boot (never silently falls back)", async () => {
    const dir = await tempDir()
    try {
      await writeFile(join(dir, "effectivity.config.ts"), "export default { plugins: [ }")
      await expect(Effect.runPromise(withHost(boot(undefined, dir)))).rejects.toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects a nameless registration, naming its position", async () => {
    const dir = await tempDir()
    try {
      await writeConfig(dir, "{ capabilities: () => null, commands: [] }")
      const failure = await Effect.runPromise(withHost(boot(undefined, dir)).pipe(Effect.flip))
      expect(failure.message).toContain("position 0")
      expect(failure.message.toLowerCase()).toContain("name")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects duplicated registration names, naming both positions", async () => {
    const dir = await tempDir()
    try {
      await writeConfig(
        dir,
        '{ name: "alpha", capabilities: () => null, commands: [] }, ' +
          '{ name: "alpha", capabilities: () => null, commands: [] }',
      )
      const failure = await Effect.runPromise(withHost(boot(undefined, dir)).pipe(Effect.flip))
      expect(failure.message).toContain("alpha")
      expect(failure.message).toContain("positions 0 and 1")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
