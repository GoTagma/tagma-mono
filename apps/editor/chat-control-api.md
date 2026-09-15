# Chat Control API implementation and acceptance map

Status: implemented; Windows Debug and isolated installed Release acceptance completed on 2026-09-15.
The ledger preserves evidence, failed attempts and validation limits. Validation did not modify a
production user workspace, publish a release, or deploy the application.

## Execution contract

Human UI and external commands use the same renderer actions and availability selectors.
The product bridge transports authorized commands to the running renderer. Those actions
collect the real editor canvas, attachments, conversation selection and model before calling
the existing Chat V2 controller and Host. The bridge must never generate its own Chat request
or run a second authoring engine. Renderer disconnect preserves receipts and reports loss
of observation; it does not imply that a Host operation stopped.

The public feature is **Chat Control API**, under `/api/agent-chat/v1`. Settings exposes
**External Agent Control**, disabled by default in both Debug and Release, independent of
read-only diagnostics. Initial transport is authenticated loopback HTTP.

## UI action → common entry → API command → acceptance case

Common entries below are implemented and wired to UI controls. `src/chat-actions/` owns product behavior;
`src/agent-chat-control/` owns transport and observations only.

| UI operation                    | Common product entry                                            | Public command/read                              | Required evidence                                                                                                     |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Chat header New                 | Conversation action → store `newSession`                        | `conversation.create`                            | Dedicated conversation appears in real History, inherits model preference and retains its own identity                |
| History select / takeover       | Conversation selection action → store `selectSession`           | `conversation.select`                            | Host grant is required for existing identity; same history, prior requests and owned target survive selection         |
| Read History                    | Existing conversation/history projection                        | `GET /conversations`, `conversation.read`        | Only granted conversations exposed; read-only historic records cannot gain write identity                             |
| Type in Composer                | Shared Composer edit action                                     | `composer.edit`                                  | UI/API change the same visible draft and use identical edit gates                                                     |
| Attach/remove context chip      | Shared attachment actions → existing store                      | `attachment.add`, `attachment.remove`            | Same id/label/content in visible chips and serialized request; loss injection fails comparison                        |
| Send button / Enter             | `submitChatComposer` → store `send` → V2 controller             | `composer.submit`                                | Same trimmed text, attachments, model/variant and frozen unsaved canvas; same failure restoration and blocked reasons |
| Model and reasoning pickers     | Shared selection actions → store setters                        | `model.select`, `model.variant`                  | Only configured model/variant values accepted, same busy gates and conversation persistence                           |
| Select pipeline context         | Shared pipeline selection action → existing editor navigation   | `context.select`                                 | Same visible canvas selection and unsaved-change decisions; no separately authored API snapshot                       |
| Clarification buttons / text    | Shared reply actions → store candidate/send actions             | `clarification.reply`                            | Same Host-issued request/candidate ids, validation, attachments and CAS; ordinary draft preserved                     |
| Question form                   | Shared answer assembly/submit action                            | `question.reply`                                 | Same single/multiple/custom answer validation, rejection and stale-request handling                                   |
| Permission bubble               | Shared permission reply action → store `replyPermission`        | `permission.reply`                               | Only granted choices; first-wins, rejection, no double reply after connection loss                                    |
| Stop                            | Shared stop action → store `abort`                              | `operation.stop`                                 | Remains responsive during generation/interaction; preserves pre/post commit semantics                                 |
| Retry / continue verification   | Shared retained-work action → existing V2 retry                 | `operation.retry`                                | Same draft retention, failure evidence, Trial and publication gates                                                   |
| Recover lost interaction        | Shared recovery choice action → existing V2 recovery            | `interaction.recover`                            | Same allowed choices, request identity and CAS; restart does not recreate stale runtime requests                      |
| Retry interrupted publication   | Shared retained-publication Retry action → V2 controller        | `operation.retry`                                | Same Host-managed roll-forward/fork and immutable commit-decision authority; no backend-only choice bypass            |
| Open/read/select draft file     | Shared draft state/action used by `DraftEditor`                 | `draft.open`, `draft.read`, `draft.select`       | Same Host-issued file identity, displayed contents, pending/error/dirty state                                         |
| Edit/save/close draft           | Shared draft state/action used by `DraftEditor`                 | `draft.edit`, `draft.save`, `draft.close`        | Same unsaved-change choices, content hash CAS; invalid YAML retainable and never implicitly published                 |
| Explicit discard                | Shared discard action → existing V2 discard                     | `operation.discard`                              | Separate from revocation and Stop; retained work not silently lost                                                    |
| Messages/errors/Trial/results   | Existing rendering selectors plus mounted component observation | `GET /state`, `GET /events`, `GET /commands/:id` | Host and renderer reported separately, with operation/event versions; result-projection failure is observable         |
| Settings enable/copy/disable    | Product management actions                                      | Management API only                              | Actual port/address, independent temporary token, manifest/instructions; default off and diagnostics independence     |
| Settings grant/revoke/take back | Host-owned grant management                                     | Management API only                              | Workspace, original owner, controller and grant version bound; queued/late commands fenced after takeback             |

