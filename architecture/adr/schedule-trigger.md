# Schedule (Cron) Trigger

Status: Approved

This ADR records the built-in `schedule` trigger: a task-level gate that waits for the next host-local time matching a 5-field cron expression, closing the scheduling capability gap surfaced by the Scenario 3 (`site_monitor.yaml`) live test set.

## Context

The trigger extension point existed end to end — `TriggerConfig` on the task, the `TriggerPlugin.watch()` contract, `TriggerBlockedError`/`TriggerTimeoutError` classification, and waiting-state observability — but no schedule/cron implementation shipped: `@tagma/core` has no built-ins, the SDK built-ins were `manual`/`file`/`directory`, and the only first-party trigger plugin is the network-oriented `@tagma/trigger-webhook`. The seeded authoring contract (`opencode-seed.ts`) therefore told chat agents to declare the capability missing rather than fabricate a schema.

Two structural facts shaped the design:

- Tagma triggers are **run-scoped gates, not run launchers**: `watch()` runs only inside an active run. Nothing in the product starts a run on a wall-clock schedule.
- The task `timeout` budget covers the trigger wait phase, and editor defaults (120-minute task / 8-hour pipeline) are far shorter than a weekend-spanning cron wait. Explicit YAML `timeout` values remain authoritative and support the `d` unit up to the ~24.8-day timer cap.

## Decision

Ship `schedule` as a **built-in** trigger in `@tagma/sdk` (registered by `bootstrapBuiltins()`), not as a plugin package:

1. A time primitive is the same class of capability as `manual`/`file`/`directory`; the webhook precedent covers integration surfaces (network listeners, secrets), which a clock is not.
2. Built-in registration closes the gap for fresh desktop/editor installs with no plugin-install step, and chat agents see the type in the registry allow-list immediately.
3. The cron parser is hand-rolled, pure, and dependency-free (`packages/sdk/src/cron.ts`), preserving the SDK's dependency footprint and lockfile governance.

### YAML contract

```yaml
trigger:
  type: schedule
  cron: "0 8 * * 1-5"   # required; host local time
  timeout: "4d"         # optional; omit or 0 = wait indefinitely
```

The cron dialect is deliberately bounded: exactly five fields (minute, hour, day-of-month, month, day-of-week); `*`, lists, ranges, and steps; case-insensitive `JAN`-`DEC` / `SUN`-`SAT` names; `0` and `7` both Sunday; Vixie OR semantics when day-of-month and day-of-week are both restricted. No seconds, macros, `L`/`W`/`#`/`?` extensions, or timezone field. An expression with no fire time within a 5-year horizon (e.g. February 31st) is a configuration error, rejected at watch time and flagged as an edit-time validation warning (`validate-raw` keeps the cron check next to the built-in type registry; the generic `PluginSchema` shape cannot express cron syntax).

### Wait semantics

- `watch()` computes the next fire strictly through `TriggerContext.runtime` (`now()` / `sleep()`), never the process clock directly. Waits longer than one timer maximum (~24.8 days) are chained across capped sleep segments and recomputed after each wake, which also absorbs host clock drift.
- The gate fires at most once per run. Recurring execution composes with workflow `lifecycle.max_runs` (each attempt waits for the next tick); `repair` stays disallowed on infinite/repeat modes per the self-repair invariants.
- Manual Run is unchanged: the run starts immediately and the gated task waits in the observable `waiting` state (`waitReason = { kind: 'trigger', triggerType: 'schedule' }`; the wire shape intentionally never carries the cron expression or next-fire time). A waiting run is in-memory and does not survive an editor restart; ticks missed while no run is active are not replayed.
- Editor-facing guidance pairs the trigger with an explicit task `timeout` (and pipeline `timeout`) sized beyond the longest cron gap, because the wait counts against the task budget and host defaults would end a multi-day wait early. `validate-raw` warns when a schedule-gated task has no explicit timeout.

### Sandbox Trial virtualization

The trigger declares Trial Interaction Protocol v1 as `interaction: 'external-event'`, `unattended: 'virtualized'`, `runtime: 'bounded'`, no filesystem/network/secrets needs. The Trial host wraps the case runtime in `runtimeWithVirtualTime` (`apps/editor/server/chat-pipeline-trial-virtual-time.ts`): `now()` reads a virtual clock and `sleep(ms)` advances it on the next macrotask while remaining abortable. Because the engine's own task/pipeline deadlines never read `runtime.now()/sleep()`, virtualization fast-forwards only the trigger gate, keeping every real execution budget intact. Execution coverage records the satisfaction as `{ type: 'schedule', mechanism: 'virtualized-clock' }`, and the signed Trial cache protocol bumped to v34 with the new evidence shape.

### Rejected alternatives

- **`@tagma/trigger-schedule` plugin package**: keeps the core smaller, but requires a manual install, so fresh installs and the live test set would still face the capability gap; adds ~8 release/build/marketplace registration surfaces.
- **Approve-to-fire-early via `ApprovalGateway`**: races an approval against the cron tick so a manual Run could execute immediately. Rejected for v1 as approval-semantic abuse (a card pending for days); remains a viable v1.1 candidate.
- **Resident run launcher (editor-side scheduler that starts runs at cron times)**: the true "automatic run start" feature, but it is a much larger lifecycle/persistence surface (run ownership across restarts, missed-fire policy, overlap policy) and is not required by the test set's trigger clause.
- **Carrying next-fire time in `TaskWaitReason`**: violates the waiting-state wire-shape invariant (only qualified task ids or the trigger type may cross the wire). The run panel renders the cron expression from task config client-side instead.

## Consequences

- Fresh editors and SDK consumers get `schedule` with no install; the seeded authoring contract now teaches the built-in instead of declaring a gap (`tagma-yaml-contract` §7, `tagma-trigger-strategy` rule 7), and the `tagma_yaml_skeleton` tool round-trips `cron` with fail-closed guards (`cron` requires type `schedule`).
- The editor client needs no hand-written form: the generic schema-driven trigger form renders `cron`/`timeout` from the server registry, following the `directory` precedent.
- Timeout pairing is a documented authoring obligation, not an engine behavior change: the engine keeps a single "task timeout covers the trigger wait" rule.
- DST policy is documented: nonexistent local wall times (spring-forward gaps) are skipped; ambiguous fall-back times fire on the first occurrence.
