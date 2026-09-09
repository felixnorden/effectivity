/**
 * Configuration surface for the effectivity CMS toolkit. A project keeps its
 * settings in `cms.config.ts` (or .mjs/.cjs), default-exporting the result of
 * `defineConfig(...)`:
 *
 * ```ts
 * import { defineConfig } from "@effectivity/cli"
 *
 * export default defineConfig({
 *   name: "docs",
 *   catalog: { root: "cms" },
 *   auth: {
 *     url: "https://cms.example.com",
 *     admin: { email: "admin@example.com" },
 *   },
 *   cloudflare: {
 *     r2: { bucket: "my-cms" },
 *     d1: { name: "my-cms-auth", id: "6d5f3a2e-..." },
 *   },
 * })
 * ```
 *
 * Values left out fall back to the local-dev defaults in `resolveConfig`, so
 * a fresh checkout works with zero environment plumbing.
 */

export interface CmsConfig {
  /** Worker name (wrangler `name`). Default `"effectivity-cms"`. */
  readonly name?: string
  readonly catalog?: {
    /** Logical catalog root inside the R2 bucket (was the `CMS_ROOT` var). Default `"cms"`. */
    readonly root?: string
  }
  readonly auth?: {
    /** Public origin for auth cookies/CSRF (was `AUTH_URL`). Default `"http://localhost:8787"`. */
    readonly url?: string
    /**
     * Better Auth signing secret (was `AUTH_SECRET`). The dev default is
     * baked into the bundle via the generated runtime module; production
     * overlays it by setting `AUTH_SECRET` as a wrangler secret (`cms
     * deploy` does this from this field or a generated value).
     */
    readonly secret?: string
    readonly admin?: {
      /** First admin email, provisioned at first boot (was `AUTH_ADMIN_EMAIL`). Default `"admin@effectivity.local"`. */
      readonly email?: string
      /**
       * First admin password (was `AUTH_ADMIN_PASSWORD`). Never baked into
       * the bundle: `cms dev` writes it to `.dev.vars`, `cms deploy` puts it
       * as a wrangler secret. Omit in production and let deploy prompt you.
       */
      readonly password?: string
    }
  }
  readonly cloudflare?: {
    readonly r2?: {
      /** R2 bucket for catalog bytes. Default `"effectivity-cms"`. */
      readonly bucket?: string
    }
    readonly d1?: {
      /** D1 database for auth/identity. Default `"effectivity-auth"`. */
      readonly name?: string
      /**
       * D1 database id. Optional: `cms deploy --provision` creates the
       * database and records the real id in the generated config.
       */
      readonly id?: string
    }
  }
}

export interface ResolvedCmsConfig {
  readonly name: string
  readonly catalog: { readonly root: string }
  readonly auth: {
    readonly url: string
    readonly secret: string
    readonly admin: { readonly email: string; readonly password?: string }
  }
  readonly cloudflare: {
    readonly r2: { readonly bucket: string }
    readonly d1: { readonly name: string; readonly id?: string }
  }
}

/** Dev signing secret: stable so local sessions survive restarts; production overlays it via a wrangler secret. */
export const DEFAULT_SECRET = "dev-secret-0123456789abcdef0123456789abcdef"
/** Local admin password, used by the reference seed script; never shipped in a bundle. */
export const DEFAULT_ADMIN_PASSWORD = "admin-seed-password-0123"

/** Fill defaults so the CLI and the generator always see a full shape. */
export const resolveConfig = (config: CmsConfig): ResolvedCmsConfig => ({
  name: config.name ?? "effectivity-cms",
  catalog: { root: config.catalog?.root ?? "cms" },
  auth: {
    url: config.auth?.url ?? "http://localhost:8787",
    secret: config.auth?.secret ?? DEFAULT_SECRET,
    admin: {
      email: config.auth?.admin?.email ?? "admin@effectivity.local",
      password: config.auth?.admin?.password,
    },
  },
  cloudflare: {
    r2: { bucket: config.cloudflare?.r2?.bucket ?? "effectivity-cms" },
    d1: {
      name: config.cloudflare?.d1?.name ?? "effectivity-auth",
      id: config.cloudflare?.d1?.id,
    },
  },
})

/**
 * Vite-style entry: type-checks the config object and passes it through.
 * The CLI resolves defaults afterwards via {@link resolveConfig}.
 */
export const defineConfig = <const T extends CmsConfig>(config: T): T => config
