import { Chunk, Context, Effect, Graph, HashMap, HashSet, Layer, Option } from "effect"
import { BlobStore, type BlobMeta, type BlobObject, type BlobStoreShape } from "./blob-store.ts"
import { CatalogRoot, type CatalogRootConfig } from "./config.ts"
import { classifyContent, splitFrontmatter } from "./codec.ts"
import { ASSET_REGION, DOC_REGION, encodeAssetKey } from "./naming.ts"

/**
 * Derived document→asset reference read model (D4, D9). Discovers image/media
 * references in stored document bodies, resolves each `src` to an asset key,
 * and classifies every reference as present, dangling, or wrong-typed against
 * the current stored bytes at the moment of the call. Provides integrity
 * verdicts that guarded mutations consult before committing.
 *
 * Pure and read-only: every call re-scans current storage (head/get/list only,
 * never put/del, never the DocumentStore service — no dependency cycles) and
 * caches nothing, so results cannot go stale (D4/D6).
 */
export type ReferenceStatus = "present" | "dangling" | "wrong-typed"

export interface ResolvedReference {
  /** The author-written `src` exactly as it appears in the markdown. */
  readonly src: string
  readonly assetKey: string
  readonly status: ReferenceStatus
  readonly sourceLine?: number
}

export type MoveVerdict =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly broken: Chunk.Chunk<ResolvedReference> }

export type AssetDeleteVerdict =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly referencers: Chunk.Chunk<string> }

export type DocumentDeleteVerdict =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly orphanedAssets: Chunk.Chunk<string> }

export interface ReferenceGraphShape {
  documentReferences(
    docKey: string,
  ): Effect.Effect<
    Chunk.Chunk<ResolvedReference>,
    never,
    BlobStore | Context.Reference<CatalogRootConfig>
  >
  referencersOf(
    assetKey: string,
  ): Effect.Effect<HashSet.HashSet<string>, never, BlobStore | Context.Reference<CatalogRootConfig>>
  wouldMoveBreakReferences(
    docKey: string,
    destKey: string,
  ): Effect.Effect<MoveVerdict, never, BlobStore | Context.Reference<CatalogRootConfig>>
  wouldAssetDeleteBeReferenced(
    assetKey: string,
  ): Effect.Effect<AssetDeleteVerdict, never, BlobStore | Context.Reference<CatalogRootConfig>>
  wouldDocumentDeleteOrphanAssets(
    docKey: string,
  ): Effect.Effect<DocumentDeleteVerdict, never, BlobStore | Context.Reference<CatalogRootConfig>>
}

/**
 * Regex scan of the markdown body region for image/media references only (D9;
 * no remark/unified stack). Matches `![alt](src)` and `![alt](src "title")`.
 */
const IMAGE_REF = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

/**
 * Substitute variant of {@link IMAGE_REF} with capture groups for the full
 * image markup; keep both patterns in sync (same tokenization).
 */
