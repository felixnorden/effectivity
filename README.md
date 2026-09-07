# effectivity

Bun workspace monorepo with Turbo.

## Layout

- `packages/*` — workspace packages (declared via `workspaces` in the root `package.json`)
- `packages/core` — `@effectivity/core`, the core Effect package

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
