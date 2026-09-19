#!/usr/bin/env bun
/**
 * @effectivity/cli entry — an Effect-native command surface over
 * `effect/unstable/cli`:
 *
 *   effectivity sync                 regenerate wrangler.jsonc + runtime settings
 *   effectivity dev [--port 8788]    local worker (vite dev) with .dev.vars secrets
 *   effectivity build                bundle the worker (vite build)
 *   effectivity preview              serve the built bundle (vite preview)
 *   effectivity seed [--url URL]     seed example content at a running worker
 *   effectivity init [dir]           write a starter effectivity.config.ts
 *
 * Help and flag parsing come from the framework: `effectivity --help` and
 * `effectivity <cmd> --help` work without a config file. `buildCli(engine)`
 * (see `./command.ts`) assembles the engine commands plus one namespaced group
 * per registered plugin.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { buildCli } from "./command.ts"
import { boot, engineLayer } from "./engine.ts"
import { HostServices } from "./plugin.ts"

// Engine entry point: extract `--config` from raw argv (handles BOTH
// `--config X` and `--config=X`, A7), boot the engine (loads
// effectivity.config.ts, captures host IO + ProjectRoot), then run. Exit
// protocol (A9): failures print and exit nonzero — PluginError and CliError
// messages go to stderr, which is where a CLI's diagnostics belong. A broken
// config makes `boot` fail; let it propagate, do not catch it here.
if (import.meta.main) {
  const rawArgs = process.argv.slice(2)
  const eqIdx = rawArgs.findIndex((a) => a.startsWith("--config="))
  const pairIdx = rawArgs.indexOf("--config")
  const explicitConfig =
    eqIdx >= 0
      ? rawArgs[eqIdx]!.slice("--config=".length)
      : pairIdx >= 0
        ? rawArgs[pairIdx + 1]
        : undefined

  const program = Effect.gen(function* () {
    const engine = yield* boot(explicitConfig)
    const cli = buildCli(engine)
    yield* Command.run(cli, { version: "0.0.0" }).pipe(Effect.provide(engineLayer(engine)))
  })

  program.pipe(
    Effect.provide(HostServices.layer.pipe(Layer.provideMerge(BunServices.layer))),
    Effect.scoped,
    Effect.tapError((error) =>
      Effect.sync(() => {
        process.stderr.write(`${String(error)}\n`)
      }),
    ),
    BunRuntime.runMain({ disableErrorReporting: true }),
  )
}
