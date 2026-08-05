# Editor Agent Notes

## Chat Session Concurrency

- OpenCode task `completed` is only a child-session lifecycle state; its `<task_result>` may still
  be empty. Seeded specialists must return a non-empty final report. The router may resume the
  same `task_id` once to retrieve a missing report, then must surface an explicit unusable-result
  failure instead of starting a replacement task or claiming success.
- A pipeline specialist's successful compile is still pending host verification. The router must
  relay the exact `authoring complete; host verification pending` status; only later host
  reconciliation and Trial evidence may upgrade it to built, ready, successful, or verified.
- Model and reasoning-effort selections are preferences for the next prompt; prompt dispatch
  snapshots both when it starts.
- For a chat-authored new pipeline, expose that snapped Chat model only in create/fill-new
  context. The production pipeline agent defaults an unspecified prompt driver to `opencode` and
  an unspecified `opencode` model to that snapshot. Explicit user driver/model choices always win;
  never inherit the Chat model into a non-`opencode` driver, an existing-pipeline edit, or runtime
  resolution.
- Keep those selectors enabled when the visible conversation is idle, even if another
  conversation is active or owns the YAML edit lock. The visible conversation's own send,
  pending prompt, queue, reconciliation, or flush may still block them.
- Provider connection and OpenCode runtime mutations use the broader lock and must remain
  blocked while any conversation is active.
- Post-turn planning and repair continuations belong to the finished turn's root session even
  after the user switches conversations. Address that cached session explicitly; never fall back
  to the mutable visible session or clear the visible turn's progress/error/watchdog state.
- Reconciliation and host-Trial progress retain a global workspace barrier but must carry the
  finished root session as their UI owner. Render progress and Stop only for that visible session,
  and route later progress updates into its cached runtime after the user switches conversations.
- Resolve finished-turn reconciliation and logical-turn continuation leases by the turn's
  workspace, not by the active YAML. Switching pipelines makes a valid path-scoped lease inactive
  for UI mutation gates; finalize, cleanup, and release must still use that exact workspace lease.
- Chat model-variant choices come from OpenCode's model catalogs. Merge a model's enabled
  runtime/legacy variants with its v2 `variants` because v2 can omit provider-generated choices;
  v2 metadata wins for duplicate ids. `null` means model default. Do not restore a fixed
  cross-model reasoning-effort enum.
- Streaming and default-open message details must not claim chat scroll ownership from a
  programmatic `toggle`. Only a trusted user activation on the `summary` may request
  `scrollIntoView`, and the next frame must confirm that the details remain open.

## Chat Message Layout

- Keep optimistic and queued user-message bodies behind the same `min-w-0 max-w-full` flex shrink
  layer as persisted message parts. `break-words` alone does not constrain a flex item's intrinsic
  minimum width, so a long unbroken token can widen a transient bubble until its state changes.

## Chat Context Attachments

- Persist composer attachment display labels on each `<attachment label="...">` inside the
  `<ask-ai-context>` wire block. User-message history must restore those labels as read-only
  reference chips while keeping attachment content hidden; accept legacy unlabeled attachments
  with a generic label, including multiple concatenated blocks produced by queued sends.

## Binding Autosync

- Auto-synced command input bindings must retain the concrete upstream task identity even when an
  output name currently has one producer. Do not materialize a unique candidate as
  `from: outputs.<name>`: prompt-output inference treats that loose form as prompt-owned in mixed
  command/prompt fan-in. Upgrade legacy editor-authored loose sources to the concrete producer
  while preserving user-authored specific sources.

## Chat YAML Branch Isolation

- A non-null Chat YAML snapshot is always bound to its required stage and exists only in renderer
  memory for that logical turn. Publish pipeline results only through staged finalize; do not
  reintroduce a live-edit/copy/restore fallback such as `/api/workspace/chat-result-copy` for
  snapshots without staging.