## Protocol and persistence requirements

- [x] `GET /manifest` lists all supported commands, strict parameter constraints and grant scopes.
- [x] `GET /state` exposes renderer connection/readiness, selected conversation, operation
      availability/reasons, actual observations, acknowledged event version, and independent Host state.
- [x] `POST /commands` returns a durable receipt before waiting for long work. Same request id
      and canonical content joins the original command; changed bytes conflict.
- [x] `GET /commands/:id` distinguishes admission, renderer execution, correlated Host operation
      and terminal result. Disconnect/restart must not replay a possibly executed command blindly.
- [x] `GET /events?after=...` provides resumable, bounded incremental state/interaction events.
- [x] Fixed strict command types; no arbitrary script route or external conversation credential.
- [x] Append control-store migration after schema 9 for grants, receipts and idempotency; preserve
      the stable private SQLite/key authority and schema/checksum drift checks.
- [x] Single external controller per conversation; explicit existing-conversation consent and
      Host-authenticated original ownership. Workspace/renderer reconnect revalidates grants.
- [x] Restart revokes temporary bearer tokens, retaining authorization/command history for
      explicit reauthentication. Revocation invalidates queued and late work without implicitly Stop.
- [x] Bridge can process Stop and interaction replies while a generation command is pending.

## Verification ledger

Every scenario must run through the human product entry and the external bridge entry;
backend-only generation is insufficient. Deterministic conformance and real-model evidence
are separate. Real runs use isolated workspaces/control data and preserve bounded evidence
without credentials. Physical UI controls additionally need browser/editor UI verification.

Real-provider validation must use the user's configured **Kimi For Coding** provider. Discover
its actual configured model list first, then select available **Kimi 2.7** or **Kimi K3**; do not
substitute a different provider or claim model discovery/real-model success before running it.
The copied Settings instructions must be sufficient for an external agent to connect and operate
without additional explanation, and include the actual endpoint, independent temporary credential,
manifest, commands, events, interactions and recovery workflow.

