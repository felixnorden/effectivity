import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api.ts"
import * as ApiError from "../error.ts"
import { CurrentIdentity } from "../middleware/auth.ts"

export const AdminApiHandlers = HttpApiBuilder.group(Api, "admin", (handlers) =>
  handlers.handleAll({
    // PUT /admin/users — provisioning placeholder. The auth gate attached the
    // identity; only admins may provision accounts. The real account creation
    // (via @effectivity/auth) replaces this stub in the auth slice.
    provision: Effect.fn("admin.provision")(function* () {
      const identity = yield* CurrentIdentity
      if (identity.role !== "admin") {
        return yield* new ApiError.Forbidden({ message: "admin role required" })
      }
      return HttpServerResponse.empty()
    }),
  }),
)
