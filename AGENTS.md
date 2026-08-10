# Agent Instructions

## Git Commit Summary Files

When an agent creates a git commit in this repository:

1. Write the commit message first and create the commit.
2. Read the final commit id after the commit is created.
3. Ensure the repository-root `changelog/` directory exists; create it first if it is missing.
4. Add one English summary file under `changelog/`, named after the final commit id:
   - `<commit-id>.en.md`
5. In the file, write the commit messages as a single-line JSON-style string array, for example `["apps: fix editor workflow return path handling","apps: normalize workflow pipeline paths across Windows and POSIX separators"]`. Do not use markdown bullet lines.
6. The `changelog/` directory is intentionally ignored by git, so these local summary files should not affect the commit contents or repository status.

If one task creates commits in multiple related repositories, such as this repository and a nested `apps` repository, create one combined changelog file in this repository root only. Name it after this repository's final commit id, and include all related commit messages from that task in the same file, including both the nested repository commit message and the parent repository commit message.

Do not amend the same commit to include these files after naming them with the commit id. Amending changes the commit id and makes the filenames stale. If these summary files need to be committed, make a separate explicit follow-up commit.

## Repository Verification Invariants

- Keep the root `.gitattributes` LF policy. It prevents Windows checkout line endings from making
  Prettier report unchanged JSON and source files as dirty.
- `bun run check:deps` must compare every workspace package's path, name, and version with its
  `bun.lock` workspace entry. A successful frozen install alone does not prove that Bun's
  workspace metadata is current.
- Repository version commands must refresh the root `bun.lock` after changing workspace package
  versions. Dry runs must remain non-mutating, and CI dependency checks must remain read-only.
- Desktop release finalization must refresh the root `bun.lock` after applying the released
  `apps/electron/package.json`, run `bun run check:deps`, and commit both files atomically.

## Public Package Test Prerequisites

- `test:public` includes SDK user-journey coverage that installs a first-party plugin in published-package shape; keep public package builds ahead of those tests (`bun run test` builds plugins first, and the npm workflow runs `check:publish` before `test:public`).

## Workflow Self-Repair Invariants

- Persist self-repair only as a finite, success-conditioned lifecycle:
  `{ max_runs: <integer >= 2>, stop_when: success, repair: true }`.
- A failed non-final attempt feeds bounded, redacted task evidence into the next prompt run and
  may resume only the same task's prior driver session. Bound and redact normalized-output
  fallback too, and keep an authored `continue_from` handoff authoritative. Ordinary repeat and
  infinite modes must not enable repair.
- Completion plugins may return a boolean or `{ passed, feedback? }`; failed structured feedback
  becomes task diagnostics and must remain available to the next repair attempt.

## Pipeline Terminal Logging

- Derive the terminal summary status and terminal pipeline log verb from the same run result:
  natural task failure is `failed`, explicit cancellation is `aborted`, and only a successful
  run is `completed`. Never emit a completed terminal line for a result whose `success` is false.

## Desktop Release Version Direction

- Every Tagma hot-update entry point must require the manifest release version to be strictly
  greater than every valid bundled, active, and user-staged editor/sidecar version. UI checks are
  advisory; the server-side gate is authoritative and must run before stopping processes or
  staging artifacts.
- A manually run desktop installer is authoritative even when it replaces a higher Tagma release.
  On installer downgrade or a newly detected install instance, clear the editor and sidecar
  userData overrides and force bundled runtime paths for that launch. Do not advance the persisted
  installer baseline until override removal is verified, so failed cleanup retries next launch.
