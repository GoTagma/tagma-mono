---
name: monitor-tagma-diagnostics
description: Continuously monitor Tagma's opt-in read-only diagnose/coding-agent diagnostics API, distinguish objective product defects and broadly effective optimization opportunities from sample-specific, authoring, or environmental noise, and maintain an evidence-backed finding ledger until the developer explicitly stops monitoring. Use when a developer enables Tagma diagnostics, invokes diagnose, pastes a diagnostics handoff, asks the agent to observe a live editor/debugging session over time, collect reproducible Tagma-owned problems or cross-scenario improvements, or guard a diagnosed change with tests and durable documentation.
---

# Monitor Tagma Diagnostics

Continuously observe a live Tagma diagnostics session. Maintain two equally important,
evidence-backed finding lanes:

- **product defects**: Tagma-owned expected-versus-actual contract violations;
- **optimization opportunities**: measurable, mechanism-level improvements that remain beneficial
  across a representative range of product scenarios without material regressions.

A developer-provided example is a probe, not the product specification or an adequate benchmark
suite. Do not treat every error as a Tagma bug, and never promote a change that merely makes the
observed fixture look better.

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
  diagnostics handoff authorizes observation, not defect repair or optimization implementation.

## Keep monitoring and finding lifecycles independent

Keep the monitor state separate from every finding's kind and state.

Monitor states:

`starting -> active -> paused -> active -> stopping -> stopped`

- Enter `paused` when the token is revoked, Tagma closes, the endpoint is unreachable, or required
  evidence is temporarily unavailable. Preserve the cursor and ledger, explain what is needed to
  resume, and do not silently call the investigation finished.
- Enter `stopping` only after an explicit developer stop request. Perform the final drain and
  summary before entering `stopped`.

Classify each finding before promotion. Do not relabel weak defect evidence as an optimization or
vice versa.

Product-defect states:

`observation -> candidate -> confirmed -> repair-authorized -> fixed -> guarded -> verified`

Optimization-opportunity states:

`observation -> candidate -> validated -> change-authorized -> implemented -> guarded -> verified`

A finding may instead become `rejected` with the exclusion reason recorded. Changing or rejecting
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

## Apply an anti-overfitting evidence standard

Apply these rules to both finding lanes:

- Treat supplied examples, prompts, workflows, paths, and timing as discovery seeds only. Infer the
  smallest causal mechanism or product invariant; never encode their literal values as the rule.
- State the claimed population and scope before promotion: which task types, workflow shapes,
  states, sizes, platforms, or operating conditions should exhibit the behavior, and which are out
  of scope. Generality means validity across that declared class, not an unsupported claim about
  every possible workflow.
- Build a representative scenario matrix from causally relevant dimensions. Depending on the
  finding, vary workflow shape and size, task type, valid and invalid input, success/failure/cancel
  paths, cold and warm state, concurrency, platform/path form, and external-output shape. Do not
  inflate the count with cosmetic variants of the same fixture.
- Include structurally different members of the claimed class and nearby counterexamples or
  non-benefiting cases. Replaying one unchanged example proves repeatability, not generality.
- Actively seek falsifying evidence and regressions. Check correctness, reliability, usability,
  latency distribution, resource use, accessibility, compatibility, and recovery where relevant;
  never optimize one visible metric by silently worsening another.
- Keep claims no broader than the evidence. A single-example signal remains an `observation` or
  `candidate`, explicitly labelled sample-specific, until cross-scenario evidence exists.

The monitor is read-only: gather naturally occurring variants or ask the developer to exercise a
safe product-level scenario matrix. Never mutate the product merely to manufacture evidence. If
representative coverage is unavailable, record the gap instead of guessing.

## Qualify objective product defects

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
- the smallest known triggering condition, claimed affected class, and relevant exclusions, rather
  than a claim phrased around one prompt, filename, workflow, or other fixture value;
- direct diagnostics evidence tied to the relevant time, cursor, run, session, workspace, or state;
- an explicit explanation of why the symptom is not solely authoring, environment, external
  service, diagnostics transport, or observation-window behavior.

Promote a candidate to `confirmed` only when it is stably reproducible and directly supported:

- reproduce the mismatch at least twice from known preconditions, preferably with one fresh
  attempt; exact replay alone is insufficient, so also preserve the mismatch in a structurally
  different member of the claimed class or with a deterministic property, metamorphic, model, or
  boundary test that represents that class;
- show that varying irrelevant surface values does not remove the mismatch, and check a nearby
  counterexample when practical so the affected condition is neither fixture-specific nor
  overbroad;
- capture the causal event sequence, not only the final error text;
- correlate independent evidence surfaces when available, such as context plus cursor logs or live
  diagnostics plus a regression test;
- narrow the likely Tagma component and falsify reasonable competing explanations.

Generality is not frequency: a real product defect may affect only a narrow boundary condition, but
it must still violate an objective Tagma-owned invariant for a defined class of cases. Do not repeat
destructive, costly, privacy-sensitive, or externally consequential actions merely to satisfy the
variation rule. Leave the item as a candidate and state the missing evidence. Never invent a
reproduction, expected behavior, or missing event.

## Qualify broadly effective optimization opportunities

Look for optimization opportunities even when Tagma is behaving according to contract. Eligible
signals include avoidable repeated actions or retries, measurable latency or resource waste,
unstable throughput, preventable user error, unclear state or recovery feedback, and recurring
friction at a Tagma-owned boundary. Personal taste, a speculative rewrite, or an isolated faster
run is not an optimization finding.