| Gate                                                                                                               | Status / evidence                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared Composer entry tests first                                                                                  | Verified: initial missing-entry failure and subsequent shared-action passes (original implementation evidence below).                                                                                             |
| Same model, attachments, unsaved canvas and input produce equivalent V2 request                                    | Verified: five UI and five real HTTP/bridge golden cases; both targeted omission mutations are detected by every case.                                                                                            |
| Send failure preserves the same input/attachments; late failures cannot contaminate another workspace/conversation | Verified: Composer guards, cutover inventory failures and independent result-read fault cases preserve input and attachments.                                                                                     |
| Create then successive edits retain history, requirements and target ownership                                     | Verified: Debug and final installed Release each create v1, recover an interrupted edit to v2 and publish v3 to the same owned target; baselines remain unchanged.                                                |
| Clarification, permission rejection, verification failure, recovery and Stop parity                                | Verified: ten UI/HTTP clarification/permission/question/recovery cases use real V2 CAS; draft/Retry/Stop gates and live Stop/recovery in both builds pass.                                                        |
| Fault injection: omitted attachment, missing canvas, failed result projection                                      | Verified: two omission mutations each fail 5 UI + 5 HTTP golden cases; two detail-read failures expose independent Host completion and absent renderer results.                                                   |
| Disconnect/reconnect, duplicate submit/reply, receipt recovery                                                     | Verified bridge/store conformance and full Debug/installed Release restarts on different ports; old tokens return 401, stale replies fail, original operations recover without resend.                            |
| Revocation, expired grant, stale command, workspace/window isolation                                               | Verified Host/store/protocol tests plus source UI revoke/regrant evidence. New desktop IPC rejects foreign or unbound workspaces.                                                                                 |
| Stable-store migration, restart token invalidation, schema/record integrity                                        | Schema 10 migration/store evidence retained. Durable desktop identity recovery, corrupt records and dangling-link rejection tested; no old migration was changed.                                                 |
| Diagnostics disabled while Chat Control API operates                                                               | Verified independent Settings/observation tests and actual Disabled diagnostics UI in both final modes.                                                                                                           |
| Editor regression suite, client/server/test types, lint and builds                                                 | Verified: final 72-test editor regression, 91 Electron tests, all workspace types, lint/format/text/dependency/tooling gates and final client/sidecar/shell/NSIS builds.                                          |
| Real Debug editor + real model via the new API: create, multiple edits, interactions and recovery                  | Verified with configured Kimi: v1, full-process restart/recovery to v2, v3, Stop at permission, identity/target preservation and real UI observations.                                                            |
| Fresh Release build + real editor/model via the new API: same journeys                                             | Verified with the final installed sidecar hash and Kimi: v1, full-process restart/recovery to v2, v3, Stop at permission and real UI observations.                                                                |
| Physical UI: Settings, copy, Composer, dialogs, layout and scrolling                                               | Verified in both builds: Settings, Copy/Ctrl+V, mounted Composer/CJK composition guard, UI/API failure parity, scrolling and full native-frame layout. Native OS IME candidate UI is outside the executed checks. |
| CI review when accessible (no automatic commit/push)                                                               | Unavailable: gh auth status confirms no authenticated GitHub host; no remote verification claimed.                                                                                                                |

## Implementation sequence

1. Extract shared product actions and availability, including component-local input/recovery
   and draft/interaction state. Wire human controls and protect existing behavior with tests.
2. Add strict protocol, renderer bridge handshake, receipts, events and observations.
3. Add Host grants, authenticated takeover/revocation and append-only store migration.
4. Complete every operation and real display observation in the map.
5. Wire Settings, instructions and sidecar/renderer startup/stop lifecycle in both build modes.
6. Complete conformance, fault injection, isolated real-model and Debug/Release validation.

## Earlier implementation evidence (chronological; final audit below takes precedence)

- `src/chat-actions/composer.ts` is wired to the real Composer button/Enter. It shares
  availability, trimmed input, failure restoration, workspace/conversation fencing and a visible
  pending-submit guard. `chat-store.send` still owns attachments and canvas/V2 serialization.
- `src/chat-actions/draft.ts` owns the actual `DraftEditor` state and open/select/edit/save/close
  actions, including dirty decisions, Host-issued file/hash/CAS authority and workspace reset.
- `src/chat-actions/selection.ts` is wired to header model/variant/new-conversation controls
  and History selection. It validates configured picker values and shares busy/modal gates.
- Each of the three new action suites was first run before its module existed and failed on
  the missing shared entry. The implemented suites then passed (11 Composer, 6 draft, 6 selection).
- The existing cutover suite now sends five saved/unsaved/navigation/inventory-refresh canvas
  scenarios through the real common Composer action and inspects the V2 request including
  model, variant, attachments and frozen YAML/layout. This is Composer regression evidence;
  it does **not** establish UI/API parity before the bridge exists.
- A seven-file isolated regression run passed all 66 tests: `chat-composer-actions`,
  `chat-composer-draft`, `chat-draft-actions`, `chat-selection-actions`,
  `chat-operation-draft-files`, `chat-operation-v2-cutover`, and `chat-operation-v2-resend`.
  Bun's sandboxed cutover run twice failed to read an existing hook with `EPERM`; the same
  test and subsequent seven-file run passed under automatic review outside that sandbox.
