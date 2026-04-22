# Sidecar Hot-Update Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a userData-based sidecar hot-update flow that downloads a newer sidecar binary and applies it on the next sidecar relaunch.

**Architecture:** Extend the existing editor hot-update manifest with optional platform-specific sidecar assets, add sidecar update routes inside the running sidecar, and teach the Electron launcher to prefer the downloaded sidecar with bundled fallback. Keep updates versioned and pointer-based so the running binary is never overwritten in place.

**Tech Stack:** Bun, TypeScript, Electron, Express, existing release workflow / GitHub release assets

---

## Chunk 1: Red Tests

### Task 1: Runtime path tests for sidecar override selection

**Files:**
- Modify: `apps/electron/tests/runtime-paths.test.ts`
- Test: `apps/electron/tests/runtime-paths.test.ts`

- [ ] **Step 1: Write the failing test**
- [ ] **Step 2: Run the runtime-path test to verify it fails**
- [ ] **Step 3: Implement the minimal launcher-side override selection**
- [ ] **Step 4: Re-run the runtime-path test to verify it passes**

### Task 2: Manifest generation tests for sidecar assets

**Files:**
- Create: `scripts/release/build-hotupdate-manifest.test.ts`
- Modify: `scripts/release/build-hotupdate-manifest.mjs`

- [ ] **Step 1: Write the failing manifest-generation test**
- [ ] **Step 2: Run the focused manifest test to verify it fails**
- [ ] **Step 3: Refactor the manifest builder into importable helpers**
- [ ] **Step 4: Re-run the focused manifest test to verify it passes**

### Task 3: Shared sidecar-manifest helper tests

**Files:**
- Create: `apps/editor/tests/update-manifest.test.ts`
- Create: `apps/editor/server/update-manifest.ts`

- [ ] **Step 1: Write the failing target-selection test**
- [ ] **Step 2: Run the focused helper test to verify it fails**
- [ ] **Step 3: Implement manifest parsing / selection helpers**
- [ ] **Step 4: Re-run the focused helper test to verify it passes**

## Chunk 2: Launcher + Sidecar Update Flow

### Task 4: Electron launcher picks user sidecar and falls back safely

**Files:**
- Modify: `apps/electron/src/runtime-paths.ts`
- Modify: `apps/electron/src/main.ts`

- [ ] **Step 1: Add launcher-side userData sidecar path resolution**
- [ ] **Step 2: Stamp active sidecar metadata into env**
- [ ] **Step 3: Add stale-override cleanup and broken-override fallback**
- [ ] **Step 4: Run electron tests and typecheck**

### Task 5: Sidecar info / update routes

**Files:**
- Create: `apps/editor/server/routes/sidecar.ts`
- Modify: `apps/editor/server/index.ts`
- Modify: `apps/editor/server/dev-bootstrap.ts`

- [ ] **Step 1: Implement `GET /api/sidecar/info`**
- [ ] **Step 2: Implement `POST /api/sidecar/update`**
- [ ] **Step 3: Reuse shared manifest helpers and enforce shell floor**
- [ ] **Step 4: Run editor tests and server typecheck**

## Chunk 3: UI + Release Pipeline

### Task 6: Expose sidecar update status in the editor UI

**Files:**
- Modify: `apps/editor/src/api/client.ts`
- Modify: `apps/editor/src/components/VersionStatusBar.tsx`

- [ ] **Step 1: Add sidecar API types and client calls**
- [ ] **Step 2: Add the sidecar status chip and popover**
- [ ] **Step 3: Wire refresh / update / broadcast handling**
- [ ] **Step 4: Run client typecheck**

### Task 7: Publish sidecar assets into the release manifest

**Files:**
- Modify: `.github/workflows/release-desktop.yml`
- Modify: `scripts/release/build-hotupdate-manifest.mjs`

- [ ] **Step 1: Export per-platform sidecar binaries into release assets**
- [ ] **Step 2: Extend the manifest with sidecar targets**
- [ ] **Step 3: Verify the generated manifest still copies into tagma-web unchanged**
- [ ] **Step 4: Run focused script tests**

## Chunk 4: Verification

### Task 8: Run focused verification

**Files:**
- Test: `apps/electron/tests/runtime-paths.test.ts`
- Test: `apps/editor/tests/update-manifest.test.ts`
- Test: `scripts/release/build-hotupdate-manifest.test.ts`

- [ ] **Step 1: Run focused red/green tests**
- [ ] **Step 2: Run `bun run check:server`**
- [ ] **Step 3: Run `bun run check:client`**
- [ ] **Step 4: Run `bun run check:electron`**
