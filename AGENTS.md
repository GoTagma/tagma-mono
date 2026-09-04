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
- Public package publishing must use Bun to pack the workspace (so `workspace:*` dependencies are
  rewritten from the current `bun.lock`) and the npm CLI to publish that tarball. Do not publish a
  workspace directory directly with npm, and do not restore Bun 1.3.11's registry client path.
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
- Classify hook output from the hook result, not from stream presence alone: successful stdout is
  informational, successful real stderr is a warning, and stderr is an error only for a failed
  hook. Suppress only a complete PowerShell CLIXML document whose every stream record is
  `progress`; mixed/plain text and CLIXML error records must remain visible.

## Pipeline Output Capture Integrity

- A child exit code is not sufficient for success when stdout or stderr capture did not finish.
  Keep child streams byte-authored (no runner diagnostics injected into stdout/stderr), report
  read failures as structured `output_error` evidence, and do not let Completion Checks override
  that runtime failure or consume partial output.
- Bun subprocess readers may omit cleanup methods under concurrency. Treat missing or throwing
  reader cleanup as compatibility cleanup after a completed drain; distinguish it from a `read()`
  failure, which means output completeness is unknown.

## Chat-Authored Pipeline Path Coordinates

- Built-in trigger, completion, and static-context relative paths resolve from the task's effective
  cwd: `task.cwd ?? track.cwd ?? workspaceRoot`. Keep that single-base runtime contract; never add
  file-existence-dependent or duplicated-prefix fallback resolution.
- Chat staging must fail closed when a generated path repeats the current pipeline workspace prefix
  beneath an effective cwd in that same pipeline. Surface the resolved-coordinate error in the
  compile log before finalize, while preserving an explicit `./` (`.\\` on Windows) opt-in for an
  intentionally nested same-name path.

## Chat Session Pipeline Ownership

- Classify natural-language desktop Chat intent before allocating a writable pipeline with an
  ordinary tool-free text response. The Host strictly parses one bounded JSON object, accepts only
  the fixed decision fields and Host-issued candidate ids, then resolves and atomically binds
  create/edit. Never require provider-native structured output or model tool capability for
  classification, discussion, or diagnosis. Discussion and diagnosis own no pipeline.
- Different sessions may share one read-only origin but must never share a writable target. Persist
  Host-authenticated binding identity separately from names/paths, reuse a target only for its owning
  session, and publish edits to the branch rather than overwriting the origin.
- Reconciliation failures are per stage/session. Skip a preserved failure so independent jobs and
  other sessions continue; keep Retry for transient failures and recover missing legacy route
  provenance through an explicit idempotent **Save as independent pipeline** path.

## ChatTurn Operation V2 Authority

- Desktop Chat V2 is sidecar-owned end to end: classification, model invocations, cancellation,
  permission/question arbitration, stage/Trial/repair, binding, usage, commit, recovery, and
  terminal state have one Host authority. The renderer submits user decisions and frozen canvas
  evidence and projects Host events; it never carries write or recovery authority. V2 is the only
  Desktop Chat execution protocol; protocol or handshake mismatches fail closed.
- Persist V2 authority in the stable user-data `server-control/chat-operation-v2.sqlite` store with
  a durable 32-byte `control-hmac-v2.key`. Never use a workspace-local, temporary, or process-random
  fallback for operation, binding, outbox, event, WAL, or usage authority; a corrupt or unreadable
  existing key must fail closed and may be replaced only by an explicit control-data reset.
- Keep the control directory, key, and exact SQLite file on regular non-symlink private filesystem
  objects (`0700` directory / `0600` files on POSIX). `canonicalPathHmac` remains the path lookup
  identity; a separate versioned record HMAC binds scope id, canonical path, creation time, and
  control generation. Re-authenticate keyless SQLite rows before treating them as trusted scope
  records, and fail closed on schema/index drift or record-HMAC mismatch.
- Write an invocation outbox record before contacting pinned OpenCode. Reuse Host-assigned session
  and input ids, and after an unknown response reconcile admission from durable history before any
  retry. OpenCode SSE is only a wake-up source: join its stable source event id to history, which is
  authoritative for durable type and aggregate sequence, before projecting a Host event.
- Classifier, discussion, and diagnosis compatibility prompts use `format: text` with wildcard tool
  denial and no `StructuredOutput` exception. Classification safety comes from strict Host parsing,
  bounded fields, and Host candidate-id resolution, not provider schema enforcement. Only a
  create/edit decision may enter authoring, where actual model tool failures are reported as an
  authoring-stage capability error rather than a global Chat admission failure.
- Put the classifier's complete fixed schema and valid kind-specific shapes in its ordinary text
  prompt. If and only if a response violates that bounded text contract, the Host may make one
  automatic repair attempt with a fresh invocation/session/input/outbox identity and an explicit
  attempt-2 prompt. Never loosen parsing, reuse the cached message id, persist or echo the rejected
  provider text, or auto-retry authentication, billing, rate-limit, transport, content, model, or
  unknown-response failures. A later explicit user Retry starts a new bounded two-attempt cycle.
- Chat admission authenticates only that the exact provider/model pair exists in managed configured
  providers. Model-catalog capability and status metadata is advisory UI data: never fetch it on the
  Send critical path, place it in the durable capability hash, or let it affect idempotency and
  recovery. The capability hash seals installed Host/runtime behavior, not provider claims.
