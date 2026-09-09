import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { DocumentStore, type ResolvedReference } from "@effectivity/core"
import { Api } from "../api.ts"
import { assetUrl, originOf } from "../asset-url.ts"

/** The region-relative asset id of a reference's storage key (`assets/` prefix stripped). */
const assetIdOf = (key: string): string =>
  key.startsWith("assets/") ? key.slice("assets/".length) : key

export const ReferencesApiHandlers = HttpApiBuilder.group(
  Api,
  "references",
  Effect.fn(function* (handlers) {
    const store = yield* DocumentStore

    return handlers.handleAll({
      // GET /references — the reference-graph read model, one entry per referenced document.
      get: Effect.fn("references.get")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const origin = originOf(request)
        const listings = yield* store.listDocuments("docs/")
        const entries: Array<{
          document: string
          references: Array<{
            src: string
            asset: string
            url: string
            status: ResolvedReference["status"]
            sourceLine?: number
          }>
        }> = []
        for (const listing of listings) {
          const refs = yield* store.documentReferences(listing.path)
          const mapped = Array.from(refs).map((ref) => {
            const entry: {
              src: string
              asset: string
              url: string
              status: ResolvedReference["status"]
              sourceLine?: number
            } = {
              src: ref.src,
              asset: assetIdOf(ref.assetKey),
              url: assetUrl(origin, assetIdOf(ref.assetKey)),
              status: ref.status,
            }
            if (ref.sourceLine !== undefined) {
              entry.sourceLine = ref.sourceLine
            }
            return entry
          })
          if (mapped.length > 0) {
            entries.push({ document: listing.path, references: mapped })
          }
        }
        return entries
      }),
    })
  }),
)
