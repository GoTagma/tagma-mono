# tagma-desktop

Electron shell that wraps the [tagma-editor](../editor) into a packaged desktop app for macOS, Linux, and Windows. Private — not published to npm. Releases ship as platform installers via the `release-desktop.yml` workflow.

## What this package provides

- An Electron main process that loads the editor frontend (either bundled or hot-updated) and spawns the Bun-compiled editor sidecar as a child process.
- A bundled `opencode` CLI binary, plus an in-app upgrade flow so end users don't need a separate install.
- A channel-aware hot-update mechanism for the editor frontend (no full app reinstall needed when the UI changes).
- Cross-platform packaging via electron-builder (NSIS, AppImage, deb, rpm, tar.gz, dmg).

## Requirements

- **Bun** >= 1.3 (matches the workspace `packageManager` pin — currently 1.3.11)
- The editor build chain: `bun run build:desktop` from the repo root produces every prerequisite (`@tagma/types` + `@tagma/core` + `@tagma/runtime-bun` + `@tagma/sdk` + plugins + editor client + sidecar + electron main).

## Local development

From the repo root:

```bash
bun run dev:desktop      # full chain build, then launch electron .
bun run pack:desktop     # electron-builder --dir (unpacked, no installer)
```

From this package:

```bash
bun run build            # tsc only — assumes editor + sidecar are already built
bun run build:deps       # rebuild the editor client + sidecar in apps/editor (skips main)
bun run build:all        # build:deps + build (editor + sidecar + main)
bun run check            # tsc --noEmit on the Electron main/preload sources
bun run test             # bun test (Electron-side tests only)
bun run dev              # bun run build && electron .  (rebuild main, then launch)
bun run start            # launch electron against the existing build
bun run fetch:opencode   # download the bundled opencode binary into build/opencode/
bun run pack             # build:all + fetch:opencode + stage sidecar + electron-builder --dir
```

The unpacked output lives at `release/` (electron-builder default).

## Packaging

```bash
bun run dist:win         # build:all + fetch opencode (win32-x64) + electron-builder --win
bun run dist:linux       # build:all + fetch opencode (linux-x64)  + electron-builder --linux
bun run dist:mac         # build:all + build mac sidecars + fetch opencode (darwin arm64 + x64) + electron-builder --mac --arm64 --x64
```

Targets are declared in `package.json → build`:

| Platform | Targets                          |
| -------- | -------------------------------- |
| Windows  | nsis (allows install dir choice) |
| Linux    | AppImage, deb, rpm, tar.gz       |
| macOS    | dmg (separate x64 and arm64)     |

Artifacts are named `Tagma-${version}-${os}-${arch}.${ext}`.

## Bundled OpenCode CLI

The editor's primary driver is OpenCode. Each installer ships a platform-matched `opencode` binary in `resources/opencode/` so end users don't need `bun` or a manual install.

- **Pin location:** `package.json → tagma.bundledOpencodeVersion` (currently `1.15.13`). Bump that field and re-run a `dist:desktop:*` command to cut a release with a new default.
- **Fetcher:** `scripts/fetch-opencode.mjs` downloads the platform-specific binary into `build/opencode/<platform>-<arch>/` before electron-builder copies it into `extraResources`.
- **Runtime lookup order** (`src/runtime-paths.ts`): `userData/opencode/bin` → `resources/opencode/bin` → system `PATH`. The bundled copy is read-only and never overwritten.

### In-app upgrade

Users can upgrade opencode from the editor (status bar version chip → **Update**, or Editor Settings → OpenCode CLI). Upgrades are downloaded into `userData/opencode/`, which then takes precedence over the bundled copy without replacing it. Removing the upgrade falls back to the bundled version automatically.

The download is handled by the editor sidecar at `POST /api/opencode/update`; status is polled via `GET /api/opencode/info`.

## Editor frontend + sidecar hot-update

Every desktop release ships both an `editor-dist-<version>.tar.gz` tarball and platform-matched sidecar binaries; the published manifest advertises them together. The running app polls a manifest URL on startup and offers an in-place update if a newer build is available — no installer reinstall required.

The default in-app **Update Tagma** action drives an atomic bundle update through the sidecar's `POST /api/release/update` route — both artifacts stage first, and only when both stage cleanly does the sidecar flip the live pointers (editor first, then sidecar). Editor-only and sidecar-only routes (`/api/editor/update`, `/api/sidecar/update`) remain available as recovery escape hatches. See `apps/editor/README.md` for the runtime route surface.

Four `package.json → tagma.*` fields drive the flow:

