# tagma-mono

Tagma monorepo — local AI task orchestration SDK and visual editor.

## Repository Structure

```
tagma-mono/
├── packages/
│   ├── types/                @tagma/types                Type-only package, no runtime code
│   ├── sdk/                  @tagma/sdk                  Core engine
│   ├── driver-codex/         @tagma/driver-codex         Codex CLI driver plugin
│   ├── driver-claude-code/   @tagma/driver-claude-code   Claude Code CLI driver plugin
│   ├── middleware-lightrag/  @tagma/middleware-lightrag  LightRAG knowledge-graph retrieval middleware
│   ├── trigger-webhook/      @tagma/trigger-webhook      HTTP webhook trigger plugin
│   ├── completion-llm-judge/ @tagma/completion-llm-judge LLM-as-judge completion plugin
│   ├── editor/               tagma-editor (private)      Visual pipeline editor (React + Vite + Bun/Express)
│   └── electron/             tagma-desktop (private)     Electron shell + Bun-compiled sidecar for desktop builds
├── package.json              monorepo root (bun workspaces)
└── .gitignore
```

The five plugin packages (`driver-codex`, `driver-claude-code`, `middleware-lightrag`, `trigger-webhook`, `completion-llm-judge`) also serve as **reference implementations** for the five plugin categories — copy any of them as a starting point for a new plugin. The SDK's built-in driver is `opencode`; all other drivers ship as plugins.

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
bun run dev:desktop    # Build the desktop chain and launch the Electron shell
```

### Build

```bash
bun run build                # Build types + sdk + all plugin packages (required before publishing)
bun run build:types          # Build @tagma/types only
bun run build:sdk            # Build @tagma/sdk only
bun run build:plugins        # Build all plugin packages (drivers + middlewares + triggers + completions)
bun run build:drivers        # Build driver plugins only
bun run build:middlewares    # Build middleware plugins only
bun run build:triggers       # Build trigger plugins only
bun run build:completions    # Build completion plugins only
bun run build:editor         # Build editor client (Vite bundle)
bun run build:editor-sidecar # Compile the editor server into a single-file executable (bun build --compile)
bun run build:electron       # Build the Electron main/preload bundles only
bun run build:desktop        # Full desktop chain: types → sdk → plugins → editor → editor-sidecar → electron
```

Build order: **types → sdk → plugins** (sdk depends on types dist, plugins depend on types only). The desktop chain layers the editor client, the compiled Bun sidecar, and the Electron shell on top.

### Type Checking

```bash
bun run check                      # Run all type checks (types, sdk, all plugins, editor server/client/tests, electron)
bun run check:types                # Check @tagma/types only
bun run check:sdk                  # Check @tagma/sdk only
bun run check:driver-codex         # Check @tagma/driver-codex only
bun run check:driver-claude-code   # Check @tagma/driver-claude-code only
bun run check:middleware-lightrag  # Check @tagma/middleware-lightrag only
bun run check:trigger-webhook      # Check @tagma/trigger-webhook only
bun run check:completion-llm-judge # Check @tagma/completion-llm-judge only
bun run check:server               # Check editor server only
bun run check:client               # Check editor client (Vite/React) only
bun run check:tests                # Check editor test sources only
bun run check:electron             # Check the Electron main/preload package only
```

### Testing

```bash
bun run test                              # Run all tests
bun run --filter @tagma/sdk test          # SDK only
bun run --filter tagma-editor test        # Editor only
```

### Desktop Packaging

```bash
bun run pack:desktop         # Build the desktop chain and produce an unpacked electron-builder dir
bun run dist:desktop:win     # Build + produce Windows installer (nsis)
bun run dist:desktop:linux   # Build + produce Linux AppImage, .deb, .rpm, and .tar.gz
bun run dist:desktop:mac     # Build + produce macOS dmg
```

Each installer also ships a platform-matched `opencode` CLI binary in `resources/opencode/` so end users don't need `bun` or a manual install. The version is pinned via `packages/electron/package.json → tagma.bundledOpencodeVersion`; bump that field and re-run a `dist:desktop:*` command to cut a release with a new default. Users can upgrade opencode in-app (Editor Settings → OpenCode CLI); those upgrades land in `userData/opencode/` and take precedence over the shipped copy without replacing it.

The `tagma-desktop` (Electron) package is private and is never published to npm.

### Lint & Format

```bash
bun run lint           # ESLint across packages/ (--max-warnings 0)
bun run format         # Prettier write
bun run format:check   # Prettier check
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
bun run version:claude-code:patch
bun run version:lightrag:patch
bun run version:webhook:patch
bun run version:llm-judge:patch
bun run version:sdk:patch

# Minor (+0.1.0)
bun run version:types:minor
bun run version:codex:minor
bun run version:claude-code:minor
bun run version:lightrag:minor
bun run version:webhook:minor
bun run version:llm-judge:minor
bun run version:sdk:minor

# Major (+1.0.0)
bun run version:types:major
bun run version:codex:major
bun run version:claude-code:major
bun run version:lightrag:major
bun run version:webhook:major
bun run version:llm-judge:major
bun run version:sdk:major
```

This runs `bun pm version` which updates the `version` field in the package's `package.json`. Commit and tag manually afterwards (`bun pm version` does not auto-create git commits/tags).

Publish order must follow the dependency chain:

1. `@tagma/types` (all other packages depend on it)
2. All plugin packages: `@tagma/driver-codex`, `@tagma/driver-claude-code`, `@tagma/middleware-lightrag`, `@tagma/trigger-webhook`, `@tagma/completion-llm-judge`
3. `@tagma/sdk`

### 2. Publish

```bash
# Publish individual packages (auto-builds before publish)
bun run publish:types
bun run publish:driver-codex
bun run publish:driver-claude-code
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
