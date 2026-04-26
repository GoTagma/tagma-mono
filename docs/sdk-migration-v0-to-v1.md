# SDK Migration v0 to v1

Date: 2026-04-26

This migration tracks the SDK redesign toward a narrow root API, explicit composition, unified bindings, capability plugins, and runtime injection.

## Root Imports

Prefer:

```ts
import { createTagma } from '@tagma/sdk';
import { loadPipeline } from '@tagma/sdk/yaml';
```

Move helper imports to explicit subpaths:

- YAML/config helpers: `@tagma/sdk/yaml` or `@tagma/sdk/config`
- plugin registry helpers: `@tagma/sdk/plugins`
- dataflow helpers: `@tagma/sdk/ports`
- approval gateway: `@tagma/sdk/approval`
- approval adapters: `@tagma/sdk/runtime/adapters/*`

## Running Pipelines

Old direct root-level `runPipeline` usage should move to an instance:

```ts
const tagma = createTagma();
await tagma.run(config, { cwd });
```

Pass `createTagma({ runtime, plugins })` when composing a custom runtime or package-level capability plugins.

## Ports to Bindings

YAML `ports` is now a migration error. Use task-level `inputs` and `outputs`:

```yaml
tasks:
  - id: build
    command: bun run build
    outputs:
      artifact:
        from: json.artifact
        type: string

  - id: test
    depends_on: [build]
    command: bun test "{{inputs.artifact}}"
    inputs:
      artifact:
        from: t.build.outputs.artifact
        required: true
        type: string
```

Omit `type` for lightweight pass-through values. Add `type`, `required`, `enum`, and `description` when the binding should be strict and editor-visible.

## Plugins

Legacy plugin modules exporting `pluginCategory` and `pluginType` are rejected. Default-export a `TagmaPlugin`:

```ts
export default {
  name: '@tagma/trigger-example',
  capabilities: {
    triggers: {
      example: ExampleTrigger,
    },
  },
} satisfies TagmaPlugin;
```

## Runtime Boundary

Runtime-specific behavior belongs behind `TagmaRuntime`.

- Drivers and command tasks use `runtime.runSpawn()` / `runtime.runCommand()`.
- Built-in file triggering uses `runtime.watch()`, `runtime.fileExists()`, and `runtime.ensureDir()`.
- Pipeline logs and stdout/stderr artifact paths use `runtime.logStore`.
- Stdin/WebSocket approval adapters now live under `@tagma/sdk/runtime/adapters/*`.

The default `bunRuntime()` preserves Bun-first behavior for existing hosts.
