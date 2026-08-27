# ChatTurn Operation V2

Status: Approved

This ADR records the managed ChatTurn V2 contract after production cutover: the sidecar owns authority, the Host outbox and SQLite history own durability, and the renderer stays a versioned client of the operation API.

## Context

V1 mixed renderer intent, runtime execution, and recovery boundaries. V2 separates those concerns so one operation has one authority owner, one durable identity, and one replayable evidence trail.

Observed Windows/native evidence from the current turn:

- OpenCode is pinned at `1.18.18`.
- The pinned `1.18.18` runtime uses streaming `POST /v1/chat/completions`.
- A duplicate Host session create returned `200` with the same identity/time.
- The same input plus identical payload returned the original `200` admission and aggregate sequence before and after restart.
- The same input plus different payload returned `409`.
- A committed response loss was recoverable once from history.
- Question recovery is verified: the live reply/reject path is first-wins `204`, every same- or opposite-payload retry is `404`, both pending lists clear, and restart drops pending or stale replies so session, admission, and history prefix survive without hidden provider continuation or tool success.
- Tool-free compatibility text is verified on the Host native session: public single and list message reads stay `400` before and after restart; exact same Host message-id replay after a lost response returns cached text and does not reinvoke the provider, including after restart; same message id with different caller bytes is rejected before replay; this replay exception is allowed only for discussion/diagnosis text and never for `json_schema`.
- Rich-classifier conformance is verified with a pinned `1.18.18` limitation: wildcard tool deny alone removes internal `StructuredOutput` and fails; exact `StructuredOutput`-only exception succeeds with provider `toolCount1` and internal-only output; after a successful HTTP response is lost there is no public durable rich result before or after restart, compatibility reads return `400`, and same/different `messageId` replay returns `200 StructuredOutputError` without reinvoking the provider.
- History exposed an exclusive aggregate-sequence cursor.
- SSE replay returned stable `evt_*` ids and parsed payloads, but the runtime omitted the declared `event` field.
- Restart preserved history and exactly one admission.
- Native test results were `2` pass / `159` assertions.
- Combined foundation evidence is `112` tests / `725` assertions.

## Decision

ChatTurn Operation V2 uses one authoritative sidecar-owned operation model with these invariants:

| Axis            | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authority       | The renderer does not own execution. It projects state and submits versioned requests to the Host-owned operation API.                                                                                                                                                                                                                                                                                                                                         |
| Binding         | A writable target is bound by Host-authenticated identity, not by path text alone. Read-only origin may be shared; writable target may not.                                                                                                                                                                                                                                                                                                                    |
| Phase           | Clarification, reservation, prompt execution, waiting, commit, recovery, and terminal handling are distinct states, not one overloaded status.                                                                                                                                                                                                                                                                                                                 |
| Evidence        | Outbox, SQLite history, SSE, and snapshots are the durable evidence sources. SSE is a wake-up signal, not the source of truth.                                                                                                                                                                                                                                                                                                                                 |
| Commit          | `commit_decided` is the linearization point. After it, recovery may roll forward, but it must not rewrite committed bytes.                                                                                                                                                                                                                                                                                                                                     |
| Permission      | A pending permission record is persisted before restart; the first live reply is `204`, duplicate replies are `404`, restart drops the pending request from the live OpenCode surface, and recreating it with either the same ID or a fresh internal ID still resolves to deny.                                                                                                                                                                                |
| Question        | The streaming question contract is first-wins `204`, same/opposite retries are `404`, both pending lists clear, and restart keeps the session/admission/history prefix while rejecting hidden continuation or tool success.                                                                                                                                                                                                                                    |
| Text replay     | Tool-free compatibility text on the Host native session succeeds with public single/list reads still returning `400`; same Host message-id replay after a lost response returns cached text and does not reinvoke the provider, including after restart; same id with different caller bytes is rejected before replay; the replay exception is discussion/diagnosis text only and never `json_schema`.                                                        |
| Rich classifier | Wildcard tool deny alone removes internal `StructuredOutput` and fails; exact `StructuredOutput`-only exception succeeds with provider `toolCount1` and internal-only output; if a successful HTTP response is lost, no public durable rich result exists before or after restart, compatibility reads return `400`, and same/different `messageId` replay returns `200 StructuredOutputError` without reinvoking the provider. This is a verified limitation. |
| Security        | The control directory and key live on exact private non-symlink filesystem objects; path-only HMAC covers lookup identity, recordHmac covers the full record, schema/index drift fails closed, and source/event dedupe is complete.                                                                                                                                                                                                                            |
| Phase 1         | Exact opt-in shadow read routes create no binding, invocation, stage, result, or WAL side effects. Production cutover is gated by packaged metadata and the V2 env trio.                                                                                                                                                                                                                                                                                       |

## Same-Operation Clarification

Clarification stays inside the same operation only before binding, staging, or foreground invocation.

- Clarification freezes Host inventory and renderer evidence.
- Clarification is bounded.
- Once reservation starts, the operation cannot return to clarification.
- Once commit is decided, the operation cannot return to authoring, verification, or repair.

Same-operation identity is defined by the Host operation identity plus the frozen payload, not by retry count or stream replay.

## Trusted Persistence

The control plane lives outside the workspace in the stable server-control root.

