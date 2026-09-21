/**
 * Consumer-config type-check coverage: `effectivity.config.ts` is compiled by
 * the package's config-check project, so a plugin call site that stops
 * matching the registration shape is a build failure rather than a silent
 * success. These cases run in Node because they spawn the compiler.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The node test project is run from the package root (`vitest run --config`).
const packageRoot = process.cwd()
const tsc = join(packageRoot, "node_modules", ".bin", "tsc")

const runTsc = (project: string): { readonly status: number; readonly output: string } => {
  try {
    const output = execFileSync(tsc, ["-p", project, "--noEmit"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { status: 0, output }
  } catch (error) {
    const failure = error as {
      readonly status?: number
      readonly stdout?: string
      readonly stderr?: string
    }
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }
  }
}

describe("consumer config type-check coverage", () => {
  it("the config-check project includes the consumer config file", () => {
    const project = JSON.parse(readFileSync(join(packageRoot, "tsconfig.config.json"), "utf8")) as {
      readonly include?: ReadonlyArray<string>
    }
    expect(project.include).toContain("effectivity.config.ts")
  })

  it("the config-check project compiles the real consumer config cleanly", () => {
    const { status, output } = runTsc("tsconfig.config.json")
    expect(status).toBe(0)
    expect(output).not.toContain("error TS")
  })

  it("a config with a field the contract no longer declares fails", () => {
    const { status, output } = runTsc("test/fixtures/tsconfig.broken.json")
    expect(status).not.toBe(0)
    expect(output).toContain("broken-effectivity.config.ts")
    expect(output).toContain("cloudflare")
  })
})