- Start every workspace-backed logical chat turn with an isolated
  `.tagma/.chat-staging/<id>/` branch. Copy each pipeline's YAML, layout, requirements,
  manifest, compile log, and bounded regular-file support tree into separate base and agent
  workspaces; bind OpenCode's prompt directory and all advertised pipeline paths to the agent
  `.tagma/` root. Live pipeline paths remain read-only source material for the agent. Reject
  symbolic links and never stage or publish `*.trial-plan.json` as part of that support tree.
- For staged OpenCode prompt POSTs, override both the `directory` query and the
  `x-opencode-directory` header with the agent `.tagma` root. The SDK keeps its client-level
  canonical workspace header on POST requests; a query-only override lets that live-directory
  header win and makes delegated sessions edit the real workspace.
- Capture YAML/layout/requirements and support-tree hashes from the base copy in server-owned
  stage metadata. Supporting-file additions, edits, and deletions participate in the same
  three-way comparison and transactional publication as the core artifacts. Queued prompts and
  bounded automatic repairs reuse the same stage, snapshot, and YAML lease; reconciliation runs
  only from the finished-turn queue.
- Attaching the compile watcher to a pre-populated chat stage must not compile the copied
  baseline YAML or regenerate timestamped companions. Actual later YAML writes and pipeline
  folders created after watcher startup must still trigger compile, requirements, and manifest
  synchronization.
- Finalize under the active chat YAML lease with a server-side three-way comparison:
  base hashes versus the current live artifacts, the renderer-local YAML/layout branch, and the
  agent branch. A global workspace revision is never a conflict signal for staged turns.
- When reconciliation publishes a numbered copy, rebase only pipeline-local track/task `cwd`
  values and known built-in file paths from the source or staged pipeline folder to the copy
  folder. Preserve shared workspace paths, external trigger paths, and command-shaped fields.
- If the agent branch is unchanged, discard it. If the live and renderer branches still match
  base and the staged result compiles, adopt the agent result in place. Preserve any local,
  external, path-move, or compile-failure branch and publish the agent result as one numbered
  copy. A genuinely new staged pipeline is created normally unless its destination already
  exists.
- Real-workspace Trial is fail-closed and default-off. Run it only when
  `opencodeChatTrialRunEnabled` is true and its server-stamped consent version matches the current
  real-workspace command policy. Never inherit authorization from the legacy boolean alone; the
  renderer and server entry point must both enforce versioned consent. Enabling the setting must
  disclose that AI-authored commands execute with normal host authority and may change files or
  external state. When disabled or unconsented, compile success is sufficient for finalization;
  do not fabricate trial evidence.
- Before an enabled trial executes, require a transient sibling trial-plan JSON file authored
  from the final compiled YAML and bound to its SHA-1. Missing, stale, or invalid plans trigger a
  dedicated hidden same-turn planning continuation that may only call `tagma_trial_plan` and may
  not edit pipeline artifacts. Ordinary router and pipeline-authoring agents must explicitly deny
  that tool so build or repair turns cannot consume the planner's revision-bound attempts.
  Enforce the configured per-stage attempt budget in the host tool per relative YAML plus YAML hash,
  not only in prompt text. Snapshot the workspace setting when the authenticated stage is created;
  the default is `2` and the allowed range is `1-3`. Serialize concurrent attempts, fail closed on
  corrupt or exhausted telemetry, and summarize repeated equivalent rejections. Accumulate prompts,
  tool attempts, rejections, elapsed time, and
  unique assistant token/cost evidence across repair revisions. Never publish the plan file.
  Generate the tool's enums and limits from the authoritative host contract, expose discriminated
  expectation schemas, and run the complete semantic validator before the atomic write. The tool
  must accept the exact staged Target YAML path when OpenCode reports a different session directory,
  reject live `.tagma` destinations, and never rely on the agent to copy staging artifacts.
- Assemble trial plans through bounded same-tool draft operations: `begin`, one `upsert-case` per
  case, `set-coverage`, `set-findings`, then exactly one `commit`. Only `commit` consumes a formal
  attempt and runs full semantic validation plus the atomic plan write. Keep drafts stage-owned,
  path-and-hash-bound, locked, size-bounded, resumable by default, explicitly resettable, and
  unpublished; never restore a whole-plan single-call boundary for model-generated trial plans.
