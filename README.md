# tagma-mono

Tagma monorepo — local AI task orchestration SDK and visual editor.

## Repository Structure

```
tagma-mono/
├── packages/
│   ├── types/                @tagma/types                Type-only package, no runtime code
│   ├── sdk/                  @tagma/sdk                  Core engine
│   ├── driver-codex/         @tagma/driver-codex         Codex CLI driver plugin
│   ├── driver-opencode/      @tagma/driver-opencode      OpenCode CLI driver plugin
│   ├── middleware-lightrag/  @tagma/middleware-lightrag  LightRAG knowledge-graph retrieval middleware
│   ├── trigger-webhook/      @tagma/trigger-webhook      HTTP webhook trigger plugin
│   ├── completion-llm-judge/ @tagma/completion-llm-judge LLM-as-judge completion plugin
│   └── editor/               tagma-editor (private)      Visual pipeline editor
├── package.json              monorepo root (bun workspaces)
└── .gitignore
```

The five plugin packages (`driver-codex`, `driver-opencode`, `middleware-lightrag`, `trigger-webhook`, `completion-llm-judge`) also serve as **reference implementations** for the five plugin categories — copy any of them as a starting point for a new plugin.

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
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; bun install --force
```

### Local Development

```bash
bun run dev:editor     # Start editor (server + client concurrently)
bun run dev:server     # Start server only (watch mode)
bun run dev:client     # Start Vite client only
```

### Build

```bash
bun run build              # Build types + sdk + all plugin packages (required before publishing)
bun run build:types        # Build @tagma/types only
bun run build:sdk          # Build @tagma/sdk only
bun run build:plugins      # Build all plugin packages (drivers + middlewares + triggers + completions)
bun run build:drivers      # Build driver plugins only
bun run build:middlewares  # Build middleware plugins only
bun run build:triggers     # Build trigger plugins only
bun run build:completions  # Build completion plugins only
bun run build:editor       # Build editor client (Vite bundle)
```

Build order: **types → sdk → plugins** (sdk depends on types dist, plugins depend on types only).

### Type Checking

```bash
bun run check                      # Run all type checks (types, sdk, all plugins, editor)
bun run check:types                # Check @tagma/types only
bun run check:sdk                  # Check @tagma/sdk only
bun run check:driver-codex         # Check @tagma/driver-codex only
bun run check:driver-opencode      # Check @tagma/driver-opencode only
bun run check:middleware-lightrag  # Check @tagma/middleware-lightrag only
bun run check:trigger-webhook      # Check @tagma/trigger-webhook only
bun run check:completion-llm-judge # Check @tagma/completion-llm-judge only
bun run check:server               # Check editor server only
```

### Testing

```bash
bun run test                              # Run all tests
bun run --filter @tagma/sdk test          # SDK only
bun run --filter tagma-editor test        # Editor only
```

### Clean

```bash
bun run clean          # Remove all node_modules and dist outputs
bun run clean:all      # Also remove bun.lock
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
bun run version:lightrag:patch
bun run version:webhook:patch
bun run version:llm-judge:patch
bun run version:sdk:patch

# Minor (+0.1.0)
bun run version:types:minor
bun run version:codex:minor
bun run version:opencode:minor
bun run version:lightrag:minor
bun run version:webhook:minor
bun run version:llm-judge:minor
bun run version:sdk:minor

# Major (+1.0.0)
bun run version:types:major
bun run version:codex:major
bun run version:opencode:major
bun run version:lightrag:major
bun run version:webhook:major
bun run version:llm-judge:major
bun run version:sdk:major
```

This runs `bun pm version` which updates the `version` field in the package's `package.json`. Commit and tag manually afterwards (`bun pm version` does not auto-create git commits/tags).

Publish order must follow the dependency chain:

1. `@tagma/types` (all other packages depend on it)
2. All plugin packages: `@tagma/driver-codex`, `@tagma/driver-opencode`, `@tagma/middleware-lightrag`, `@tagma/trigger-webhook`, `@tagma/completion-llm-judge`
3. `@tagma/sdk`

### 2. Publish

```bash
# Publish individual packages (auto-builds before publish)
bun run publish:types
bun run publish:driver-codex
bun run publish:driver-opencode
bun run publish:middleware-lightrag
bun run publish:trigger-webhook
bun run publish:completion-llm-judge
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
3. **Published tarballs include both `dist/` and `src/`** — `dist/` is the runtime entry (`main` / `exports`); `src/` ships alongside so `declarationMap` / `sourceMap` can jump to the original TypeScript in IDEs
4. **Editor uses public API only** — consumes sdk/types via workspace link, never reaches into `src/`

---

## Tech Stack

- Runtime: Bun >= 1.3
- Types: TypeScript 5.8+
- Frontend: React 19 + Vite + Tailwind
- Server: Express 5 + Bun
- Package manager: Bun workspaces
