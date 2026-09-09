import { Effect, Layer, Option } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { AuthenticationService, type AuthIdentity, AuthFailure } from "@effectivity/api"
import { makeIdentity } from "./identity.ts"

/**
 * The AuthenticationService implementation for @effectivity/api.
 *
 * One resolution path covers both credential kinds: the session cookie and
 * the `x-api-key` header (the api-key plugin mocks a session for a valid
 * key). Expired or missing credentials resolve to `Option.none`; failures
 * inside the identity core (never expected in a healthy deployment) surface
 * as `AuthFailure`.
 */

/** Adapt the effect Headers record (indexable by lowercase name) to the native shape better-auth reads. */
const toNativeHeaders = (record: Record<string, string>): unknown => {
  const native = new (
    globalThis as unknown as {
      Headers: { new (): { set(name: string, value: string): void } }
    }
  ).Headers()
  for (const [name, value] of Object.entries(record)) {
    native.set(name, value)
  }
  return native
}

/** The role of a session user; anything not exactly "admin" is a plain user. */
const roleOf = (user: { role?: string }): AuthIdentity["role"] =>
  user.role === "admin" ? "admin" : "user"

/** Resolve the identity for one request, or none when unauthenticated. */
const authenticate = (identity: ReturnType<typeof makeIdentity>) =>
  Effect.fn("auth.authenticate")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.fn.Return<Option.Option<AuthIdentity>, AuthFailure> {
    const headers = request.headers as Record<string, string>
    const session = yield* Effect.tryPromise({
      try: async () => {
        // API keys verify first (graceful `valid: false`); only a valid key
        // proceeds to the mocked-session read that carries the user's role.
        const apiKey = headers["x-api-key"]
        if (apiKey !== undefined) {
          const result = await identity.api.verifyApiKey({ body: { key: apiKey } })
          if (!result.valid) {
            return null
          }
        }
        return identity.api.getSession({
          // Single boundary cast: the runtime only needs the native header
          // surface; the rc-pinned better-auth types are not ambient here.
          headers: toNativeHeaders(headers) as never,
        })
      },
      catch: (error) =>
        new AuthFailure({
          message: error instanceof Error ? error.message : "identity core failure",
        }),
    })
    if (session === null || session.user === undefined) {
      return Option.none()
    }
    return Option.some({
      id: session.user.id,
      role: roleOf(session.user as { role?: string }),
    })
  })

/**
 * The auth layer: the api package's AuthenticationService over a shared
 * identity instance. The caller builds the instance (Worker boots one and
 * dispatches the /auth namespace through it); this layer only adapts it to
 * the api contract.
 */
export const authServiceLayer = (
  identity: ReturnType<typeof makeIdentity>,
): Layer.Layer<AuthenticationService, never, never> =>
  Layer.effect(
    AuthenticationService,
    Effect.sync(() =>
      AuthenticationService.of({
        authenticate: authenticate(identity),
      }),
    ),
  )
