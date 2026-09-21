import { Schema } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi"
import * as ApiError from "./error.ts"
import { AuthGate } from "./middleware/auth.ts"

/**
 * The declarative CMS contract: groups, endpoints, request schemas, and
 * response/error schemas. No handlers live here — the declarations are shared
 * as the runtime agnostic surface (OpenAPI, clients, tests).
 *
 * Document paths are region-relative folder-tree paths (`guides/start`). The
 * router's wildcard captures the whole nested path as the `*` param, so reads
 * and writes work for any depth.
 */

/** One entry in a document listing: the region-relative path plus title/folder metadata. */
export class DocumentSummary extends Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  folder: Schema.String,
}) {}

/** One image reference of a document model view: the src to substitute plus its resolved absolute url. */
export class ReferenceView extends Schema.Struct({
  src: Schema.String,
  asset: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["present", "dangling", "wrong-typed"] as const),
}) {}

/** The schema-parsed document view (`?view=model`): validated frontmatter, the markdown body, and resolved image urls. */
export class DocumentModel extends Schema.Struct({
  frontmatter: Schema.Unknown,
  body: Schema.String,
  hasFrontmatter: Schema.Boolean,
  references: Schema.Array(ReferenceView),
}) {}

/** One entry in an asset listing: the region-relative path plus folder metadata. */
export class AssetSummary extends Schema.Struct({
  path: Schema.String,
  folder: Schema.String,
}) {}

/** One reference inside a document: the author-written src, resolved asset id and absolute url, plus graph status. */
export class Reference extends Schema.Struct({
  src: Schema.String,
  asset: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["present", "dangling", "wrong-typed"] as const),
  sourceLine: Schema.optional(Schema.Finite),
}) {}

/** One document's classified image references from the reference-graph read model. */
export class ReferenceEntry extends Schema.Struct({
  document: Schema.String,
  references: Schema.Array(Reference),
}) {}

/** The response of every successful write: the new blob version token. */
export class VersionResponse extends Schema.Struct({
  version: Schema.String,
}) {}

export class DocumentsApiGroup extends HttpApiGroup.make("documents")
  .add(
    HttpApiEndpoint.get("read", "/*", {
      params: {
        // The whole region-relative path (absent for the bare prefix = listing).
        "*": Schema.optional(Schema.String),
      },
      query: {
        // Folder filter for the listing (`` path); absent lists the whole catalog.
        folder: Schema.optional(Schema.String),
        // `view=model` returns the schema-parsed model; absent returns the raw markdown.
        view: Schema.optional(Schema.Literal("model")),
        // `resolve=urls` rewrites image srcs in the raw markdown to absolute asset urls.
        resolve: Schema.optional(Schema.Literal("urls")),
      },
      success: [
        Schema.Array(DocumentSummary),
        DocumentModel,
        HttpApiSchema.WithHeaders(
          Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
          { etag: Schema.String },
        ),
      ],
      error: [ApiError.InvalidArgument, ApiError.BlobNotFound, ApiError.ValidationFailed],
    }),
    HttpApiEndpoint.put("upsert", "/*", {
      params: {
        "*": Schema.optional(Schema.String),
      },
      headers: {
        "if-match": Schema.optional(Schema.String),
      },
      payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/markdown" })),
      success: VersionResponse,
      error: [
        ApiError.Unauthorized,
        ApiError.InvalidArgument,
        ApiError.PreconditionFailed,
        ApiError.ValidationFailed,
      ],
    }).middleware(AuthGate),
    HttpApiEndpoint.delete("remove", "/*", {
      params: {
        "*": Schema.optional(Schema.String),
      },
      success: Schema.Void,
      error: [
        ApiError.Unauthorized,
        ApiError.InvalidArgument,
        ApiError.PreconditionFailed,
        ApiError.IntegrityViolation,
      ],
    }).middleware(AuthGate),
  )
  .prefix("/documents")
  .annotateMerge(
    OpenApi.annotations({
      title: "Documents",
      description: "Document read surface: listing, raw markdown, and schema-parsed models",
    }),
  ) {}

