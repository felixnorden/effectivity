import type { HttpServerRequest } from "effect/unstable/http"

/**
 * The origin of the current request — the base every resolved asset url
 * points at. Absolute urls (Workers, proxied deploys) resolve directly;
 * relative urls (in-process test harnesses) are rebuilt from the Host header.
 */
export const originOf = (request: HttpServerRequest.HttpServerRequest): string => {
  const url = request.url
  if (/^https?:\/\//i.test(url)) {
    return new URL(url).origin
  }
  const host = request.headers.host ?? "localhost"
  const proto =
    request.headers["x-forwarded-proto"] ??
    (host.startsWith("127.") || host.includes("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

/** The absolute `GET /assets/{id}` url for a region-relative asset id on a given origin. */
export const assetUrl = (origin: string, id: string): string =>
  `${origin}/assets/${id.split("/").map(encodeURIComponent).join("/")}`

/** The absolute `GET /documents/{path}` url for a region-relative doc path on a given origin. */
export const documentUrl = (origin: string, path: string): string =>
  `${origin}/documents/${path.split("/").map(encodeURIComponent).join("/")}`
