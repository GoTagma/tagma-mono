# Editor Agent Notes

## Chat Session Concurrency

- Treat History selection as a latest-intent-wins async transition. Keep the current conversation
  visible until the target messages load, expose the pending target immediately, and invalidate
  it on a newer selection, workspace change, or target deletion. Selecting the already-visible
  conversation closes History synchronously without a network request; bootstrap failures must
  clear pending state and remain handled inside the store.
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
- Persist the exact YAML-lock id in every non-null Chat YAML snapshot. Resolve finished-turn
  reconciliation, logical-turn continuation, cleanup, and release by that immutable workspace +
  lock-id pair, never by the active YAML or whichever renderer-local lease is currently visible.
  Switching pipelines makes a valid path-scoped lease inactive for UI mutation gates without
  transferring ownership to another lease.
- A YAML-lock heartbeat rejection is definitive lease loss only when the server returns HTTP 423.
  Retain the local lease across transport and 5xx failures so the next heartbeat can renew it, but
  never extend the last confirmed `expiresAt` locally; its expiry timer is the finite fail-safe.
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

## Chat Context Window

- "Limit AI context" (settings `chatContextLimitEnabled` + `chatContextRounds`) trims only the
  in-memory model input per request; it must never create, rotate, or clear OpenCode sessions.
  The conversation identity, History rows, and persisted messages stay untouched.
- On every normal user send, `promptOpencode` freezes a policy snapshot from
  `dispatchRuntimeAtStart.messages` (never the mutable visible session mid-flight) and embeds a
  `<tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="N" ... />` marker
  inside the message's `<editor-context>` block. Internal repair/planning continuations create no
  marker and inherit the most recent visible user turn's policy.
- The seeded `.opencode/plugins/tagma-chat-context-window.ts` plugin hooks
  `experimental.chat.messages.transform` (verified in pinned OpenCode 1.17.8 prompt.ts and
  compaction.ts). It parses the marker from the leading host-authored `<editor-context>` only,
  counts visible user turns (excluding `<tagma-internal>` continuations, synthetic compaction
  continues, and text-less bookkeeping), and MUST `splice` the array in place — reassigning
  `output.messages` is discarded because OpenCode keeps using the original `msgs` variable.
- The plugin writes a readiness marker to `.opencode/.tagma-chat-context-window-ready.json` on
  init; the ensure/restart routes poll it and report `contextWindowPluginReady` in the bootstrap.
  When the limit is enabled but the plugin is not ready, sends fail closed (no prompt, no session
  creation) with the "plugin is unavailable" error instead of silently exposing full history.
- Seeding a changed plugin source must delete the readiness marker so a stale marker cannot
  report ready for a runtime that never loaded the new version.

## Binding Autosync

- Auto-synced command input bindings must retain the concrete upstream task identity even when an
  output name currently has one producer. Do not materialize a unique candidate as
  `from: outputs.<name>`: prompt-output inference treats that loose form as prompt-owned in mixed
  command/prompt fan-in. Upgrade legacy editor-authored loose sources to the concrete producer
  while preserving user-authored specific sources.
- Raw binding validation must mirror runtime lookup: required inputs without `value`/`default`
  need exactly one direct producer; a required task-specific `from` without fallback must name an
  output that producer can provide; loose or implicit ambiguity blocks optional and defaulted
  inputs too because lookup ambiguity is resolved before fallback. Preserve prompt-to-command
  inferred outputs and raw stream sources as valid producers.

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
- Advertise staged `<current-file>` and pipeline inventory targets as absolute paths under the
  agent `.tagma` root. Delegated OpenCode child sessions can inherit a different cwd, so relative
  staged paths can resolve into the live `.tagma` tree even when the root prompt was redirected.
  Escape every dynamic editor-context value, including absolute paths, before embedding it in the
  XML-like prompt envelope.
- Treat descendant writes as a host-enforced boundary: resolve the effective staged root through
  the complete child-to-root session ancestry and server-authenticated stage metadata. Auto-allow
  once only when `edit`/`write` execution metadata identifies raw absolute targets inside that
  root (`metadata.filepath`, or every `metadata.files[*].filePath`/`movePath` for `apply_patch`);
  `external_directory` remains scoped by its absolute pattern. OpenCode deliberately emits
  worktree-relative `edit` patterns even for absolute tool targets, so never resolve those patterns
  against either the staged root or the live workspace. Keep absolute-pattern fallback only for
  metadata-free older events, and reject malformed target-bearing metadata, display-only legacy
  permission titles, live paths, glob or symlink escapes, and unscoped shell capabilities. Bind
  authorization to the YAML lock that created the stage, and
  present that immutable snapshot lock id on the renderer's staged path-authorization request so
  the global YAML-lock middleware cannot reject the request before host path validation runs.
