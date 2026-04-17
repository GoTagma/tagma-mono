# @tagma/driver-opencode

[OpenCode](https://github.com/anomalyco/opencode) driver plugin for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Translates pipeline tasks into `opencode run` invocations with JSON output parsing.

## Install

```bash
bun add @tagma/driver-opencode
```

Requires the `opencode` CLI to be installed and available in your PATH.

## Usage

Declare the plugin in your `pipeline.yaml`:

```yaml
pipeline:
  name: my-pipeline
  plugins:
    - '@tagma/driver-opencode'
  tracks:
    - id: backend
      name: Backend
      driver: opencode
      tasks:
        - id: implement
          name: Implement feature
          prompt: 'Refactor the database layer to use connection pooling'
```

Or load it programmatically:

```ts
import { bootstrapBuiltins, loadPlugins } from '@tagma/sdk';

bootstrapBuiltins();
await loadPlugins(['@tagma/driver-opencode']);
```

## Behavior

- **Model**: all tiers
- **Output format**: `--format json` -- `parseResult` extracts session ID and normalized text from JSON output
- **Error JSON handling**: opencode sometimes emits `{type: "error"}` JSON with exit code 0 for transient API failures. The driver detects this pattern in `parseResult` and returns `forceFailure: true` with the error message, so the engine marks the task as failed instead of silently succeeding with bogus output that downstream tasks would then consume
- **Session resume**: supported via `--session` flag when `continue_from` references a task with a known session ID
- **System prompt**: not supported -- `agent_profile` is prepended to the prompt
- **Fallback**: when no session ID is available for `continue_from`, previous output is injected into the prompt text

## License

MIT
