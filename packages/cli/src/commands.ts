/**
 * The `effectivity` commands: develop against a local worker, provision
 * Cloudflare resources, deploy with secrets, and seed example content. All
 * wrangler calls run in the project directory (config file's folder), which
 * owns the R2/D1 bindings.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { writeFile, mkdir } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import type { ResolvedCmsConfig } from "./config.ts"
import {
  sync,
  mergeDevVars,
  readState,
  writeState,
  generateWranglerConfig,
  d1IdOf,
  runtimeModulePath,
  wranglerConfigPath,
} from "./generate.ts"

export interface RunOptions {
  /** Project directory (owns the config and the wrangler bindings). */
  readonly dir: string
  readonly config: ResolvedCmsConfig
}

interface RunResult {
  readonly code: number
  readonly stdout: string
}

/** Run wrangler via `bun x wrangler` in `cwd`. Optional piped stdin; optional captured stdout. */
const runWrangler = (
  cwd: string,
  args: string[],
  input?: string,
  capture = false,
): Promise<RunResult> =>
  new Promise((resolveResult, reject) => {
    const child = spawn("bun", ["x", "wrangler", ...args], {
      cwd,
      stdio:
        capture || input !== undefined
          ? ["pipe", capture ? "pipe" : "inherit", "inherit"]
          : "inherit",
    })
    let stdout = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.once("error", reject)
    if (input !== undefined) {
      child.stdin?.write(input)
      child.stdin?.end()
    }
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout }))
  })

const isTty = (): boolean => Boolean(process.stdin.isTTY)

const prompt = async (text: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(`${text} `)
  } finally {
    rl.close()
  }
}

const freshSecret = (): string => randomBytes(32).toString("hex") // 64 hex chars

const warn = (text: string): void => console.warn(`  ! ${text}`)
const ok = (text: string): void => console.log(`  ✓ ${text}`)

/** `effectivity sync`: regenerate the deployable surface from cms.config.ts. */
export const syncCommand = async ({ dir, config }: RunOptions): Promise<number> => {
  await sync(dir, config)
  console.log(`sync ${wranglerConfigPath(dir)}`)
  console.log(`sync ${runtimeModulePath(dir)}`)
  ok(`bindings + runtime settings regenerated from cms.config.ts`)
  return 0
}

/**
 * `effectivity dev [--port]`: regenerate, write dev-only secrets to
 * `.dev.vars`, and run `wrangler dev` (local emulation) with stdio attached.
 */
export const devCommand = async ({
  dir,
  config,
  port,
}: RunOptions & { readonly port: number }): Promise<number> => {
  await sync(dir, config)
  const secrets: Record<string, string> = { AUTH_SECRET: config.auth.secret }
  if (config.auth.admin.password !== undefined) {
    secrets.AUTH_ADMIN_PASSWORD = config.auth.admin.password
  }
  await mergeDevVars(dir, secrets)
  ok(`dev secrets written to .dev.vars (auth origin ${config.auth.url})`)
  const result = await runWrangler(dir, ["dev", "--port", String(port)])
  return result.code
}

const D1_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * `effectivity provision`: create the R2 bucket and D1 database, recording
 * the real D1 id in cms.state.json so generated configs use it.
 */
export const provisionCommand = async ({ dir, config }: RunOptions): Promise<number> => {
  const bucket = await runWrangler(
    dir,
    ["r2", "bucket", "create", config.cloudflare.r2.bucket],
    undefined,
    true,
  )
  if (bucket.code === 0) {
    ok(`r2 bucket ${config.cloudflare.r2.bucket}`)
  } else {
    warn(`r2 bucket create exited ${bucket.code} (already exists?)`)
  }

  const d1 = await runWrangler(dir, ["d1", "create", config.cloudflare.d1.name], undefined, true)
  const id = D1_ID.exec(d1.stdout)?.[1]
  if (id !== undefined) {
    const state = await readState(dir)
    await writeState(dir, { ...state, d1Id: id })
    ok(`d1 database ${config.cloudflare.d1.name} (${id})`)
  } else if (d1.code === 0 || /already exists/i.test(d1.stdout)) {
    warn(
      `d1 create: no new id (database exists?) — set cloudflare.d1.id in cms.config.ts or rerun provision`,
    )
  } else {
    warn(`d1 create exited ${d1.code}`)
  }

  const state = await readState(dir)
  await writeFile(wranglerConfigPath(dir), generateWranglerConfig(config, d1IdOf(config, state)))
  return 0
}

const putSecret = (dir: string, name: string, value: string): Promise<RunResult> =>
  runWrangler(dir, ["secret", "put", name], `${value}\n`)

