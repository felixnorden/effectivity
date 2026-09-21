/**
 * The CLI program assembly: the engine's own commands plus one namespaced
 * group per registered plugin. This module deliberately imports no
 * platform-specific runtime, so a bundled `effectivity.config.ts` that imports
 * `@effectivity/cli` stays host-agnostic; the entry point (`./cli.ts`) adds the
 * Bun runtime and runs the program.
 */
import { type Context, Effect, Layer, Option, Path, type Scope } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { commandGroups } from "./command-groups.ts"
import { dispatch } from "./dispatch.ts"
import type { Engine } from "./engine.ts"
import { loadRawConfig } from "./loader.ts"
import {
  Build,
  Dev,
  HostServices,
  PluginError,
  Preview,
  ProjectRoot,
  Seed,
  Sync,
} from "./plugin.ts"

/**
 * One dispatch path for every engine command, so a missing capability fails in
 * exactly one place. Delegates to `dispatch` and returns its effect directly.
 */
const runCapability = <Identifier, Shape>(
  engine: Engine,
  tag: Context.Key<Identifier, Shape>,
  name: string,
  run: (service: Shape) => Effect.Effect<void, PluginError>,
): Effect.Effect<void, PluginError, Scope.Scope> => dispatch(engine, tag, name, run)

// Root command — shared --config flag available to all subcommands
const effectivity = Command.make("effectivity").pipe(
  Command.withDescription("Configure, generate, and run an effectivity CMS worker"),
  Command.withSharedFlags({
    config: Flag.string("config").pipe(
      Flag.withDescription("Path to effectivity.config.ts (default: walk up from cwd)"),
      Flag.optional,
    ),
  }),
)

export const INIT_TEMPLATE = `/**
 * effectivity configuration. Defaults keep a fresh checkout working locally;
 * production overlays secret values at deploy time.
 */
import { defineConfig } from "@effectivity/cli"
import { cloudflarePlugin } from "@effectivity/cloudflare"

export default defineConfig({
  plugins: [
    cloudflarePlugin({
      name: "effectivity-cms",
      r2: { bucket: "effectivity-cms" },
      d1: { name: "effectivity-auth" },
      auth: {
        url: "http://localhost:8787",
        admin: {
          email: "admin@effectivity.local",
          // Never baked into a bundle: dev -> .dev.vars.
          password: "admin-seed-password-0123",
        },
      },
      catalog: { root: "cms" },
    }),
  ],
})
`

/**
 * Assemble the command program for an engine: the six engine commands plus one
 * group per registered plugin, namespaced by registration order.
 */
export const buildCli = (engine: Engine) => {
  const sync = Command.make(
    "sync",
    {},
    Effect.fn("sync")(function* () {
      yield* runCapability(engine, Sync, "sync", (capability) => capability.sync)
    }),
  ).pipe(Command.withDescription("Regenerate wrangler.jsonc + src/runtime.generated.ts"))

  const dev = Command.make(
    "dev",
    {
      port: Flag.integer("port").pipe(
        Flag.withAlias("p"),
        Flag.withDescription("Dev server port"),
        Flag.withDefault(8788),
      ),
    },
    Effect.fn("dev")(function* ({ port }) {
      yield* runCapability(engine, Dev, "dev", (capability) => capability.dev({ port }))
    }),
  ).pipe(
    Command.withDescription(
      "Run the local worker (vite dev) with dev secrets; a long-running provider blocks later registrations",
    ),
  )

  const build = Command.make(
    "build",
    {},
    Effect.fn("build")(function* () {
      yield* runCapability(engine, Build, "build", (capability) => capability.build)
    }),
  ).pipe(Command.withDescription("Regenerate artifacts and bundle the worker (vite build)"))

  const preview = Command.make(
    "preview",
    {},
    Effect.fn("preview")(function* () {
      yield* runCapability(engine, Preview, "preview", (capability) => capability.preview)
    }),
  ).pipe(
    Command.withDescription(
      "Serve the built bundle (vite preview); a long-running provider blocks later registrations",
    ),
  )

  const seed = Command.make(
    "seed",
    {
      url: Flag.string("url").pipe(
        Flag.withDescription("Worker URL to seed content at"),
        Flag.withDefault("http://localhost:8788"),
      ),
    },
    Effect.fn("seed")(function* ({ url }) {
      yield* runCapability(engine, Seed, "seed", (capability) => capability.seed({ url }))
    }),
  ).pipe(Command.withDescription("Seed example content at a running worker"))

  const init = Command.make(
    "init",
    {
      dir: Argument.string("dir").pipe(
        Argument.withDescription("Directory to initialise (default: cwd)"),
        Argument.optional,
      ),
    },
    Effect.fn("init")(function* ({ dir }) {
      const targetDir = Option.isSome(dir) ? dir.value : process.cwd()
      const host = yield* HostServices
      const path = yield* Path.Path
      const file = path.join(targetDir, "effectivity.config.ts")
      if (yield* host.fs.exists(file)) {
        yield* Effect.log(`effectivity.config.ts already exists at ${file}`)
      } else {
        yield* host.fs.makeDirectory(targetDir, { recursive: true })
        yield* host.fs.writeFileString(file, INIT_TEMPLATE)
        yield* Effect.log(`wrote ${file}`)
      }
      // A10 parity: dispatch sync through the freshly written config. The
      // nested engine reuses the captured host and provides the new config's
      // directory as ProjectRoot (the nested value shadows the outer one). In
      // a fresh directory with no installed dependencies the template cannot
      // be bundled yet — degrade to a hint instead of failing init.
      const loaded = yield* Effect.tryPromise({
        try: () => loadRawConfig(undefined, targetDir),
        catch: (error) =>
          new PluginError({
            message: `could not load the fresh config for the parity sync: ${String(error)}`,
          }),
      }).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            yield* Effect.log("run `bun install`, then `effectivity sync`")
            return null
          }),
        ),
      )
      if (loaded !== null) {
        const nested: Engine = {
          registrations: loaded.config.plugins ?? [],
          host,
          projectRoot: loaded.dir,
        }
        yield* runCapability(nested, Sync, "sync", (capability) => capability.sync).pipe(
          Effect.provide(Layer.succeed(ProjectRoot, loaded.dir)),
        )
      }
      yield* Effect.log("next: edit effectivity.config.ts, then:")
      yield* Effect.log("  effectivity dev      # local worker (vite dev)")
      yield* Effect.log("  effectivity build    # bundle the worker")
    }),
  ).pipe(Command.withDescription("Write a starter effectivity.config.ts"))

  return effectivity.pipe(
    Command.withSubcommands([sync, dev, build, preview, seed, init, ...commandGroups(engine)]),
  )
}