- Every plan must account for multiple inputs, duplicate input names, multiline content,
  inter-task, repeat-run, and concurrent-run output collisions, repeated runs, empty content, and
  special characters. Inter-task coverage needs two target tasks plus distinct-output evidence;
  repeat-run collision coverage needs two runs plus distinct-output evidence. The sequential
  harness can never mark concurrent collision covered: use accepted-risk, blocked, or genuinely
  not-applicable. Accepted risk and warning findings produce `passed-with-warnings`.
- Preserve the existing real-workspace baseline run, then execute each targeted case in a fresh
  stage-owned temporary workspace with bounded helpers/fixtures, contained portable paths,
  selected task targets, repeated-run support, and host-evaluated assertions. Case workspaces
  must be removed afterward and their fixtures/outputs must never leak into the live workspace.
- Treat each case's `targetTaskIds` as mandatory at the tool schema, persisted-plan parser, and
  execution boundary. Never translate an empty or missing target list to `undefined`, because that
  means a full-pipeline run.
- For an exact Git-root workspace, witness actual bytes for tracked and non-ignored untracked
  source files, authored `.tagma` files, and ignored root dependency/environment descriptors.
  Bind Git HEAD/index/status/flags/config/locks, ignored-root presence, the Git binary, declared
  binaries, minimal environment, and Python identity. Use a full filesystem witness outside an
  exact Git root, and never reuse an in-process manifest cache across a fresh `WorkspaceState`.
- When that fallback scope is a volume root or UNC share root, fail before recursive capture and
  tell the user to select a narrower project directory. Do not silently narrow the witness; an
  exact Git root must still get the Git witness attempt before this filesystem-root guard.
- Keep full-filesystem Trial witness capture off the sidecar main thread. Trial timeout and
  cancellation must cover pre-run, post-run, and case-seal capture; finalize must use the same
  asynchronous worker path with its own bounded timeout and the shared Stop cancellation route.
  Dispose the per-workspace worker and cache with its `WorkspaceState`.
- Set an explicit `trial-running` post-chat phase before awaiting the host Trial request; progress
  labels must follow that current phase instead of inferring it from a stale plan or failure result.
  Snapshot execution budgets from workspace Settings when Trial starts. Recommended defaults are
  120 minutes per task, 480 minutes per production pipeline, and 1440 minutes per Trial; supported
  ranges are 30m-24h, 1h-7d, and 2h-7d respectively. Normalize each outer lifecycle to at least 30
  minutes above the default task budget. Explicit YAML task/pipeline timeouts remain authoritative;
  never reintroduce a hidden Trial-specific task cap.
- Before the real-workspace Trial baseline, fail immediately with diagnostic-only `preflight-failed`
  evidence when every DAG root is a built-in file/directory trigger whose input is currently absent.
  Do not start the engine, write an all-skipped run log, consume the Trial budget, or authorize YAML
  repair for a no-input baseline. Any runnable, manual, custom, or indeterminate root continues
  through normal execution.
- Desktop sidecar builds must embed the Trial witness worker with the compiled executable and,
  for native host targets, smoke-run the final executable through a real worker capture before
  accepting the build. Source-text or bundle-presence checks alone do not prove Worker loading.
- Exact Git-root workspaces must fail closed when git cannot be resolved or the repository layout
  cannot be inspected. Do not fall back to filesystem witness capture just because a `.git`
  marker exists.
- Git objects and ignored dependency/generated trees are intentionally outside the byte-hash
  scope; lockfiles/manifests and declared runtime identities represent those prerequisites.
  During isolated cases, a recursive same-process mutation monitor must fail closed on writes
  outside stage-owned/runtime paths, including ignored files. This is application-level
  verification, not an OS sandbox.
- Pin Trial YAML and requirements to one immutable execution snapshot, and hold the shared
  per-workspace run reservation for the entire host Trial. A completed response retry is keyed by
  stage, trial id, path, and input hash even if the host later drifts; finalize must still verify
  the current host witness. Inject only requirements secrets globally, keep task/track secrets
  scoped through the runtime resolver, and fail on persistent real-workspace drift after any
  isolated case.
