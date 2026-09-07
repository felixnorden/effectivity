# @effectivity/core

A runtime-agnostic Effect library for a markdown document CMS: markdown
documents plus the image assets they reference, organized in logical folder
trees over a pluggable byte-blob storage boundary.

The package ships interfaces and services only — no adapter, no fake, no HTTP.
A runtime supplies the `BlobStore` byte seam (e.g. an R2/S3 adapter in a
separate package) and the root config; core composes everything else.

## Wire it

One schema per logical catalog root (D7). Provide a `BlobStore` layer plus a
root config, and receive the full store group:

```ts
import { Effect, Layer, Schema } from "effect"
import { BlobStore, Core, DocumentStore, parseDocument } from "@effectivity/core"

// caller-side: the schema that frontmatter must validate against
const Post = Schema.Struct({ title: Schema.String, tags: Schema.Array(Schema.String) })
type Post = typeof Post.Type

const config = { root: "docs/", frontmatter: Post }

const program = Effect.gen(function* () {
  const store = yield* DocumentStore
  const bytes = new TextEncoder().encode("---\ntitle: Hi\ntags: []\n---\nbody")
  const version = yield* store.create("docs/hello.md", bytes)
  const stored = yield* store.read("docs/hello.md") // Option<{ bytes, version }>
  if (stored._tag === "Some") {
    // typed parsing is generic on the schema you already own
    const doc = yield* parseDocument(Post, stored.value.bytes)
    doc.frontmatter.title // typed as string; `ValidationFailed` if it no longer fits
  }
})

program.pipe(
  Effect.provide(Core.layer(r2BlobStoreLayer, config)), // blob layer + config only
)
```

`Core.layer(blobStoreLayer, config)` is the single composition entry. It wires
Naming, the Catalog and ReferenceGraph read models, ChangeEvents, config, and
the facade over the caller's blob layer. Nothing else is required.

### Multiple document types

Two supported arrangements:

- **One root, one union schema** (the plan's D7 default). Use
  `Schema.Union([Page, Post])` as the frontmatter schema; validation enforces
  the per-type shape, and all types share one integrity graph and one event
  bus:
  ```ts
  const Root = Schema.Union([Page, Post])
  yield * store.create("docs/a.md", bytes) // validated against Root
  const doc = yield * parseDocument(Root, stored.bytes)
  // narrow by the discriminant field after parse
  ```
- **Separate instances for disjoint roots**. Call `Core.layer` per type with
  different roots. Each instance carries its own integrity graph and event
  bus; cross-instance references are not visible to either graph.

### Typed reads and where the schema lives

`store.read(path)` is a storage read: it returns `Option<{ bytes, version }>`
without parsing, mirroring `getAsset`. Typed parsing and validation are
caller-side codec calls — `parseDocument(schema, bytes)` and
`decodeFrontmatter(schema, yaml)` — generic over the schema argument, so the
schema value is the single type witness (no second config, no casts).
Mutations are still validated inside the store against the wired schema
(`ValidationFailed` on nonconforming writes), so the enforceable
serialization layer stays inside the store.

## Error contract

Every failure is a typed `Schema.TaggedError`:

| `_tag`                                     | Meaning                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `InvalidArgument`                          | Bad logical path/key input                                                |
| `ValidationFailed`                         | Bytes did not validate against the caller's frontmatter schema            |
| `PreconditionFailed`                       | Guarded conditional write/delete saw the wrong version or presence        |
| `IntegrityViolation`                       | Move/delete refused because references would break or orphan              |
| `BlobNotFound`                             | Byte wasn't found at the seam (reads return `Option`; head/get may raise) |
| `PermissionDenied` / `IOError` / `Timeout` | Adapter-mapped infrastructure failures                                    |

Cross-document operations are best-effort: each key-level step is atomic,
order is deterministic (destination before source), no rollback. Integrity
refusals are default; pass `{ override: true }` to force.

## Change events

Every successful mutation publishes exactly one `ChangeEvent` after all its
key-level steps commit, on the `ChangeEvents` service: `subscribe` returns a
`Stream` of events; document ops are `create`/`update`/`move`/`delete`, asset
ops are `store`/`delete`/`rename`. Refused mutations and reads emit nothing.
The bus is in-process (layer-scoped PubSub); external/storage-level writes are
out of scope.

## Out of scope

No HTTP/transport, no concrete runtime adapters, no auth, no binary asset
transforms, no markdown rendering, no full-text search, no versioning/soft
delete, no cross-key transactions, no observation of external writes, no
persistent event log, no pagination, no retry on conflicts. See the QRSPI plan
(`.qrspi/plans/20260907-effectivity-core.md`) for the full contract.