const IMAGE_REWRITE = /(!\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g

/**
 * Rewrite every image-reference `src` in a markdown body through a
 * caller-supplied mapping, preserving alt text, titles, and all other text
 * byte-identically. Non-image occurrences are untouched.
 */
export const rewriteImageRefs = (body: string, rewrite: (src: string) => string): string =>
  body.replace(
    IMAGE_REWRITE,
    (_full, pre: string, src: string, post: string) => `${pre}${rewrite(src)}${post}`,
  )

/**
 * Link-target rewrite regex, mirroring the image patterns. The leading
 * (^|[^!]) guard keeps image markup `![alt](src)` out: a link match whose
 * `[` is preceded by `!` is part of an image and is skipped.
 */
const LINK_REWRITE = /(^|[^!])(\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/gm

/**
 * Rewrite every markdown link `[text](target)` through a caller-supplied
 * mapping, preserving link text, titles, and all other text byte-identically.
 * Image markup (`![alt](src)`) is never matched. Targets the rewrite decides
 * to keep unchanged are returned as-is by returning the input target.
 */
export const rewriteDocLinks = (body: string, rewrite: (target: string) => string): string =>
  body.replace(
    LINK_REWRITE,
    (_full, prefix: string, pre: string, target: string, post: string) =>
      `${prefix}${pre}${rewrite(target)}${post}`,
  )

/** A resolved markdown link target: either a catalog document or an asset. */
export type ResolvedLink =
  | { readonly kind: "doc"; readonly path: string; readonly fragment?: string }
  | { readonly kind: "asset"; readonly id: string }

/**
 * Resolve a markdown link `target` against the source document key (catalog
 * convention): plain targets are catalog paths, `./`/`../` resolve against
 * the document's own folder, `docs/`/`/`-prefixed forms address the catalog
 * root explicitly, and `assets/...` targets resolve to assets. External,
 * anchor, and empty targets resolve to none (left as written).
 */
export const resolveLinkTarget = (docKey: string, target: string): Option.Option<ResolvedLink> => {
  if (target === "" || /^(https?:|mailto:|tel:|data:|#|\?)/i.test(target)) {
    return Option.none()
  }
  if (target.startsWith("assets/")) {
    return Option.some({ kind: "asset", id: target.slice("assets/".length) })
  }
  const [pathPart, fragment] = target.split("#")
  let path = pathPart ?? ""
  if (path.startsWith("docs/")) {
    path = path.slice("docs/".length)
  } else if (path.startsWith("/")) {
    path = path.slice(1)
  } else if (path.startsWith("./") || path.startsWith("../")) {
    const relDoc = docKey.startsWith(DOC_REGION) ? docKey.slice(DOC_REGION.length) : docKey
    const segments = relDoc.split("/")
    segments.pop() // drop the filename; the remainder is the document's folder
    const parent = segments.join("/")
    const normalized = normalizeRelative(parent === "" ? path : `${parent}/${path}`)
    if (Option.isNone(normalized)) {
      return Option.none()
    }
    path = normalized.value
  }
  return fragment === undefined
    ? Option.some({ kind: "doc", path })
    : Option.some({ kind: "doc", path, fragment })
}

interface DiscoveredRef {
  readonly src: string
  readonly line: number
}

const discoverImageRefs = (body: string): Chunk.Chunk<DiscoveredRef> => {
  const out: Array<DiscoveredRef> = []
  let match: RegExpExecArray | null
  while ((match = IMAGE_REF.exec(body)) !== null) {
    out.push({
      src: match[1] ?? "",
      line: body.slice(0, match.index).split("\n").length,
    })
  }
  return Chunk.fromIterable(out)
}

/**
 * Resolve ".."-free relative reference paths against a folder. Returns none
 * when the path escapes above the root or collapses to nothing.
 */
const normalizeRelative = (rel: string): Option.Option<string> => {
  const stack: Array<string> = []
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return Option.none()
      }
      stack.pop()
    } else {
      stack.push(segment)
    }
  }
  return stack.length === 0 ? Option.none() : Option.some(stack.join("/"))
}

/**
 * Resolve a reference `src` to a logical asset id. Absolute sources
 * (`assets/...`) resolve to themselves; relative sources resolve against the
 * document's own folder mirrored under the asset region, so a reference that
 * resolves from the source location may resolve elsewhere after a move.
 */
const resolveReferenceId = (docKey: string, src: string): Option.Option<string> => {
  if (src.startsWith(ASSET_REGION)) {
    return Option.some(src.slice(ASSET_REGION.length))
  }
  const relDoc = docKey.startsWith(DOC_REGION) ? docKey.slice(DOC_REGION.length) : docKey
  const segments = relDoc.split("/")
  segments.pop() // drop the filename; the remainder is the document's folder
  const parent = segments.join("/")
  return normalizeRelative(parent === "" ? src : `${parent}/${src}`)
}

/** Encode an asset id to its storage key, mapping malformed ids to none. */
const safeEncodeAssetKey = (id: string): Effect.Effect<Option.Option<string>> =>
  Effect.match(encodeAssetKey(id), {
    onFailure: () => Option.none(),
    onSuccess: Option.some,
  })

/** The document body as text; a malformed fence yields an empty body (never fails). */
const documentBody = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.match(splitFrontmatter(bytes), {
    onFailure: () => "",
    onSuccess: (split) => split.body,
  })

/** Read metadata, mapping exceptional failures to none (missing ⇔ dangling). */
const safeHead = (store: BlobStoreShape, key: string): Effect.Effect<Option.Option<BlobMeta>> =>
  Effect.match(BlobStore.head(store)(key), {
    onFailure: () => Option.none(),
    onSuccess: (meta) => meta,
  })

