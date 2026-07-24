# Editor Agent Notes

## Chat Session Concurrency

- Model and reasoning-effort selections are preferences for the next prompt; prompt dispatch
  snapshots both when it starts.
- Keep those selectors enabled when the visible conversation is idle, even if another
  conversation is active or owns the YAML edit lock. The visible conversation's own send,
  pending prompt, queue, reconciliation, or flush may still block them.
- Provider connection and OpenCode runtime mutations use the broader lock and must remain
  blocked while any conversation is active.
- Post-turn planning and repair continuations belong to the finished turn's root session even
  after the user switches conversations. Address that cached session explicitly; never fall back
  to the mutable visible session or clear the visible turn's progress/error/watchdog state.
- Chat model-variant choices come from OpenCode's model catalogs. Merge a model's enabled
  runtime/legacy variants with its v2 `variants` because v2 can omit provider-generated choices;
  v2 metadata wins for duplicate ids. `null` means model default. Do not restore a fixed
  cross-model reasoning-effort enum.

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

- Start every workspace-backed logical chat turn with an isolated
  `.tagma/.chat-staging/<id>/` branch. Copy each pipeline's YAML, layout, requirements,
  manifest, and compile log into separate base and agent workspaces; bind OpenCode's prompt
  directory and all advertised pipeline paths to the agent `.tagma/` root. Live pipeline paths
  remain read-only source material for the agent.
- For staged OpenCode prompt POSTs, override both the `directory` query and the
  `x-opencode-directory` header with the agent `.tagma` root. The SDK keeps its client-level
  canonical workspace header on POST requests; a query-only override lets that live-directory
  header win and makes delegated sessions edit the real workspace.
- Capture YAML/layout/requirements hashes from the base copy in server-owned stage metadata.
  Queued prompts and bounded automatic repairs reuse the same stage, snapshot, and YAML lease;
  reconciliation runs only from the finished-turn queue.
- Attaching the compile watcher to a pre-populated chat stage must not compile the copied
  baseline YAML or regenerate timestamped companions. Actual later YAML writes and pipeline
  folders created after watcher startup must still trigger compile, requirements, and manifest
  synchronization.
- Finalize under the active chat YAML lease with a server-side three-way comparison:
  base hashes versus the current live artifacts, the renderer-local YAML/layout branch, and the
  agent branch. A global workspace revision is never a conflict signal for staged turns.
- If the agent branch is unchanged, discard it. If the live and renderer branches still match
  base and the staged result compiles, adopt the agent result in place. Preserve any local,
  external, path-move, or compile-failure branch and publish the agent result as one numbered
  copy. A genuinely new staged pipeline is created normally unless its destination already
  exists.
- After a changed staged pipeline compiles, trial-run its staged YAML against the real workspace
  before finalize when the workspace `opencodeChatTrialRunEnabled` setting is enabled (the
  default). When disabled, compile success is sufficient for finalization; do not fabricate trial
  evidence. Keep trial requests idempotent across response retries, bound and redact task evidence,
  and never auto-approve a manual trigger or weaken another safety/prerequisite gate.
- Before an enabled trial executes, require a transient sibling trial-plan JSON file authored
  from the final compiled YAML and bound to its SHA-1. Missing, stale, or invalid plans trigger a hidden
  same-turn planning continuation that may only call tagma_trial_plan and may not edit pipeline
  artifacts. Allow at most two attempts for one YAML hash and keep the total planning lifecycle
  finite across repair revisions. Never finalize or publish the plan file as a live artifact.
  Generate the tool's enums and limits from the authoritative host contract, expose discriminated
  expectation schemas, and run the complete semantic validator before the atomic write. The tool
  must accept the exact staged Target YAML path when OpenCode reports a different session directory,
  reject live `.tagma` destinations, and never rely on the agent to copy staging artifacts.
- Every plan must account for multiple inputs, duplicate input names, multiline content, output
  collisions, repeated runs, empty content, and special characters. A dimension marked covered
  must have concrete linked fixtures/assertions; blocked coverage or a blocking design finding
  fails before execution and becomes repair evidence.
- Preserve the existing real-workspace baseline run, then execute each targeted case in a fresh
  stage-owned temporary workspace with bounded helpers/fixtures, contained portable paths,
  selected task targets, repeated-run support, and host-evaluated assertions. Case workspaces
  must be removed afterward and their fixtures/outputs must never leak into the live workspace.
- A failed trial may feed one of the existing bounded hidden repair continuations back into the
  same OpenCode session, stage, snapshot, and YAML lease. Adopt into the live pipeline only after
  both compile and trial succeed; preserve a still-failing trial result as a numbered copy.
  This includes newly staged pipelines: leave the requested primary path absent and publish only
  the numbered copy when final verification still fails.
- Treat Stop as cancellation of the entire staged logical chat lifecycle, not only the current OpenCode physical turn: a user-stopped finished turn or host-trial cancellation must abort the active host trial, discard the stage, clear post-chat action, release the YAML lease, and acknowledge exactly once, without planning, repair, trial retry, or finalize. Keep queued force-push continuation semantics unchanged.
- Keep the shared compile/trial hidden-repair budget in the workspace Editor setting
  `opencodeChatPipelineRepairMaxAttempts`: default `25`, allowed range `0-50`, with `0` disabling
  automatic repair. The settings panel keeps it beside the trial-run toggle.
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
  as Chat. Do not let editor-owned AI runs silently select a different global OpenCode version.
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
  per workspace from bootstrap and SSE. Route descendant permission prompts to the owning root
  runtime while replying with the real child session id; clear exact workspace/session/permission
  tuples and prune/reset ancestry with session deletion and workspace changes.
- Managed Windows command strings run under PowerShell by default. Author PowerShell syntax for
  plain command/shell tasks; invoke CMD-only syntax explicitly through argv with cmd.exe.
- A hung-turn force stop must finish the visible turn before waiting for restart health. Keep an
  exact workspace/session/turn recovery barrier so sends stay queued and runtime/session mutation
  stays blocked until the replacement is healthy; late recovery failures must not overwrite a new
  workspace, and must invalidate the failed workspace client cache.

## Focused Editor Tests

- `bun scripts/test-serial.mjs` intentionally runs each test file in a separate serial Bun process
  because editor tests share module mocks, ports, and process globals. Keep that isolation as the
  default.
- For fast regressions, pass repeatable unique selectors such as
  `bun scripts/test-serial.mjs --file tests/chat-yaml-staging.test.ts --file tests/opencode-lifecycle.test.ts`.

## Editor Settings Mutations

- Keep ordinary per-workspace settings controls responsive while persistence is in flight. Serialize
  their PATCHes, coalesce pending values, rebase them on each server response, and roll back only
  failed fields that have not been superseded by a newer edit.
- Keep restart-backed global and Python settings mutations mutually exclusive with each other and
  with pending workspace settings saves.

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

## Windows Pipeline Paths

- Treat resolved pipeline paths as case-insensitively equivalent on Windows before enforcing the
  `.tagma/<stem>/<stem>.yaml` shape. Drive-letter casing and `/` versus `\\` are aliases;
  POSIX path comparisons remain case-sensitive.

## Workflow Self-Repair

- Persisted workflow self-repair is finite and success-conditioned. The editor UI and workspace
  route must preserve `{ max_runs >= 2, stop_when: 'success', repair: true }` and must not
  collapse that policy into an ordinary fixed-count or infinite repeat mode.