Promote an observation to an optimization `candidate` only when all of these are present:

- a concrete current behavior and desired outcome at a Tagma-owned boundary;
- an objective baseline and metric or observable proxy, such as latency distribution, resource
  use, action count, retry/failure rate, successful recovery, or task-completion outcome;
- a plausible mechanism that does not depend on the literal content of the observed example;
- a declared beneficiary population, applicability scope, exclusions, and no-regression
  constraints;
- direct diagnostics evidence tied to relevant times, cursors, runs, sessions, workspaces, or
  states, with alternative explanations recorded.

Promote a candidate to `validated` only when all of these hold:

- the improvement repeats across multiple structurally distinct scenarios in the claimed scope,
  including a fresh case, or is supported by a representative benchmark corpus, property test, or
  equivalent systematic evidence;
- the scenario matrix varies the dimensions implicated by the proposed mechanism and includes a
  normal case, a boundary or stress case, and a negative or non-benefiting case when applicable;
- comparison against the same baseline shows a meaningful improvement, not measurement noise,
  warm-cache luck, shifted work, hidden retries, or diagnostics clipping;
- correctness and relevant no-regression constraints hold throughout the matrix, including cases
  that differ from the developer's original examples;
- reasonable competing explanations and simpler alternatives have been evaluated, and the
  proposed direction addresses the owning mechanism rather than special-casing a symptom.

Any unexplained material regression in a representative in-scope case rejects validation. A known
trade-off may be presented only as an explicitly scoped product decision with evidence and developer
approval; never describe it as broadly effective. If only the original example improves, keep the
finding sample-specific and do not recommend implementation as a qualified optimization.

## Keep an evidence ledger

Maintain one compact record per finding:

```text
ID and title:
Kind: product defect | optimization opportunity
Status:
First seen / last seen:
Affected Tagma version and workspace/run/session scope:
Claimed invariant or mechanism, population, scope, and exclusions:
Expected behavior and authority (defect):
Objective baseline, metric, target, and no-regression constraints (optimization):
Actual behavior:
Minimal preconditions and reproduction steps:
Cross-scenario matrix, counterexamples, results, and stability:
Direct evidence (endpoint, timestamp, cursor/event IDs, relevant sanitized fields):
Truncation/read boundaries:
Product-ownership argument:
Alternatives, falsification attempts, trade-offs, or rejection reason:
Likely component/root cause and confidence:
Impact and affected population:
Change, tests/benchmarks, documentation, and verification:
```

Redact secrets and minimize user-authored prompts, paths, messages, and tool output. Reference the
smallest sufficient evidence rather than copying entire payloads. Merge duplicate symptoms when
they share one causal chain; split symptoms that require different causes or fixes.

## Change only after authorization and qualification

Proceed only when the developer explicitly authorizes repair of a `confirmed` defect or
implementation of a `validated` optimization:

1. Keep monitoring active unless the developer separately asks to stop.
2. Locate the owning cause or mechanism before editing. Do not silence logs, weaken validation,
   move work outside the measured window, or special-case observed prompts, paths, task names,
   fixture shapes, or literal values.
3. Add the smallest meaningful failing regression test for a defect, or a pre-change
   benchmark/acceptance suite with an explicit target and no-regression constraints for an
   optimization. Demonstrate the mismatch or unmet target before changing implementation.
4. Fix or optimize the owning layer while preserving public APIs, persisted YAML, plugin contracts,
   diagnostics isolation, and desktop/update contracts. Prefer a rule that applies to the declared
   class over branches that recognize known examples.
5. Add multiple durable guardrails where applicable:
   - encode the invariant in types, schemas, validation, or runtime assertions;
   - retain the original case and add structurally distinct, negative, boundary, stress, recovery,
     or integration cases derived from the scenario matrix;
   - use property, metamorphic, corpus, or distribution-aware performance checks when they better
     protect mechanism-level generality;
   - document user-visible behavior, optimization scope, or protocol contracts in the relevant
     README;
   - add a concise invariant to the nearest `AGENTS.md` when future agents could plausibly undo or
     misinterpret the change.
6. Run the narrow regression or benchmark suite, relevant workspace checks, and broader
   verification in proportion to the affected boundary. Compare every representative scenario
   against its baseline and investigate every material regression.
7. Re-run both the original live scenario and the cross-scenario matrix while diagnostics remain
   active. Mark `guarded` only when code, tests/benchmarks, and documentation enforce the result;
   mark `verified` only when automated verification and live cross-scenario evidence agree.
8. Continue watching for recurrence, optimization regressions, and new findings in both lanes.

Follow the repository's `tagma-dev` workflow and completion gate for any change. If a defect lacks
stable, class-level reproduction or an optimization lacks broad evidence within its declared scope,
report the gap and continue monitoring; do not implement a fixture-specific patch as a qualified
product improvement.

## Stop cleanly

After an explicit stop request:

1. Poll once from the last cursor and take one final context snapshot if the diagnostics session is
   still available.
2. Freeze the ledger and summarize product defects and optimization opportunities separately,
   including confirmed or validated, candidate, rejected, fixed or implemented, guarded, and
   verified findings. State every unresolved evidence and generality gap.
3. Forget the bearer token and do not retain raw diagnostics. The developer controls disabling the
   Tagma diagnostics session; do not use a non-read-only endpoint to do it.
4. Clearly report that both monitoring and new issue collection have stopped.
