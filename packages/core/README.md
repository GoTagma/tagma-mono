# @tagma/core

Runtime-independent orchestration core for Tagma pipelines.

This package owns pipeline DAG execution, plugin registries, approval gateways, lifecycle events, logging abstractions, dataflow helpers, prompt document helpers, and the `TagmaRuntime` interface. It does not provide a concrete process runner or file watcher; hosts must pass a runtime implementation to `runPipeline()`.

```ts
import { PluginRegistry, runPipeline } from '@tagma/core';
import { bunRuntime } from '@tagma/runtime-bun';

const registry = new PluginRegistry();
const result = await runPipeline(config, process.cwd(), {
  registry,
  runtime: bunRuntime(),
});
```

Use `@tagma/sdk` for the Bun-first convenience API with built-ins registered by default.

## Publishing

`@tagma/core` is a public npm dependency of `@tagma/runtime-bun` and `@tagma/sdk`. Publish it after `@tagma/types` and before runtime or SDK packages.
