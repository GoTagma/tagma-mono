# Tagma SDK Redesign Plan

> Date: 2026-04-26
>
> Goal: make `@tagma/sdk` lightweight, stable, and highly extensible without losing the current pipeline runner capabilities.

## 1. Target Direction

The SDK should become a small orchestration core with explicit extension points. The current implementation works, but too many responsibilities are bundled behind one public package entry:

- Pipeline execution
- YAML parsing and serialization
- DAG building
- Config editing helpers
- Plugin loading and global registry
- Approval adapters
- Logging
- Prompt document utilities
- Port and binding resolution
- Bun process execution
- Editor-oriented event payloads

The redesign should move toward this shape:

```ts
import { createTagma, bunRuntime } from '@tagma/sdk';

const tagma = createTagma({
  runtime: bunRuntime(),
  // Built-in plugins, including the opencode driver, are registered by default.
});

const result = await tagma.run(pipeline, {
  cwd: process.cwd(),
  signal,
  onEvent(event) {
    // stable event protocol
  },
});
```

The important design rule: `@tagma/sdk` should expose a small, stable host API. Everything else should either be an explicit subpath, an internal module, or a separate package.

## 2. Design Principles

### Small Core

The core should only know how to:

- Validate a normalized pipeline shape.
- Build and schedule a task graph.
- Resolve task dependencies.
- Call registered capabilities.
- Emit stable lifecycle events.
- Return a stable run result.

The core should not directly own Bun APIs, editor CRUD helpers, WebSocket adapters, stdin approval, plugin package resolution, or YAML authoring concerns.

### Explicit Composition

No hidden process-global runtime should be required for ordinary usage. Prefer:

```ts
const tagma = createTagma({ runtime, plugins });
```

Global helpers should not be the primary API. If a helper is still needed, expose it through a named subpath that describes the boundary.

### Stable Public Surface

The root export should be narrow. A user importing from `@tagma/sdk` should see only the durable API:

- `createTagma`
- `definePipeline`
- `TagmaPlugin`
- `TagmaRuntime`
- stable config/result/event types
- stable error classes

Internal helpers such as `buildDag`, `resolveTaskRef`, `tailLines`, `_resetShellCache`, low-level port extraction, and raw config CRUD should not be root exports.

### Capability-Based Extensions

Plugin categories should not be hard-coded forever as only `drivers`, `triggers`, `completions`, and `middlewares`. Use a capability model:

```ts
export interface TagmaPlugin {
  readonly name: string;
  readonly capabilities: {
    readonly driver?: DriverCapability;
    readonly trigger?: TriggerCapability;
    readonly completion?: CompletionCapability;
    readonly middleware?: MiddlewareCapability;
    readonly policy?: PolicyCapability;
    readonly storage?: StorageCapability;
    readonly telemetry?: TelemetryCapability;
  };
}
```

This allows future features without changing the registry shape every time.

### Single Dataflow Model

The current split between `task.inputs` / `task.outputs` and `task.ports` creates unnecessary mental overhead. The redesign should converge on one model:

```yaml
inputs:
  city:
    from: fetch.outputs.city
    type: string
    required: true

outputs:
  report:
    from: json.report
    type: string
```

`type` should be optional. If present, it validates and documents the binding. If absent, the binding stays lightweight. This gives one concept with optional strictness.

## 3. Current Problems To Fix

### 3.1 Root Export Is Too Wide

Current file: `packages/sdk/src/sdk.ts`

The root entry exports engine internals, config operations, DAG builders, registry internals, approval adapters, logger helpers, task reference utilities, prompt document helpers, ports helpers, and all types.

Problems:

- Internal decisions become de facto public contracts.
- Refactoring becomes risky because downstream users may depend on implementation details.
- The package feels heavier than it needs to be.

Target:

- Keep root API small.
- Move advanced helpers to explicit subpaths.
Targeted helper APIs should move to explicit subpaths instead of staying on the root export.