- OpenCode 1.18.18 session status is a sparse activity map: absence means idle, while explicit
  busy/retry state and pending permission/question requests mean active. A relocation dependency
  failure must become a durable retryable `staging` wait, preserve any prepared relocation identity,
  and recover the Host-authenticated stage session across restart; it must never escape as a generic
  mutation error while the Renderer continues projecting the operation as running.
- Keep the public Chat V2 error kind and HTTP-status mapping in one shared sidecar/Renderer contract.
  A missing configured model is a model-configuration conflict, never a generic action outage or
  evidence that the model lacks tool capability; preserve the Composer request with that distinction.
- Packaged V2 cutover is declared in `apps/electron/package.json` with
  `tagma.chatOperationProtocolVersion: 2`; `runtime-paths.ts` only emits
  `TAGMA_CHAT_OPERATION_V2_SHADOW=1` and `TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER=2` when that
  gate passes. The control store schema version is 7, and schema mismatches fail closed.
- Tool-free text compatibility prompts have no public message read on a Host-created native session,
  but replaying the exact same Host message id returns cached text before and after restart without
  another provider call. Permit that one digest-authenticated same-id replay for classifier,
  discussion, and diagnosis recovery; reject changed caller bytes before any OpenCode access.
- Treat pending OpenCode permission and question requests as process-local evidence, not durable
  state. Live requests are first-wins, but OpenCode 1.18.18 drops them on restart; permission
  and question replies against the stale request are not found. Persist the Host request
  independently; never recreate the old runtime request after restart, and recover via a new
  controlled invocation/repair decision or an explicit failure rather than claiming that the old
  OpenCode drain can still accept a reply.
- On first use by a freshly constructed Host, atomically convert any durable `live_pending`
  permission/question request into `recovery_required` before renderer projection, while retaining
  its active authoring/repair phase. A reply that itself discovers the missing drain must take the
  same CAS transition. Keep explicit Host-drain-loss evidence distinct from a verified OpenCode
  process-generation change; the latter must retain its strict generation-change check.
- `commit_decided` is the sole publish linearization point. Before it, cancellation may end as
  `cancelled_precommit`; after it, Stop appends audit only and recovery must roll forward to a
  published or forked result without overwriting third-party bytes. Terminal outcome, commit
  decision, binding/result identity, artifact hashes, generation, and the exactly-once terminal
  event are immutable; only the typed post-terminal annotation allowlist may append.
- An automatic pre-commit discard carries its Host-authenticated cause in the discard
  `stage_status_changed` event's `errorCode`/`diagnosticCodes` (`trial_plan_no_change`,
  `repair_no_change`, `repair_attempts_exhausted`, `stage_creation_failed`, or a verification
  pass-through code). User-initiated Stop/Discard, `cancelled_precommit`, and `completed_noop`
  keep both fields null. The Usage Stats page reads the control-store `usage_ledger` through
  `GET /api/chat/operations/usage`; the legacy workspace `usage.jsonl` routes have no remaining
  caller.
- New V2 clients mutate Chat only through the versioned operation API with generation/version CAS.
  Raw OpenCode prompt, interrupt, permission, move, update, and delete routes are never a renderer
  compatibility path; version-skewed mutation attempts must fail explicitly with HTTP 426.

## Static Context Source Integrity

- `static_context.file` is a required runtime dependency for prompt tasks. Missing or unreadable
  sources must fail the task; never silently run a prompt after dropping its promised context.
- Live Smoke may use a target-pipeline static-context source only when its real-workspace bytes
  match the authenticated staged Trial snapshot. Missing, deleted, or divergent staged sources
  require Sandbox coverage of the excluded terminal branch. Command tasks ignore middleware.

## Runtime Abort Listener Capacity

- Size each run-owned AbortSignal listener budget from its finite DAG task count so legitimate
  high-concurrency runs do not emit EventTarget leak warnings. Never disable listener warnings
  globally, and keep every per-task listener cleanup path authoritative.

## Runtime Waiting-State Observability

- Represent a waiting cause with the safe `TaskWaitReason` wire shape only: qualified dependency
  ids or a registered trigger type, never raw trigger configuration, paths, messages, metadata, or
  credentials. `undefined` means an older producer or no update, `null` explicitly clears the cause.
- Seed dependency reasons, update them as dependencies finish, replace them with the trigger reason
  before watching, and clear the reason atomically before running or any terminal status. UI copy
  must distinguish dependency, trigger, queued/preparing, and unavailable-detail states and show all
  applicable authored timeouts without claiming one is the sole deadline.

## Task Error Context Semantics

- Decide whether a task is eligible for error-chat context from its canonical terminal status, not
  from stderr content or the presence of a preallocated stderr path. A success task may legitimately
  have either and must never be described to an agent as failed.
- Build the attachment once and use that same nullable result for both button eligibility and the
  submitted prompt so renderer and formatter cannot disagree about task failure semantics.

## Desktop Release Version Direction

- Every Tagma hot-update entry point must require the manifest release version to be strictly
  greater than every valid bundled, active, and user-staged editor/sidecar version. UI checks are
  advisory; the server-side gate is authoritative and must run before stopping processes or
  staging artifacts.
- A manually run desktop installer is authoritative even when it replaces a higher Tagma release.
  On installer downgrade or a newly detected install instance, clear the editor and sidecar
  userData overrides and force bundled runtime paths for that launch. Do not advance the persisted
  installer baseline until override removal is verified, so failed cleanup retries next launch.