- Capture YAML/layout/requirements and support-tree hashes from the base copy in server-owned
  stage metadata. Supporting-file additions, edits, and deletions participate in the same
  three-way comparison and transactional publication as the core artifacts. Queued prompts and
  bounded automatic repairs reuse the same stage, snapshot, and YAML lease; reconciliation runs
  only from the finished-turn queue.
- Attaching the compile watcher to a pre-populated chat stage must not compile the copied
  baseline YAML or regenerate timestamped companions. Actual later YAML writes and pipeline
  folders created after watcher startup must still trigger compile, requirements, and manifest
  synchronization.
- After attaching or replacing the chat compile watcher's root fs.watch, keep one
  identity-guarded deferred reconciliation. Linux may not deliver a pipeline-folder creation that
  happens in the same event-loop turn as watcher startup; the deferred pass may compile only
  newly discovered folders, never the already-attached stage baseline.
- Finalize under the active chat YAML lease with a server-side three-way comparison:
  base hashes versus the current live artifacts, the renderer-local YAML/layout branch, and the
  agent branch. A global workspace revision is never a conflict signal for staged turns.
- The post-turn stage list may report live source drift from server-owned base hashes, but an
  unchanged staged agent branch must not finalize, fork, run Trial, or publish a pipeline result.
  No-op turns are discarded after diagnostics/bookkeeping. Only staged artifact mutations for a
  concrete target may produce a persisted chat pipeline result.
- Treat user navigation separately from pipeline identity. Switching canvases or selecting another
  pipeline during chat is not a reconcile conflict and must not redirect the result to a different
  live path. Only the staged target's own authoritative finalize/reconcile result determines the
  persisted Open Pipeline destination.
- Reject root and delegated-session write/edit/external-directory requests outside the
  server-authenticated staged agent root at the host permission boundary. Descendants inherit the
  visible turn's effective root through their parent chain; prompt policy is defense in depth, not
  the write fence. A direct live `.tagma` write must fail with a diagnostic and must never be
  converted into a reconcile result.
- When one turn mutates multiple pipelines, finalize every changed relative path independently and
  retain the authenticated stage until the last target. Persist an authenticated per-target
  finalize record so response-loss retries are idempotent and skip already-published targets on
  later passes.
- Conflict forks preserve complete pipeline branches: YAML, layout, requirements, and support
  files. Restore the renderer branch from the server-owned base artifacts before applying its
  YAML/layout, and refresh the optimistic-lock baseline after every successful reconcile or
  rollback so Save and Run cannot resume against a stale file version.
- Treat a missing layout artifact and a layout containing only empty default
  `positions`/`folders`/`trackHeights` as the same semantic absence in base, stage, live,
  branch comparison, hashing, publication, and local-branch persistence. For non-empty layouts,
  omit empty optional fields and recursively stabilize object-key order before comparison or
  hashing. Preserve an omitted local layout as "not supplied", keep genuinely non-empty values
  distinct, and never trust the renderer `changed` hint as a conflict decision.
- When reconciliation publishes a numbered copy, rebase only pipeline-local track/task `cwd`
  values and known built-in file paths from the source or staged pipeline folder to the copy
  folder. Preserve shared workspace paths, external trigger paths, and command-shaped fields.
- If the agent branch is unchanged, discard it regardless of live/local drift. For an actual
  staged mutation, adopt in place when the live and renderer branches still match base; fork only
  for a real conflicting branch or a compile-failure preservation path. Switching the visible
  canvas is navigation, not a path-moved conflict. A genuinely new staged pipeline is created
  normally unless its destination already exists.
- Chat pipeline Trial is fail-closed and default-off. `opencodeChatTrialRunEnabled` plus its
  current server-stamped consent authorizes Sandbox Trial only. Live Smoke Test is a separate,
  default-off setting with its own current consent, and is effective only while Sandbox Trial is
  currently consented. Never inherit either authorization from a legacy boolean alone; the
  renderer and server entry point must both enforce versioned consent. Disclose that Sandbox uses
  a temporary workspace copy, closed stdin, no TTY, and synthetic secrets, but does not yet
  OS-enforce filesystem, network, or child-process isolation. Live Smoke disclosure must separately
  state that it runs in the real workspace with real credentials and normal host authority and may
  change files or external state. When Sandbox Trial is disabled or unconsented, compile success is
  sufficient for finalization; do not fabricate Trial evidence.