Suggested export layout:

```json
{
  ".": "./dist/index.js",
  "./config": "./dist/config.js",
  "./yaml": "./dist/yaml.js",
  "./plugins": "./dist/plugins.js",
  "./ports": "./dist/ports.js",
  "./testing": "./dist/testing/index.js"
}
```

### 3.2 Engine Owns Too Many Responsibilities

Current file: `packages/sdk/src/engine.ts`

`runPipeline` currently owns scheduling, trigger waiting, hooks, approval event bridging, prompt middleware, port inference, binding resolution, process execution, result parsing, output extraction, logging, event emission, failure policy, and cleanup.

Problems:

- Small changes carry large regression risk.
- Extension points are hard to add cleanly.
- Testing specific behavior requires large integration tests.

Target decomposition:

- `scheduler.ts`: task readiness, dependency satisfaction, failure propagation.
- `task-executor.ts`: execute one task through trigger, hook, dataflow, driver/command, completion.
- `lifecycle.ts`: events, hook invocation, status transitions.
- `dataflow.ts`: input resolution, output extraction, placeholder substitution.
- `runtime.ts`: process spawning, file watching, time, filesystem, log storage.
- `engine.ts`: thin orchestration wrapper.

### 3.3 Runtime Is Coupled To Bun

Current files:

- `packages/sdk/src/runner.ts`
- `packages/sdk/src/triggers/file.ts`
- `packages/sdk/src/adapters/websocket-approval.ts`
- `packages/sdk/package.json`

The SDK is Bun-only. That may be acceptable for product direction, but the orchestration core does not need to know Bun-specific process and server details.

Target:

- `@tagma/core`: pure orchestration, no Bun APIs.
- `@tagma/runtime-bun`: process spawn, filesystem, file watch, WebSocket/server utilities.
- `@tagma/sdk`: convenience package that composes core + Bun runtime for existing users.

This improves stability because the core can be tested without runtime-specific behavior.

### 3.4 Plugin Registry Uses Fixed Categories And Global State

Current file: `packages/sdk/src/registry.ts`

The registry is now instance-scoped, but the current category model is still fixed to drivers, triggers, completions, and middlewares.

Problems:

- Multi-workspace isolation depends on callers remembering to pass a registry.
- Global mutable state complicates tests.
- Fixed categories make future extension harder.

Target:

- Make instance-scoped registries the normal path.
- Do not keep a compatibility barrel. Registry operations stay on explicit `PluginRegistry` instances.
- Register plugins by capability, not by category string.

### 3.5 Dataflow Has Too Many Concepts

Current files:

- `packages/types/src/index.ts`
- `packages/sdk/src/ports.ts`
- `packages/sdk/src/validate-raw.ts`
- `packages/sdk/src/engine.ts`

There are now two related systems:

- Lightweight `inputs` / `outputs`
- Strict `ports.inputs` / `ports.outputs`

Prompt tasks also have special inference rules. This is powerful, but not lightweight.

Target:

- Replace `ports` with typed `inputs` and `outputs`.
- Let `type` make a binding strict.
- Avoid prompt-task-only rules where possible.
- Keep inference as an editor convenience, not a runtime contract.

### 3.6 Editor Concerns Leak Into SDK Core

Current examples:

- Config CRUD in `config-ops.ts`
- raw validation for visual editor feedback in `validate-raw.ts`
- event fields tailored for UI snapshots
- WebSocket approval adapter

These are useful, but they make the SDK feel like the editor backend instead of a clean orchestration package.

Target:

- Move editor-specific helpers to `@tagma/editor-sdk` or `@tagma/sdk/config`.
- Keep the core event protocol stable and minimal.
- Let editor adapters enrich events outside the engine.

## 4. Target Package Structure

Recommended final package structure:

