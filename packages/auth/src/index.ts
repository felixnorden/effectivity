/**
 * @effectivity/auth — the Better Auth identity core.
 *
 * Runtime-agnostic: environment only supplies config (base URL, secret,
 * database). Exposes the Better Auth instance, the db injection + migrations
 * boundary, and the AuthenticationService implementation that @effectivity/api
 * consumes for its write gate.
 */
export { makeIdentity, type IdentityConfig } from "./identity.ts"
export { getMigrations, type DatabaseConfig } from "./db.ts"
export { authServiceLayer } from "./auth-service.ts"
