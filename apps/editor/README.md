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

2. Start the development environment (ensures the bundled OpenCode binary, starts the Express backend, then starts Vite once the backend port is ready):

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

| Script                     | Description                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `bun run dev`              | Ensure OpenCode, start the backend, wait for it, then start Vite                      |
| `bun run dev:server`       | Ensure OpenCode, then run backend only (`bun --watch server/index.ts`)                |
| `bun run dev:server:watch` | Run backend only without the OpenCode ensure step                                     |
| `bun run dev:client`       | Run frontend only (`vite`)                                                            |
| `bun run build`            | Build the frontend for production                                                     |
| `bun run build:sidecar`    | Compile the backend into a single-file executable (`bun build --compile`) for desktop |
| `bun start`                | Start the backend in production mode                                                  |
| `bun run preview`          | Preview the production build locally                                                  |
| `bun test`                 | Run the test suite                                                                    |
| `bun run check:server`     | Type-check the backend only                                                           |
| `bun run ensure:opencode`  | Download the bundled OpenCode binary into `../electron/build/opencode/`               |
| `bun run install:clean`    | Wipe `node_modules` + `bun.lock` + Bun's pm cache, then reinstall                     |

## In-app update surfaces

Several features are designed for the desktop wrapper ([tagma-desktop](../electron/README.md)) but also work in dev when the matching env vars are set.

### Bottom status bar

`src/components/VersionStatusBar.tsx` renders a persistent bar across all views except the welcome screen.

- **Left side** — two version chips:
  - **`tagma <version>`** — unified view of the editor + sidecar bundle. Shows an "update available" dot when either component has a newer build, or a red warning triangle when editor and sidecar are on different versions (skew). Clicking opens a popover whose primary action runs an **atomic editor + sidecar bundle update** via `POST /api/release/update`; the popover also exposes editor-only and sidecar-only escape hatches for recovery scenarios.
  - **`opencode <version>`** — read-only. Shows the running/bundled version but intentionally does not expose an updater — OpenCode is pinned per Tagma release and upgrades ride along with bundle updates.
- **Middle** — current YAML file path (clickable to reveal in the OS file manager) and a save indicator.
- **Right side** — zoom controls (`src/components/board/ZoomControls.tsx`) and a theme toggle.

The Tagma chip's active version is the shared `activeVersion` of editor + sidecar (or `mixed` when they disagree). Versions come from `GET /api/editor/info`, `GET /api/sidecar/info`, and `GET /api/opencode/info`.

### Cross-window sync

`src/utils/window-sync.ts` wraps a same-origin `BroadcastChannel('tagma.sync')` so multiple editor windows stay coherent without any IPC plumbing:

| Event             | Effect on peer windows                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `theme`           | Apply the new theme via `useTheme()`                                                                                                                           |
| `editor-updated`  | Re-fetch `/api/editor/info` so the Tagma chip flips to "pending restart" (no `window.location.reload` — only a sidecar respawn would actually swap the bundle) |
| `sidecar-updated` | Re-fetch `/api/sidecar/info` so the Tagma chip flips to "pending restart"                                                                                      |

Because the channel is renderer-side and same-origin, no Electron IPC is involved — the same wiring works in the browser dev preview.

### Tagma bundle hot-update (editor + sidecar)

The primary hot-update path. Stages both the editor frontend tarball and the sidecar binary first; if either stage fails (network, hash mismatch, signature failure), neither is activated and the previous build keeps running. Only after both stages succeed does the sidecar flip the live pointers (editor first, then sidecar). Two new builds always activate together, so a peer-window reload never picks up a half-applied update.

- Routes: `POST /api/release/update`, `POST /api/release/update/cancel` (`server/routes/release.ts`).
- Status: `GET /api/hotupdate/status` reports the active update kind (`release` | `editor` | `sidecar` | `opencode`) so peer windows can show the in-flight indicator.
- Manifest: pinned to the editor channel's manifest; editor and sidecar advertised together must agree on a single shell-compatible version.
- The Tagma chip's **Update** action drives this route; the popover also exposes editor-only / sidecar-only retries for recovery when one half got stuck.

### Editor frontend hot-update

The editor sidecar can fetch a newer frontend bundle from a published manifest, validate its `sha256`, and stage it under `userData/editor/dist/` without reinstalling the desktop app.

- Routes: `GET /api/editor/info`, `POST /api/editor/update` (`server/routes/editor.ts`).
- Manifest URL is built from `TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL` + `/${TAGMA_EDITOR_UPDATE_CHANNEL}/manifest.json`. Manifest fetches are cached for up to 60 seconds; `POST /api/editor/update` force-refreshes.
- Static-asset resolution prefers `TAGMA_EDITOR_USER_DIST_DIR` when its `index.html` exists, falling back to the bundled dist (`server/static-assets.ts`). Both env vars are set by the Electron main process at launch.
- The previous bundle is preserved at `<userData>/editor/dist.previous/` for rollback if the atomic rename of `dist.staged` → `dist` fails.

### Sidecar hot-update

The running sidecar can also fetch a newer platform-specific sidecar binary from the same manifest and stage it under `userData/editor-sidecar/versions/<version>/`.

- Routes: `GET /api/sidecar/info`, `POST /api/sidecar/update` (`server/routes/sidecar.ts`).
- Electron stamps `TAGMA_SIDECAR_*` env vars so the route can report bundled vs running vs staged versions.
- Applying the update is pointer-based: `current.json` moves to the new version, and Electron picks it up the next time it respawns the sidecar.
- If the downloaded sidecar crashes before `TAGMA_READY`, Electron removes the override and falls back to the bundled copy automatically.

### In-app OpenCode CLI upgrade

`POST /api/opencode/update` downloads the requested version (defaults to the latest npm release) into the userData opencode dir. Lookup order at runtime: `TAGMA_OPENCODE_USER_DIR/bin` → bundled `resources/opencode/bin` → system `PATH`. Removing the user-dir copy reverts to the bundled binary.

The frontend status bar no longer surfaces this endpoint — independent OpenCode upgrades have caused chat/runtime regressions, so the desktop UI pins users to the OpenCode that ships with each Tagma release. The route is kept for tooling/manual recovery only.

## Notes

- The entire stack (editor server, SDK, CLI, sandbox) runs on Bun. Do not use `npm` or `node` — scripts assume Bun and the server source imports `Bun.*` globals.
- Task positions and editor-only track folders are persisted to a sibling `.layout.json` file next to the YAML file (e.g. `pipeline.yaml` ↔ `pipeline.layout.json`), saved on `Ctrl+S`. Track folders never appear in the pipeline YAML itself.
- Command-type task cards automatically hide AI-specific fields.
- Hot-update / in-app upgrade surfaces are best exercised via the packaged desktop app (where the env vars are wired up automatically). See [`apps/electron/README.md`](../electron/README.md) for the release-side of the same flow (channel pinning, manifest publishing, `editor-dist-<version>.tar.gz`).