- Current foundation changes pass `bun run check:client`, `bun run check:tests`, focused
  ESLint with zero warnings, focused Prettier checking and `git diff --check`.
  `bun run build:editor` passes against the final source (Vite 3233 modules, 17.23 seconds);
  its existing large-chunk advisory remains. An initial client type failure on `Object.hasOwn`
  was fixed using the configured target's `hasOwnProperty.call`; the selection suite and checks
  were rerun successfully. No sidecar or desktop build/real-model validation is claimed yet.
- `src/chat-actions/operation.ts` now serves UI permission/question/clarification/recovery,
  Stop, retained-work Retry and explicit discard. Pending decisions are visible in the Chat
  store; Stop has a separate action slot so it is not queued behind a pending reply. The real
  question form keeps Stop outside its disabled reply fieldset. Both the failing rendered-form
  test and the five common-action tests pass after implementation.
- `src/chat-actions/context.ts` is registered by the mounted `App`. The ordinary workspace file
  picker and Host-issued context candidate commands enter that same App navigation callback,
  including workflow return-path handling. Three tests cover shared navigation, dirty decisions,
  missing candidates, detached renderer and changed workspace.
- `shared/agent-chat-control.ts` defines the strict 24-command registry, parameter constraints,
  conversation/controller scope and canonical request bytes. Twelve protocol tests pass.
  `src/chat-actions/commands.ts` dispatches to the common product actions; four tests cover the
  same visible input/attachments, failed sends, conversation/modal fences and chip identity.
  These are product-entry tests, not a claim of full HTTP/renderer bridge parity.
- Schema 10 (`agent_chat_control_authority`) appends controller/grant/command/event tables to
  the existing V2 database. `server/agent-chat-control/store.ts` signs records with the durable
  control key, preserves grant versions and idempotent receipts, separates revocation from Stop,
  and retains unknown claimed outcomes across controller restart revocation. Seven dedicated
  persistence tests pass against isolated stable control directories. The existing migration
  fixtures are extended to exercise upgrades from schema 1 through 9 without changing their
  previous migration identities.
- Host `authenticateAgentChatConversation` now verifies the original owner against authenticated
  conversation contexts and a supplied existing operation. Two tests reject changed keys,
  renderer/conversation identities, foreign workspaces, missing credentials and legacy history.
  `agentChatControlWorkspace` exposes the stable store facade internally without exposing its key.
- The 12-file product/protocol regression run passed 91 tests. The dedicated control store has
  seven passing tests. The old Store suite passed 84 tests; its remaining historical-migration
  expectation was updated to schema 10, then the complete schema 1–9 migration/drift case passed.
  Another 21 migration executor/runtime/service/protocol tests pass. Server and test types pass;
  focused lint/format checks pass. The editor bundle and compiled sidecar both build, including
  the compiled Trial witness worker check. These builds do not constitute real desktop journeys.
- The HTTP namespace, temporary independent tokens, renderer handshake/poll/claim/finish,
  stable Host request identity and receipt-to-operation lookup are implemented. Settings exposes
  External Agent Control alongside Diagnostics, with default-off enablement, explicit existing
  conversation grants, revocation, Take back control and Copy agent instructions. The actual
  App mounts the bridge; the dispatcher enters the same product actions as the UI.
- The bridge polls independently of pending generation, preserves unacknowledged receipts,
  reauthenticates original conversation credentials after reconnect, and reports actual committed
  Chat/Draft surfaces separately from Host and renderer projections. Host, HTTP, Settings,
  observation and bridge suites covered these boundaries; full conformance had not yet run at that checkpoint.

## Earlier isolated live evidence (2026-09-14; superseded by the final audit)

Artifacts are local and ignored under `output/playwright/chat-control-1789377624720` and
`output/playwright/chat-control-1789382691806`. The source-sidecar lab serves the built editor
at loopback port 52440 with workspace `D:/Temp/tagma-chat-control-lab-7yKX2k/workspace`.
This is real-browser/source-sidecar evidence, **not** packaged Debug/Release acceptance.
Only the configured Kimi For Coding credential is copied into isolated temporary XDG data;
credentials and copied token instructions must not enter committed artifacts.

- Configured catalog discovery found `kimi-for-coding` (Kimi K2.7 Code), `k3`, `k3-256k`
  and the high-speed model. Live calls use `kimi-for-coding/kimi-for-coding`.
