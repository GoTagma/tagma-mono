# Sidecar Hot-Update Design

**Date:** 2026-04-22

**Goal:** Let the desktop app download a newer editor sidecar into `userData` and apply it on the next sidecar relaunch, without requiring a full installer update.

## Context

The desktop app already supports two adjacent update layers:

- `editor-dist` hot-update under `userData/editor/dist`
- `opencode` binary override under `userData/opencode`

The missing piece is the sidecar executable itself. Today Electron always spawns the bundled binary from `resources/editor-sidecar/`, so backend-only fixes still require a new installer.

## Constraints

- The running sidecar process must not be overwritten in place.
- Windows executable locking must be respected.
- A broken downloaded sidecar must not brick app startup.
- The existing editor hot-update manifest and channel flow should remain the source of truth.

## Chosen Approach

Store downloaded sidecars under:

- `userData/editor-sidecar/versions/<version>/<executable>`
- `userData/editor-sidecar/current.json`

The launcher chooses the active sidecar at startup:

1. Prefer the user-installed override declared in `current.json`, if the executable exists.
2. Otherwise fall back to the bundled `resources/editor-sidecar/<executable>`.

Applying an update means:

1. The running sidecar downloads the new platform-specific binary declared in the release manifest.
2. The binary is verified with `sha256`.
3. It is written into a versioned directory under `userData/editor-sidecar/versions/`.
4. `current.json` is atomically updated to point at that version.
5. The new binary takes effect only after all windows close and Electron respawns the sidecar.

## Manifest Shape

Keep the existing editor hot-update manifest and extend it with optional sidecar targets:

```json
{
  "version": "0.2.2",
  "channel": "alpha",
  "minShellVersion": "0.2.2",
  "dist": {
    "url": "https://...",
    "sha256": "…",
    "size": 123
  },
  "sidecar": {
    "targets": [
      {
        "platform": "win32",
        "arch": "x64",
        "url": "https://...",
        "sha256": "…",
        "size": 456
      }
    ]
  },
  "releaseNotesUrl": "https://..."
}
```

The current machine selects the matching `(platform, arch)` entry.

## Runtime Behavior

- Electron stamps the sidecar env with:
  - bundled version
  - active version
  - active source (`bundled` or `user`)
  - user sidecar root
  - channel / manifest URL
- On startup, if the downloaded override version is older than the bundled installer version, Electron deletes the override root so a newer installer wins.
- If a user-installed override fails before emitting `TAGMA_READY`, Electron removes the override root and retries the bundled sidecar.

## API Surface

Add:

- `GET /api/sidecar/info`
- `POST /api/sidecar/update`

UI mirrors the existing editor update chip:

- show running / bundled / staged / latest
- show pending restart
- show shell floor incompatibility
- allow re-check and update

## Testing

- Runtime path selection prefers user sidecar only when the override is valid.
- Runtime path selection falls back to bundled when the pointer is missing or invalid.
- Manifest generation includes sidecar assets when present.
- Shared manifest helpers select the correct sidecar target for the current platform.
