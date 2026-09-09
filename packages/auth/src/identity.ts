import { betterAuth } from "better-auth"
import { admin } from "better-auth/plugins/admin"
import { apiKey } from "@better-auth/api-key"
import type { DatabaseConfig } from "./db.ts"

/**
 * The identity core configuration. The caller supplies the deployment shape
 * (base URL, signing secret, injected database); test doubles and the
 * platform package build on this.
 */
export interface IdentityConfig {
  /** Public base URL of the auth endpoints (cookie/CSRF scope). */
  readonly baseURL: string
  /** Signing/encryption secret (>= 32 chars outside tests). */
  readonly secret: string
  /** Injected database config; absent uses better-auth's built-in memory. */
  readonly database?: DatabaseConfig
  /** Auth namespace path prefix; defaults to better-auth's "/api/auth". */
  readonly basePath?: string
  /** Session cookie lifetime in seconds (defaults to better-auth's 7 days). */
  readonly sessionExpiresIn?: number
  /** Allow open email/password registration (tests bootstrap admins this way). */
  readonly signUpEnabled?: boolean
}

/**
 * One options object feeds both the Better Auth instance and the migration
 * runner, so the schema the migrations create always matches the plugins the
 * instance serves (admin fields, the api-key table, impersonation columns).
 */
export const identityOptions = (config: IdentityConfig) => ({
  baseURL: config.baseURL,
  secret: config.secret,
  basePath: config.basePath,
  database: config.database,
  session: {
    expiresIn: config.sessionExpiresIn,
  },
  emailAndPassword: {
    enabled: true,
    // Accounts are admin-provisioned; open registration stays off by
    // default and can be enabled for bootstrap/trimming configs.
    disableSignUp: !config.signUpEnabled,
  },
  plugins: [
    admin(),
    apiKey({
      defaultPrefix: "sk_",
      enableSessionForAPIKeys: true,
    }),
  ],
})

/**
 * Build the Better Auth instance: email/password sign-in, admin-provisioned
 * accounts, and API keys for headless callers. API keys authenticate through
 * the `x-api-key` header by mocking a session for the key's owner, so the
 * whole request surface (session cookie or key) resolves through one
 * `getSession` call in the authentication service.
 */
export const makeIdentity = (config: IdentityConfig) =>
  betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    basePath: config.basePath,
    database: config.database,
    session: {
      expiresIn: config.sessionExpiresIn,
    },
    emailAndPassword: {
      enabled: true,
      // Accounts are admin-provisioned; open registration stays off by
      // default and can be enabled for bootstrap/trimming configs.
      disableSignUp: !config.signUpEnabled,
    },
    plugins: [
      admin(),
      apiKey({
        defaultPrefix: "sk_",
        enableSessionForAPIKeys: true,
      }),
    ],
  })