/** Set the auth secrets on the deployed worker. Values that are missing or still the dev default are generated or prompted for. */
const putSecrets = async ({
  dir,
  config,
  force,
}: RunOptions & { readonly force: boolean }): Promise<void> => {
  const askOrGenerate = async (
    name: string,
    current: string | undefined,
  ): Promise<string | undefined> => {
    if (current === undefined || current === "") {
      if (isTty()) {
        const input = await prompt(`[${name}] paste secret value (blank = generate one):`)
        return input === "" ? undefined : input.trim()
      }
      warn(`${name} not set and stdin is not a terminal — skipping`)
      return undefined
    }
    if (current === "dev-secret-0123456789abcdef0123456789abcdef") {
      if (isTty()) {
        const answer = await prompt(
          `[${name}] still has the dev default; use a fresh random secret? [Y/n]`,
        )
        if (answer.toLowerCase().startsWith("n")) {
          return current
        }
      } else {
        warn(`${name} still has the dev default — generate a fresh one`)
      }
      return freshSecret()
    }
    return current
  }

  const candidates: ReadonlyArray<readonly [string, string]> = [
    ["AUTH_URL", config.auth.url],
    ["AUTH_ADMIN_EMAIL", config.auth.admin.email],
    ["AUTH_ADMIN_PASSWORD", config.auth.admin.password ?? ""],
  ]
  const secret = await askOrGenerate("AUTH_SECRET", config.auth.secret)

  const put = async (name: string, value: string | undefined): Promise<void> => {
    if (value === undefined || value === "") {
      return
    }
    if (!force) {
      // Refuse to overwrite an existing secret blindly; `secret put` shadows
      // rather than replaces, so a re-put is safe, but prompt on first run.
      const existing = await runWrangler(
        dir,
        ["secret", "list", "--format", "json"],
        undefined,
        true,
      )
      if (existing.code === 0 && existing.stdout.includes(`"name":"${name}"`)) {
        const answer = isTty()
          ? await prompt(`[${name}] already set on the worker; overwrite? [y/N]`)
          : "n"
        if (!answer.toLowerCase().startsWith("y")) {
          ok(`kept existing ${name}`)
          return
        }
      }
    }
    const result = await putSecret(dir, name, value)
    if (result.code === 0) {
      ok(`${name} set`)
    } else {
      warn(`${name} failed (exit ${result.code})`)
    }
  }

  for (const [name, value] of candidates) {
    await put(name, value)
  }
  if (secret !== undefined) {
    await put("AUTH_SECRET", secret)
  }
}

/**
 * `effectivity deploy [--dry-run] [--provision]`: provision resources when
 * asked, set secrets, validate the bundle, then deploy.
 */
export const deployCommand = async (
  options: RunOptions & {
    readonly dryRunOnly: boolean
    readonly provision: boolean
    readonly forceSecrets: boolean
  },
): Promise<number> => {
  const { dir, config, dryRunOnly, provision, forceSecrets } = options
  if (provision) {
    await provisionCommand(options)
  }
  await syncCommand({ dir, config })

  if (dryRunOnly) {
    ok("dry-run: validating the bundle against configured bindings only")
    const result = await runWrangler(dir, ["deploy", "--dry-run"])
    return result.code
  }

  await putSecrets({ dir, config, force: forceSecrets })
  console.log("validating bundle...")
  const dry = await runWrangler(dir, ["deploy", "--dry-run"])
  if (dry.code !== 0) {
    warn(`dry-run failed (exit ${dry.code}) — refusing to deploy`)
    return dry.code
  }
  return (await runWrangler(dir, ["deploy"])).code
}

/**
 * `effectivity seed [--url]`: run the project's seed script against a running
 * worker (local or deployed). ORIGIN is pinned to the configured auth origin.
 */
export const seedCommand = async ({
  dir,
  config,
  url,
}: RunOptions & { readonly url: string }): Promise<number> => {
  const script = join(dir, "scripts", "seed.sh")
  if (!existsSync(script)) {
    warn(`no scripts/seed.sh in ${dir}`)
    return 1
  }
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", [script], {
      cwd: dir,
      stdio: "inherit",
      env: { ...process.env, CMS_URL: url, ORIGIN: config.auth.url },
    })
    child.once("error", reject)
    child.once("close", (code) => resolveResult(code ?? 1))
  })
}

const CONFIG_TEMPLATE = `/**
 * effectivity CMS configuration. Defaults keep a fresh checkout working
 * locally; production overrides the notable values below.
 */
import { defineConfig } from "@effectivity/cli"

export default defineConfig({
  name: "effectivity-cms",
  catalog: {
    // Logical catalog root inside the R2 bucket (was the CMS_ROOT var).
    root: "cms",
  },
  auth: {
    // Public origin for auth cookies/CSRF (was AUTH_URL).
    url: "http://localhost:8787",
    admin: {
      // Provisioned at first boot (was AUTH_ADMIN_EMAIL).
      email: "admin@effectivity.local",
      // Never baked into a bundle: dev -> .dev.vars, deploy -> wrangler secret.
      password: "admin-seed-password-0123",
    },
    // signing secret (was AUTH_SECRET): dev default is baked; set a real
    // value here or let \`effectivity deploy\` generate one for production.
    // secret: "...",
  },
  cloudflare: {
    r2: { bucket: "effectivity-cms" },
    d1: {
      name: "effectivity-auth",
      // Optional: \`effectivity deploy --provision\` creates the database and
      // records the real id in cms.state.json for you.
      // id: "6d5f3a2e-0000-4000-8000-000000000000",
    },
  },
})
`

/**
 * `effectivity init`: write a starter cms.config.ts (never overwriting an
 * existing one) and generate the initial surface so `dev` works immediately.
 */
export const initCommand = async (dir: string): Promise<number> => {
  await mkdir(dir, { recursive: true })
  const file = join(dir, "cms.config.ts")
  if (existsSync(file)) {
    warn(`cms.config.ts already exists at ${file}`)
  } else {
    await writeFile(file, CONFIG_TEMPLATE)
    ok(`wrote ${file}`)
  }
  const { loadConfig } = await import("./loader.ts")
  await syncCommand(await loadConfig(file, dir))
  console.log("")
  console.log("next: edit cms.config.ts, then:")
  console.log("  effectivity dev      # local worker (wrangler dev)")
  console.log("  effectivity deploy   # validate + deploy")
  console.log("  effectivity seed     # seed example content at a running worker")
  return 0
}
