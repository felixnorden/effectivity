/**
 * The Cloudflare plugin: a real capability registration over the Vite dev
 * engine. Tests run in pure Effect with fakes at the two host boundaries:
 * `ChildProcessSpawner` (plugin <-> OS) and `FileSystem` (plugin <->
 * consumer project filesystem), injected through the engine's host surface.
 * Secrets never land in generated artifacts; the admin password goes to
 * `.dev.vars` only.
 */
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, FileSystem, Layer, Scope, Sink, Stdio, Stream } from "effect"
import { ChildProcessSpawner, type ChildProcess } from "effect/unstable/process"
import {
  Build,
  Dev,
  dispatch,
  type Engine,
  PluginError,
  Preview,
  ProjectRoot,
  Seed,
  Sync,
} from "@effectivity/cli"
import { cloudflarePlugin, type CloudflarePluginConfig } from "../src/plugin.ts"

interface SpawnRecord {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly options: ChildProcess.CommandOptions
}

/** A ChildProcessSpawner stub: records every spawn and returns a fixed exit code. */
const fakeSpawner = (spawns: SpawnRecord[], exitCode = 0) =>
  ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") {
        throw new Error("unexpected piped command in fake spawner")
      }
      spawns.push({ command: command.command, args: command.args, options: command.options })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1234),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    }),
  )

/**
 * A FileSystem stub backed by a write map. Reads return the written contents
 * (`.dev.vars` merges); `exists` answers true for the seed script.
 */
const fakeFilesystem = (writes: Map<string, string>, seedScript = true) =>
  FileSystem.layerNoop({
    exists: (path) =>
      Effect.succeed(writes.has(path) || (seedScript && path.endsWith("/scripts/seed.sh"))),
    makeDirectory: () => Effect.void,
    readFileString: (path) => Effect.succeed(writes.get(path) ?? ""),
    writeFileString: (path, data) =>
      Effect.sync(() => {
        writes.set(path, data)
      }),
  })

/** Build a requirement-free layer into a value for the engine host. */
const layerValue = <I, A>(layer: Layer.Layer<I>, tag: Context.Key<I, A>): A =>
  Context.get(Effect.runSync(Effect.scoped(Layer.build(layer))), tag)

const testStdio = layerValue(Stdio.layerTest({}), Stdio.Stdio)

const cfg: CloudflarePluginConfig = {
  name: "test-worker",
  r2: { bucket: "test-bucket" },
  d1: { name: "test-auth" },
  workerEntry: "src/index.ts",
  auth: {
    url: "http://localhost:8787",
    secret: "baked-secret",
    admin: { email: "a@example.com", password: "admin-seed-password-0123" },
  },
  catalog: { root: "docs" },
}

/** An engine whose single registration is the plugin, over fake host IO. */
const testEngine = (
  config: CloudflarePluginConfig = cfg,
  spawns: SpawnRecord[] = [],
  writes = new Map<string, string>(),
  seedScript = true,
): Engine => ({
  registrations: [cloudflarePlugin(config)],
  projectRoot: "/tmp/proj",
  host: {
    fs: layerValue(fakeFilesystem(writes, seedScript), FileSystem.FileSystem),
    spawner: fakeSpawner(spawns),
    stdio: testStdio,
  },
})

/** Run a capability from the engine, with the project root in the run context. */
const runCapability = <Identifier, Shape>(
  engine: Engine,
  tag: Context.Key<Identifier, Shape>,
  name: string,
  run: (service: Shape) => Effect.Effect<void, PluginError>,
): Effect.Effect<void, PluginError, Scope.Scope> =>
  dispatch(engine, tag, name, run).pipe(
    Effect.provide(Layer.succeed(ProjectRoot, engine.projectRoot)),
  )

