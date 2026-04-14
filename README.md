# tagma-mono

Tagma monorepo — local AI task orchestration SDK and visual editor.

## Repository Structure

```
tagma-mono/
├── packages/
│   ├── types/           @tagma/types       Type-only package, no runtime code
│   ├── sdk/             @tagma/sdk         Core engine
│   ├── driver-codex/    @tagma/driver-codex Codex CLI driver plugin
│   ├── driver-opencode/ @tagma/driver-opencode OpenCode CLI driver plugin
│   └── editor/          tagma-editor (private) Visual pipeline editor
├── package.json         monorepo root (bun workspaces)
└── .gitignore
```

## Quick Start

```bash
bun install
bun run build
bun run dev:editor
```

Workspace packages are symlinked. Edit SDK code → restart server. No reinstall needed.

---

## Common Commands

### Install Dependencies

```bash
bun install
# If proxy is blocking:
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; bun install --no-cache
```

### Local Development

```bash
bun run dev:editor     # Start editor (server + client concurrently)
bun run dev:server     # Start server only (watch mode)
bun run dev:client     # Start Vite client only
```

### Build

```bash
bun run build          # Build types + sdk (required before publishing)
bun run build:all      # Build types + sdk + drivers
bun run build:types    # Build @tagma/types only
bun run build:sdk      # Build @tagma/sdk only
bun run build:drivers  # Build both driver plugins
bun run build:editor   # Build editor client (Vite bundle)
```

Build order: **types → sdk → drivers** (sdk depends on types dist).

### Type Checking

```bash
bun run check          # Run all type checks
bun run check:types    # Check @tagma/types only
bun run check:sdk      # Check @tagma/sdk only
bun run check:server   # Check editor server only
```

### Testing

```bash
bun run test                              # Run all tests
bun run --filter @tagma/sdk test          # SDK only
bun run --filter tagma-editor test        # Editor only
```

### Clean

```bash
bun run clean          # Remove all node_modules, dist, lock files
bun install            # Reinstall
```

---

## Publishing

### 1. Bump version

```bash
# Patch (+0.0.1)
bun run version:types:patch
bun run version:codex:patch
bun run version:opencode:patch
bun run version:sdk:patch

# Minor (+0.1.0)
bun run version:types:minor
bun run version:codex:minor
bun run version:opencode:minor
bun run version:sdk:minor

# Major (+1.0.0)
bun run version:types:major
bun run version:codex:major
bun run version:opencode:major
bun run version:sdk:major
```

This runs `npm version` which updates the `version` field in the package's `package.json` and creates a git commit + tag.

Publish order must follow the dependency chain:

1. `@tagma/types` (all other packages depend on it)
2. `@tagma/driver-codex` + `@tagma/driver-opencode`
3. `@tagma/sdk`

### 2. Publish

```bash
# Publish individual packages (auto-builds before publish)
bun run publish:types
bun run publish:driver-codex
bun run publish:driver-opencode
bun run publish:sdk

# Publish all public packages in order
bun run publish:all
```

Each `publish:*` script runs `bun run build` then `npm publish`.

### 3. Dry run

```bash
bun run publish:dry
```

`tagma-editor` is a private package and is not published to npm.

---

## Dependency Principles

1. **No internal path imports** — packages only import from `@tagma/types`, `@tagma/sdk` public package names
2. **No `latest`** — workspace packages use `workspace:*`, third-party deps use pinned ranges
3. **Publish artifacts, not source** — types/sdk publish `.js` + `.d.ts` from `dist/`, not raw `.ts`
4. **Editor uses public API only** — consumes sdk/types via workspace link, never reaches into `src/`

---

## Tech Stack

- Runtime: Bun >= 1.3
- Types: TypeScript 5.8+
- Frontend: React 19 + Vite + Tailwind
- Server: Express 5 + Bun
- Package manager: Bun workspaces