- Trial execution and finalize verification must import one shared signed-cache protocol version.
  Bump it whenever result semantics change so an older signed result cannot be reinterpreted under
  a newer success, warning, or authorization policy.
- A failed trial may feed one of the existing bounded hidden repair continuations back into the
  same OpenCode session, stage, snapshot, and YAML lease. Mutation requires the exact top-level
  `pipeline-change-allowed` authorization, derived only from a blocking `pipeline-artifact` finding
  or a direct executable behavior/expectation failure. Untyped legacy results fail closed. Blocked
  coverage and environment, harness, credential, external-service, manual-approval, timeout,
  witness, or unsupported-observation failures remain `diagnostic-only` and must not be repaired by
  weakening or redirecting the pipeline. Adopt into live only after compile and required Trial
  succeed; preserve a failure as a numbered copy.
  This includes newly staged pipelines: leave the requested primary path absent and publish only
  the numbered copy when final verification still fails.
- Recompile or rerun Trial after a hidden repair only when the staged YAML, layout, requirements,
  or transient trial-plan hash changed. A report-only/external-boundary response must reuse the
  prior failed evidence and end that repair chain instead of consuming another attempt.
- Before publication, compare executable references removed from the immutable base YAML with the
  staged agent-owned requirements body/frontmatter. Do not finalize while removed environment
  names, PowerShell cmdlets, or external binaries remain documented; repair YAML and its sibling
  requirements in the same continuation.
- Trial-plan fixture and expectation paths are relative to the isolated case project root and may
  target only case fixtures or outputs. Reject plans that inspect the staged YAML or its
  host-private companion artifacts under the case `.tagma` tree before starting Trial.
- Treat Stop as cancellation of the entire staged logical chat lifecycle, not only the current OpenCode physical turn: a user-stopped finished turn or host-trial cancellation must abort the active host trial, discard the stage, clear post-chat action, release the YAML lease, and acknowledge exactly once, without planning, repair, trial retry, or finalize. Keep queued force-push continuation semantics unchanged.
- Keep the shared compile/trial hidden-repair budget in the workspace Editor setting
  `opencodeChatPipelineRepairMaxAttempts`: default `25`, allowed range `0-50`, with `0` disabling
  automatic repair. The settings panel keeps it beside the trial-run toggle.
- Keep the per-revision Trial Plan tool budget in the workspace Editor setting
  `opencodeChatTrialPlanMaxAttempts`: default `2`, allowed range `1-3`. Apply changes to newly
  created authenticated chat stages so one stage never changes budgets mid-lifecycle.
- Only a successful finalize may mutate the live workspace or advance its revision. Finalize is
  idempotent after response loss, artifact writes roll back together on failure, and abandoned
  or expired stages must stop their compile watcher and be removed.
- Capture the renderer-local pipeline edit revision immediately before staged finalize starts, and
  only adopt the returned finalized state onto the current canvas if that revision still matches
  at the synchronous adoption point. Later same-window edits stay local; genuine multi-window
  conflicts still depend on the live-workspace finalize outcome instead of this guard.
- Serialize every live-workspace revision-advancing request per workspace, including bypass routes
  that advance revision themselves. Capture the workspace and YAML-lock bypass token when the API
  call is made, and never let a late read or state event roll the cached revision backward.
- Keep global metadata and side-log writes such as recent workspaces, global settings, and chat
  usage outside live-workspace revision middleware; they neither mutate nor return pipeline state.
- Preserve the host finalize outcome, conflicts, destination path, compile status, and local-branch
  decision for the next real user turn in the same chat session and workspace. Do not inject or
  consume that evidence in hidden repairs, logical-turn continuations, fresh sessions, or another
  workspace.
- Treat only verified `adopted` and `created` finalize outcomes as live chat deployments. Final
  chat navigation must use the authoritative reconcile result path; `forked`, `unchanged`, and
  failed results may still be described but must not expose a live-pipeline link.
- After a verified live finalize, merge the returned live entry into the workspace pipeline list
  before publishing the completion result, then re-list with an explicit workspace key. Route SSE
  and ordinary list refreshes through the same sequence-guarded refresh path so a late response
  cannot restore a stale pipeline name in the toolbar.