| Field                     | Purpose                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `bundledOpencodeVersion`  | Pinned OpenCode version baked into the installer (see above).                                                 |
| `channel`                 | Release channel: `alpha` \| `beta` \| `rc` \| `stable`. Selects which manifest the running app polls.         |
| `updateManifestBaseUrl`   | Base URL for the manifest. The sidecar appends `/<channel>/manifest.json`.                                    |
| `updateManifestPublicKey` | Optional Ed25519 public key used to verify the hot-update manifest before trusting its asset URLs and hashes. |

The sidecar fetches `${updateManifestBaseUrl}/${channel}/manifest.json`, verifies the manifest signature when `updateManifestPublicKey` is configured, validates the published `sha256` against the downloaded tarball, and atomically swaps `userData/editor/dist.staged/` → `userData/editor/dist/`. The previous build is preserved in `userData/editor/dist.previous/` for rollback. `express.static` captures its root at sidecar startup, so the new bundle only takes effect after the sidecar respawns — i.e. close every window (macOS: quit the app) and reopen. A plain window reload keeps serving the previous bundle; `/api/editor/info` reports this state as `pendingRestart: true`.

Static-asset resolution prefers `userData/editor/dist/` (when `index.html` exists) over the bundled copy in `resources/editor-dist/`. Routes: `GET /api/editor/info` (status), `POST /api/editor/update` (force-fetch + apply).

## Sidecar hot-update

The same manifest may also advertise platform-specific sidecar binaries. When present, the running sidecar can download the matching binary into `userData/editor-sidecar/versions/<version>/`, atomically repoint `userData/editor-sidecar/current.json`, and let Electron apply it on the next sidecar relaunch.

- Electron launch precedence: `userData/editor-sidecar/current.json` override → bundled `resources/editor-sidecar/`.
- A broken user-installed sidecar is automatically discarded if it fails before `TAGMA_READY`, then the launcher falls back to the bundled copy.
- Installer upgrades still win: if the bundled sidecar version is newer than the staged override, Electron clears the override root on startup.
- Routes: `GET /api/sidecar/info`, `POST /api/sidecar/update`.

## Runtime and release configuration

The Electron shell forwards `package.json → tagma.*` metadata to the sidecar as environment variables. Most users should configure the `tagma` fields instead of setting these manually.

| Variable                                 | Set by                                                            | Meaning                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TAGMA_EDITOR_UPDATE_CHANNEL`            | Electron from `tagma.channel`                                     | Editor hot-update channel.                                                                                                                                                                              |
| `TAGMA_SIDECAR_UPDATE_CHANNEL`           | Electron from `tagma.channel`                                     | Sidecar hot-update channel.                                                                                                                                                                             |
| `TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL`  | Electron from `tagma.updateManifestBaseUrl`                       | Base URL for editor update manifests.                                                                                                                                                                   |
| `TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL` | Electron from `tagma.updateManifestBaseUrl`                       | Base URL for sidecar update manifests.                                                                                                                                                                  |
| `TAGMA_UPDATE_MANIFEST_PUBLIC_KEY`       | Electron from `tagma.updateManifestPublicKey`, or manually in dev | Ed25519 public key for manifest verification. Accepts PEM or base64 SPKI. When set, unsigned or mismatched manifests are rejected.                                                                      |
| `TAGMA_HOTUPDATE_MANIFEST_PRIVATE_KEY`   | Release shell / CI                                                | PEM Ed25519 private key used by `scripts/release/build-hotupdate-manifest.mjs` to add the manifest `signature` field. Prefer the script's `--signing-key <private-key.pem>` option in CI when possible. |

`scripts/release/build-hotupdate-manifest.mjs` signs the canonical manifest payload when either `--signing-key <private-key.pem>` or `TAGMA_HOTUPDATE_MANIFEST_PRIVATE_KEY` is present. The matching public key must be baked into `tagma.updateManifestPublicKey` before shipping an installer that requires signed manifests.

In GitHub Actions, set repository variable `TAGMA_UPDATE_MANIFEST_PUBLIC_KEY` to the base64 SPKI or PEM public key and repository secret `TAGMA_HOTUPDATE_MANIFEST_PRIVATE_KEY` to the PEM private key. The release workflow writes the public key into `package.json → tagma.updateManifestPublicKey` during `prepare`, then uses the private key to sign the manifest during `publish`.

Manifest signing is opt-in. Leaving both values unset still allows a release and keeps signature verification disabled. Do not set only `TAGMA_UPDATE_MANIFEST_PUBLIC_KEY`: clients built with a public key reject unsigned manifests. The release workflow fails the manifest step when the public key is present but the private signing key is missing.

To generate a key pair:

```bash
node -e "const { generateKeyPairSync } = require('node:crypto'); const { publicKey, privateKey } = generateKeyPairSync('ed25519'); console.log('TAGMA_UPDATE_MANIFEST_PUBLIC_KEY=' + publicKey.export({ type: 'spki', format: 'der' }).toString('base64')); console.log('TAGMA_HOTUPDATE_MANIFEST_PRIVATE_KEY='); console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }));"
```

## Release flow

`.github/workflows/release-desktop.yml` is the source of truth. The workflow is `workflow_dispatch` only — there is no tag trigger. Job graph (atomic-on-success: the bump + tag + release only land if every earlier job passed):

1. **prepare** — compute the new `version`, pin `tagma.channel` to the chosen channel (`patch` collapses to `stable`), scaffold `CHANGELOG/<version>.md`. All writes stay on the runner and are shipped to downstream jobs as the `prepared` artifact. **No commits.**
2. **build** (matrix: macos / ubuntu / windows) — overlay the prepared `package.json` + `CHANGELOG`, then build the desktop chain, fetch opencode, run electron-builder, compute checksums. Linux additionally produces `editor-dist-<version>.tar.gz`.
3. **publish** — flatten artifacts, verify cross-OS editor-dist hashes match, generate the editor hot-update manifest via `scripts/release/build-hotupdate-manifest.mjs`, draft release notes. Still **no commits, no tag, no GitHub Release** yet.
4. **finalize** — the only job that writes to a remote. Commits the desktop version bump and tags `desktop-v<version>` in `tagma-mono/main`, then creates the GitHub Release pinned to that tag. The stage is idempotent so a re-run after a partial failure can complete what's missing.
5. **sync-web** — copy archive entry + hot-update manifest into the [tagma-web](https://github.com/GoTagma/tagma-web) repo at `public/editor-updates/<channel>/manifest.json`. Runs last so tagma-web only ever points at a release that actually exists on GitHub.

Channel notes:

- Channel is locked at release time by overwriting `tagma.channel` in the committed `package.json` — this is what keeps an alpha installer on the alpha manifest after install.
- `patch` is a release-time alias for `stable` (so a patch can reach already-installed stable users).

## Code signing

Signing secrets are read from CI env vars by electron-builder:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`