/** Read a blob, mapping exceptional failures to none (missing ⇔ no body). */
const safeGet = (store: BlobStoreShape, key: string): Effect.Effect<Option.Option<BlobObject>> =>
  Effect.match(BlobStore.get(store)(key), {
    onFailure: () => Option.none(),
    onSuccess: (blob) => blob,
  })

/** Classified references of one document; missing or malformed documents yield none. */
const documentReferences = Effect.fn("reference-graph.documentReferences")(function* (
  docKey: string,
): Effect.fn.Return<
  Chunk.Chunk<ResolvedReference>,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const config = yield* CatalogRoot
  const blob = yield* safeGet(store, docKey)
  if (Option.isNone(blob)) {
    return Chunk.empty()
  }
  const body = yield* documentBody(blob.value.body)
  const out: Array<ResolvedReference> = []
  for (const ref of discoverImageRefs(body)) {
    const id = resolveReferenceId(docKey, ref.src)
    if (Option.isNone(id)) {
      continue
    }
    const key = yield* safeEncodeAssetKey(id.value)
    if (Option.isNone(key)) {
      continue
    }
    const meta = yield* safeHead(store, key.value)
    let status: ReferenceStatus
    if (Option.isNone(meta)) {
      status = "dangling"
    } else {
      const asset = yield* safeGet(store, key.value)
      const parsesAsDocument =
        Option.isSome(asset) && (yield* classifyContent(asset.value.body, config.frontmatter))
      status = parsesAsDocument ? "wrong-typed" : "present"
    }
    out.push({ src: ref.src, assetKey: key.value, status, sourceLine: ref.line })
  }
  return Chunk.fromIterable(out)
})

/** Document keys that reference a given asset key. */
const referencersOf = Effect.fn("reference-graph.referencersOf")(function* (
  assetKey: string,
): Effect.fn.Return<
  HashSet.HashSet<string>,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const docs = yield* BlobStore.list(store)(DOC_REGION)
  let referencers = HashSet.empty<string>()
  for (const docKey of docs) {
    const refs = yield* documentReferences(docKey)
    const referencesAsset = Array.from(refs).some((ref) => ref.assetKey === assetKey)
    if (referencesAsset) {
      referencers = HashSet.add(referencers, docKey)
    }
  }
  return referencers
})

/** Asset key → set of document keys referencing it, scanned from current storage. */
const buildAdjacency = Effect.fn("reference-graph.buildAdjacency")(function* (): Effect.fn.Return<
  HashMap.HashMap<string, HashSet.HashSet<string>>,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const docs = yield* BlobStore.list(store)(DOC_REGION)
  let adjacency = HashMap.empty<string, HashSet.HashSet<string>>()
  for (const docKey of docs) {
    const refs = yield* documentReferences(docKey)
    for (const ref of refs) {
      const current = HashMap.get(adjacency, ref.assetKey)
      const set = Option.isSome(current) ? current.value : HashSet.empty<string>()
      adjacency = HashMap.set(adjacency, ref.assetKey, HashSet.add(set, docKey))
    }
  }
  return adjacency
})

/** Verdict for a document move: refused when any reference resolves elsewhere from the destination. */
const wouldMoveBreakReferences = Effect.fn("reference-graph.wouldMoveBreakReferences")(function* (
  docKey: string,
  destKey: string,
): Effect.fn.Return<MoveVerdict, never, BlobStore | Context.Reference<CatalogRootConfig>> {
  const store = yield* BlobStore
  const blob = yield* safeGet(store, docKey)
  if (Option.isNone(blob)) {
    return { status: "allowed" }
  }
  const body = yield* documentBody(blob.value.body)
  const broken: Array<ResolvedReference> = []
  for (const ref of discoverImageRefs(body)) {
    const idAtSource = resolveReferenceId(docKey, ref.src)
    const idAtDestination = resolveReferenceId(destKey, ref.src)
    if (Option.isNone(idAtSource) || Option.isNone(idAtDestination)) {
      continue
    }
    if (idAtSource.value !== idAtDestination.value) {
      const key = yield* safeEncodeAssetKey(idAtDestination.value)
      if (Option.isSome(key)) {
        broken.push({ src: ref.src, assetKey: key.value, status: "dangling", sourceLine: ref.line })
      }
    }
  }
  return broken.length === 0
    ? { status: "allowed" }
    : { status: "refused", broken: Chunk.fromIterable(broken) }
})

