# @tagma/driver-claude-code

[Claude Code](https://code.claude.com/docs/en/cli-reference) driver plugin for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Translates pipeline tasks into `claude -p` invocations with JSON output parsing and native session resume.

## Install

```bash
bun add @tagma/driver-claude-code
```

Requires the `claude` CLI to be installed and available in your PATH.

## Usage

Declare the plugin in your `pipeline.yaml`:

```yaml
pipeline:
  name: my-pipeline
  plugins:
    - '@tagma/driver-claude-code'
  tracks:
    - id: backend
      name: Backend
      driver: claude-code
      tasks:
        - id: implement
          name: Implement feature
          prompt: 'Refactor the database layer to use connection pooling'
```

Or load it programmatically:

```ts
import { bootstrapBuiltins, loadPlugins } from '@tagma/sdk';

bootstrapBuiltins();
await loadPlugins(['@tagma/driver-claude-code']);
```

## Behavior

- **Model**: all tiers; default `sonnet`
- **Output format**: `--output-format json` — `parseResult` extracts session ID and normalized text from the result envelope
- **Session resume**: native support via `--resume <session_id>` when `continue_from` references a task with a known session ID
- **System prompt**: supported via `--append-system-prompt` (driven by `agent_profile`)
- **Permissions**: mapped to `--permission-mode` (`bypassPermissions` when `execute: true`, otherwise `dontAsk` with an explicit `--allowedTools` whitelist)
- **Reasoning effort**: passed through via `--effort` (accepts `low|medium|high|max`)
- **Windows**: auto-discovers Git Bash and sets `CLAUDE_CODE_GIT_BASH_PATH` when needed

## License

MIT
