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
- `TemplateConfig` / `TemplateParamDef` -- reusable task template definition

### Plugin Interfaces

- `DriverPlugin` -- translates a task into a spawn spec (`buildCommand`, `parseResult`). `parseResult` receives `stdout` and an optional `stderr` parameter
- `TriggerPlugin` -- watches for an event before a task starts (`watch`)
- `CompletionPlugin` -- validates task output (`check`)
- `MiddlewarePlugin` -- enriches prompts before execution (`enhance`)
- `PluginManifest` -- shape of the `tagmaPlugin` field a plugin package declares in its `package.json` (`{ category, type }`). Hosts use this for auto-discovery without importing the module
- `PluginSchema` / `PluginParamDef` / `PluginParamType` -- optional declarative form metadata so visual editors can render typed config forms for a plugin
- `PluginCategory` -- `'drivers' | 'triggers' | 'completions' | 'middlewares'`
- `PluginModule` -- runtime plugin entry shape (`pluginCategory`, `pluginType`, `default`)

### Runtime Types

- `TaskStatus` -- `'idle' | 'waiting' | 'running' | 'success' | 'failed' | 'timeout' | 'skipped' | 'blocked'`
- `TaskResult` -- exit code, stdout/stderr, output path, duration, session ID, normalized output, failure kind
- `TaskFailureKind` -- distinguishes *why* a task didn't return exit 0: `'timeout' | 'spawn_error' | 'exit_nonzero' | null`
- `TaskState` -- mutable engine state for a running task (config, status, result, timestamps)
- `SpawnSpec` -- args, stdin, cwd, env returned by a driver
- `DriverCapabilities` -- declares session resume, system prompt, output format support
- `DriverContext` / `DriverResultMeta` -- inputs and result metadata exchanged between driver and engine. `DriverResultMeta.forceFailure` lets a driver mark a task failed even when the CLI exited 0 (e.g. an error-JSON payload)
- `ApprovalGateway` / `ApprovalRequest` / `ApprovalDecision` / `ApprovalEvent` / `ApprovalListener` / `ApprovalOutcome` -- approval flow types
- `TriggerContext` / `CompletionContext` / `MiddlewareContext` -- contexts passed to plugin methods

## License

MIT