- Before issuing a Trial Plan attempt, checking readiness, reserving a run, capturing a host
  witness, or executing a capability, build a complete Trial Interaction Protocol v1 report for
  every hook, command, driver, trigger, middleware, and completion in the compiled pipeline.
  Capability declarations must be exact v1
  objects. Fail closed on missing or malformed declarations, unknown interactions, unsupported
  unattended operation, interactive stdio, browser authentication, and long-lived runtimes.
  Real-required secrets, external network access, and external filesystem writes require a
  separately authorized Live Smoke Test. Host commands and hooks may remain Sandbox-runnable only
  when the report explicitly records their non-OS-enforced host risk; never describe this
  app-level containment as a permission sandbox. The report must keep Sandbox-case enforcement
  separate from the optional Live Smoke baseline's real-workspace, real-secret, unrestricted-host
  authority; never reuse the Sandbox enforcement block as a whole-mode disclosure. Bind the
  selected Trial mode and a deterministic hash of the full report into the authenticated cache
  key and result, and recompute that report before finalize accepts cached evidence.
- Before an enabled trial executes, require a transient sibling trial-plan JSON file authored
  from the final compiled YAML and bound to its SHA-1. Missing, stale, or invalid plans trigger a
  dedicated hidden same-turn planning continuation that may only call `tagma_trial_plan` and may
  not edit pipeline artifacts. Ordinary router and pipeline-authoring agents must explicitly deny
  that tool so build or repair turns cannot consume the planner's revision-bound attempts.
  Enforce the configured per-stage attempt budget in the host tool per relative YAML plus YAML hash,
  not only in prompt text. Snapshot the workspace setting when the authenticated stage is created;
  the default is `2` and the allowed range is `1-3`. Serialize concurrent attempts, fail closed on
  corrupt or exhausted telemetry, and summarize repeated equivalent rejections. Give every physical
  planner continuation one host-issued attempt ID and require that exact ID on every tool operation.
  At most one `commit` for an ID may consume the budget; a repeated `begin` or `commit` in the
  same physical continuation must be rejected without incrementing counters. Only a later host
  continuation with a fresh ID may consume the next attempt. Accumulate prompts, tool attempts,
  rejections, elapsed time, and
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
- Validate and normalize every proposed case, coverage section, and finding section before
  persisting it. Reject reserved pipeline-artifact paths, incomplete or duplicate coverage,
  unknown case links, unsupported coverage evidence, and a case update that would invalidate
  already-covered evidence at that bounded mutation. Revalidate a persisted draft before
  `begin` resumes it. A rejected pre-commit mutation must leave the prior draft and
  formal-attempt telemetry unchanged so the planner can correct it in the same physical
  continuation. Keep final whole-plan completeness and the atomic write at `commit`; do not move
  the attempt counter to conceal malformed draft writes.
- Every plan must account for multiple inputs, duplicate input names, multiline content,
  inter-task, repeat-run, and concurrent-run output collisions, repeated runs, empty content, and
  special characters. Inter-task coverage needs two target tasks plus distinct-output evidence;
  repeat-run collision coverage needs two runs plus distinct-output evidence. The sequential
  harness can never mark concurrent collision covered: use accepted-risk, blocked, or genuinely
  not-applicable. Accepted risk and warning findings produce `passed-with-warnings`.
- Default Sandbox Trial never runs a real-workspace baseline and never injects real pipeline
  credentials into execution; it uses deterministic synthetic values for every declared or
  required secret. Host-witness preparation may resolve real credentials only to bind prerequisite
  availability, and must not pass those values into a Sandbox run. Every terminal DAG task must
  therefore be directly targeted by an isolated case so each sink's full dependency closure
  executes. A sink that is unsafe or impossible to run requires a blocking `diagnostic-only`
  finding; warning or accepted-risk text must never turn an unexecuted sink into a passing Trial.
