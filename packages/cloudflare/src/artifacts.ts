/**
 * The generated platform artifact shapes: the objects `sync` writes into
 * `src/runtime.generated.ts` and `wrangler.jsonc`. This package owns them —
 * it is the package that produces the artifacts, so it is authoritative for
 * their meaning.
 */

/**
 * The Generated Runtime Surface Contract: the shape written into
 * `src/runtime.generated.ts` and read by the consumer composition.
 */
export interface RuntimeSettings {
  readonly catalog: { readonly root: string }
  readonly auth: {
    readonly url: string
    readonly secret: string
    readonly admin: { readonly email: string }
  }
}

/** The bindings-only Workers config emitted (`r2_buckets`). */
export interface WranglerR2Binding {
  readonly binding: string
  readonly bucket_name: string
}

/** The bindings-only Workers config emitted (`d1_databases`). */
export interface WranglerD1Binding {
  readonly binding: string
  readonly database_name: string
  readonly database_id: string
}
