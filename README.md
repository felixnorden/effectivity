# effectivity

Bun workspace monorepo with Turbo.

## Layout

`packages/*` is the workspace glob (declared in the root `package.json`):

- `packages/core` — `@effectivity/core`: the runtime-agnostic Effect library for the markdown CMS (documents, assets, catalog, reference graph). See [packages/core/README.md](packages/core/README.md).
- `packages/api` — `@effectivity/api`: the runtime-agnostic HTTP surface (HttpApi app, conditional writes, auth gate). See [packages/api/README.md](packages/api/README.md).
- `packages/auth` — `@effectivity/auth`: the Better Auth identity core behind the api write gate. See [packages/auth/README.md](packages/auth/README.md).
- `packages/cli` — `@effectivity/cli`: the Effect-native command engine that loads `effectivity.config.ts` and dispatches platform capabilities. See [packages/cli/README.md](packages/cli/README.md).
- `packages/cloudflare` — `@effectivity/cloudflare`: the Cloudflare Workers runtime library (plugin, R2 adapter, composition). See [packages/cloudflare/README.md](packages/cloudflare/README.md).
- `packages/examples` — `@effectivity/examples`: the reference runnable instance. See [packages/examples/README.md](packages/examples/README.md).

## How it fits together

- An instance owns `effectivity.config.ts` and a Worker entry. The config
  registers `cloudflarePlugin`.
- `@effectivity/cli` loads the config and dispatches the platform
  capabilities (`sync`, `dev`, `build`, `preview`, `seed`) to the registered
  plugins, in order.
- `@effectivity/cloudflare` owns all Cloudflare orchestration. `sync` writes
  `wrangler.jsonc` and `src/runtime.generated.ts`; the runtime serves
  `@effectivity/api` over the R2 byte adapter and the `@effectivity/auth`
  identity core.
- `@effectivity/core` is the domain library those layers build on.

## Catalogs

Shared dependency versions are defined once in the root `package.json` under
`catalog` and referenced from packages with the `catalog:` protocol:

```json
{
  "catalog": {
    "effect": "rc"
  }
}
```

```json
// packages/core/package.json
{
  "dependencies": {
    "effect": "catalog:"
  }
}
```

Update a version in one place (the root catalog), then run `bun install`.

## Scripts (root)

```bash
bun install          # install everything
bun run lint         # oxlint across all packages (via turbo)
bun run fmt          # oxfmt across all packages (via turbo)
bun run typecheck    # tsc across all packages (via turbo)
bun run test         # vitest across all packages (via turbo)
bun run check        # lint + typecheck + test
```

## Tooling

- [Effect](https://effect.website) — typed functional programming, used throughout
- oxlint — linting (`oxlint.config.ts`)
- oxfmt — formatting (`oxfmt.config.ts`)
- TypeScript 7 (native) — type checking, via `tsc`
- [@effect/tsgo](https://github.com/Effect-TS/tsgo) — Effect Language Service for editors
- Turbo — task runner / cache (`turbo.json`)
