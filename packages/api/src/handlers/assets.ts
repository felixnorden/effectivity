import { Effect, Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { BlobStore, Catalog, DocumentStore, Naming } from "@effectivity/core"
import { Api } from "../api.ts"
import * as ApiError from "../error.ts"

/** The folder of a region-relative path: everything before the last segment, "" at the root. */
const folderOf = (path: string): string => {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

/** The region-relative asset id of a storage key (`assets/` prefix stripped). */
const assetIdOf = (key: string): string =>
  key.startsWith("assets/") ? key.slice("assets/".length) : key

export const AssetsApiHandlers = HttpApiBuilder.group(
  Api,
  "assets",
  Effect.fn(function* (handlers) {
    const blobs = yield* BlobStore
    const catalog = yield* Catalog
    const naming = yield* Naming
    const store = yield* DocumentStore

    return handlers.handleAll({
      // GET /assets/* — bare prefix is the folder-grouped listing; any other path is a byte read.
      read: Effect.fn("assets.read")(function* ({ params, query }) {
        const id = params["*"]
        if (id === undefined) {
          const prefix = query.folder === undefined ? "assets/" : `assets/${query.folder}/`
          const keys = yield* catalog.listAssets(prefix)
          return Array.from(keys).map((key) => {
            const path = assetIdOf(key)
            return { path, folder: folderOf(path) }
          })
        }
        const key = yield* naming
          .encodeAssetKey(id)
          .pipe(
            Effect.mapError(
              (error) => new ApiError.InvalidArgument({ value: error.value, reason: error.reason }),
            ),
          )
        const blob = yield* BlobStore.get(blobs)(key).pipe(
          Effect.mapError(
            (error) =>
              new ApiError.InvalidArgument({
                value: error.key,
                reason: "store read failed",
              }),
          ),
        )
        if (Option.isNone(blob)) {
          return yield* new ApiError.BlobNotFound({ key })
        }
        return HttpServerResponse.uint8Array(blob.value.body, {
          contentType: Option.getOrElse(
            blob.value.meta.contentType,
            () => "application/octet-stream",
          ),
          headers: { etag: blob.value.version },
        })
      }),

      // PUT /assets/* — create without If-Match (201), update with it (200).
      store: Effect.fn("assets.store")(function* ({ params, headers, payload }) {
        const id = params["*"]
        if (id === undefined || id === "") {
          return yield* new ApiError.InvalidArgument({ value: "", reason: "missing asset id" })
        }
        const expected = headers["if-match"]
        const opts: { ifCurrent?: string; contentType?: string } = {}
        if (expected !== undefined) {
          opts.ifCurrent = expected
        }
        const contentType = headers["content-type"]
        if (contentType !== undefined) {
          opts.contentType = contentType
        }
        const version = yield* store.storeAsset(id, payload, opts).pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "PreconditionFailed":
                return new ApiError.PreconditionFailed({
                  key: error.key,
                  expected: error.expected,
                  actual: error.actual,
                })
              case "InvalidArgument":
                return new ApiError.InvalidArgument({ value: error.value, reason: error.reason })
            }
          }),
        )
        return yield* HttpServerResponse.json(
          { version },
          { status: expected === undefined ? 201 : 200 },
        ).pipe(
          Effect.mapError(
            () => new ApiError.InvalidArgument({ value: "", reason: "response encoding failed" }),
          ),
        )
      }),

      // DELETE /assets/* — integrity-checked removal; missing keys are idempotent.
      remove: Effect.fn("assets.remove")(function* ({ params }) {
        const id = params["*"]
        if (id === undefined || id === "") {
          return yield* new ApiError.InvalidArgument({ value: "", reason: "missing asset id" })
        }
        yield* store.deleteAsset(id).pipe(
          Effect.mapError((error) => {
            switch (error._tag) {
              case "PreconditionFailed":
                return new ApiError.PreconditionFailed({
                  key: error.key,
                  expected: error.expected,
                  actual: error.actual,
                })
              case "IntegrityViolation":
                return new ApiError.IntegrityViolation({
                  reason: error.reason,
                  refs: error.refs,
                })
              case "InvalidArgument":
                return new ApiError.InvalidArgument({ value: error.value, reason: error.reason })
            }
          }),
        )
        return HttpServerResponse.empty()
      }),
    })
  }),
)
