# @tagma/types

Shared TypeScript type definitions for the [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk) ecosystem. This package contains **types only** -- no runtime code.

## Install

```bash
bun add @tagma/types
```

You typically don't need to install this directly -- `@tagma/sdk` re-exports everything from this package. Install it only when building a standalone plugin that needs type definitions without depending on the full SDK.

## Usage

```ts
import type {
  PipelineConfig,
  TrackConfig,
  TaskConfig,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
  SpawnSpec,
  TaskResult,
  Permissions,
} from '@tagma/types';
```

## Key Types

### Pipeline Configuration

- `PipelineConfig` / `RawPipelineConfig` -- top-level pipeline definition
- `TrackConfig` / `RawTrackConfig` -- parallel execution track
- `TaskConfig` / `RawTaskConfig` -- individual task (AI prompt or shell command)
- `HooksConfig` / `HookCommand` -- lifecycle hook commands
- `OnFailure` -- track failure strategy: `'ignore' | 'skip_downstream' | 'stop_all'`
- `Permissions` -- `{ read, write, execute }` capability flags

### Plugin Interfaces

- `DriverPlugin` -- translates a task into a spawn spec (`buildCommand`, optional `parseResult` / `resolveModel` / `resolveTools`). `parseResult` receives `stdout` and an optional `stderr` parameter
- `TriggerPlugin` -- watches for an event before a task starts (`watch`)
- `CompletionPlugin` -- validates task output (`check`)
- `MiddlewarePlugin` -- enriches prompts before execution. Exposes `enhanceDoc(doc, config, ctx)` (preferred — operates on a structured `PromptDocument`) and/or the legacy `enhance(prompt, config, ctx)` (deprecated — kept for v0.x plugins). When both are defined the engine calls `enhanceDoc`
- `PluginManifest` -- shape of the `tagmaPlugin` field a plugin package declares in its `package.json` (`{ category, type }`). Hosts use this for auto-discovery without importing the module
- `PluginSchema` / `PluginParamDef` / `PluginParamType` -- optional declarative form metadata so visual editors can render typed config forms for a plugin
- `PluginCategory` -- `'drivers' | 'triggers' | 'completions' | 'middlewares'`
- `PluginModule` -- runtime plugin entry shape (`pluginCategory`, `pluginType`, `default`)

### Prompt Types

- `PromptDocument` -- structured prompt handed to middlewares and drivers: `{ contexts: PromptContextBlock[]; task: string }`. Middlewares append labeled blocks to `contexts` and must not rewrite `task`
- `PromptContextBlock` -- `{ label, content }` section rendered as `[<label>]\n<content>` by the serializer

### Runtime Types

- `TaskStatus` -- `'idle' | 'waiting' | 'running' | 'success' | 'failed' | 'timeout' | 'skipped' | 'blocked'`
- `TaskResult` -- exit code, stdout/stderr, duration, session ID, normalized output, failure kind
- `TaskFailureKind` -- distinguishes _why_ a task didn't return exit 0: `'timeout' | 'spawn_error' | 'exit_nonzero' | null`
- `TaskState` -- mutable engine state for a running task (config, status, result, timestamps)
- `SpawnSpec` -- args, stdin, cwd, env returned by a driver
- `DriverCapabilities` -- declares session resume, system prompt, output format support
- `DriverContext` / `DriverResultMeta` -- inputs and result metadata exchanged between driver and engine. `DriverContext.promptDoc` exposes the structured post-middleware prompt; `DriverResultMeta.forceFailure` lets a driver mark a task failed even when the CLI exited 0 (e.g. an error-JSON payload)
- `ApprovalGateway` / `ApprovalRequest` / `ApprovalDecision` / `ApprovalEvent` / `ApprovalListener` / `ApprovalOutcome` / `ApprovalRequestInfo` -- approval flow types (`ApprovalRequestInfo` is the wire alias for `ApprovalRequest`)
- `TriggerContext` / `CompletionContext` / `MiddlewareContext` -- contexts passed to plugin methods
- `OnFailure`, `HooksConfig`, `HookCommand` -- failure strategy and lifecycle hook types

### Wire Protocol Types

The SDK engine, the editor server, and the editor client speak a single event vocabulary for a pipeline run. These types live here so every layer stays in sync.

- `RunEventPayload` -- discriminated union emitted by `runPipeline`'s `onEvent` callback. Variants: `run_start`, `task_update`, `task_log`, `run_end`, `run_error`, `approval_request`, `approval_resolved`. Every variant carries `runId`
- `RunTaskState` -- wire-shape projection of an engine `TaskState` (flat fields, `logs` capped at `TASK_LOG_CAP`)
- `RunSnapshotPayload` -- server-only payload the editor server emits on SSE (re)connect to rebuild the task map, pending approvals, and pipeline-level logs
- `WireRunEvent` -- `(RunEventPayload | RunSnapshotPayload) & { seq: number }` — the stamped on-the-wire event. Clients dedupe by `(runId, seq)`
- `AbortReason` -- `'timeout' | 'stop_all' | 'external'`; carried on `run_end`
- `TaskLogLine` / `TaskLogLevel` -- structured log line + level (`'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet'`)
- `RUN_PROTOCOL_VERSION` -- protocol version constant for the SSE stream; the editor server echoes this in the `X-Tagma-Run-Protocol` header and the client refuses mismatched streams
- `TASK_LOG_CAP` -- max log lines retained per task in the snapshot buffer and the client reducer; must agree across SDK / server / client

## License

MIT
