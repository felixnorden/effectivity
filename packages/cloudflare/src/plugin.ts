/**
 * The Cloudflare platform plugin: a `PluginRegistration` over the Vite dev
 * engine. This package is the authoritative owner of ALL Cloudflare
 * orchestration — the generic CLI only dispatches. `sync` regenerates
 * `wrangler.jsonc` + `src/runtime.generated.ts`; `dev` syncs, merges dev
 * secrets into `.dev.vars`, then runs `bun x vite dev` (workerd via the
 * Cloudflare Vite plugin); `build` syncs then runs `vite build`; `preview`
 * runs `vite preview`; `seed` runs `bash scripts/seed.sh`.
 *
 * All I/O goes through the engine-provided `HostServices` surface, so tests
 * inject fakes at the engine boundary.
 */
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
// Import the plugin contract from the `./plugin` subpath, not the package
// root: the root re-exports the config loader (and esbuild), which must not
// enter the Worker bundle that re-exports this factory's package.
import {
  Build,
  Dev,
  type HostServicesShape,
  PluginError,
  type PluginRegistration,
  Preview,
  ProjectRoot,
  Seed,
  Sync,
} from "@effectivity/cli/plugin"
import type { RuntimeSettings, WranglerD1Binding, WranglerR2Binding } from "./artifacts.ts"

/** The config a project passes to `cloudflarePlugin`. Every field except `r2`
 * and `d1` has a default; `sync` bakes the resolved values into the generated
 * artifacts. */
export interface CloudflarePluginConfig {
  /** Worker name (wrangler `name`) and registration name. Default `"effectivity-cms"`. */
  readonly name?: string
  /** R2 bucket that backs the core `BlobStore` seam; bound as `BUCKET`. */
  readonly r2: { readonly bucket: string }
  /** D1 database that backs the identity core; bound as `DB`. `id` defaults to
   * a placeholder until the database is provisioned. */
  readonly d1: { readonly name: string; readonly id?: string }
  /** Worker entry file, relative to the instance root. Default `"src/index.ts"`;
   * the generated `wrangler.jsonc` `main` follows it. */
  readonly workerEntry?: string
  /** Auth settings baked into `runtime.generated.ts`. `url` defaults to
   * `http://localhost:8787`, `secret` to a stable dev value, `admin.email` to
   * `admin@effectivity.local`. `admin.password` never enters an artifact: `dev`
   * writes it to `.dev.vars`, production overlays it at deploy. */
  readonly auth?: {
    readonly url?: string
    readonly secret?: string
    readonly admin?: { readonly email?: string; readonly password?: string }
  }
  /** Catalog root within the R2 bucket. Default `"cms"`. */
  readonly catalog?: { readonly root?: string }
}

/** Dev signing secret: stable so local sessions survive restarts; production overlays it via a wrangler secret. */
const DEFAULT_SECRET = "dev-secret-0123456789abcdef0123456789abcdef"
const DEFAULT_ADMIN_EMAIL = "admin@effectivity.local"
const DEFAULT_AUTH_URL = "http://localhost:8787"
/** Well-known placeholder D1 id used until provision records the real one (no state file, A5). */
const D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000"

/** The default-merged view of a plugin config, used by every operation. */
export interface ResolvedCloudflareConfig {
  readonly name: string
  readonly workerEntry: string
  readonly r2: { readonly bucket: string }
  readonly d1: { readonly name: string; readonly id: string }
  readonly auth: {
    readonly url: string
    readonly secret: string
    readonly admin: { readonly email: string; readonly password?: string }
  }
  readonly catalog: { readonly root: string }
}

export const resolveCloudflareConfig = (config: CloudflarePluginConfig): ResolvedCloudflareConfig => ({
  name: config.name ?? "effectivity-cms",
  workerEntry: config.workerEntry ?? "src/index.ts",
  r2: { bucket: config.r2.bucket },
  d1: { name: config.d1.name, id: config.d1.id ?? D1_PLACEHOLDER },
  auth: {
    url: config.auth?.url ?? DEFAULT_AUTH_URL,
    secret: config.auth?.secret ?? DEFAULT_SECRET,
    admin: {
      email: config.auth?.admin?.email ?? DEFAULT_ADMIN_EMAIL,
      password: config.auth?.admin?.password,
    },
  },
  catalog: { root: config.catalog?.root ?? "cms" },
})