- If the active workspace changes while finalize is in flight, do not publish that result or clear
  the new workspace's post-chat action; completion-result selectors must also reject explicit
  workspace mismatches before exposing navigation.

## Managed OpenCode Execution

- Tagma may share OpenCode's user-level data and session database with the standalone CLI.
  Pin operational browser SDK clients and the primary history query to the server-returned
  canonical `<workspace>/.tagma` directory. Also use an unscoped discovery query to recover
  Tagma-marked legacy sessions that predate canonical directory pinning; accept those only when
  their metadata names the active workspace. Preserve untagged exact-directory legacy chats,
  recognize the early flat `tagmaSurface`/`tagmaWorkspace` ownership shape, exclude
  foreign-workspace and platform-export markers, and admit SSE-created history rows only for
  marked desktop-chat or bot-bridge sessions.
- OpenCode custom tools must resolve session-relative pipeline and companion paths from `ToolContext.directory`, never `process.cwd()`; staged chats depend on it to keep `.tagma/.chat-staging/<id>/.../agent-workspace/.tagma` as the authoritative root.
- Pipeline prompt tasks using the built-in `opencode` driver must resolve the executable through
  `resolveOpencodeBinary()`, using the same user-runtime, bundled, dev-staged, then PATH precedence
  as Chat. They must also use Chat's `buildOpencodeEnv()` isolation rooted at the workspace
  `.tagma` directory so user-global plugins and config cannot enter editor-owned runs. Do not let
  editor-owned AI runs silently select a different global OpenCode version or environment.
- Managed prompt CLI runs must print error-level OpenCode logs and terminate a hung child when the
  pinned runtime reports `message="stream error" small=false mode=primary`; title-model
  (`small=true`) and subagent errors remain recoverable. Keep Chat sidecar Basic Auth credentials
  out of these one-shot child environments.
- Preparing the embedded OpenCode runtime must not atomically rewrite an unchanged workspace
  `.tagma/opencode.json`; that host-only event is inside Trial's real-workspace witness scope and
  would be misclassified as an isolated case leak.
- Command tasks remain host commands and must keep their normal PATH resolution, even when the
  command itself invokes `opencode`.
- When the managed layers are intentionally absent in headless development, resolve the system
  fallback with `Bun.which('opencode')` before spawning so Windows `.cmd` shims work.
- OpenCode reserves an agent's configured final `steps` iteration for a forced text-only summary.
  Tagma applies the machine-global `opencodeAgentMaxSteps` setting (default 25, range 3-1000)
  to every managed agent during seeding; changing it must reseed and restart the current runtime.
  A primary router that makes one `task` call still needs the minimum 3 iterations: delegate,
  relay the result, then cap. An exiting process may clear lifecycle maps only when it is still
  the tracked child for that cwd, or a stale exit callback can detach its replacement.
- Treat assistant `finish` as a runtime protocol boundary even though the generated OpenCode SDK
  types it as `string`. For pinned OpenCode 1.17.8, `stop` is normal completion, `tool-calls` is a
  continuation, `length` is incomplete output, `content-filter` and `error` are errors, and
  `unknown` is indeterminate. Preserve partial output and finished-turn reconciliation; surface
  incomplete/indeterminate states as warnings instead of silently declaring success.
- Accept user messages while the visible conversation is flushing, reconciling, or waiting on its
  YAML lifecycle barrier. Preserve them in the queue without clearing lifecycle progress, then
  dispatch them as a fresh logical turn after the barrier releases; messages queued during an
  active physical turn continue in that turn's existing stage and logical lifecycle.
- Do not infer model success from assistant `time.completed`: OpenCode writes it during processor
  cleanup even when no finish reason arrived. Require confirmed idle before ending that state and
  show an indeterminate warning. Surface future finish strings as protocol-compatibility warnings,
  and keep waiting for OpenCode's follow-up whenever the assistant envelope has a runnable local
  tool call, even if a provider reported `stop`, `length`, or `unknown`.