- When Live Smoke Test is separately consented, preserve its real-workspace baseline when at least
  one DAG root is runnable. When every root is waiting for a missing workspace-local file or
  directory input, request the targeted plan first and require representative data only as an
  isolated case fixture; do not create placeholder inputs in the real workspace. Skip that
  unavailable Live Smoke baseline, retain pre/post host witness and mutation monitoring, execute
  the Sandbox fixture cases for real, and report `sandbox-cases-only` rather than claiming a
  live-data baseline. A completed Live Smoke baseline plus Sandbox cases reports
  `sandbox-cases-with-live-smoke`. Execute every targeted case in a fresh stage-owned temporary
  workspace with bounded helpers/fixtures, contained portable paths, selected task targets,
  repeated-run support, and host-evaluated assertions. Case workspaces must be removed afterward
  and their fixtures/outputs must never leak into the live workspace.
- Resolve staged pipeline support files identically in isolated Trial and after publication.
  When a short relative file/directory trigger, `file_exists` completion, or `static_context`
  path names an existing regular staged support-tree entry, relocate it to the copied or published
  `.tagma/<pipeline>/` directory before loading the YAML. Never make Trial find an asset that the
  finalized pipeline cannot resolve, or vice versa.
- Treat each case's `targetTaskIds` as mandatory at the tool schema, persisted-plan parser, and
  execution boundary. Never translate an empty or missing target list to `undefined`, because that
  means a full-pipeline run.
- A Trial case that inspects a `.json` artifact with a path or text assertion must also use
  `json-valid` or `json-pointer-equals` for that same path. Raw text matches do not establish RFC
  8259 validity. Assert decoded control characters, quotes, Unicode, and nested values through a
  JSON Pointer plus a serialized `expectedJson` value; never weaken this back to text-only checks.
- Trial task evidence is a bounded diagnostic view, not the source of truth for task cardinality.
  Prioritize executable failures and non-empty stderr, reserve representative task context for
  every failed case, and only then admit blocked/skipped noise. Return total and omitted task counts
  plus status breakdowns, and report planned/result/not-run case counts, so the bounded view cannot
  silently imply that omitted tasks or cases did not exist.
- Preserve truncation provenance across every Trial evidence boundary. Distinguish source/runtime
  tail capture, Trial-result field or stream clipping, and repair-prompt clipping. Return produced,
  source-returned, and final-returned byte counts where they are known, and label inline truncation
  markers with the layer. Never diagnose or change runtime output handling merely because a
  read-only diagnostic response or repair prompt was clipped.
- Compilation-repair evidence is a separate prompt boundary. Its inline character and UTF-8 byte
  markers must identify `compile-repair-prompt`, remain inside the declared bound, and never fall
  back to an unqualified `[truncated]` marker.