- Real Settings initially showed Disabled. Enable and Copy succeeded; the copied handoff reached
  the 24-command public manifest. Public `conversation.create` made a visible dedicated
  conversation, and public model selection updated the real picker.
- Real discussion returned `CONTROL_API_READY`; Host completed_readonly and actual rendered
  text agreed. Repeating the same public request id/body retained the original operation id.
- The first real authoring attempt exposed a shared-action bug: a pending Send blocked permission
  replies. Public Stop cancelled it precommit. The fix removes that blanket gate and keys pending
  decisions by request identity, retaining Stop's independent slot; focused regression tests pass.
- Restarting the isolated sidecar invalidated the previous external token (HTTP 401). Explicit
  re-enable reauthenticated the existing grant using the original renderer conversation credential.
- The next creation, operation `operation-5ae6a691-4dda-48a9-a6d3-8f66aff47490`, accepted
  six public once-only staged-file permission replies, ran real Sandbox Trial, and ended
  `completed_published` at version 28. The actual UI shows Passed (1/1 cases), two successful
  task executions, Live Smoke not enabled and verification warnings. Output is an independent
  `chat-abb550bb2b1a9fa449ac258f` pipeline; baseline remained unchanged. The five-minute observer
  timed out before completion; later explicit observation confirmed the terminal result.
- This creation exposed an observation defect: asynchronous child rendering added the assistant
  result after the parent's layout effect, leaving API surface text stale even though the UI showed
  publication. `published-before-observation-fix.png` and the saved API state preserve the mismatch.
  ChatPanel now observes committed subtree and layout changes. The later v3 turn below verifies
  the fix without refreshing the page.
- A fault-injection test first reproduced stale connected=true after a failed heartbeat; the fix
  reports disconnected and reconnects without replay. All five bridge tests now pass.
- Real follow-up edits changed `control-v1` to `control-v2` (operation
  `operation-6e1bdc42-60d3-4961-a4a6-df769c33a5a3`) and then `control-v3`
  (`operation-676633f5-eb3f-424c-8991-37af640a7445`). Both retained the same published
  pipeline coordinate, passed Sandbox Trial and ended completed_published. The v2 turn handled
  12 once-only permissions; the v3 turn handled four. Following a second observation fix for
  content-visibility layout timing, the v3 API surface automatically included its newest response,
  Trial outcome and published result without refresh. `control-v3-published.png` was inspected.
- The cutover suite now runs the five frozen-canvas scenarios through both UI entry and real
  control HTTP/SQLite/renderer bridge/client/dispatcher, retaining the original V2 controller and
  serialization. An ambiguous-inventory fault also runs through both entries and preserves input
  and attachments without Host admission. All 29 tests / 210 assertions pass. V2 model execution
  is a deterministic fixture in these tests; real-model evidence is recorded separately above.
- Client, server, test and Electron types pass. The current editor (3242 modules), compiled
  sidecar (including Trial witness worker), Electron shell and Windows unpacked Release build
  all succeeded. Packaged real-editor and installed-build journeys had not yet run at that checkpoint.
- To keep desktop QA isolated, the explicit `TAGMA_DESKTOP_USER_DATA_DIR` override now applies
  before the single-instance lock in both Debug and Release; default launches keep their usual
  profile. The updated launcher regression first failed, then passed with all 14 launcher tests.
- The pending-permission restart test for
  `operation-4f5b6085-4faf-451e-bc08-da208fd5a47b`. Its old token returned 401 after restart.
  initially exposed the V2 controller's operation-wide mutation lock blocking a new permission
  while the recovery response remained pending. The controller now fences interactive requests
  by qualified request identity and Stop independently, retaining Host generation/version CAS.
  The regression first failed, then all 16 controller tests passed. A second real restart/recovery
  with that fix handled seven permissions and ended completed_published, version 36, cursor 269,
  with stdout `control-v4`. Host and actual UI Trial/publication observations agree. Latest source
  metadata: `output/playwright/chat-control-1789388393262/lab.json`.
