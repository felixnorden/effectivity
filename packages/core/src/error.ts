import { Schema } from "effect"

/**
 * Shared error taxonomy for @effectivity/core.
 *
 * Every typed outcome across the package is expressed through these tagged
 * errors, so callers can match on one closed vocabulary instead of per-layer
 * drift. Errors are `Schema.TaggedError` classes: schema-validated, yieldable,
 * and matchable by `_tag`.
 */

/** A blob does not exist where the operation required one to. */
export class BlobNotFound extends Schema.TaggedError<BlobNotFound>()("BlobNotFound", {
  key: Schema.String,
}) {}

/** A guarded conditional write/read saw a version (or presence) it did not expect. */
export class PreconditionFailed extends Schema.TaggedError<PreconditionFailed>()(
  "PreconditionFailed",
  {
    key: Schema.String,
    expected: Schema.Option(Schema.String), // the version we required, if any
    actual: Schema.Option(Schema.String), // the version actually present, if any
  },
) {}

/** Frontmatter / codec validation failure. */
export class ValidationFailed extends Schema.TaggedError<ValidationFailed>()("ValidationFailed", {
  path: Schema.String,
  issues: Schema.Array(Schema.String),
}) {}

/** Invalid logical names / keys / arguments. */
export class InvalidArgument extends Schema.TaggedError<InvalidArgument>()("InvalidArgument", {
  value: Schema.String,
  reason: Schema.String,
}) {}

/** Reference-graph integrity refusal (a move/delete would break or orphan references). */
export class IntegrityViolation extends Schema.TaggedError<IntegrityViolation>()(
  "IntegrityViolation",
  {
    reason: Schema.String,
    refs: Schema.Array(Schema.String),
  },
) {}

/**
 * Adapter-mapped infrastructure failures (permission / I/O / timeout).
 * These are the mapping targets for real adapters (R2/S3) — never raised by
 * in-test doubles. Higher layers only ever see the package vocabulary above.
 */
export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  key: Schema.String,
  message: Schema.String,
}) {}

export class IOError extends Schema.TaggedError<IOError>()("IOError", {
  key: Schema.String,
  message: Schema.String,
}) {}

export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  key: Schema.String,
}) {}
