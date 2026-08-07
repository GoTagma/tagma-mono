---
name: monitor-tagma-diagnostics
description: Continuously monitor Tagma's opt-in read-only diagnose/coding-agent diagnostics API, distinguish product defects from authoring or environmental noise, and maintain an evidence-backed defect ledger until the developer explicitly stops monitoring. Use when a developer enables Tagma diagnostics, invokes diagnose, pastes a diagnostics handoff, asks the agent to observe a live editor/debugging session over time, collect reproducible Tagma-caused anomalies, or guard a diagnosed fix with tests and durable documentation.
---

# Monitor Tagma Diagnostics

Continuously observe a live Tagma diagnostics session. Maintain a qualified defect ledger rather
than treating every error or unusual intermediate state as a Tagma bug.

## Non-negotiable boundaries

- Keep the diagnostics phase read-only. Use only `GET` requests below
  `/api/diagnostics/v1`; never mutate files, code, settings, processes, editor state, OpenCode, or
  the workspace while monitoring.
- Treat the bearer token as a secret. Send it only in the `Authorization` header. Never echo it,
  place it in a URL, save it in the repository, or include it in reports.
- Run diagnostics requests directly. Do not ask the developer to run API requests manually.
- Continue monitoring and collecting until the developer explicitly says to stop, that monitoring
  is no longer needed, or cancels the task. A quiet interval, one completed diagnosis, or one fixed
  issue does not end monitoring.
- Require separate, explicit developer authorization before changing code or other state. A
  diagnostics handoff authorizes observation, not repair.

## Maintain two independent state machines

Keep the monitor state separate from each finding's state.

Monitor states:

`starting -> active -> paused -> active -> stopping -> stopped`

- Enter `paused` when the token is revoked, Tagma closes, the endpoint is unreachable, or required
  evidence is temporarily unavailable. Preserve the cursor and ledger, explain what is needed to
  resume, and do not silently call the investigation finished.
- Enter `stopping` only after an explicit developer stop request. Perform the final drain and
  summary before entering `stopped`.

Finding states:

`observation -> candidate -> confirmed -> repair-authorized -> fixed -> guarded -> verified`

A finding may instead become `rejected` with the exclusion reason recorded. Repairing or rejecting
one finding never changes the monitor state.

## Start and poll

1. Parse the pasted handoff for the loopback base URL, protocol version, workspace key, and token.
   If the handoff is missing, request the copied Tagma agent instructions; do not guess credentials.
2. Fetch `/manifest` first and honor its advertised protocol, endpoint coverage, bounds, and privacy
   notes.
3. Establish a baseline with `/context`, `/logs?after=0&limit=500`, and
   `/opencode/sessions`. Read relevant session messages with the URL-encoded session id and a
   bounded limit. A `409` from OpenCode means it is not running; do not start or restart it.
4. Poll logs with the returned `nextCursor` as the next `after` value. Never reset to zero merely
   because an interval is quiet. Refresh context and relevant message history after material state
   changes or when logs point to a different evidence layer.
5. Prefer the host's recurring-monitor or wait mechanism when available. Otherwise use bounded
   polling waits and keep the active task alive. Avoid busy loops and excessive requests; use a
   short interval during active reproduction and back off while idle.
6. Emit concise progress only when the monitor changes state, a finding changes state, evidence is
   needed, or a periodic heartbeat is useful. Keep the ledger current internally between updates.

Treat every reported `total`, `returned`, `omitted`, cursor, limit, read error, and truncation layer
as part of the evidence. A clipped diagnostics page is evidence about the read interface, not
proof that the underlying log, stream, file, run history, or persisted record was truncated. An
empty, short, or unavailable response is not proof that the underlying evidence does not exist.

## Qualify product defects

Create an `observation` for anything unexpected, then attempt to falsify product ownership before
promoting it.

Exclude by default:

- incomplete YAML, partially authored workflows, transient creation/editing states, or invalid
  user input that Tagma reports as designed;
- command, prompt, model, plugin, or external-service output that Tagma merely displays correctly;
- local environment, network, credential, permission, approval, missing-binary, or service
  availability failures when Tagma handles them according to contract;
- developer cancellation, deliberate feature limits, unsupported observations, test-harness
  limitations, and diagnostic-interface clipping;