export class AssetsApiGroup extends HttpApiGroup.make("assets")
  .add(
    HttpApiEndpoint.get("read", "/*", {
      params: {
        // The whole region-relative asset id (absent for the bare prefix = listing).
        "*": Schema.optional(Schema.String),
      },
      query: {
        // Folder filter for the listing (absent path); absent lists the whole asset region.
        folder: Schema.optional(Schema.String),
      },
      success: [
        Schema.Array(AssetSummary),
        HttpApiSchema.WithHeaders(
          Schema.Uint8Array.pipe(
            HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
          ),
          { etag: Schema.String },
        ),
      ],
      error: [ApiError.InvalidArgument, ApiError.BlobNotFound],
    }),
    HttpApiEndpoint.put("store", "/*", {
      params: {
        "*": Schema.optional(Schema.String),
      },
      headers: {
        "if-match": Schema.optional(Schema.String),
        "content-type": Schema.optional(Schema.String),
      },
      // Opaque bytes declared per accepted content type. The type a client
      // sends is retained in blob metadata and served back on reads, so
      // uploaded images render when linked directly. Untyped uploads default
      // to octet-stream.
      payload: [
        Schema.Uint8Array.pipe(
          HttpApiSchema.asUint8Array({ contentType: "application/octet-stream" }),
        ),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "text/plain" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/png" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/jpeg" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/gif" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/webp" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "image/svg+xml" })),
        Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array({ contentType: "application/pdf" })),
      ],
      success: VersionResponse,
      error: [ApiError.Unauthorized, ApiError.InvalidArgument, ApiError.PreconditionFailed],
    }).middleware(AuthGate),
    HttpApiEndpoint.delete("remove", "/*", {
      params: {
        "*": Schema.optional(Schema.String),
      },
      success: Schema.Void,
      error: [
        ApiError.Unauthorized,
        ApiError.InvalidArgument,
        ApiError.PreconditionFailed,
        ApiError.IntegrityViolation,
      ],
    }).middleware(AuthGate),
  )
  .prefix("/assets")
  .annotateMerge(
    OpenApi.annotations({
      title: "Assets",
      description:
        "Asset read surface: folder-grouped listing and opaque byte reads with preserved content type",
    }),
  ) {}

export class ReferencesApiGroup extends HttpApiGroup.make("references")
  .add(
    HttpApiEndpoint.get("get", "/", {
      success: Schema.Array(ReferenceEntry),
      error: [ApiError.InvalidArgument],
    }),
  )
  .prefix("/references")
  .annotateMerge(
    OpenApi.annotations({
      title: "References",
      description:
        "The reference-graph read model: present, dangling, and wrong-typed image references per document",
    }),
  ) {}

/** One identity: id plus role, as the admin provisioning endpoints consume it. */
export class IdentityPayload extends Schema.Struct({
  email: Schema.String,
  role: Schema.Literals(["admin", "user"] as const),
}) {}

export class AdminApiGroup extends HttpApiGroup.make("admin")
  .add(
    // Provisioning placeholder — the real account creation lands in Slice 4.
    HttpApiEndpoint.put("provision", "/users", {
      payload: IdentityPayload,
      success: Schema.Void,
      error: [ApiError.Unauthorized, ApiError.Forbidden, ApiError.InvalidArgument],
    }),
  )
  .prefix("/admin")
  .middleware(AuthGate)
  .annotateMerge(
    OpenApi.annotations({
      title: "Admin",
      description: "Admin-only provisioning endpoints (account creation lands in the auth slice)",
    }),
  ) {}

/** The root API: every group plus the generated OpenAPI document. */
export class Api extends HttpApi.make("effectivity-cms")
  .add(DocumentsApiGroup)
  .add(AssetsApiGroup)
  .add(ReferencesApiGroup)
  .add(AdminApiGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Effectivity CMS API",
      description: "Document CMS over @effectivity/core",
    }),
  ) {}
