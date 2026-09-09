import type { BetterAuthOptions } from "better-auth"
import { identityOptions } from "./identity.ts"

/**
 * Database + migration boundary for @effectivity/auth.
 *
 * The identity core never imports a concrete database driver or binding: the
 * database option accepts whatever better-auth accepts for `database` — a raw
 * D1 binding, a direct connection, an adapter factory (the built-in
 * `memoryAdapter` for development/tests), or the Kysely/D1-ready config a
 * platform resolves. Migrations run programmatically so the runtime (Worker
 * entry, CI) creates the schema at boot — the CLI cannot reach D1 from
 * outside a Worker.
 */

/** The database-option slot of a better-auth config: injected, never imported. */
export type DatabaseConfig = NonNullable<BetterAuthOptions["database"]>

/**
 * Run better-auth's schema migrations from the full identity options (the
 * database slot plus the plugins whose tables/columns the schema includes).
 * Safe to call repeatedly; the runner diffs against what already exists.
 */
export const getMigrations = async (
  config: Parameters<typeof identityOptions>[0],
): Promise<{ runMigrations(): Promise<void> }> => {
  const { getMigrations: loadMigrations } = await import("better-auth/db/migration")
  return loadMigrations(identityOptions(config))
}
