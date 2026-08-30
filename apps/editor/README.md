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

## Workflow editor and run behavior

Pipeline Detail exposes four run modes: run once, retry until success, repeat a fixed count, or
repeat until aborted. Retry until success is bounded by an editable maximum attempt count
(default 3) and feeds failed-attempt evidence into the next agent attempt. Pipeline success is the
gate, so use a final command task such as `pytest` or `bun test`, or configure a task Completion
Check, to verify the generated result. Run details keep the existing Run N/M and task snapshots and
show repair feedback in a compact expandable section when a failed attempt is retried.

Chat-authored Sandbox Trial keeps revision safety while avoiding mechanical reruns. A new YAML
revision can seed its draft from the previous Host-authenticated Trial Plan. Successful
command-only cases are reused only when their complete target closure, fixtures, expectations,
user-owned support files, runtime mode, capability report, and Host prerequisites are unchanged;
prompt and triggered closures always run again. The live Trial status includes a Host heartbeat
and elapsed time during long, otherwise-silent model tasks.

Desktop Chat routes pipeline work in two phases. A tool-free text invocation first returns one small
JSON decision: discussion, read-only diagnosis, create, edit of one Host-issued pipeline candidate,
or clarification. The Host strictly parses that text and accepts only its fixed fields and candidate
ids; provider-native structured output is not required. The ordinary prompt carries the complete
fixed schema and valid kind-specific shapes. If the model still violates that text contract, the
Host performs at most one automatic repair with a fresh durable invocation identity; other provider
failures are never auto-retried, and a second malformed result fails closed while preserving the
request. Tagma allocates no pipeline for
discussion/diagnosis and asks rather than guessing when a write target is ambiguous. Model tools are
needed only after a create/edit decision reaches the isolated authoring branch. Send authenticates
the exact configured provider/model pair without consulting advisory model capability or status
metadata, so catalog refreshes cannot change request identity or recovery.

Every mutating Chat session owns a Host-authenticated pipeline branch. Sessions may clone the same
read-only origin, but they never share a writable target; a session reuses only its own published
branch on later edits. Finished branches reconcile independently, so one preserved failure does not
block other sessions. Host Trial remains a workspace-wide safety barrier while it is running.

When Chat preserves an unverified fork instead of overwriting another pipeline, the pipeline picker
keeps that unchanged branch under a collapsed **Failed Chat drafts** section. The branch remains
openable and explicitly removable; editing it or replacing it with a newer successful result returns
it to the ordinary pipeline list. A legacy result whose route provenance is missing offers **Save as
independent pipeline** instead of repeating a deterministic Retry.

## Production diagnostics for coding agents

Packaged Tagma builds include an opt-in, read-only diagnostics API for debugging the installed
editor with Codex or another local coding agent. It is disabled by default and needs no separate
CLI or developer build.

1. Open the workspace that has the problem.
2. Open **Editor Settings → Coding agent diagnostics**.
3. Select **Enable diagnostics**.
4. Select **Copy agent instructions** and paste the copied text into the coding agent. No extra
   prompt is required.
5. Select **Disable** when the investigation is finished.

The copied handoff is self-contained: it contains the loopback URL, a temporary bearer token, the
requests the agent should run itself, and instructions to diagnose the root cause before proposing
changes. The agent is told not to modify files, settings, processes, or editor state unless the user
explicitly asks after the diagnosis. Put the token in
`Authorization: Bearer <temporary-diagnostics-token>`, never in a URL.
It starts with one context snapshot plus the structured timeline and log cursors, then polls the
timeline and logs independently with each response's own `nextCursor`.

