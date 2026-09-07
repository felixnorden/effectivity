import { Context, Schema } from "effect"

/**
 * Root-scoped config: the logical catalog root plus the caller-supplied
 * frontmatter schema (D7). One schema per logical catalog root, provided at
 * wiring time; the store validates every mutation against it.
 *
 * The schema is consumed for validation, not for static typing: typed
 * parsing happens at the call site via the generic `parseDocument(schema,
 * bytes)` / `decodeFrontmatter(schema, yaml)` codec functions, where the
 * schema value is the type witness.
 */
export interface CatalogRootConfig {
  readonly root: string
  readonly frontmatter: Schema.ConstraintDecoder<unknown>
}

export const CatalogRoot = Context.Reference<CatalogRootConfig>("effectivity/config/CatalogRoot", {
  defaultValue: () => ({
    root: "",
    frontmatter: Schema.Struct({}),
  }),
})
