import { Schema } from "effect"

/**
 * HTTP-facing error vocabulary for @effectivity/api.
 *
 * These mirror the @effectivity/core taxonomy payload-for-payload, adding the
 * HTTP status mapping the wire needs. Handlers translate core failures into
 * these classes so the endpoint error sets stay schema-driven (OpenAPI carries
 * them) and every failure leaves the app as a typed, status-mapped response.
 * Core stays runtime-agnostic: it never imports these.
 */

/** A blob does not exist where the operation required one to. */
export class BlobNotFound extends Schema.TaggedError<BlobNotFound>()(
  "BlobNotFound",
  {
    key: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

/** A guarded conditional write/read saw a version (or presence) it did not expect. */
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
  "PreconditionFailed",
  {
    key: Schema.String,
    expected: Schema.Option(Schema.String),
    actual: Schema.Option(Schema.String),
  },
  { httpApiStatus: 412 },
) {}

/** Frontmatter / codec validation failure. */
export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()(
  "ValidationFailed",
  {
    path: Schema.String,
    issues: Schema.Array(Schema.String),
  },
  { httpApiStatus: 422 },
) {}

/** Invalid logical names / keys / arguments. */
export class InvalidArgument extends Schema.TaggedError<InvalidArgument>()(
  "InvalidArgument",
  {
    value: Schema.String,
    reason: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/** Reference-graph integrity refusal (a move/delete would break or orphan references). */
export class IntegrityViolation extends Schema.TaggedError<IntegrityViolation>()(
  "IntegrityViolation",
  {
    reason: Schema.String,
    refs: Schema.Array(Schema.String),
  },
  { httpApiStatus: 409 },
) {}

/** Authentication failure: no valid session or API key. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {}

/** Authentication succeeded but the identity lacks the required privilege. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}
