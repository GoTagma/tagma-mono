# tagma-editor

A visual editor for Tagma, built with React + Vite + Express, running on **Bun**.

## Requirements

- **Bun** >= 1.3

Check your current version:

```bash
bun --version
```

Install or upgrade Bun (PowerShell on Windows):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Or on macOS / Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Getting Started

1. Install dependencies:

   ```bash
   bun install
   ```

2. Start the development environment (runs the Vite dev server and the Express backend in parallel):

   ```bash
   bun run dev
   ```

3. Build the production bundle:

   ```bash
   bun run build
   ```

4. Run the backend in production mode:

   ```bash
   bun start
   ```

5. Preview the built frontend locally:

   ```bash
   bun run preview
   ```

6. Run the test suite:

   ```bash
   bun test
   ```

## Available Scripts

| Script                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `bun run dev`           | Run frontend and backend dev servers in parallel                                      |
| `bun run dev:server`    | Run backend only (`bun --watch server/index.ts`)                                      |
| `bun run dev:client`    | Run frontend only (`vite`)                                                            |
| `bun run build`         | Build the frontend for production                                                     |
| `bun run build:sidecar` | Compile the backend into a single-file executable (`bun build --compile`) for desktop |
| `bun start`             | Start the backend in production mode                                                  |
| `bun run preview`       | Preview the production build locally                                                  |
| `bun test`              | Run the test suite                                                                    |
| `bun run check:server`  | Type-check the backend only                                                           |

## In-app update surfaces

Several features are designed for the desktop wrapper ([tagma-desktop](../electron/README.md)) but also work in dev when the matching env vars are set.

### Bottom status bar

`src/components/VersionStatusBar.tsx` renders a persistent bar across all views except the welcome screen.

- **Left side** — version chips for the editor and the OpenCode CLI, each with an "update available" indicator. Clicking a chip opens a popover with detailed version info, a refresh button, and an **Update** action.
- **Right side** — zoom controls (`src/components/board/ZoomControls.tsx`) and a theme toggle.

The editor version comes from `GET /api/editor/info`; the OpenCode running/installed/bundled triple comes from `GET /api/opencode/info`.

### Cross-window sync

`src/utils/window-sync.ts` wraps a same-origin `BroadcastChannel('tagma.sync')` so multiple editor windows stay coherent without any IPC plumbing:

| Event              | Effect on peer windows                            |
| ------------------ | ------------------------------------------------- |
| `theme`            | Apply the new theme via `useTheme()`              |
| `editor-updated`   | `window.location.reload()` to pick up the new UI  |
| `opencode-updated` | Re-fetch `/api/opencode/info` (no reload needed)  |

Because the channel is renderer-side and same-origin, no Electron IPC is involved — the same wiring works in the browser dev preview.

### Editor frontend hot-update

The editor sidecar can fetch a newer frontend bundle from a published manifest, validate its `sha256`, and stage it under `userData/editor/dist/` without reinstalling the desktop app.

- Routes: `GET /api/editor/info`, `POST /api/editor/update` (`server/routes/editor.ts`).
- Manifest URL is built from `TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL` + `/${TAGMA_EDITOR_UPDATE_CHANNEL}/manifest.json`. Manifest fetches are cached for 5 minutes; `POST /api/editor/update` force-refreshes.
- Static-asset resolution prefers `TAGMA_EDITOR_USER_DIST_DIR` when its `index.html` exists, falling back to the bundled dist (`server/static-assets.ts`). Both env vars are set by the Electron main process at launch.
- The previous bundle is preserved at `<userData>/editor/dist.previous/` for rollback if the atomic rename of `dist.staging` → `dist` fails.

### In-app OpenCode CLI upgrade

`POST /api/opencode/update` downloads the requested version (defaults to the latest npm release) into the userData opencode dir. Lookup order at runtime: `TAGMA_OPENCODE_USER_DIR/bin` → bundled `resources/opencode/bin` → system `PATH`. Removing the user-dir copy reverts to the bundled binary.

## Notes

- The entire stack (editor server, SDK, CLI, sandbox) runs on Bun. Do not use `npm` or `node` — scripts assume Bun and the server source imports `Bun.*` globals.
- Task positions are persisted to a sibling `.layout.json` file next to the YAML file, saved on `Ctrl+S`.
- Command-type task cards automatically hide AI-specific fields.
- Hot-update / in-app upgrade surfaces are best exercised via the packaged desktop app (where the env vars are wired up automatically). See [`packages/electron/README.md`](../electron/README.md) for the release-side of the same flow (channel pinning, manifest publishing, `editor-dist-<version>.tar.gz`).