- A Trial assertion file that exceeds the host reader's byte limit is `diagnostic-only`. Return the
  `trial-assertion-reader` limit and source/returned byte counts; do not treat an unread remainder as
  a failed content assertion or grant pipeline repair authority.
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
- Model Trial prerequisite readiness in one host-owned discriminated state:
  `runnable | fixture-backed | blocked`. Missing workspace-contained built-in file/directory root
  inputs are fixture-backed data, not pipeline failures. For a mixed DAG with Live Smoke enabled,
  its real-workspace baseline must target only tasks whose dependency closure excludes every
  unavailable input; test the fixture-dependent branches in Sandbox cases. When every branch
  depends on unavailable data, skip Live Smoke instead of starting an all-skipped run. Expose the
  exact fixture paths to the planner, and require every unavailable input in a case whose target
  closure runs its root task. Validate this pure plan/readiness phase before reserving a run session
  or capturing a host witness. An incomplete fixture plan requests another bounded, host-issued
  plan continuation as `diagnostic-only`; it must not execute, authorize pipeline repair, or write
  a placeholder into the live workspace. Never fabricate binaries, services, real credentials, or
  human approvals to make Live Smoke appear ready. Sandbox's deterministic synthetic-secret
  substitution is execution isolation, not evidence that a real credential exists. Authenticated
  absence needed by Live Smoke is a structured, diagnostic-only `blocked` prerequisite state. The
  sole approval exception is a host-owned, run-ID-scoped Trial execution grant for a manual task in
  an explicitly selected case target dependency closure. It is not human approval and must never
  change ordinary-run approval behavior. A manual task outside every explicit case target closure
  remains rejected and diagnostic-only. Changing this grant policy requires a Trial consent version
  bump and updated user-facing disclosure.
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
- A real-workspace mutation observed during an isolated case is a harness-containment failure and
  remains `diagnostic-only`, even when the task itself succeeded. Return bounded, redacted,
  workspace-relative changed paths and an omitted-path-event count before attempting any product
  fix. The mutation monitor establishes timing, not causation: label the writer `writer-unknown`
  and never claim that the isolated case caused the change. Such evidence must never by itself
  grant `pipeline-change-allowed` or authorize YAML repair.
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
  weakening or redirecting the pipeline. A signed, current-YAML/current-host
  blocked prerequisite state means Trial could not establish executable behavior because a real
  prerequisite was unavailable. It may be discovered before execution (`ran: false`) or after safe
  branches began, such as a manual approval gate (`ran: true`); an independent executable failure
  must still take precedence over the blocker. Publish the compile-valid pipeline in place with a
  distinct blocked/amber status and an open-pipeline action, never label it failed and never create
  a numbered copy solely for that state. The renderer may report only renderer-owned path-move or
  compile facts to finalize; it must not send `forceFork`, author `trial-run-failed`, or interpret
  raw Trial failure as publication authority. The server derives Trial conflicts exclusively from
  the signed current-YAML/current-host cache. Persist that authoritative `trialVerification`
  disposition in the session reconciliation summary and preserve it in exports and the next-turn
  agent context, so `prerequisite-unavailable` never degrades back to a failure label. Missing,
  stale, unsigned, tampered, or semantically inconsistent Trial evidence still fails closed.
  Actual compile or executed-Trial failures, live/local/path conflicts, and destination collisions
  retain numbered-copy behavior, including for newly staged pipelines.
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
- Pipeline-local Trial fixtures and outputs use the `.tagma`-relative namespace `<stem>/...` in
  plans, never a literal `.tagma/<stem>/...` path. Readiness must translate a missing real path
  under `.tagma/<stem>/` into that logical namespace, and isolated execution must map the same
  namespace back for both fixture writes and expectation reads.
- Treat Stop as cancellation of the entire staged logical chat lifecycle, not only the current OpenCode physical turn: a user-stopped finished turn or host-trial cancellation must abort the active host trial, discard the stage, clear post-chat action, release the YAML lease, and acknowledge exactly once, without planning, repair, trial retry, or finalize. Keep queued force-push continuation semantics unchanged.
- An unexpected pre-finalize reconciliation failure must preserve the stage, exact snapshot, repair
  state, and finished-turn queue head for an explicit retry. It must also offer an explicit
  abandon-result action that keeps the live canvas, discards only that isolated stage, releases
  the exact lease, acknowledges the head, and lets queued prompts continue as a fresh turn.
  Treat a server-reported already-finalized disposition as an ambiguous committed result, not a
  successful discard: restore the failed head and require idempotent finalize/readback.
- Persist every stage-backed finished-turn queue per workspace before reconciliation and hydrate it
  before OpenCode bootstrap. An asynchronous discard claim remains persisted until confirmed
  cleanup or finalized readback is explicitly acknowledged; failed cleanup restores the same turn.
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
- Persist chat pipeline results per finished assistant message/turn, not as a single mutable
  session-level slot. Preserve the host finalize outcome, conflicts, destination path,
  compile/trial status, and local-branch decision across session switches, exports, and reloads.
  Hidden repairs and internal continuations keep the original visible turn/message anchor instead of
  overwriting later turns.
- Fail closed on authenticated pre-owner-hash stages with an actionable discard-and-resend
  explanation; never resume them under a newly presented lock. Drop legacy results that lack both
  message and turn anchors without guessing from assistant text, but surface a workspace-list
  recovery explanation instead of silently losing them.
- Keep at most the newest 500 valid unique Open Pipeline result entries per workspace. Persist
  whether older history was truncated, explain that only ledger entries were removed, and keep the
  warning available after reload; truncation must never delete pipeline files.
- Treat `created`, `adopted`, and `forked` finalize outcomes as openable live chat results even
  when compile or verification status is failed or blocked. Final chat navigation must always use
  the authoritative reconcile result path; `unchanged` and no-op turns must not expose a pipeline
  link.
- Never derive that path from assistant text or expose `.chat-staging`. Revalidate workspace
  containment and current YAML-list membership before enabling and again before opening; deleted,
  moved, cross-workspace, or invalid targets remain disabled with a reason. Finalization must not
  navigate to a different canvas; only an explicit Open Pipeline click opens the target.
