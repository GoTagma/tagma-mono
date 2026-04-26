# SDK Public API

Date: 2026-04-26

`@tagma/sdk` exposes a narrow root API for normal Bun-based pipeline hosts. Advanced helpers live on explicit subpaths so internal engine modules can evolve without becoming public contracts.

## Root: `@tagma/sdk`

Use the root package for stable host APIs:

- `createTagma(options?)`
- `bunRuntime()`
- `definePipeline(pipeline)`
- `PluginRegistry`
- stable config/result/event/plugin/runtime types
- `TriggerBlockedError` and `TriggerTimeoutError`

```ts
import { createTagma, bunRuntime } from '@tagma/sdk';

const tagma = createTagma({
  runtime: bunRuntime(),
  plugins: [],
});

const result = await tagma.run(pipeline, {
  cwd: process.cwd(),
  onEvent(event) {
    console.log(event.type);
  },
});
```

## Explicit Subpaths

- `@tagma/sdk/yaml`: YAML parsing, serialization, validation, and compile diagnostics.
- `@tagma/sdk/config`: immutable editor/config helpers.
- `@tagma/sdk/plugins`: plugin registry, built-in registration, and manifest helpers.
- `@tagma/sdk/ports`: dataflow helpers for bindings and internal prompt inference.
- `@tagma/sdk/runner`: higher-level multi-run `PipelineRunner`.
- `@tagma/sdk/approval`: in-memory approval gateway.
- `@tagma/sdk/runtime/adapters/stdin-approval`: stdin approval adapter.
- `@tagma/sdk/runtime/adapters/websocket-approval`: Bun WebSocket approval adapter.
- `@tagma/sdk/adapters/*`: compatibility re-exports for old adapter paths.

## Package Boundary Direction

Phase 6 split the orchestration and Bun runtime into publishable packages. The dependency direction is:

```txt
@tagma/types
  <- @tagma/core
      <- @tagma/runtime-bun

@tagma/core + @tagma/runtime-bun
  <- @tagma/sdk
```

`@tagma/core` exports `runPipeline`, `PluginRegistry`, approval/logging primitives, stable event/result/runtime types, and shared dataflow helpers. `@tagma/runtime-bun` exports `bunRuntime()`, process execution helpers, file watching/log storage, and Bun approval adapters. `@tagma/sdk` composes those packages with built-in plugins and keeps existing explicit subpaths as compatibility re-exports.

Avoid adding imports from runtime-specific code back into core scheduling, dataflow, or registry modules.

## Versioning Strategy

Publish order is `@tagma/types` -> `@tagma/core` -> `@tagma/runtime-bun` -> plugin packages -> `@tagma/sdk`. Runtime packages may evolve independently, but `@tagma/sdk` pins compatible workspace versions during repository development and should bump whenever it changes the composed public API.
