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
- `HooksConfig` -- lifecycle hook commands

### Plugin Interfaces

- `DriverPlugin` -- translates a task into a spawn spec (`buildCommand`, `parseResult`). `parseResult` receives `stdout` and an optional `stderr` parameter
- `TriggerPlugin` -- watches for an event before a task starts (`watch`)
- `CompletionPlugin` -- validates task output (`check`)
- `MiddlewarePlugin` -- enriches prompts before execution (`enhance`)

### Runtime Types

- `TaskResult` -- exit code, stdout, stderr, output path, session ID
- `TaskState` -- mutable engine state for a running task
- `SpawnSpec` -- args, stdin, cwd, env returned by a driver
- `DriverCapabilities` -- declares session resume, system prompt, output format support
- `ApprovalGateway` / `ApprovalRequest` / `ApprovalDecision` -- approval flow types

## License

MIT