- Real Settings Revoke advanced the grant to version 2; an old version-1 command returned 403,
  and public state masked both Host and renderer. Explicit Authorize conversation regranted the
  original identity at version 3 and restored the same history/result. Version-1 requests remained
  rejected. The Composer stayed empty and no model operation was created by those rejected commands.
- All 18 related editor regression files pass, including all 85 V2 store tests. Electron's complete
  83 tests pass. Client/server/tests/Electron types and focused lint pass; dependency metadata and
  frozen install, public imports, package cycles and diff whitespace checks pass. GitHub CLI has
  no authenticated account, so CI status is unavailable; no remote check for these uncommitted
  changes is claimed. Several sandbox executions failed EPERM, and several automatic approval
  requests were rejected because the approval service stream disconnected; successful retries are
  distinguished from those failed attempts.
- Explicit re-enable after 24-hour token expiry initially abandoned the previous controller's
  grants. It now revokes the expired controller and reauthenticates its preserved grants with a
  fresh token. The added failing regression now passes with all seven Host tests. The final baseline
  sidecar was rebuilt with the cached Bun 1.3.11 and its embedded Trial worker verified. Its SHA256 is
  `809F6745DE4D54685021E5CC7E5FA73014EB12171C6355841392A28FACFA3305`.
- Final desktop generation validation uses unpacked Release
  `apps/electron/release/chat-control-qa/win-unpacked/Tagma.exe` (metadata
  `output/playwright/chat-control-1789389477886/lab.json`) and Debug Electron (metadata
  `output/playwright/chat-control-1789389896411/lab.json`). Both used Settings Enable and the
  actual Copy response, then public API dedicated-conversation creation and Kimi model selection.
  Release operation `operation-908feb58-cb13-472d-b3b0-a9e5890769c9` passed real Sandbox Trial
  and completed_published after six permissions. Debug operation
  `operation-5c55be23-7f16-4396-9576-619d48f3bcdd` completed_published at version 38, cursor 65,
  with Sandbox Trial passed. The final state was re-read during the September 15 resumption;
  the earlier timeout artifact remains evidence of an observation deadline, not a terminal failure.
- Desktop Copy displayed Copied, but CDP clipboard read returned empty and the sandboxed system
  clipboard read failed. The model tests captured the actual response to the Copy button's request,
  not a fabricated token. Native desktop clipboard round-trip remains unverified (the browser
  clipboard round-trip succeeded earlier). These are unpacked Release tests, not installer execution.
- Earlier source lab startup shared the user's recent-workspaces list because that route does not
  use the global-settings override. Subsequent labs isolate the child's USERPROFILE/home as well.
  No user pipeline was modified; the early test added a temporary recent-workspace entry.

## Resumption evidence (2026-09-15)

- The HTTP conformance fixture can now run the human product action while maintaining a real
  control connection and read independent Host evidence through public `/state`. Two new cases
  inject a valid V2 HTTP 500 `chat_operation_read_failed` response on the actual renderer detail
  read after Host completion. Both entries retain identical input/attachments and show the read
  error with renderer result null; the same public state still contains the independent Host result.
  This exercises the real controller, HTTP, control SQLite, bridge and observation path; model
  execution remains deterministic. It is not a claim of physical DOM rendering coverage.
- Targeted source mutations removed serialized attachments and then the frozen canvas snapshot.
  Each mutation made all five human-entry and all five HTTP-entry golden tests fail. Baseline
  and restored source each pass all ten; the restored source SHA256 equals the captured original.
  Local evidence: `output/playwright/chat-control-mutations-20260915/{summary.json,*.log}`;
  the adjacent `.ts` harness records the exact mutations and restores source in `finally`.
- The cutover suite passes 31 tests. Operation-action conformance passes 12, including new HTTP
  comparisons for valid/invalid question answers, stale/recovery-required requests and displayed
  Stop failure. Draft conformance passes all ten after unnecessary public-state reads were removed
  from ordinary command fixtures. The first combined run hit a five-second draft test deadline and
  its outstanding requests then failed authentication; that failed run is not counted as passing.
- Staging the final sidecar reproduced a real packaging defect: an old no-extension binary made
  the script skip the newer Windows `.exe`. The regression failed before the fix, then all three
  staging tests passed, including preservation of newer per-architecture builds. Electron's full
  suite now passes 86 tests / 268 assertions. Source, staged and newly packaged `.exe` hashes all
  match the final baseline hash above.
