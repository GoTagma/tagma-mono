# tagma-mono

Tagma monorepo - local AI task orchestration SDK and visual editor.

## Repository Structure

```
tagma-mono/
|-- packages/                 public npm packages (bun workspace: packages/*)
|   |-- types/                @tagma/types                Shared contracts and small runtime helpers
|   |-- core/                 @tagma/core                 Runtime-independent orchestration core
|   |-- runtime-bun/          @tagma/runtime-bun          Bun runtime implementation
|   |-- sdk/                  @tagma/sdk                  Public SDK and helpers
|   |-- driver-codex/         @tagma/driver-codex         Codex CLI driver plugin
|   |-- driver-claude-code/   @tagma/driver-claude-code   Claude Code CLI driver plugin
|   |-- middleware-lightrag/  @tagma/middleware-lightrag  LightRAG knowledge-graph retrieval middleware
|   |-- trigger-webhook/      @tagma/trigger-webhook      HTTP webhook trigger plugin
|   `-- completion-llm-judge/ @tagma/completion-llm-judge LLM-as-judge completion plugin
|-- apps/                     git submodule: GoTagma/tagma-desktop (private, bun workspace: apps/*)
|   |-- editor/               tagma-editor                Visual pipeline editor (React + Vite + Bun/Express)
|   `-- electron/             tagma-desktop               Electron shell + Bun-compiled sidecar for desktop builds
|-- package.json              monorepo root (bun workspaces)
`-- .gitignore
```

The five plugin packages (`driver-codex`, `driver-claude-code`, `middleware-lightrag`, `trigger-webhook`, `completion-llm-judge`) also serve as **reference implementations** for the five plugin categories - copy any of them as a starting point for a new plugin. The SDK's built-in driver is `opencode`; all other drivers ship as plugins.

## Quick Start

```bash
bun install
bun run build
bun run dev:editor
```

Workspace packages are symlinked. Edit SDK code, then restart the server. No reinstall needed.

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
bun run build                # Build types + core + runtime-bun + sdk + all plugin packages
bun run build:types          # Build @tagma/types only
bun run build:core           # Build @tagma/core only
bun run build:runtime-bun    # Build @tagma/runtime-bun only
bun run build:sdk            # Build @tagma/sdk only
bun run build:plugins        # Build all plugin packages (drivers + middlewares + triggers + completions)
bun run build:drivers        # Build driver plugins only
bun run build:middlewares    # Build middleware plugins only
bun run build:triggers       # Build trigger plugins only
bun run build:completions    # Build completion plugins only
bun run build:editor         # Build editor client (Vite bundle)
bun run build:editor-sidecar # Compile the editor server into a single-file executable (bun build --compile)
bun run build:electron       # Build the Electron main/preload bundles only
bun run build:desktop        # Full desktop chain: types -> core -> runtime-bun -> sdk -> plugins -> editor -> editor-sidecar -> electron
```

Build order: **types -> core -> runtime-bun -> sdk -> plugins**. The desktop chain layers the editor client, the compiled Bun sidecar, and the Electron shell on top.

### Type Checking

```bash
bun run check                      # Run all type checks (packages, editor server/client/tests, electron)
bun run check:types                # Check @tagma/types only
bun run check:core                 # Check @tagma/core only
bun run check:runtime-bun          # Check @tagma/runtime-bun only
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

Each installer also ships a platform-matched `opencode` CLI binary in `resources/opencode/` so end users don't need `bun` or a manual install. The version is pinned via `apps/electron/package.json -> tagma.bundledOpencodeVersion`; bump that field and re-run a `dist:desktop:*` command to cut a release with a new default. Users can upgrade opencode in-app (Editor Settings -> OpenCode CLI); those upgrades land in `userData/opencode/` and take precedence over the shipped copy without replacing it.

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

The default flow is **CI-driven**: bump the public package `version` fields, push to `main`, and `.github/workflows/publish-npm.yml` detects the changes and publishes to npm in dependency order. Manual scripts (below) are kept as a local fallback.

### 1. Bump version

The public `@tagma/*` packages can keep independent versions. Bump only the package that changed, or bump every public package from its own current version when a coordinated release is useful:

```bash
bun run version <all|package> <patch|minor|major|x.y.z>

# Examples
bun run version sdk patch      # bump @tagma/sdk only
bun run version core minor     # bump @tagma/core only
bun run version all patch      # +0.0.1 on each public package's current version
bun run version @tagma/sdk 0.8.0
```

The version script only updates package `version` fields; commit and push the change yourself. The CI workflow keys off version diffs in `packages/*/package.json`, not on git tags.

### 2. Push to `main` - CI publishes automatically

`publish-npm.yml` runs on every push to `main` that touches `packages/*/package.json`:

1. **Detect** - diffs each package's `version` against the previous commit. Packages whose version is unchanged are skipped.
2. **Publish** - for each changed package, runs the matching `publish:*` script in the dependency order **types -> core -> runtime-bun -> plugins -> sdk**.

Auth comes from the `NPM_TOKEN` repo secret (written to `.npmrc` at the workspace root before `bun publish`).

To force-publish without a version bump, trigger the workflow manually from the Actions tab and pass a JSON array, e.g. `["types","sdk"]`. Valid keys: `types`, `core`, `runtime-bun`, `codex`, `claude-code`, `lightrag`, `webhook`, `llm-judge`, `sdk`.

Publish order - required because npm rejects a published package version that depends on workspace package versions that do not exist yet:

1. `@tagma/types` (all other packages depend on it)
2. `@tagma/core`
3. `@tagma/runtime-bun`
4. All plugin packages: `@tagma/driver-codex`, `@tagma/driver-claude-code`, `@tagma/middleware-lightrag`, `@tagma/trigger-webhook`, `@tagma/completion-llm-judge`
5. `@tagma/sdk`

### 3. Manual publish (local fallback)

Use these only when the CI path is unavailable (workflow disabled, npm outage, hotfix from a branch). Each script runs `bun run build` then `bun publish`.

```bash
# Publish individual packages
bun run publish:types
bun run publish:core
bun run publish:runtime-bun
bun run publish:driver-codex
bun run publish:driver-claude-code
bun run publish:middleware-lightrag
bun run publish:trigger-webhook
bun run publish:completion-llm-judge
bun run publish:sdk

# Publish all public packages in order
bun run publish:all
```

### 4. Dry run

```bash
bun run publish:dry
```

`tagma-editor` and `tagma-desktop` live in the private [`GoTagma/tagma-desktop`](https://github.com/GoTagma/tagma-desktop) repo and are mounted here as a git submodule at `apps/`. Desktop releases ship as installer artifacts via `release-desktop.yml`; see `apps/electron/README.md`. Clone with `git clone --recurse-submodules`, or run `git submodule update --init --recursive` after a plain clone.

---

## Dependency Principles

1. **No internal path imports** - packages only import from public `@tagma/*` package names
2. **No `latest`** - workspace packages use `workspace:*`, third-party deps use pinned ranges
3. **Published tarballs include `dist/` only** - build scripts clean `dist/` before compiling so removed source files cannot leak into published packages
4. **Editor uses public API only** - consumes sdk/types via workspace link, never reaches into `src/`

---

## Tech Stack

- Runtime: Bun >= 1.3
- Types: TypeScript 5.8+
- Frontend: React 19 + Vite + Tailwind
- Server: Express 5 + Bun
- Desktop: Electron 35 + electron-builder (NSIS / AppImage / deb / rpm / dmg)
- Package manager: Bun workspaces