- The explicit absolute `TAGMA_CHAT_CONTROL_DIR` wins first.
- Then the sibling of `TAGMA_EDITOR_USER_DIR`.
- Then the OS state directory.
- The SQLite database and the HMAC key must never fall back into `.tagma`, the repository, a temporary directory, or a process-random key.
- The HMAC key proves control-plane integrity; it does not define workspace identity.

The SQLite database is the trusted journal for admissions, aggregate sequence, recovery state, and terminal outcome.

- The control-store schema version is 6. Schema mismatches fail closed, and the migration/reset paths rebuild V2 state against that schema instead of silently downgrading.

## Workspace Identity And Snapshots

Workspace identity is host-authenticated and path-aware, but it is not just a string path.

- Managed Chat and prompt-task processes must receive the same absolute, Tagma-owned `OPENCODE_DB` path.
- Different sessions may share a read-only origin.
- Different sessions must not share a writable target.
- Frozen snapshots carry the evidence needed for clarification and recovery.
- A target-pipeline smoke path is valid only when the staged Trial snapshot bytes match the authenticated source snapshot.

## Outbox, History, And SSE

The durable flow is:

1. Write the invocation outbox record before contacting OpenCode.
2. Use the Host admission and history row as the source of truth for identity, sequence, and terminal state.
3. Treat SSE as a wake-up channel.
4. Join the SSE `evt_*` id back to history because the runtime omits the declared `event` field.

The durable join key is the tuple `(sessionId, aggregateSeq, eventId)`.

## Projections And Wake Protocol

- `GET /api/chat/operations/snapshot` returns `{ protocolVersion, snapshot }`.
- `GET /api/chat/operations/events` returns `protocolVersion` plus either replayable JSON pages or SSE frames.
- SSE wake frames use `chat_operation_wake` and carry only `workspaceSeq` and `operationId`.
- `cursor_reset_required` is a 409 reset signal. The renderer must resync its cursor instead of inferring state from a missing event.
- Host event payloads are `schemaVersion: 1`, and renderer-side projection readers validate the projection shape before accepting it.

## Production Cutover

V2 is the production write path.

- `apps/electron/package.json` declares `tagma.chatOperationProtocolVersion: 2`.
- `runtime-paths.ts` emits `TAGMA_CHAT_OPERATION_V2_SHADOW=1`, `TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER=2`, and `TAGMA_CHAT_OPERATION_V2_MIGRATION=1` only when that packaged declaration and the version-skew gate agree; otherwise it strips the V2 env trio.
- The binding lifecycle is still explicit: classify the user intent before allocating a writable pipeline, discussion and diagnosis own no writable pipeline, and the Host resolves and atomically binds create or edit authority.
- Reconciliation failures remain scoped per stage and per session, and preserved failures stay preserved so independent jobs and other sessions can continue.
- Host persists pending permission authority, but it cannot rehydrate or reply the old OpenCode drain after restart; recovery must use a new controlled invocation or repair path, or fail explicitly.
- No single operation may own both V1 and V2 executors.

## WAL Linearization And Recovery

`commit_decided` is the sole publish linearization point.

- Before `commit_decided`, cancellation may still end as a pre-commit cancellation.
- After `commit_decided`, Stop only appends audit and recovery metadata.
- Recovery must roll forward from durable history or fork a new branch when required.
- Recovery must never overwrite third-party bytes or erase committed history.

Terminal outcome, generation identity, artifact hashes, and the exactly-once terminal event are immutable once recorded.

## Usage

Usage belongs to the same durable operation record as the admission and terminal outcome.

- Usage is captured in history, not inferred from replay.
- Usage follows the committed operation across restarts.
- Usage is not recomputed from SSE alone.

## API And Proxy

Renderer code is a versioned operation API client and event projection layer.

- The renderer may submit a frozen dirty-canvas snapshot.
- The renderer may submit CAS-guarded clarify, permission, cancel, retry, discard, or recovery choices.
- The renderer may not call OpenCode mutations or stage/finalize primitives directly.
- Raw OpenCode prompt, interrupt, permission, move, update, and delete routes are not a compatibility path for V2.

## Phased Migration

V2 replaces the write path in stages:

1. Keep legacy V1 readable and migratable.
2. Route new managed Chat execution through the V2 sidecar-owned path.
3. Keep both models separated during the atomic editor-plus-sidecar cutover.
4. Remove legacy write paths only after the acceptance gates below stay green.

No single operation may own both V1 and V2 executors.

## Acceptance Gates

The acceptance gates for this plan are:

- Pinned binary verification stays on OpenCode `1.18.18`.
- Duplicate Host session create remains idempotent and returns the same identity/time.
- Same input plus identical payload returns the same admission and aggregate sequence before and after restart.
- Same input plus different payload returns `409`.
- A committed response loss remains recoverable once through history.
- History keeps an exclusive aggregate-sequence cursor.
- SSE replay keeps the stable `evt_*` id and requires history join for event type and sequence.
- Restart preserves history and exactly one admission.
- The native conformance test passes.
- Permission handling follows the verified deny/restart contract.
- Question conformance follows the verified live/restart contract.
- Ordinary text replay follows the verified discussion/diagnosis-only contract, and the replay exception never applies to `json_schema`.
- Rich-classifier conformance is a verified limitation; lost rich results are provider_unavailable, never auto-reprompt, and require an explicit new Host invocation for user retry.
- Production cutover is active for packaged V2 builds; shadow reads remain exact opt-in only, and the V2 env trio appears only when the packaged protocol gate is satisfied.