```txt
packages/
  core/
    src/
      index.ts
      engine/
        engine.ts
        scheduler.ts
        task-executor.ts
        lifecycle.ts
        dataflow.ts
      plugins/
        plugin.ts
        registry.ts
      types/
        pipeline.ts
        events.ts
        result.ts
        errors.ts

  runtime-bun/
    src/
      index.ts
      process-runner.ts
      file-watcher.ts
      log-store.ts
      approval-adapters/

  sdk/
    src/
      index.ts
      yaml.ts
      config.ts
      plugins.ts
      testing/

  types/
    src/
      index.ts
```

If splitting packages is too disruptive initially, use this intermediate structure inside `packages/sdk/src`:

```txt
src/
  index.ts
  core/
    engine.ts
    scheduler.ts
    task-executor.ts
    lifecycle.ts
    dataflow.ts
  runtime/
    bun-process-runner.ts
    file-watcher.ts
    log-store.ts
  plugins/
    registry.ts
    capability.ts
  config/
    schema.ts
    yaml.ts
    operations.ts
```

Start with the internal split. Create separate packages only after the boundaries are proven.

## 5. Proposed Public API

### Root API

```ts
export function createTagma(options: CreateTagmaOptions): Tagma;
export function definePipeline(pipeline: PipelineInput): PipelineInput;

export interface Tagma {
  run(pipeline: PipelineInput, options: RunOptions): Promise<RunResult>;
  validate(pipeline: PipelineInput): ValidationResult;
}

export interface CreateTagmaOptions {
  runtime: TagmaRuntime;
  plugins?: readonly TagmaPlugin[];
  logger?: LoggerCapability;
}
```

### Runtime API

```ts
export interface TagmaRuntime {
  spawn(spec: SpawnSpec, options: SpawnOptions): Promise<ProcessResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  watch?(pattern: string, options: WatchOptions): AsyncIterable<WatchEvent>;
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

### Plugin API

```ts
export interface TagmaPlugin {
  readonly name: string;
  setup?(ctx: PluginSetupContext): void | Promise<void>;
  readonly capabilities?: PluginCapabilities;
}

