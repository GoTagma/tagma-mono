# tagma-mono

Tagma monorepo — local AI task orchestration SDK and visual editor.

## Packages

| Package | Directory | NPM | Role |
|---|---|---|---|
| `@tagma/types` | `packages/types` | `@tagma/types` | Shared type surface — no runtime code |
| `@tagma/sdk` | `packages/sdk` | `@tagma/sdk` | Core engine |
| `@tagma/driver-codex` | `packages/driver-codex` | `@tagma/driver-codex` | Codex CLI driver plugin |
| `@tagma/driver-opencode` | `packages/driver-opencode` | `@tagma/driver-opencode` | OpenCode CLI driver plugin |
| `tagma-editor` | `packages/editor` | (private) | Visual pipeline editor |

## Quick Start

```bash
# Install all workspace dependencies
bun install

# Build types first (other packages depend on this)
bun run build

# Start the editor in dev mode
bun run dev:editor
```

## Common Commands

| Command | Description |
|---|---|
| `bun install` | Install all workspace dependencies |
| `bun run build` | Build types + SDK (publishable packages) |
| `bun run build:types` | Build only `@tagma/types` |
| `bun run build:sdk` | Build only `@tagma/sdk` |
| `bun run build:editor` | Build editor client (Vite) |
| `bun run dev:editor` | Start editor (server + client, concurrently) |
| `bun run dev:server` | Start editor server only (watch mode) |
| `bun run dev:client` | Start editor client only (Vite dev) |
| `bun run check` | Run all type checks (types + sdk + server) |
| `bun run check:types` | Type check `@tagma/types` |
| `bun run check:sdk` | Type check `@tagma/sdk` |
| `bun run check:server` | Type check editor server |
| `bun run test` | Run all tests |
| `bun run clean` | Remove all node_modules, dist, lock files |

## Per-Package Commands

```bash
# From repo root, use --filter:
bun run --filter @tagma/types build
bun run --filter @tagma/sdk build
bun run --filter @tagma/sdk test
bun run --filter tagma-editor test
```

## Publishing

Build order matters because of dependencies:

```bash
# 1. Build and publish types first
cd packages/types && bun run build && npm publish

# 2. Build and publish drivers
cd packages/driver-codex && bun run build && npm publish
cd packages/driver-opencode && bun run build && npm publish

# 3. Build and publish SDK
cd packages/sdk && bun run build && npm publish
```

Or use the SDK's interactive release script:

```bash
cd packages/sdk
bun run release          # interactive version bump
bun run release:publish  # bump + publish
```

## Dependency Principles

1. **No internal path imports** — packages only import from public `@tagma/*` package names
2. **No `latest`** — workspace packages use `workspace:*`, all other deps are pinned ranges
3. **Build artifacts for publishing** — `@tagma/types` and `@tagma/sdk` build to `dist/` and ship build artifacts, not raw `.ts`
4. **Editor uses public API only** — `tagma-editor` imports `@tagma/sdk` and `@tagma/types` via workspace link, never touches internal `src/` paths

## Clean Install (no proxy)

```bash
bun run clean
bun install
```

## Tech Stack

- Runtime: Bun >= 1.3
- Types: TypeScript 5.8+
- Frontend: React 19 + Vite + Tailwind
- Server: Express 5 + Bun
- Package manager: Bun workspaces