- After a verified live finalize, merge the returned live entry into the workspace pipeline list
  before publishing the completion result, then re-list with an explicit workspace key. Route SSE
  and ordinary list refreshes through the same sequence-guarded refresh path so a late response
  cannot restore a stale pipeline name in the toolbar.
- If the active workspace changes while finalize is in flight, do not publish that result or clear
  the new workspace's post-chat action; completion-result selectors must also reject explicit
  workspace mismatches before exposing navigation.

## Managed OpenCode Execution

- Tagma may reuse OpenCode's user-level data root for provider login state, but it must never share
  the schema-bearing session database with a standalone OpenCode CLI. Every managed Chat and
  prompt-task process must receive the same absolute, Tagma-owned `OPENCODE_DB` path.
- Treat the explicit positive `bundledOpencodeDbSchemaVersion` release epoch as compatibility
  metadata, not as a singleton database path. A compatible OpenCode upgrade keeps the epoch; an
  incompatible schema change bumps it. Persist that epoch beside staged binaries and inside the
  signed hot-update manifest.
- Store managed databases as lineage generations behind one atomic `current-head` pointer. Reuse
  the current generation when its compatibility key matches. On upgrade, copy the current lower
  generation forward with a consistent SQLite snapshot into a new descendant generation. On
  downgrade, create a fresh fork without copying newer schema backward. Re-entering an epoch after
  a downgrade must create a descendant of the current fork, never silently reuse an older branch.
  Retain every prior generation. A legacy runtime without epoch metadata gets an exact-version
  compatibility key and never participates in automatic copy-forward.
- Guard first use of every unpublished generation with an exclusive initialization lease. Chat and
  prompt-task launchers must pass the exact prepared generation into `buildOpencodeEnv`, wait when
  another live owner holds the lease, publish only after database-backed readiness and integrity
  checks, and discard only their own unready generation on failure. A dead owner's provisional
  generation may be rebuilt; a published generation must never be removed by lease recovery.
- Do not mark a managed database epoch active until OpenCode health, a database-backed session
  query, and SQLite integrity validation all succeed. Expose the active runtime identity, database
  path, epoch, and initialization mode through the read-only diagnostics context.
- Pin operational browser SDK clients and the primary history query to the server-returned
  canonical `<workspace>/.tagma` directory. Also use an unscoped discovery query to recover
  Tagma-marked legacy sessions that predate canonical directory pinning; accept those only when
  their metadata names the active workspace. Preserve untagged exact-directory legacy chats,
  recognize the early flat `tagmaSurface`/`tagmaWorkspace` ownership shape, exclude
  foreign-workspace and platform-export markers, and admit SSE-created history rows only for
  marked desktop-chat or bot-bridge sessions.
- OpenCode custom tools must resolve session-relative pipeline and companion paths from
  `ToolContext.directory`, never `process.cwd()`. Staged chats depend on it to keep
  `.tagma/.chat-staging/<id>/.../agent-workspace/.tagma` as the authoritative root, and delegated
  child sessions must inherit that effective root through host-validated permission routing rather
  than prompt text alone.
- Pipeline prompt tasks using the built-in `opencode` driver must resolve the executable through
  `resolveOpencodeBinary()`, using the same user-runtime, bundled, dev-staged, then PATH precedence
  as Chat. They must also use Chat's `buildOpencodeEnv()` isolation rooted at the workspace
  `.tagma` directory so user-global plugins and config cannot enter editor-owned runs. Do not let
  editor-owned AI runs silently select a different global OpenCode version or environment.
- Managed prompt CLI runs must print error-level OpenCode logs and terminate a hung child when the
  pinned runtime reports `message="stream error" small=false mode=primary`; title-model
  (`small=true`) and subagent errors remain recoverable. Keep Chat sidecar Basic Auth credentials
  out of these one-shot child environments.
- Preserve raw managed OpenCode stderr in persisted runtime streams, but omit exact recoverable
  `message="stream error" small=true mode=primary` title-model lines from task-scoped Trial
  evidence and report the omitted line count. Keep primary-model `small=false` failures and every
  ordinary task diagnostic in the evidence so repair ranking cannot mistake auxiliary billing or
  title-generation noise for the task's root cause.
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
  changes. For staged roots, resolve descendants to the first ancestor carrying the turn snapshot
  and host-authorize write-capable permissions against that authenticated root; a child catalog
  entry must never become a new write root.
