import { Effect, Layer } from "effect"
import { AuthenticationService, type AuthIdentity } from "../../src/auth-service.ts"

/**
 * Auth service doubles for the api write tests. The real identity core lands
 * in @effectivity/auth; these prove the gate semantics (anonymous → 401, role
 * checks → 403) without any auth library.
 */

/** A caller whose credentials always authenticate as the given identity. */
export const alwaysAuthenticated = (
  role: AuthIdentity["role"],
): Layer.Layer<AuthenticationService, never, never> =>
  Layer.succeed(
    AuthenticationService,
    AuthenticationService.of({
      authenticate: () => Effect.succeedSome({ id: "double-user", role }),
    }),
  )

/** A caller with no credentials: every write is rejected. */
export const alwaysAnonymous: Layer.Layer<AuthenticationService, never, never> = Layer.succeed(
  AuthenticationService,
  AuthenticationService.of({
    authenticate: () => Effect.succeedNone,
  }),
)