When unset, `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps electron-builder from probing the keychain on macOS runners.

### Sidecar hot-update signing (opt-in, no paid cert required)

electron-builder signs what it packages inside the installer, but the standalone sidecar binary uploaded to the GitHub Release as a hot-update asset (`tagma-editor-server-<version>-<platform>-<arch>[.exe]`) is **not** signed by default. A raw unsigned Mach-O written into `userData/editor-sidecar/versions/<ver>/` and spawned via `child_process` will fail Gatekeeper on macOS 10.15+.

Set the repository secret `TAGMA_SIGN_SIDECAR=1` to turn on the dedicated signing steps in `.github/workflows/release-desktop.yml`. The steps work without a paid Apple / Authenticode certificate — they auto-detect what's available and fall back to a safe no-cost path:

| Platform | Paid cert present                                                                                                    | No cert                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | imports `CSC_LINK` into a temp keychain, signs with Developer ID + `--timestamp` + `--options runtime`               | ad-hoc sign via `codesign --sign -` (enough for `spawn`-only consumption since Node `fetch` does not set the `LSQuarantineEnabled` xattr) |
| Windows  | `signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256` with `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | skip (SmartScreen only fires on user-initiated launches of downloaded `.exe` files, not on `CreateProcess` from the signed parent app)    |

Secrets consulted: `TAGMA_SIGN_SIDECAR` (required; set to `1`), `CSC_LINK`, `CSC_KEY_PASSWORD` (macOS identity mode), `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (Windows identity mode).

Pending follow-up: **macOS notarization of the standalone binary.** `codesign + hardened runtime` is the minimum Gatekeeper needs when the quarantine xattr is absent, but a distrusted or airgapped keychain policy can still reject unnotarized binaries. Full notarization requires a zip + `xcrun notarytool submit --wait` + `xcrun stapler staple` round-trip and is tracked separately.

## Notes

- The Bun runtime on Windows GitHub runners occasionally fails to extract the `bun-windows-x64-baseline` cross-target. The build job pre-downloads and swaps in the baseline bun binary before `build:desktop` so the cross-compile becomes a no-op host build, and retries `build:desktop` up to 3 times.
- `tagma-desktop` is private. To release a new desktop version, trigger `release-desktop.yml` manually from the GitHub Actions UI (choose `bump` and `channel`). The workflow computes the new version itself — pushing a `desktop-v*` tag by hand is no longer a supported entrypoint. Do not publish this package to npm.