/** Failure mappings surface as PluginError so the capability interface stays honest. */
const fsError = (context: string) =>
  Effect.mapError(
    (error: { readonly message: string }) =>
      new PluginError({ message: `${context}: ${error.message}` }),
  )

/**
 * The plugin factory. Returns a registration whose `capabilities` builds a
 * layer from the engine-provided host surface, so the layer declares no IO
 * requirement. (`ProjectRoot` is read per operation: a `Context.Reference`
 * key, so its declared identifier is `never` and the layer reads the provided
 * or default root at run time.)
 */
export const cloudflarePlugin = (
  config: CloudflarePluginConfig,
): PluginRegistration<Sync | Dev | Build | Preview | Seed> => ({
  name: config.name ?? "effectivity-cms",
  capabilities: (host: HostServicesShape) => {
    // Capture the host services once so tests can replace them at the engine
    // boundary. ProjectRoot is a per-op value channel (the engine provides it
    // for each run), so ops yield it at run time — capturing it here would
    // freeze the build-time root (often the process default) instead of the
    // dispatch's root.
    const spawner = host.spawner
    const fs = host.fs
    const resolved = resolveCloudflareConfig(config)

    const pathOf = Effect.fn("CloudflarePlugin.pathOf")(function* (relative: string) {
      const projectRoot = yield* ProjectRoot
      return `${projectRoot}/${relative}`
    })

    /** Run a child process with inherited stdio; fail as PluginError on any problem. */
    const runChild = Effect.fn("CloudflarePlugin.runChild")(function* (
      command: string,
      args: ReadonlyArray<string>,
      options: { readonly env?: Record<string, string> } = {},
    ) {
      const projectRoot = yield* ProjectRoot
      const child = ChildProcess.make(command, args, {
        cwd: projectRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        extendEnv: true, // without it, env alone replaces process.env (verified)
        ...(options.env !== undefined ? { env: options.env } : {}),
      })
      const code = yield* spawner.exitCode(child).pipe(
        Effect.mapError(
          (cause) =>
            new PluginError({
              message: `failed to run \`${command} ${args.join(" ")}\`: ${cause.message}`,
            }),
        ),
      )
      if (code !== ChildProcessSpawner.ExitCode(0)) {
        return yield* new PluginError({
          message: `\`${command} ${args.join(" ")}\` exited with code ${code}`,
        })
      }
    })

    /** Regenerate wrangler.jsonc + src/runtime.generated.ts (no state file, A5). */
    const sync = Effect.fn("CloudflarePlugin.sync")(
      function* () {
        // Contract enforcement (A15): the emitted objects are constructed
        // against the plugin-declared types — a compile error if the generated
        // content ever drifts from the contract.
        const settings = {
          catalog: { root: resolved.catalog.root },
          auth: {
            url: resolved.auth.url,
            // Dev signing secret baked for local runs; production overlays
            // it via a wrangler secret.
            secret: resolved.auth.secret,
            admin: { email: resolved.auth.admin.email },
          },
        } as const satisfies RuntimeSettings

        const r2Binding = {
          binding: "BUCKET",
          bucket_name: resolved.r2.bucket,
        } as const satisfies WranglerR2Binding

        const d1Binding = {
          binding: "DB",
          database_name: resolved.d1.name,
          database_id: resolved.d1.id, // config.d1.id ?? placeholder (A5)
        } as const satisfies WranglerD1Binding

        const runtimeModule = [
          "/**",
          " * Generated by @effectivity/cli from effectivity.config.ts — do not hand-edit.",
          " * Regenerate with `effectivity sync` (this repo: `bun run cms sync`).",
          " *",
          " * Runtime settings born from the config object instead of environment",
          " * variables. Secrets are NOT baked: the admin password lives in",
          " * .dev.vars (dev) / wrangler secrets (deploy); production may overlay any",
          " * baked value via AUTH_URL / AUTH_SECRET / AUTH_ADMIN_EMAIL vars.",
          " */",
          `export const settings = ${JSON.stringify(settings, null, 2)} as const`,
        ].join("\n") + "\n"

        const wranglerConfig = [
          "// Generated by @effectivity/cli from effectivity.config.ts (source of truth) —",
          "// hand-edits are overwritten. Bindings only: runtime settings live in",
          "// src/runtime.generated.ts; secrets go to .dev.vars (dev) / wrangler",
          "// secret put (prod), never into vars.",
          "{",
          `  "$schema": "node_modules/wrangler/config-schema.json",`,
          `  "name": ${JSON.stringify(resolved.name)},`,
          `  "main": ${JSON.stringify(resolved.workerEntry)},`,
          '  "compatibility_date": "2026-08-15",',
          '  "compatibility_flags": ["nodejs_compat"],',
          '  "r2_buckets": [',
          "    {",
          `      "binding": ${JSON.stringify(r2Binding.binding)},`,
          `      "bucket_name": ${JSON.stringify(r2Binding.bucket_name)}`,
          "    }",
          "  ],",
          '  "d1_databases": [',
          "    {",
          `      "binding": ${JSON.stringify(d1Binding.binding)},`,
          `      "database_name": ${JSON.stringify(d1Binding.database_name)},`,
          `      "database_id": ${JSON.stringify(d1Binding.database_id)}`,
          "    }",
          "  ],",
          '  "observability": {',
          '    "enabled": true,',
          '    "traces": { "enabled": true }',
          "  }",
          "}",
          "",
        ].join("\n")

        yield* fs.makeDirectory(yield* pathOf("src"), { recursive: true })
        yield* fs.writeFileString(yield* pathOf("src/runtime.generated.ts"), runtimeModule)
        yield* fs.writeFileString(yield* pathOf("wrangler.jsonc"), wranglerConfig)
      },
      fsError("sync failed"),
    )

    /** Merge the plugin's dev-only secret values into `.dev.vars`, preserving hand-written keys. */
    const mergeDevVars = Effect.fn("CloudflarePlugin.mergeDevVars")(
      function* (values: Readonly<Record<string, string>>) {
        const varsPath = yield* pathOf(".dev.vars")
        const existing = yield* fs.readFileString(varsPath).pipe(
          Effect.catch(() => Effect.succeed("")),
        )
        const entries = new Map(
          existing
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#") && line.includes("="))
            .map((line) => {
              const [key, ...rest] = line.split("=")
              return [key!, rest.join("=")]
            }),
        )
        for (const [key, value] of Object.entries(values)) {
          entries.set(key, value)
        }
        const body = [...entries.entries()].map(([key, value]) => `${key}=${value}`).join("\n")
        yield* fs.writeFileString(varsPath, body === "" ? "" : `${body}\n`)
      },
      fsError("writing .dev.vars failed"),
    )

    /** Run `bun x vite …` from the project root (Vite dev engine, A3). */
    const runVite = Effect.fn("CloudflarePlugin.runVite")(function* (args: ReadonlyArray<string>) {
      yield* runChild("bun", ["x", "vite", ...args])
    })

    const dev = Effect.fn("CloudflarePlugin.dev")(function* (opts: { port: number }) {
      yield* sync()
      const secrets: Record<string, string> = { AUTH_SECRET: resolved.auth.secret }
      if (resolved.auth.admin.password !== undefined) {
        secrets.AUTH_ADMIN_PASSWORD = resolved.auth.admin.password
      }
      yield* mergeDevVars(secrets)
      yield* runVite(["dev", "--port", String(opts.port)])
    })

    const build = Effect.fn("CloudflarePlugin.build")(function* () {
      yield* sync()
      yield* runVite(["build"])
    })

    const preview = Effect.fn("CloudflarePlugin.preview")(function* () {
      yield* runVite(["preview"])
    })

    const seed = Effect.fn("CloudflarePlugin.seed")(
      function* (opts: { url: string }) {
        const projectRoot = yield* ProjectRoot
        const script = yield* pathOf("scripts/seed.sh")
        if (!(yield* fs.exists(script))) {
          return yield* new PluginError({ message: `no scripts/seed.sh in ${projectRoot}` })
        }
        yield* runChild("bash", [script], { env: { CMS_URL: opts.url, ORIGIN: resolved.auth.url } })
      },
      fsError("seed failed"),
    )

    return Layer.mergeAll(
      Layer.succeed(Sync, Sync.of({ sync })),
      Layer.succeed(Dev, Dev.of({ dev })),
      Layer.succeed(Build, Build.of({ build })),
      Layer.succeed(Preview, Preview.of({ preview })),
      Layer.succeed(Seed, Seed.of({ seed })),
    )
  },
  commands: [],
})