/** Verdict for an asset delete: refused while any document still references it. */
const wouldAssetDeleteBeReferenced = Effect.fn("reference-graph.wouldAssetDeleteBeReferenced")(
  function* (
    assetKey: string,
  ): Effect.fn.Return<AssetDeleteVerdict, never, BlobStore | Context.Reference<CatalogRootConfig>> {
    const adjacency = yield* buildAdjacency()
    const referencers = HashMap.get(adjacency, assetKey)
    return Option.isSome(referencers) && HashSet.size(referencers.value) > 0
      ? { status: "refused", referencers: Chunk.fromIterable(referencers.value) }
      : { status: "allowed" }
  },
)

/** Verdict for a document delete: refused when it is the sole referencer of any asset. */
const wouldDocumentDeleteOrphanAssets = Effect.fn(
  "reference-graph.wouldDocumentDeleteOrphanAssets",
)(function* (
  docKey: string,
): Effect.fn.Return<
  DocumentDeleteVerdict,
  never,
  BlobStore | Context.Reference<CatalogRootConfig>
> {
  const store = yield* BlobStore
  const docs = yield* BlobStore.list(store)(DOC_REGION)

  // Resolve each document's referenced asset keys (Effect pass).
  let docRefs = HashMap.empty<string, ReadonlyArray<string>>()
  for (const doc of docs) {
    const refs = yield* documentReferences(doc)
    docRefs = HashMap.set(
      docRefs,
      doc,
      Array.from(refs).map((ref) => ref.assetKey),
    )
  }

  // Build the directed doc→asset graph (D11: Graph for reachability).
  let nodeIndexByKey = HashMap.empty<string, number>()
  const graph = Graph.mutate<string, string>((mutable) => {
    for (const [doc, refs] of Array.from(docRefs)) {
      let from: number
      const existingDoc = HashMap.get(nodeIndexByKey, doc)
      if (Option.isSome(existingDoc)) {
        from = existingDoc.value
      } else {
        const fresh = Graph.addNode(mutable, doc)
        nodeIndexByKey = HashMap.set(nodeIndexByKey, doc, fresh)
        from = fresh
      }
      for (const assetKey of refs) {
        let to: number
        const existingAsset = HashMap.get(nodeIndexByKey, assetKey)
        if (Option.isSome(existingAsset)) {
          to = existingAsset.value
        } else {
          const fresh = Graph.addNode(mutable, assetKey)
          nodeIndexByKey = HashMap.set(nodeIndexByKey, assetKey, fresh)
          to = fresh
        }
        Graph.addEdge(mutable, from, to, assetKey)
      }
    }
  })(Graph.directed<string, string>())

  // Sole-referencer analysis: assets reachable from docKey with indegree 1.
  const docNode = HashMap.get(nodeIndexByKey, docKey)
  if (Option.isNone(docNode)) {
    return { status: "allowed" }
  }
  const orphaned: Array<string> = []
  for (const target of Graph.successors(graph, docNode.value)) {
    const incoming = Graph.predecessors(graph, target)
    if (incoming.length === 1 && (Array.from(incoming)[0] ?? -1) === docNode.value) {
      const data = Graph.getNode(graph, target)
      if (Option.isSome(data)) {
        orphaned.push(data.value)
      }
    }
  }
  return orphaned.length === 0
    ? { status: "allowed" }
    : { status: "refused", orphanedAssets: Chunk.fromIterable(orphaned) }
})

export class ReferenceGraph extends Context.Service<ReferenceGraph, ReferenceGraphShape>()(
  "effectivity/reference-graph/ReferenceGraph",
) {
  static readonly layer = Layer.effect(
    ReferenceGraph,
    Effect.gen(function* () {
      yield* BlobStore
      yield* CatalogRoot
      return ReferenceGraph.of({
        documentReferences,
        referencersOf,
        wouldMoveBreakReferences,
        wouldAssetDeleteBeReferenced,
        wouldDocumentDeleteOrphanAssets,
      })
    }),
  )
}