- temporary failures introduced by an agent's own work before that work is complete.

An external trigger can still reveal a Tagma defect when Tagma itself handles that trigger
incorrectly—for example, corrupting state, hanging, misreporting status, losing persisted data, or
violating a documented recovery contract. Record the defective Tagma behavior, not the external
trigger, as the finding.

Promote an observation to `candidate` only when all of these are present:

- a concrete expected-versus-actual mismatch at a Tagma-owned boundary;
- an expectation grounded in product documentation, tests, schemas, UI semantics, API contracts,
  or a clearly invariant workflow;
- direct diagnostics evidence tied to the relevant time, cursor, run, session, workspace, or state;
- an explicit explanation of why the symptom is not solely authoring, environment, external
  service, diagnostics transport, or observation-window behavior.

Promote a candidate to `confirmed` only when it is stably reproducible and directly supported:

- reproduce the same mismatch at least twice from equivalent known preconditions, preferably with
  one fresh attempt; or reproduce it with a deterministic failing automated test;
- capture the causal event sequence, not only the final error text;
- correlate independent evidence surfaces when available, such as context plus cursor logs or live
  diagnostics plus a regression test;
- narrow the likely Tagma component and falsify reasonable competing explanations.

Do not repeat destructive, costly, privacy-sensitive, or externally consequential actions merely
to satisfy the repetition rule. Leave the item as a candidate and state the missing evidence.
Never invent a reproduction, expected behavior, or missing event.

## Keep an evidence ledger

Maintain one compact record per finding:

```text
ID and title:
Status:
First seen / last seen:
Affected Tagma version and workspace/run/session scope:
Expected behavior and authority:
Actual behavior:
Minimal preconditions and reproduction steps:
Reproduction count and stability:
Direct evidence (endpoint, timestamp, cursor/event IDs, relevant sanitized fields):
Truncation/read boundaries:
Product-ownership argument:
Alternatives checked or rejection reason:
Likely component/root cause and confidence:
Impact:
Repair, tests, documentation, and verification:
```

Redact secrets and minimize user-authored prompts, paths, messages, and tool output. Reference the
smallest sufficient evidence rather than copying entire payloads. Merge duplicate symptoms when
they share one causal chain; split symptoms that require different causes or fixes.

## Repair only after authorization and confirmation

When the developer explicitly authorizes repair of a `confirmed` finding:

1. Keep monitoring active unless the developer separately asks to stop.
2. Locate the root cause before editing. Do not silence logs, weaken validation, expand a read
   limit, or special-case the observed symptom unless that is the proven defective layer.
3. Add the smallest meaningful failing regression test first and demonstrate that it exposes the
   confirmed behavior. Use the same preconditions and assertion boundary as the live evidence.
4. Fix the root cause at its owning layer while preserving public APIs, persisted YAML, plugin
   contracts, diagnostics isolation, and desktop/update contracts.
5. Add multiple durable guardrails where applicable:
   - encode the invariant in types, schemas, validation, or runtime assertions;
   - retain the exact regression test and add a negative, boundary, recovery, or integration case;
   - document user-visible behavior or protocol contracts in the relevant README;
   - add a concise invariant to the nearest `AGENTS.md` when future agents could plausibly undo or
     misinterpret the fix.
6. Run the narrow regression test, relevant workspace checks, and broader verification in
   proportion to the affected boundary.
7. Re-run the original live reproduction while diagnostics remain active. Mark `guarded` only when
   code, tests, and documentation enforce the result; mark `verified` only when both automated
   verification and live evidence support the fix.
8. Continue watching for recurrence and new findings.

Follow the repository's `tagma-dev` workflow and completion gate for any repair. If repair cannot be
authorized by stable reproduction and direct evidence, report the gap and continue monitoring.

## Stop cleanly

After an explicit stop request:

1. Poll once from the last cursor and take one final context snapshot if the diagnostics session is
   still available.
2. Freeze the ledger and summarize confirmed, candidate, rejected, fixed, guarded, and verified
   findings. State any unresolved evidence gaps.
3. Forget the bearer token and do not retain raw diagnostics. The developer controls disabling the
   Tagma diagnostics session; do not use a non-read-only endpoint to do it.
4. Clearly report that both monitoring and new issue collection have stopped.