export interface PluginCapabilities {
  readonly drivers?: Readonly<Record<string, DriverCapability>>;
  readonly triggers?: Readonly<Record<string, TriggerCapability>>;
  readonly completions?: Readonly<Record<string, CompletionCapability>>;
  readonly middlewares?: Readonly<Record<string, MiddlewareCapability>>;
  readonly policies?: Readonly<Record<string, PolicyCapability>>;
}
```

Use plural maps so a plugin package can provide multiple related capabilities.

## 6. Migration Strategy

The redesign should be incremental. Avoid a big-bang rewrite.

### Phase 0: API Audit And Root Contract

Goal: decide what is stable, deprecated, and internal.

Tasks:

- [x] Create `packages/sdk/src/index.ts` as the new intended root.
- [x] Remove the old wide `sdk.ts` root barrel.
- [x] Move non-root helpers to explicit subpaths.
- [x] Document the instance API in `packages/sdk/README.md`.

Acceptance criteria:

- [x] Package root resolves to the new narrow API.
- [x] New imports are documented.
- [x] Users can see which APIs live behind explicit subpaths.

### Phase 1: Introduce Tagma Instance API

Goal: make explicit composition the primary path.

Add:

- [x] `createTagma(options)`
- [x] `Tagma.run(...)`
- [x] `Tagma.validate(...)`
- [x] instance-scoped plugin registry

Remove:

- [x] root-level `runPipeline` as a public API. Internal execution can keep a direct engine function, but public usage goes through `createTagma().run(...)`.

Acceptance criteria:

- [x] All current tests pass.
- [x] New tests prove two `Tagma` instances do not share plugin state.

### Phase 2: Split Engine Internals

Goal: reduce `engine.ts` from a large procedure to a small coordinator.

Create internal modules:

- `core/scheduler.ts`
- `core/task-executor.ts`
- `core/lifecycle.ts`
- `core/dataflow.ts`
- `core/run-state.ts`

Move behavior without changing public API.

Suggested ownership:

- `scheduler.ts`: dependency readiness, terminal status rules, `on_failure`.
- `task-executor.ts`: execute one task.
- `lifecycle.ts`: status updates, event emission, hook boundaries.
- `dataflow.ts`: inputs, outputs, placeholder substitution.
- `run-state.ts`: state maps, summaries, snapshots.

Acceptance criteria:

- `engine.ts` becomes mostly orchestration.
- Unit tests cover scheduler and dataflow without spawning processes.
- Existing engine integration tests continue passing.

**Phase 2a status (pure helpers extracted, 2026-04-26):**

- [x] `core/run-state.ts` — `isTerminal`, `freezeStates`, `summarizeStates`, `toRunTaskState` (commit 678b457)
- [x] `core/preflight.ts` — registry validation (commit 39ad5a4)
- [x] `core/log-prune.ts` — per-run log directory cleanup (commit d4732c5)
- [x] `core/run-context.ts` — state container (Phase 2b)
- [x] `core/scheduler.ts` — dependency readiness, event loop launch checks, abort cleanup (Phase 2c)
- [x] `core/dataflow.ts` — prompt port inference and successful output extraction (Phase 2c)
- [x] `core/task-executor.ts` — single-task execution (Phase 2d)
- [x] `core/trigger-errors.ts` — trigger error classes separated from engine/task-executor
- [x] `engine.ts` thinned to orchestrator (Phase 2d)

`engine.ts` line count: 1622 → 452 (1170 lines removed). Full SDK suite 228/228 green.

### Phase 3: Unify Inputs, Outputs, And Ports

Goal: remove the split mental model.

Introduce new shape:

```ts
export interface TaskBinding {
  readonly from?: string;
  readonly value?: unknown;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly type?: BindingType;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export type TaskInputs = Readonly<Record<string, TaskBinding>>;
export type TaskOutputs = Readonly<Record<string, TaskBinding>>;
```

Migration:

- Do not keep `ports` as a compatibility layer.
- Validate `ports` as a clear migration error.
- Move typed declarations into `inputs.<name>` and `outputs.<name>`.
- Keep `type` optional so lightweight bindings remain lightweight.
- Keep Prompt-task neighbor inference as an internal convenience over unified bindings.

Acceptance criteria:

- [x] Runtime data flow uses `inputs` and `outputs` as the single task-level model.
- [x] `type` on bindings coerces and validates values; omitted `type` stays pass-through.
- [x] Prompt/command mixed flows infer Prompt inputs/outputs from neighboring unified bindings.
- [x] `ports` produces a migration validation error.
- [x] New tests and examples use no `ports`.

**Phase 3 status (2026-04-26):**

- [x] Added typed fields to unified task input/output bindings.
- [x] Rewired engine execution to resolve command bindings directly from `inputs`.
- [x] Rewired successful output extraction to publish typed `outputs`.
- [x] Kept Prompt neighbor inference internally, now sourced from neighboring `inputs` / `outputs`.
- [x] Replaced old engine/schema/validation port tests with unified binding coverage.
- [x] Full SDK suite green: 198/198.

### Phase 4: Convert Plugins To Capabilities

Goal: make extension surface future-proof.

Add capability plugin support and remove old plugin module exports. This SDK has
not been published, so there is no legacy compatibility requirement.

Old:

```ts
export const pluginCategory = 'drivers';
export const pluginType = 'opencode';
export default DriverPlugin;
```

New:

```ts
export default {
  name: '@tagma/driver-codex',
  capabilities: {
    drivers: {
      codex: CodexDriver,
    },
  },
} satisfies TagmaPlugin;
```

Cutover:

- Registry internally stores capabilities.
- Existing in-repo plugins are updated to the new `TagmaPlugin` shape directly.
- Plugin packages default-export a `TagmaPlugin`; `pluginCategory` and
  `pluginType` runtime exports are removed.

Acceptance criteria:

- [x] In-repo plugins load through the new capability shape.
- [x] New multi-capability plugins load.
- [x] Legacy `pluginCategory` / `pluginType` modules are rejected with a clear
  migration error.
- [x] Registry replacement warnings remain available.

**Phase 4 status (2026-04-26):**

- [x] Added `TagmaPlugin` / `PluginCapabilities` package-level types.
- [x] Added `PluginRegistry.registerTagmaPlugin()` for capability maps.
- [x] Converted built-ins and in-repo plugin packages to default-export `TagmaPlugin`.
- [x] Removed runtime reliance on `pluginCategory` / `pluginType` module exports.
- [x] Updated editor plugin loading metadata to track multiple capability registrations.
- [x] Added `createTagma({ plugins })` so explicit composition can register capability plugins at instance creation.

### Phase 5: Extract Runtime Boundary

Goal: remove Bun-specific logic from core execution.

Create runtime interface and Bun implementation.

Move:

- process execution into the `@tagma/runtime-bun` package.
- file trigger watch implementation behind runtime watch APIs.
- log file writing behind runtime log store.
- WebSocket/stdin adapters out of core.

Acceptance criteria:

- Core tests run without Bun-specific spawn behavior.
- Bun runtime tests cover process execution, timeout, Windows shim handling, and output streaming.
- Public `@tagma/sdk` remains the Bun-first convenience facade over `@tagma/core` and `@tagma/runtime-bun`.

**Phase 5a status (2026-04-26):**

- [x] Added `TagmaRuntime` and `bunRuntime()` as the process execution boundary.
- [x] Added `createTagma({ runtime })` and threaded runtime through `runPipeline`, `RunContext`, and `task-executor`.
- [x] Added fake-runtime coverage proving command tasks can run without real process spawn.

**Phase 5b status (2026-04-26):**

- [x] Moved the Bun process runner implementation into `packages/runtime-bun/src/bun-process-runner.ts`.
- [x] Moved file trigger watching behind `TagmaRuntime.watchPath()`, `fileExists()`, and `ensureDir()`.
- [x] Moved log file creation, task stdout/stderr artifact paths, and log pruning behind `TagmaRuntime.logStore`.
- [x] Moved stdin/WebSocket approval adapter implementations into `packages/runtime-bun/src/adapters/*`; SDK adapter subpaths re-export the runtime package for compatibility.
- [x] Added focused fake-runtime tests for file watching, log store routing, and runtime adapter subpaths.

### Phase 6: Package Split

Goal: publish clean package boundaries once internal boundaries are stable.

Potential packages:

- `@tagma/core`
- `@tagma/runtime-bun`
- `@tagma/sdk`
- `@tagma/config`
- `@tagma/editor-sdk`

Do this only after phases 1-5 are stable. Splitting too early creates package churn without solving architecture.

Acceptance criteria:

- [x] Package exports are documented.
- [x] No circular dependencies.
- [x] Versioning strategy is clear.

**Phase 6a status (2026-04-26):**

- [x] Added `@tagma/core` for runtime-independent orchestration, plugin registry, approval gateway, logging primitives, event/result types, and runtime interfaces.
- [x] Added `@tagma/runtime-bun` for Bun process execution, file watching, log storage, and runtime approval adapters.
- [x] Retargeted `@tagma/sdk` root APIs and compatibility subpaths to compose `@tagma/core` + `@tagma/runtime-bun`.
- [x] Updated workspace build/check/publish ordering so split package dependencies build before `@tagma/sdk`.
- [x] Documented exports and publish order in `docs/sdk-public-api.md`.

## 7. Testing Strategy

### Unit Tests

Add focused tests for:

- Scheduler readiness.
- Failure policy.
- Dataflow resolution.
- Binding type coercion.
- Plugin capability registration.
- Runtime-independent engine behavior.

### Cutover Tests

Keep tests proving:

- root exports only expose the intended public API.
- explicit subpath exports compile.
- current in-repo pipeline examples still run.
- SDK instances do not share registry state.

### Runtime Tests

For Bun runtime:

- spawn success
- spawn non-zero exit
- timeout
- abort signal
- stdout/stderr streaming
- Windows command resolution
- large output truncation

### Snapshot/Event Tests

Events are a public protocol. Add tests for:

- `run_start`
- `task_update`
- `task_log`
- `approval_request`
- `approval_resolved`
- `run_end`
- `run_error`

Events should be stable and versioned if fields change.

## 8. Documentation Changes

Update `packages/sdk/README.md` after phase 1:

- [x] Show `createTagma` as the primary API.
- [x] Show explicit subpath imports for YAML/config/plugin helpers.
- [x] Explain runtime/plugin composition.
- [x] Replace `ports` examples with unified `inputs` / `outputs`.
- [x] Add migration guide.

Add docs:

- [x] `docs/sdk-public-api.md`
- [x] `docs/sdk-plugin-authoring.md`
- [x] `docs/sdk-runtime-authoring.md`
- [x] `docs/sdk-migration-v0-to-v1.md`

## 9. Recommended Execution Order

Do not start with package splitting. It creates churn before the boundaries are proven.

Recommended order:

1. Add narrow API beside existing API.
2. Add instance-based `createTagma`.
3. Split `engine.ts` internally.
4. Unify dataflow model.
5. Add capability plugin model.
6. Add runtime abstraction.
7. Split packages only if still valuable.

This keeps the project shippable at every step.

## 10. Non-Goals

These should not be part of the first redesign pass:

- Rewriting the YAML format from scratch.
- Removing Bun support.
- Replacing all plugins immediately.
- Changing editor UX.
- Adding distributed execution.
- Adding remote workers.
- Building a general workflow engine unrelated to AI task orchestration.

## 11. Success Criteria

The redesign is successful when:

- A new user can understand the primary SDK API in under five minutes.
- A plugin author can add a driver, trigger, completion, or middleware without reading `engine.ts`.
- The core engine can be tested without spawning real processes.
- Multiple SDK instances can run in one process without shared mutable state.
- `engine.ts` is no longer the main place every feature must be edited.
- The root API does not carry old implementation details.
- Root exports are small enough to be treated as a stable contract.

## 12. Key Risks

### Cutover Risk

Consumers importing old root helpers will break. This is intentional for the redesign; in-repo callers must be updated to explicit subpaths in the same change set.

### Scope Risk

The redesign can become a large rewrite. Mitigation: each phase must preserve existing tests and be independently mergeable.

### Abstraction Risk

Runtime abstraction can become too generic. Mitigation: design it around current needs: spawn, file IO, watch, time, logs.

### Plugin Migration Risk

There is no published legacy plugin surface to preserve. Migration risk is
limited to this repository's packages and editor loader. Mitigation: migrate
all in-repo plugin packages and tests in the same Phase 4 change set.

## 13. Phase Status

Audit status on 2026-04-26:

- [x] Phase 0: narrow root entry and explicit subpaths are in place.
- [x] Phase 1: `createTagma()` instance API and instance-scoped registries are in place.
- [x] Phase 2: engine internals are split into focused core modules and `engine.ts` is an orchestrator.
- [x] Phase 3: runtime dataflow uses unified typed `inputs` / `outputs`; `ports` is a validation migration error.
- [x] Phase 4: capability plugin model is implemented as a clean cutover with no legacy module compatibility.
- [x] Phase 5: runtime boundary extraction is complete; process execution, file watching, log storage, and approval adapters are behind runtime boundaries.
- [x] Phase 6: package split is in place with `@tagma/core`, `@tagma/runtime-bun`, and SDK composition boundaries.