| Read-only endpoint                                                      | Contents                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/diagnostics/v1/manifest`                                      | Protocol, coverage, privacy notes, and endpoint discovery                    |
| `GET /api/diagnostics/v1/context`                                       | Editor/workspace/run state, renderer snapshot, and OpenCode runtime info     |
| `GET /api/diagnostics/v1/timeline?after=<cursor>&limit=<1-1000>`        | Content-minimized structured renderer transitions with an independent cursor |
| `GET /api/diagnostics/v1/logs?after=<cursor>&limit=<1-1000>`            | Cursor logs plus the Electron `sidecar.log` tail                             |
| `GET /api/diagnostics/v1/opencode/sessions`                             | Sessions scoped to the workspace's existing OpenCode process                 |
| `GET /api/diagnostics/v1/opencode/sessions/<id>/messages?limit=<1-200>` | Bounded history after verifying session ownership                            |

The diagnostics token is independent from the sidecar management token, rotates on every enable,
authorizes only `GET` below `/api/diagnostics/v1`, and is revoked on disable or shutdown. OpenCode
history reads never start, restart, prompt, or mutate OpenCode; they return `409` when it is not
running. OpenCode's compatibility-text sessions may have no public message projection; for an empty
first page, the message endpoint can return the authenticated immutable Host-visible
discussion/diagnosis result and labels that source explicitly. It never exposes internal classifier
text or uses this fallback for cursor pagination. Captured logs, renderer reports, timeline
comparison state, timeline events, and all
cursors are cleared whenever a session rotates or ends, so a later workspace cannot inherit them.
Renderer console/error capture exists only during the matching diagnostics session and is restored
without overwriting a console wrapper installed later by another feature. Normal Chat health probes
(`checking`/`ok`) do not create timeline events; degraded health and its recovery remain observable.
Release process output
comes from Electron's existing `sidecar.log`, so normal process streams are not wrapped.

The protocol is extensible without changing the connection flow. Renderer features register lazy
state under `features` with `registerRendererDiagnosticsContributor`; sidecar features use
`registerServerDiagnosticsContributor`. Providers run only when diagnostics context is requested,
are failure-isolated and sanitized, and do not participate in normal feature execution. Repository
instructions require new long-lived feature state to use this extension point. Accepted renderer
reports also feed the timeline: the first report from each renderer instance establishes
`page/chat/pipeline/run/features` baselines, and later events contain only the sections whose
meaningful summary changed. Snapshot capture timestamps and Chat turn-health heartbeat timestamps
do not create timeline churn by themselves.

Payloads are bounded, and known credential fields and common token formats are redacted. This is
best-effort protection. Timeline events use explicit metadata allow-lists and are
content-minimized: they exclude raw authored message bodies, composer drafts, pending user text,
tool prompts or output, and commands. They can retain bounded, redacted host error, validation, and
Trial diagnostic strings needed for diagnosis; treat those strings as sensitive. The broader
context, OpenCode history, logs, paths, errors, and arbitrary user-authored text can also be
sensitive. Review diagnostics before sharing them.

Every intentional diagnostics window reports its own layer and source/returned/omitted boundary.
Renderer session and log snapshots preserve the newest retained entries and expose their counts;
run-history list, pipeline-log, task-output, and Ask AI context reads likewise identify their
read-interface limit. Treat those limits as clipping of the read-only response, not evidence that
the persisted file, runtime stream, or underlying event buffer was truncated.

For a long-running investigation, retain two independent cursors. Read
`/timeline?after=0&limit=500` and `/logs?after=0&limit=500` once, then use the timeline
`nextCursor` only for the next timeline request and the log `nextCursor` only for the next log
request. On each response, inspect `retention` separately from `page`:
`diagnostics-timeline-buffer` reports events lost before the requested cursor, while
`diagnostics-timeline-page` reports events merely omitted from the current bounded response.

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

The manifest release must be strictly newer than the highest valid bundled, active, or user-staged editor/sidecar version. `POST /api/release/update` enforces this before stopping OpenCode or staging any artifact and returns `409` with `kind: not-newer` when the version direction is invalid. The component recovery routes apply the same server-side rule.

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

Tagma-owned custom tools are deployed into the workspace's isolated managed OpenCode config root,
next to the dependency tree owned by that runtime. Chat bootstrap does not report the runtime as
ready until OpenCode's ToolRegistry loads all required Tagma tool IDs. Existing workspaces are
migrated on bootstrap by removing only the three legacy Tagma tool copies from the old project
tool directory; user-authored tools are left untouched.

## Notes

- The entire stack (editor server, SDK, CLI, sandbox) runs on Bun. Do not use `npm` or `node` — scripts assume Bun and the server source imports `Bun.*` globals.
- Task positions and editor-only track folders are persisted to a sibling `.layout.json` file next to the YAML file (e.g. `pipeline.yaml` ↔ `pipeline.layout.json`), saved on `Ctrl+S`. Track folders never appear in the pipeline YAML itself.
- Command-type task cards automatically hide AI-specific fields.
- Hot-update / in-app upgrade surfaces are best exercised via the packaged desktop app (where the env vars are wired up automatically). See [`apps/electron/README.md`](../electron/README.md) for the release-side of the same flow (channel pinning, manifest publishing, `editor-dist-<version>.tar.gz`).
