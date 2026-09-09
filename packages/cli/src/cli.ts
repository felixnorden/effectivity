/**
 * @effectivity/cli entry — a small Vite-style command surface:
 *
 *   effectivity sync                 regenerate wrangler.jsonc + runtime settings
 *   effectivity dev [--port 8788]    local worker with .dev.vars secrets
 *   effectivity provision            create R2 bucket + D1 database
 *   effectivity deploy [--dry-run] [--provision]
 *   effectivity seed [--url URL]
 *   effectivity init [dir]
 *
 * Config discovery and all flags are handled here; every command delegates to
 * the SDK face in ./commands.ts.
 */
import { loadConfig } from "./loader.ts"

const USAGE = `effectivity — configure, generate, and run an effectivity CMS worker

usage: effectivity <command> [options]

commands:
  sync                 regenerate wrangler.jsonc + src/runtime.generated.ts
                       from cms.config.ts
  dev [--port N]       run the local worker (wrangler dev) with dev secrets
  provision            create the R2 bucket and D1 database, record D1 id
  deploy               validate, set secrets, deploy
    --dry-run          validate the bundle only
    --provision        create resources before deploying
    --force-secrets    overwrite existing worker secrets without prompting
  seed [--url URL]     seed example content at a running worker
  init [dir]           write a starter cms.config.ts and generate the surface
  help                 this text

options:
  --config <path>      config file (default: nearest cms.config.* upward)
  -h, --help           this text`

interface Flags {
  config?: string
  port?: number
  url?: string
  dryRun: boolean
  provision: boolean
  forceSecrets: boolean
  help: boolean
}

const parseFlags = (args: string[]): { positionals: string[]; flags: Flags } => {
  const flags: Flags = {
    dryRun: false,
    provision: false,
    forceSecrets: false,
    help: false,
  }
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-h" || arg === "--help") {
      flags.help = true
    } else if (arg === "--dry-run") {
      flags.dryRun = true
    } else if (arg === "--provision") {
      flags.provision = true
    } else if (arg === "--force-secrets") {
      flags.forceSecrets = true
    } else if (arg === "--config") {
      flags.config = args[++i]
    } else if (arg.startsWith("--config=")) {
      flags.config = arg.slice("--config=".length)
    } else if (arg === "--port") {
      flags.port = Number(args[++i])
    } else if (arg.startsWith("--port=")) {
      flags.port = Number(arg.slice("--port=".length))
    } else if (arg === "--url") {
      flags.url = args[++i]
    } else if (arg.startsWith("--url=")) {
      flags.url = arg.slice("--url=".length)
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`unknown flag: ${arg} (see \`effectivity help\`)`)
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

const main = async (argv: string[]): Promise<number> => {
  const { positionals, flags } = parseFlags(argv)
  if (flags.help || positionals.length === 0) {
    console.log(USAGE)
    return 0
  }
  const [command, ...rest] = positionals
  const { syncCommand, devCommand, provisionCommand, deployCommand, seedCommand, initCommand } =
    await import("./commands.ts")

  if (command === "init") {
    return await initCommand(rest[0] ?? process.cwd())
  }

  const { dir, config } = await loadConfig(flags.config)
  switch (command) {
    case "sync":
    case "generate":
      return await syncCommand({ dir, config })
    case "dev":
      return await devCommand({ dir, config, port: flags.port ?? 8788 })
    case "provision":
      return await provisionCommand({ dir, config })
    case "deploy":
      return await deployCommand({
        dir,
        config,
        dryRunOnly: flags.dryRun,
        provision: flags.provision,
        forceSecrets: flags.forceSecrets,
      })
    case "seed":
      return await seedCommand({ dir, config, url: flags.url ?? "http://localhost:8788" })
    case "init":
      return await initCommand(rest[0] ?? process.cwd())
    default:
      console.error(`effectivity: unknown command "${command}"`)
      console.log(USAGE)
      return 1
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`effectivity: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