- Managed Windows command strings run under PowerShell by default. Author PowerShell syntax for
  plain command/shell tasks; invoke CMD-only syntax explicitly through argv with cmd.exe.
- Treat YAML literal/folded command blocks as opaque scripts during requirements discovery even
  when their parsed value contains only one command plus the block scalar's terminal newline;
  PowerShell cmdlets in those blocks are not external binary requirements.
- Conversation exports may continue to hide internal planning and repair turns, but must include
  every durable message-bound pipeline result with its final target, outcome, status, compile,
  redacted Trial evidence, conflicts, and live result path. Insert all results after their
  assistant message using the persisted message identity, preserve later turns, and never infer
  ownership or paths from model-authored text. Keep the legacy single-session fallback only for
  old in-memory results without a reliable message anchor.
- A hung-turn force stop must finish the visible turn before waiting for restart health. Keep an
  exact workspace/session/turn recovery barrier so sends stay queued and runtime/session mutation
  stays blocked until the replacement is healthy; late recovery failures must not overwrite a new
  workspace, and must invalidate the failed workspace client cache.
- Manual new-conversation creation is a non-idempotent POST. On an ambiguous transport or proxy
  failure, do not retry automatically because the first request may already have created a session.
  Catch the rejection inside the chat store, preserve the current session/runtime, close History,
  and surface one user-visible error; button event handlers must never leak it as an unhandled
  Promise rejection.

## Production Diagnostics

- Use the bounded structured diagnostics timeline for lifecycle evidence. Timeline events must
  exclude raw authored messages, drafts, prompts, tool input/output, and commands. Bounded,
  redacted host error, validation, and Trial diagnostic strings may be included for diagnosis but
  remain sensitive. Ignore capture-time and turn-health heartbeat-only churn, and report retention
  loss separately from page-level omission.
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
- Diagnostics sanitization must detect cycles against the active recursion path, not all objects
  visited during traversal. Repeated references in an acyclic object graph must serialize in every
  location; only ancestor back-references become `__circular`.
- Preserve the stable manifest/context/log/session-history protocol when adding coverage. Put
  feature-specific state under the contributor `features` namespace instead of coupling it into
  the diagnostics bridge or route. Keep diagnostics isolation, contributor, auth-boundary, and
  workspace-isolation tests current.
- Any bounded read-only diagnostic collection must expose what was omitted: include total/returned
  counts (and status/category breakdowns when meaningful) plus explicit truncation-layer metadata.
  A tail-read or response-size limit is diagnostic-interface truncation, not proof that the
  underlying runtime, file, task output, or persisted record was truncated. Locate and test the
  exact layer before changing source behavior.
- Conversation exports are also a bounded read-only evidence view. Label their own clipping as
  `chat-export`, include the omitted character count, and preserve Trial planned/returned/not-run
  cases, task status totals/omissions, repair scopes, selected stderr/stdout, stream truncation
  provenance, assertion-reader limits, and writer-unknown workspace-mutation observations.
- Bounded run-history reads must identify `run-history-log-read`,
  `run-history-task-output-read`, `run-history-list-window`, or `run-history-context-read` as
  appropriate. Return retained/returned/omitted run counts and source/read/source-returned/final
  byte counts; report bytes discarded to align the returned tail. These limits describe the
  read-only response or assembled AI context, never truncation of the persisted log or stream.
  Any UI rendering a clipped log or task stream must visibly identify it as a bounded tail and
  state that the complete persisted file remains on disk; never present that response as the full
  runtime or persisted output.
- Renderer diagnostics must return source, returned, and omitted counts for intentionally bounded
  session/message/log windows. Keep the sanitizer array bound at least as large as those explicit
  windows so a second generic sanitation pass cannot discard the newest retained evidence.
- Keep renderer-report ingestion, diagnostics log-ring retention, response pagination, active-run
  event windows, desktop-log tail reads, and OpenCode source-query limits as separate evidence
  layers. Return read errors and source boundaries explicitly; `null`, an empty array, or a short
  page must not silently mean that no underlying evidence exists.
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
- Keep prerequisite assertions independent of unrelated CLI availability. Prompt tasks default to
  the `opencode` driver, so use a command task when a test intends to isolate another blocker.

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

- Picker opens must compare the post-open YAML path with those same platform rules, suppress
  same-tick duplicate opens, and remain visible on failure. Keep plugin registry refresh after
  `openFile`; opening a pipeline can change the server-side plugin set.

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
