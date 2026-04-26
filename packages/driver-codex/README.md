# @tagma/driver-codex

[Codex CLI](https://github.com/openai/codex) driver plugin for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Translates pipeline tasks into `codex exec` invocations for headless, non-interactive execution.

## Install

```bash
bun add @tagma/driver-codex
```

Requires the `codex` CLI to be installed and available in your PATH. The driver checks for the CLI at task start and throws a clear error if it's missing.

## Usage

Declare the plugin in your `pipeline.yaml`:

```yaml
pipeline:
  name: my-pipeline
  plugins:
    - '@tagma/driver-codex'
  tracks:
    - id: backend
      name: Backend
      driver: codex
      permissions: { read: true, write: true, execute: false }
      tasks:
        - id: implement
          name: Implement feature
          prompt: 'Add input validation to the signup form'
```

Or load it programmatically:

```ts
import { createTagma } from '@tagma/sdk';

const tagma = createTagma();
await tagma.registry.loadPlugins(['@tagma/driver-codex'], process.cwd());
```

## Behavior

- **Model**: all tiers
- **Approval**: always `--ask-for-approval never` (headless, no TTY)
- **Sandbox**: mapped from task `permissions` -- `read-only`, `workspace-write`, or `danger-full-access`
- **Session resume**: not supported -- `continue_from` falls back to injecting previous output into the prompt text
- **System prompt**: not supported -- `agent_profile` is prepended to the prompt

## License

MIT
