# SDK Public API

Date: 2026-04-26

`@tagma/sdk` exposes a narrow root API for normal pipeline hosts. Advanced helpers live on explicit subpaths so internal engine modules can evolve without becoming public contracts.

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

The current SDK remains Bun-first, but its runtime dependency is explicit through `TagmaRuntime`. If the package split becomes valuable, the intended dependency direction is:

```txt
@tagma/types
  <- @tagma/core
  <- @tagma/runtime-bun
  <- @tagma/sdk
```

Avoid adding imports from runtime-specific code back into core scheduling, dataflow, or registry modules.
