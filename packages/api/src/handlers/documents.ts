import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  DocumentStore,
  resolveLinkTarget,
  rewriteDocLinks,
  rewriteImageRefs,
  type ParsedDocument,
} from "@effectivity/core"
import { Api } from "../api.ts"
import { assetUrl, documentUrl, originOf } from "../asset-url.ts"
import { decodeUtf8, encodeUtf8 } from "../bytes.ts"
import * as ApiError from "../error.ts"
import { Parse } from "../wiring.ts"

/** The markdown body of a stored document as text. */
const decodeBody = (bytes: Uint8Array): string => decodeUtf8(bytes)

/** The frontmatter title of a parsed document; empty when absent (docs are write-validated). */
const getTitle = (parsed: ParsedDocument<unknown>): string =>
  typeof parsed.frontmatter === "object" &&
  parsed.frontmatter !== null &&
  "title" in parsed.frontmatter &&
  typeof parsed.frontmatter.title === "string"
    ? parsed.frontmatter.title
    : ""

/** The folder of a region-relative path: everything before the last segment, "" at the root. */
const folderOf = (path: string): string => {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

/** The region-relative asset id of a storage key (`assets/` prefix stripped). */
const assetIdOf = (key: string): string =>
  key.startsWith("assets/") ? key.slice("assets/".length) : key

export const DocumentsApiHandlers = HttpApiBuilder.group(
  Api,
  "documents",
  Effect.fn(function* (handlers) {
    const store = yield* DocumentStore
    const parse = yield* Parse

    return handlers.handleAll({
      // GET /documents/* — bare prefix (no path param) is the catalog listing; any
      // other path is a read.
      read: Effect.fn("documents.read")(function* ({ params, query }) {
        const path = params["*"]
        if (path === undefined) {
          // Bare prefix — the catalog listing.
          const prefix = query.folder === undefined ? "docs/" : `docs/${query.folder}/`
          const listings = yield* store.listDocuments(prefix)
          const summaries: Array<{ path: string; title: string; folder: string }> = []
          for (const listing of listings) {
            const blob = yield* store.read(listing.path)
            if (Option.isNone(blob)) {
              continue
            }
            const parsed = yield* Effect.match(parse.parse(blob.value.bytes), {
              // A doc that no longer parses is skipped, matching the catalog read model.
              onFailure: () => Option.none<ParsedDocument<unknown>>(),
              onSuccess: Option.some,
            })
            if (Option.isNone(parsed)) {
              continue
            }
            summaries.push({
              path: listing.path,
              title: getTitle(parsed.value),
              folder: folderOf(listing.path),
            })
          }
          return summaries
        }
        const blob = yield* store
          .read(path)
          .pipe(
            Effect.mapError(
              (error) => new ApiError.InvalidArgument({ value: error.value, reason: error.reason }),
            ),
          )
        if (Option.isNone(blob)) {
          return yield* new ApiError.BlobNotFound({ key: `docs/${path}` })
        }
        if (query.view === "model") {
          const parsed = yield* parse
            .parse(blob.value.bytes)
            .pipe(
              Effect.mapError(
                (error) =>
                  new ApiError.ValidationFailed({ path: error.path, issues: error.issues }),
              ),
            )
          const request = yield* HttpServerRequest.HttpServerRequest
          const origin = originOf(request)
          const refs = yield* store.documentReferences(`docs/${path}`)
          const references = Array.from(refs).map((ref) => ({
            src: ref.src,
            asset: assetIdOf(ref.assetKey),
            url: assetUrl(origin, assetIdOf(ref.assetKey)),
            status: ref.status,
          }))
          return HttpServerResponse.text(
            JSON.stringify({
              frontmatter: parsed.frontmatter,
              body: parsed.body,
              hasFrontmatter: parsed.hasFrontmatter,
              references,
            }),
            { contentType: "application/json", headers: { etag: blob.value.version } },
          )
        }
        let text = decodeBody(blob.value.bytes)
        if (query.resolve === "urls") {
          const request = yield* HttpServerRequest.HttpServerRequest
          const origin = originOf(request)
          const refs = yield* store.documentReferences(`docs/${path}`)
          if (Array.from(refs).length > 0) {
            const urlBySrc = new Map(
              Array.from(refs).map((ref) => [ref.src, assetUrl(origin, assetIdOf(ref.assetKey))]),
            )
            text = rewriteImageRefs(text, (src) => urlBySrc.get(src) ?? src)
          }
          // Doc-to-doc links: catalog paths, ./ and ../ against this folder,
          // docs/ and /-prefixed absolute forms, assets/..., externals intact.
          text = rewriteDocLinks(text, (target) => {
            const resolved = resolveLinkTarget(`docs/${path}`, target)
            if (Option.isNone(resolved)) {
              return target
            }
            switch (resolved.value.kind) {
              case "doc":
                return `${documentUrl(origin, resolved.value.path)}${
                  resolved.value.fragment === undefined ? "" : `#${resolved.value.fragment}`
                }`
              case "asset":
                return assetUrl(origin, resolved.value.id)
            }
          })
        }
        return HttpServerResponse.text(text, {
          contentType: "text/markdown",
          headers: { etag: blob.value.version },
        })
      }),

      // PUT /documents/* — create without If-Match (201), update with it (200).
      upsert: Effect.fn("documents.upsert")(function* ({ params, headers, payload }) {
        const path = params["*"]
        if (path === undefined || path === "") {
          return yield* new ApiError.InvalidArgument({ value: "", reason: "missing document path" })
        }
        const bytes = encodeUtf8(payload)
        const expected = headers["if-match"]
        const version =
          expected === undefined
            ? yield* store.create(path, bytes).pipe(
                Effect.mapError((error) => {
                  switch (error._tag) {
                    case "PreconditionFailed":
                      return new ApiError.PreconditionFailed({
                        key: error.key,
                        expected: error.expected,
                        actual: error.actual,
                      })
                    case "ValidationFailed":
                      return new ApiError.ValidationFailed({
                        path: error.path,
                        issues: error.issues,
                      })
                    case "InvalidArgument":
                      return new ApiError.InvalidArgument({
                        value: error.value,
                        reason: error.reason,
                      })
                  }
                }),
              )
            : yield* store.update(path, bytes, { ifCurrent: expected }).pipe(
                Effect.mapError((error) => {
                  switch (error._tag) {
                    case "PreconditionFailed":
                      return new ApiError.PreconditionFailed({
                        key: error.key,
                        expected: error.expected,
                        actual: error.actual,
                      })
                    case "ValidationFailed":
                      return new ApiError.ValidationFailed({
                        path: error.path,
                        issues: error.issues,
                      })
                    case "InvalidArgument":
                      return new ApiError.InvalidArgument({
                        value: error.value,
                        reason: error.reason,
                      })
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

      // DELETE /documents/* — integrity-checked removal; missing keys are idempotent.
      remove: Effect.fn("documents.remove")(function* ({ params }) {
        const path = params["*"]
        if (path === undefined || path === "") {
          return yield* new ApiError.InvalidArgument({ value: "", reason: "missing document path" })
        }
        yield* store.deleteDocument(path).pipe(
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
