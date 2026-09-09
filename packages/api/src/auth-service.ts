import { Context, Effect, Option, Schema } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"

/**
 * The identity attached to an authenticated request. The shape mirrors what
 * @effectivity/auth will produce from a session or API key; the api package
 * itself never inspects credentials — it only consumes this value.
 */
export interface AuthIdentity {
  readonly id: string
  readonly role: "admin" | "user"
}

/** A failure inside the auth service itself (backend unavailable, etc.). */
export class AuthFailure extends Schema.TaggedError<AuthFailure>()("AuthFailure", {
  message: Schema.String,
}) {}

/**
 * The decoupling boundary between the api package and the identity core.
 * Reads never consult it; write endpoints authenticate through it and the
 * middleware attaches the resulting identity for handler/admin checks.
 * `Option.none` means "not authenticated"; failures mean the service could
 * not decide.
 */
export interface AuthenticationServiceShape {
  readonly authenticate: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<Option.Option<AuthIdentity>, AuthFailure>
}

export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationServiceShape
>()("effectivity/api/AuthenticationService") {}
