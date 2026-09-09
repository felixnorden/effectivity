import { Context, Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { AuthenticationService, type AuthIdentity } from "../auth-service.ts"
import * as ApiError from "../error.ts"

/**
 * The identity of the current request, provided by the auth gate middleware
 * to handlers that need it (admin endpoints). Absent outside gated endpoints.
 */
export class CurrentIdentity extends Context.Service<CurrentIdentity, AuthIdentity>()(
  "effectivity/api/CurrentIdentity",
) {}

/**
 * The write gate: authenticates every request that reaches a gated endpoint
 * and attaches the identity, or fails 401. Reads declare no middleware, so
 * they stay public; the admin gate is role-checked inside the admin handler.
 */
export class AuthGate extends HttpApiMiddleware.Service<
  AuthGate,
  {
    provides: CurrentIdentity
    requires: AuthenticationService
    error: ApiError.Unauthorized
  }
>()("effectivity/api/AuthGate", {}) {}

/** Implementation of {@link AuthGate}: consult the auth service per request. */
// The single boundary cast: the rc's middleware effect algebra is too noisy to
// thread end-to-end here; the runtime shape (request in context, identity
// provided, Unauthorized on failure) is fixed by the code below.
export const AuthGateLayer = Layer.effect(
  AuthGate,
  Effect.gen(function* () {
    const auth = yield* AuthenticationService
    const gate = (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown>,
      _options: unknown,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, unknown> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const identity = yield* auth
          .authenticate(request)
          .pipe(
            Effect.mapError(() => new ApiError.Unauthorized({ message: "authentication failed" })),
          )
        if (Option.isNone(identity)) {
          return yield* new ApiError.Unauthorized({ message: "authentication required" })
        }
        return yield* httpEffect.pipe(Effect.provideService(CurrentIdentity, identity.value))
      })
    return gate
  }) as unknown as Effect.Effect<
    HttpApiMiddleware.HttpApiMiddleware<CurrentIdentity, never, AuthenticationService>,
    never,
    AuthenticationService
  >,
)