- A fresh NSIS QA package was built at
  `apps/electron/release/chat-control-installer-qa-20260915/Tagma-0.11.9-win-x64.exe`.
  It uses the same application source/version/resources with separate appId
  `com.tagma.chatcontrol.qa20260915` and product name `TagmaChatControlQA`; it disables shortcuts,
  installer elevation and automatic application launch. It is unsigned. Installation and live
  journeys must be recorded separately from this successful package build.

### Desktop identity and final-source verification

Full Electron restart exposed a gap that sidecar-only restart had not covered: renderer and
conversation credentials lived only in `sessionStorage`. New shells now keep them in private
userData `chat-identities` files, accessed only by the trusted top-level frame bound to that
workspace. Main enforces one window per workspace; credential writes finish before admission.
Five desktop identity tests cover process reconstruction, workspace/renderer isolation, strict IPC,
corrupt records and dangling links. Three renderer tests cover persistence failure and old-preload
compatibility. Already-lost legacy credentials remain read-only, never regenerated as ownership.

- Debug lab `chat-control-1789444822089` created `Durable Debug QA` using Kimi. Operation
  `operation-33652f09-06b9-4781-9cc5-ef989977088b` passed Trial and published at version 36.
  Its observer timed out; a subsequent authoritative read proved completion without resending.
- During the next edit, the whole Electron process exited at a live permission. Lab
  `chat-control-1789447244871` resumed the same profile on a different port. The old external
  token returned 401; identity-file SHA256 remained
  `3C71EE9020112F1A37566B3DA55CD450FCA839F310CC8E029F70412E51566132`; the same grant was
  reauthenticated and the old permission became `recovery_required`. A stale reply was rejected.
  Public recovery completed `operation-2c778b40-d2c5-4b3f-b87c-5b8f995baa74` to the same target
  after four new permission replies. A further edit,
  `operation-b01aebb2-78ec-4ce5-a39e-2f70f1b208dc`, published v3 after five permissions.
- Debug Stop during a subsequent live permission ended
  `operation-b3eedc27-1219-4730-b542-5c4d38e82ff6` as `cancelled_precommit`; published YAML bytes
  matched the pre-Stop hash. Physical Copy → Ctrl+V in task search matched the actual handoff.
  Mounted Composer testing used a real CJK input and composition Enter event, then real Enter
  and public API Send against an intercepted V2 failure: both requests were equivalent and both
  restored input; no Host/model admission occurred. This checks browser composition handling,
  not a native operating-system IME candidate window. Three publication regions scroll normally,
  and the Composer stays within the viewport. See `physical-evidence.json` and
  `debug-native-frame.png` in the resumed Debug artifact directory.
- Claimed recovery receipts initially omitted their known Host target until acknowledgement.
  They now link that target while executing only after workspace/renderer/conversation ownership
  checks. The regression failed before the change; all ten Host tests pass, including foreign
  target masking. The final baseline sidecar SHA256 is
  `E5C0DA2D6E0C8DF2FE305CB9CD5FE5CD1D4DD4EEB74D40DC8129F759359D8758`.
- The final current-source installer is
  `apps/electron/release/chat-control-final-qa/Tagma-0.11.9-win-x64.exe`, with separate appId
  `com.tagma.chatcontrol.finalqa20260915`. Its isolated installation exited 0 and the installed
  sidecar hash matches the final build. Lab `chat-control-1789449331127` created `Final Release QA`:
  `operation-23f664c9-e259-4717-96ed-23d0fe97046e` passed Trial and published at version 22.
  The whole app subsequently exited at the second edit's live permission. Resumed lab
  `chat-control-1789451911300` uses another port, rejects the old token, retains the same identity
  file hash (`BB387E57E422D43B44AE90643FCB04CDB2833C27EEE786986A88777C71895E99`), reauthenticates
  the same grant and rejects the stale reply. Recovery of
  `operation-b097841a-ab1d-4d73-96b7-0bd76ecf2a0b` completed_published after nine permission replies.
  Its recovery receipt exposed the same Host operation while still executing. The third turn,
  `operation-b5a74b6f-f756-4dcf-917b-0af0f6c325a1`, passed Trial and published to the same coordinate
  after three permissions. Stop during the next permission wait terminalized
  `operation-69fa7e7e-a771-4195-9fe3-908005fa585d` as `cancelled_precommit`; the published YAML hash
  remained unchanged. The final YAML prints `release-v3`, then the dependent `verified` marker.