- Route concrete pipeline inspection, explanation, review, and why/how questions without an
  explicit file-mutation request to the read-only pipeline diagnosis agent. Keep an independent
  mutation-authorization gate in the write-capable pipeline agent so a router mistake cannot
  silently authorize edits.
- Treat runtime/config mutations as workspace-wide: switching to another pipeline in the same
  workspace does not make them safe. A hung-turn force stop may bypass the runtime restart guard
  only with the matching YAML-lock lease capability; ordinary settings changes must never use
  that bypass.
- If a restart overlaps startup, cancel the superseded attempt and coalesce restart callers onto
  the final healthy replacement. No successful caller may receive a handle that the restart has
  already killed. While a YAML chat lock is active, chat bootstrap may reuse/recover the current
  runtime but must not reseed and implicitly restart it.
- Keep delegated OpenCode sessions hidden from chat history but retain their raw parent ancestry
  per workspace from bootstrap and SSE. Normalize current `permission.asked` / `requestID` events
  and legacy `permission.updated` / `permissionID` events before routing descendant permission
  prompts to the owning root runtime. Reply with the real child session id; clear exact
  workspace/session/permission tuples and prune/reset ancestry with session deletion and workspace
  changes.
- Managed Windows command strings run under PowerShell by default. Author PowerShell syntax for
  plain command/shell tasks; invoke CMD-only syntax explicitly through argv with cmd.exe.
- Treat YAML literal/folded command blocks as opaque scripts during requirements discovery even
  when their parsed value contains only one command plus the block scalar's terminal newline;
  PowerShell cmdlets in those blocks are not external binary requirements.
- Conversation exports may continue to hide internal planning and repair turns, but must append
  the durable current-session compile, redacted Trial Plan/case evidence, and final host
  reconciliation result when those facts exist.
- A hung-turn force stop must finish the visible turn before waiting for restart health. Keep an
  exact workspace/session/turn recovery barrier so sends stay queued and runtime/session mutation
  stays blocked until the replacement is healthy; late recovery failures must not overwrite a new
  workspace, and must invalidate the failed workspace client cache.

## Production Diagnostics

- Keep coding-agent diagnostics disabled by default, loopback-only, session-scoped, and read-only.
  Its random token must remain independent from sidecar/OpenCode credentials and may authorize only
  `GET` below `/api/diagnostics/v1`; rotate on enable and revoke on disable/shutdown. Clear every
  captured log, renderer report, and cursor when a session rotates or ends so diagnostics never
  carry data into a later workspace session.
- Diagnostics must remain a side-channel concern: do not wrap sidecar stdout/stderr, start/restart
  OpenCode, send prompts, mutate files/state, or install renderer console/error capture outside an
  active matching diagnostics session. Restore any renderer hooks immediately when it ends.
- New renderer features with long-lived state must register a lazy, side-effect-free snapshot via
  `registerRendererDiagnosticsContributor`; new sidecar features should use
  `registerServerDiagnosticsContributor`. Keep providers synchronous, bounded, credential-free, and
  safe to fail independently. Provider code runs only when an enabled diagnostics request collects
  context, so ordinary feature execution must not depend on it.
- Preserve the stable manifest/context/log/session-history protocol when adding coverage. Put
  feature-specific state under the contributor `features` namespace instead of coupling it into
  the diagnostics bridge or route. Keep diagnostics isolation, contributor, auth-boundary, and
  workspace-isolation tests current.
- Discover OpenCode diagnostics history with the canonical directory query plus the bounded
  unscoped compatibility query used by Chat. Do not set OpenCode's `roots=true` on that discovery
  request because it explicitly removes delegated children. First verify owned roots through the
  shared root-session ownership rules, then admit delegated descendants only when their complete
  `parentID` chain reaches one of those roots. Exclude foreign roots, platform-export sessions,
  orphans, and cycles; Chat history may continue hiding delegated sessions. Read messages with each
  verified root or descendant's stored directory because OpenCode directory matching may be
  case-sensitive on Windows.

## Focused Editor Tests

- `bun scripts/test-serial.mjs` intentionally runs each test file in a separate serial Bun process
  because editor tests share module mocks, ports, and process globals. Keep that isolation as the
  default.