describe("cloudflarePlugin sync", () => {
  it.effect("writes runtime.generated.ts with settings and no secrets", () => {
    const writes = new Map<string, string>()
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, [], writes), Sync, "sync", (c) => c.sync)

      const module = writes.get("/tmp/proj/src/runtime.generated.ts")!
      expect(module).toContain('"root": "docs"')
      expect(module).toContain('"url": "http://localhost:8787"')
      expect(module).toContain('"email": "a@example.com"')
      expect(module).toMatch(/as const/)
      expect(module).not.toMatch(/"password":/)
      expect(module).not.toContain("admin-seed-password-0123")
    })
  })

  it.effect("writes wrangler.jsonc with bindings only", () => {
    const writes = new Map<string, string>()
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, [], writes), Sync, "sync", (c) => c.sync)

      const raw = writes.get("/tmp/proj/wrangler.jsonc")!
      // Strip // comments (the emitted header) and parse the rest.
      const parsed = JSON.parse(raw.replaceAll(/^\s*\/\/.*$/gm, "")) as {
        name: string
        main: string
        r2_buckets: ReadonlyArray<{ binding: string; bucket_name: string }>
        d1_databases: ReadonlyArray<{ binding: string; database_name: string; database_id: string }>
        vars?: unknown
      }
      expect(parsed.name).toBe("test-worker")
      expect(parsed.main).toBe("src/index.ts")
      expect(parsed.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "test-bucket" }])
      expect(parsed.d1_databases).toEqual([
        {
          binding: "DB",
          database_name: "test-auth",
          database_id: "00000000-0000-0000-0000-000000000000",
        },
      ])
      expect(parsed).not.toHaveProperty("vars")
    })
  })

  it.effect("uses the d1 id from config when present, placeholder otherwise", () => {
    const noId = new Map<string, string>()
    const withId = new Map<string, string>()
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, [], noId), Sync, "sync", (c) => c.sync)
      const placeholderConfig = JSON.parse(
        noId.get("/tmp/proj/wrangler.jsonc")!.replaceAll(/^\s*\/\/.*$/gm, ""),
      ) as { d1_databases: ReadonlyArray<{ database_id: string }> }
      expect(placeholderConfig.d1_databases[0]!.database_id).toBe(
        "00000000-0000-0000-0000-000000000000",
      )

      yield* runCapability(
        testEngine({ ...cfg, d1: { name: "test-auth", id: "real-db-id" } }, [], withId),
        Sync,
        "sync",
        (c) => c.sync,
      )
      const realIdConfig = JSON.parse(
        withId.get("/tmp/proj/wrangler.jsonc")!.replaceAll(/^\s*\/\/.*$/gm, ""),
      ) as { d1_databases: ReadonlyArray<{ database_id: string }> }
      expect(realIdConfig.d1_databases[0]!.database_id).toBe("real-db-id")
    })
  })
})

describe("cloudflarePlugin dev", () => {
  it.effect("syncs, merges dev secrets into .dev.vars, then spawns vite dev", () => {
    const spawns: SpawnRecord[] = []
    const writes = new Map<string, string>()
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, spawns, writes), Dev, "dev", (c) =>
        c.dev({ port: 9000 }),
      )

      const devVars = writes.get("/tmp/proj/.dev.vars")!
      expect(devVars).toContain("AUTH_SECRET=baked-secret")
      expect(devVars).toContain("AUTH_ADMIN_PASSWORD=admin-seed-password-0123")
      // Sync artifacts were written first.
      expect(writes.has("/tmp/proj/wrangler.jsonc")).toBe(true)
      expect(writes.has("/tmp/proj/src/runtime.generated.ts")).toBe(true)

      const spawn = spawns[0]!
      expect(spawn.command).toBe("bun")
      expect(spawn.args).toEqual(["x", "vite", "dev", "--port", "9000"])
      expect(spawn.options.stdout).toBe("inherit")
      expect(spawn.options.stderr).toBe("inherit")
      expect(spawn.options.extendEnv).toBe(true)
    })
  })
})

describe("cloudflarePlugin build and preview", () => {
  it.effect("build regenerates then spawns vite build", () => {
    const spawns: SpawnRecord[] = []
    const writes = new Map<string, string>()
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, spawns, writes), Build, "build", (c) => c.build)

      expect(writes.has("/tmp/proj/wrangler.jsonc")).toBe(true)
      expect(spawns[0]!.args).toEqual(["x", "vite", "build"])
    })
  })

  it.effect("preview spawns vite preview", () => {
    const spawns: SpawnRecord[] = []
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, spawns), Preview, "preview", (c) => c.preview)

      const spawn = spawns[0]!
      expect(spawn.command).toBe("bun")
      expect(spawn.args).toEqual(["x", "vite", "preview"])
    })
  })
})

describe("cloudflarePlugin seed", () => {
  it.effect("spawns bash scripts/seed.sh with CMS_URL and ORIGIN env", () => {
    const spawns: SpawnRecord[] = []
    return Effect.gen(function* () {
      yield* runCapability(testEngine(cfg, spawns), Seed, "seed", (c) =>
        c.seed({ url: "https://cms.example.com" }),
      )

      const spawn = spawns[0]!
      expect(spawn.command).toBe("bash")
      expect(spawn.args).toEqual(["/tmp/proj/scripts/seed.sh"])
      expect(spawn.options.env).toEqual({
        CMS_URL: "https://cms.example.com",
        ORIGIN: "http://localhost:8787",
      })
      expect(spawn.options.extendEnv).toBe(true)
      expect(spawn.options.stdout).toBe("inherit")
    })
  })

  it.effect("fails with PluginError when scripts/seed.sh is missing", () =>
    Effect.gen(function* () {
      const failure = yield* runCapability(
        testEngine(cfg, [], new Map<string, string>(), false),
        Seed,
        "seed",
        (c) => c.seed({ url: "http://localhost:8788" }),
      ).pipe(Effect.flip)
      expect(failure.message).toContain("scripts/seed.sh")
    }),
  )
})