- Final focused editor regression passes 72 tests (37 cutover, 12 operation actions, 10 draft,
  10 Host and 3 desktop identity). The full Electron suite passes 91 tests / 288 assertions.
  The 37 cutover cases include real HTTP comparisons for clarification, permission allow/reject,
  question and qualified recovery, preserving the real V2 controller and strict parser.
- Broad verification passes dependency/lockfile metadata, imports, cycles, focus, credential scan,
  all workspace types, formatting, text hygiene, lint and tooling tests at the recorded revisions.
  Text/lint initially traversed ignored desktop packages and old `.tmp` audit scripts. Precise
  generated-output exclusions now have two regressions that still reject bad application source.
  `gh auth status` confirms CI is unavailable.
- One attempted upgrade of the earlier custom QA install failed with NSIS exit 2 (old-file
  uninstall failure); it is not counted as a successful upgrade. Fresh isolated identities installed
  successfully. Temporary unpacked-directory locks caused separate failed packaging attempts;
  using the local Electron distribution and documented prepackaged mode produced the final package.
  Playwright's ordinary screenshot clipping disagreed with Electron native zoom; unclipped
  `Page.captureScreenshot` provides the complete frame. No generated credential enters screenshots.
- Removed only the proven early QA entry from the global recent-workspace list, preserving the two
  other current records, their order and the document version. Previously displaced unknown entries
  cannot be reconstructed. Both final instances took back control and exited. Thirteen temporary
  provider/instruction-response files created during this resumption were removed. All three QA
  installations uninstalled with exit 0. The final cleanup audit reports zero remaining QA app/lab
  processes, installed executables, matching HKCU uninstall registrations or copied credential files.
  Isolated profiles, identity/control stores, test workspaces and build/evidence artifacts remain
  private local reproduction material. See `output/playwright/chat-control-cleanup-20260915.json`.

### Final UI and boundary audit

- The final installed Release repeats the Debug physical checks: actual Copy → Ctrl+V round-trip;
  mounted CJK Composer input with composition Enter suppressed; ordinary UI Enter and public API
  Send produce equivalent requests and restore identical text after an intercepted V2 failure,
  with zero Host/model admissions. Three publication regions scroll (1142.5 → 3159.17), and the
  Composer is inside the viewport. `release-native-frame.png` was inspected at full native size.
- Both modes visibly show Coding Agent Diagnostics as Disabled while Chat Control operates.
  Their Sandbox Trial consent is version 3 and Live Smoke stays off. Both baseline YAML files retain
  SHA256 `467DD2B432C349AC8EEB75B5D6A45AD285B65488141C2C1F3A8B0C8B052CD9D9`.
- Final cleanup rechecks confirm zero task-owned QA app/lab processes, installed executables,
  matching per-user uninstall registrations and copied provider/token files. All three uninstallers
  exited 0. The existing user's provider configuration and production Tagma installation were not modified.
- Dedicated creation uses the normal new-conversation action and succeeds only after its id
  actually changes. Grant completion requires the original credential and a creation proof without
  a prior operation. Existing history cannot acquire write authority from a conversation id.
- Reports are bounded to 4 MiB, 30,000 nodes and depth 20; committed Chat text is capped at 128 KiB
  with explicit truncation. Commands cap at 2 MiB; durable command/event records cap at 8 MiB.
  Event reads default to 200 records (maximum 1000). Sustained retention and maximum-size history
  throughput were reviewed for these bounds, not load-tested; no unbounded-capacity claim is made.
- Validation limits: native OS IME candidate windows, macOS/Linux installers, Live Smoke, production
  signing/identity and remote CI were not exercised. The browser composition guard and Windows QA
  installer flows were exercised. The earlier custom-QA upgrade failure remains recorded above.
  Validation did not push changes, publish a release or modify a production installation.
