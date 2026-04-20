# tagma-desktop

Electron shell that wraps the [tagma-editor](../editor) into a packaged desktop app for macOS, Linux, and Windows. Private — not published to npm. Releases ship as platform installers via the `release-desktop.yml` workflow.

## What this package provides

- An Electron main process that loads the editor frontend (either bundled or hot-updated) and spawns the Bun-compiled editor sidecar as a child process.
- A bundled `opencode` CLI binary, plus an in-app upgrade flow so end users don't need a separate install.
- A channel-aware hot-update mechanism for the editor frontend (no full app reinstall needed when the UI changes).
- Cross-platform packaging via electron-builder (NSIS, AppImage, deb, rpm, tar.gz, dmg).

## Requirements

- **Bun** >= 1.3 (matches the workspace `packageManager` pin — currently 1.3.11)
- The editor build chain: `bun run build:desktop` from the repo root produces every prerequisite (`@tagma/types` + `@tagma/sdk` + plugins + editor client + sidecar + electron main).

## Local development

From the repo root:

```bash
bun run dev:desktop      # full chain build, then launch electron .
bun run pack:desktop     # electron-builder --dir (unpacked, no installer)
```

From this package:

```bash
bun run build            # tsc only — assumes editor + sidecar are already built
bun run build:all        # editor + sidecar + main
bun run start            # launch electron against the existing build
bun run fetch:opencode   # download the bundled opencode binary into build/opencode/
```

The unpacked output lives at `release/` (electron-builder default).

## Packaging

```bash
bun run dist:win         # build/all + fetch opencode (win32-x64) + electron-builder --win
bun run dist:linux       # build/all + fetch opencode (linux-x64)  + electron-builder --linux
bun run dist:mac         # build/all + fetch opencode (darwin arm64 + x64) + electron-builder --mac
```

Targets are declared in `package.json → build`:

| Platform | Targets                          |
| -------- | -------------------------------- |
| Windows  | nsis (allows install dir choice) |
| Linux    | AppImage, deb, rpm, tar.gz       |
| macOS    | dmg (universal: x64 + arm64)     |

Artifacts are named `Tagma-${version}-${os}-${arch}.${ext}`.

## Bundled OpenCode CLI

The editor's primary driver is OpenCode. Each installer ships a platform-matched `opencode` binary in `resources/opencode/` so end users don't need `bun` or a manual install.

- **Pin location:** `package.json → tagma.bundledOpencodeVersion` (currently `1.14.18`). Bump that field and re-run a `dist:desktop:*` command to cut a release with a new default.
- **Fetcher:** `scripts/fetch-opencode.mjs` downloads the platform-specific binary into `build/opencode/<platform>-<arch>/` before electron-builder copies it into `extraResources`.
- **Runtime lookup order** (`src/runtime-paths.ts`): `userData/opencode/bin` → `resources/opencode/bin` → system `PATH`. The bundled copy is read-only and never overwritten.

### In-app upgrade

Users can upgrade opencode from the editor (status bar version chip → **Update**, or Editor Settings → OpenCode CLI). Upgrades are downloaded into `userData/opencode/`, which then takes precedence over the bundled copy without replacing it. Removing the upgrade falls back to the bundled version automatically.

The download is handled by the editor sidecar at `POST /api/opencode/update`; status is polled via `GET /api/opencode/info`.

## Editor frontend hot-update

Every desktop release also ships an `editor-dist-<version>.tar.gz` tarball. The running app polls a manifest URL on startup and offers an in-place update if a newer build is available — no installer reinstall required.

Three `package.json → tagma.*` fields drive the flow:

| Field                       | Purpose                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bundledOpencodeVersion`    | Pinned OpenCode version baked into the installer (see above).                                                            |
| `channel`                   | Release channel: `alpha` \| `beta` \| `rc` \| `stable`. Selects which manifest the running app polls.                    |
| `updateManifestBaseUrl`     | Base URL for the manifest. The sidecar appends `/<channel>/manifest.json`.                                               |

The sidecar fetches `${updateManifestBaseUrl}/${channel}/manifest.json`, validates the published `sha256` against the downloaded tarball, and atomically swaps `userData/editor/dist.staging/` → `userData/editor/dist/`. The previous build is preserved in `userData/editor/dist.previous/` for rollback. The next window reload picks up the new bundle (no app restart).

Static-asset resolution prefers `userData/editor/dist/` (when `index.html` exists) over the bundled copy in `resources/editor-dist/`. Routes: `GET /api/editor/info` (status), `POST /api/editor/update` (force-fetch + apply).

## Release flow

`.github/workflows/release-desktop.yml` is the source of truth. Job graph:

1. **cut-tag** (`workflow_dispatch` only) — bump `version`, pin `tagma.channel` to the chosen channel (`patch` collapses to `stable`), scaffold `CHANGELOG/<version>.md`, commit, tag `desktop-v<version>`, push. The tag re-enters the workflow.
2. **build** (matrix: macos / ubuntu / windows) — build the desktop chain, fetch opencode, run electron-builder, compute checksums. Linux additionally produces `editor-dist-<version>.tar.gz` (built once because the editor bundle is pure JS and identical across runners).
3. **publish** — flatten artifacts, generate the editor hot-update manifest via `scripts/release/build-hotupdate-manifest.mjs`, draft release notes, create the GitHub Release (prerelease flag set per channel).
4. **sync-web** — regenerate the manifest in a fresh checkout and copy it into the [tagma-web](https://github.com/GoTagma/tagma-web) repo at `public/editor-updates/<channel>/manifest.json`. That file is what installed clients poll.

Channel notes:

- Channel is locked at release time by overwriting `tagma.channel` in the committed `package.json` — this is what keeps an alpha installer on the alpha manifest after install.
- `patch` is a release-time alias for `stable` (so a patch can reach already-installed stable users).

## Code signing

Signing secrets are read from CI env vars by electron-builder:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

When unset, `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps electron-builder from probing the keychain on macOS runners.

## Notes

- The Bun runtime on Windows GitHub runners occasionally fails to extract the `bun-windows-x64-baseline` cross-target. The build job pre-downloads and swaps in the baseline bun binary before `build:desktop` so the cross-compile becomes a no-op host build, and retries `build:desktop` up to 3 times.
- `tagma-desktop` is private. To release a new desktop version, push a `desktop-v*` tag (or trigger `release-desktop.yml` manually). Do not publish this package to npm.