- For fast regressions, pass repeatable unique selectors such as
  `bun scripts/test-serial.mjs --file tests/chat-yaml-staging.test.ts --file tests/opencode-lifecycle.test.ts`.

## Targeted Pipeline Runs

- Run and Run Selected controls must not bubble into parent selection-clearing handlers before
  the async run path snapshots its options. Preserve the selected qualified task ids and send
  them as `targetTaskIds`; omitting that field intentionally means a full-pipeline run.

## Editor Settings Mutations

- Keep ordinary per-workspace settings controls responsive while persistence is in flight. Serialize
  their PATCHes, coalesce pending values, rebase them on each server response, and roll back only
  failed fields that have not been superseded by a newer edit.
- Keep restart-backed global and Python settings mutations mutually exclusive with each other and
  with pending workspace settings saves.
- Keep task, production-pipeline, and Chat-Trial execution budgets workspace-local and adjustable in
  the dedicated Execution category. Server parsing, persistence, UI ranges, ordinary pipelines,
  workflow pipelines, and Trial must share one source of defaults/ranges. Pipeline-authoring agents
  should omit YAML timeouts by default so these settings apply, while explicit user deadlines win.
- Execution-facing hook, completion, middleware, trigger, worker, export, and witness fences must be
  long enough not to undercut the configured task/lifecycle defaults. Do not conflate them with short
  health, startup, stop-acknowledgement, polling, or renewable lock-lease timeouts.

## Canvas Panning

- Keep blank-surface drag panning aligned across the editor `BoardCanvas`, completed-run
  `HistoryFlowView`, main `RunView`, and live-history `RunCanvasView`; read-only task cards and
  the minimap must remain separate interaction targets.
- A short pipeline still needs content at least one viewport plus `CANVAS_PAD_BOTTOM` tall.
  Otherwise the drag handler fires but vertical movement clamps at `scrollTop = 0`.
- The floating minimap requires bottom scroll clearance so the final task row can pan above it.
  Mirror the same computed clearance in the track-header column or vertical scrolling will
  misalign track headers and task rows.
- Keep pipeline run-history layout summaries self-contained: live and persisted summaries carry
  task `positions` and `trackHeights` together, including replay-derived runs.
  Completed-run rendering must use the shared render-plan height/clamping rules; summaries from
  older releases without `trackHeights` fall back to the default lane height.
- HistoryFlowView inspectors intentionally use `RUN_HISTORY_INSPECTOR_PANEL_CLASSES` as absolute
  overlays; keep its source-contract assertion in `history-flow-view.test.tsx` synchronized.
- Failed, timed-out, blocked, or non-zero-exit run-history tasks must offer Ask AI even when
  `stdoutPath`, `stderrPath`, and `normalizedOutput` are all absent. Pre-spawn and policy failures
  legitimately have no stream files; build their fix context from bounded historical summaries
  and pipeline logs, without the historical-comparison routing directive.

## Windows Pipeline Paths

- Treat resolved pipeline paths as case-insensitively equivalent on Windows before enforcing the
  `.tagma/<stem>/<stem>.yaml` shape. Drive-letter casing and `/` versus `\\` are aliases;
  POSIX path comparisons remain case-sensitive.

## Workspace Roots

- Filesystem, Windows drive, and UNC share roots are navigation-only and must never be accepted as Tagma workspaces. Enforce this in both the workspace picker and the sidecar boundary; ordinary project directories beneath those roots remain valid.

## Workflow Self-Repair

- Persisted workflow self-repair is finite and success-conditioned. The editor UI and workspace
  route must preserve `{ max_runs >= 2, stop_when: 'success', repair: true }` and must not
  collapse that policy into an ordinary fixed-count or infinite repeat mode.

## Web Response Test Fixtures

- When editor tests pass Node buffers to `Response`, type fixture maps as `Buffer<ArrayBuffer>` and
  copy `readFileSync` results with `Buffer.from`; the default `Buffer<ArrayBufferLike>` is not
  assignable to TypeScript's DOM `BodyInit` binary view.
