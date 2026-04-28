# @tagma/middleware-lightrag

[LightRAG](https://github.com/HKUDS/LightRAG) knowledge-graph retrieval middleware for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Queries a running LightRAG API server and prepends the retrieved subgraph context to the task prompt, so downstream drivers (Claude Code, Codex, OpenCode, ...) see the prompt already augmented with relevant facts from your knowledge graph.

## Install

```bash
bun add @tagma/middleware-lightrag
```

Requires a running LightRAG API server. Follow the [LightRAG README](https://github.com/HKUDS/LightRAG) to ingest your corpus and start the server (defaults to `http://localhost:9621`).

## Usage

Declare the plugin in your `pipeline.yaml` and reference it on any track or task:

```yaml
pipeline:
  name: docs-rewrite
  plugins:
    - '@tagma/middleware-lightrag'
  tracks:
    - id: writer
      name: Docs writer
      driver: claude-code
      middlewares:
        - type: lightrag
          endpoint: http://localhost:9621
          mode: mix
          top_k: 20
          api_key_env: LIGHTRAG_API_KEY
          label: Knowledge Graph Context
      tasks:
        - id: draft
          name: Draft migration guide
          prompt: 'Draft a migration guide for the new event bus API'
```

Or load it programmatically:

```ts
import { createTagma } from '@tagma/sdk';

const tagma = createTagma();
await tagma.registry.loadPlugins(['@tagma/middleware-lightrag'], process.cwd());
```

## Config

| Field               | Type     | Default                   | Notes                                                                                                                                              |
| ------------------- | -------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`          | string   | _(required)_              | LightRAG API server base URL (default port 9621). Must use `http`/`https` -- other schemes are rejected                                            |
| `mode`              | enum     | `mix`                     | One of `local`, `global`, `hybrid`, `naive`, `mix`; matches LightRAG's server default                                                              |
| `top_k`             | number   | `10`                      | Top-k entities (local mode) / relationships (global mode). Runtime capped at 200                                                                   |
| `max_context_chars` | number   | `40000`                   | Maximum retrieved context characters inserted into the prompt                                                                                      |
| `api_key_env`       | string   | _(none)_                  | Env var holding the API key; sent via `X-API-Key` header                                                                                           |
| `timeout`           | duration | `30s`                     | Max time to wait for the LightRAG response                                                                                                         |
| `required`          | boolean  | `false`                   | When `true`, an empty retrieval result fails the middleware (and implies `on_error: fail` for transport errors)                                    |
| `on_error`          | enum     | `warn` (or `fail`)        | One of `warn`, `fail`, `skip`. Controls how transport / non-2xx errors are handled. Defaults to `warn`; defaults to `fail` when `required: true`   |
| `label`             | string   | `Knowledge Graph Context` | Header rendered above the retrieved context in the final prompt                                                                                    |
| `query`             | string   | _(task instruction)_      | Override the retrieval query. Defaults to the user's task instruction (`PromptDocument.task`), not the already-serialized prompt                   |

## Behavior

- Calls `POST /query` on the LightRAG server (see `lightrag/api/routers/query_routes.py`) with:
  - `only_need_context: true` - LightRAG skips the LLM synthesis step and returns the raw assembled context in the `response` field
  - `include_references: false` - strips reference metadata so the prompt stays focused
  - `stream: false`
- The raw context is then prepended to the task prompt as `[<label>]\n<context>\n\n<prompt>` so the downstream driver's model consumes it as prompt augmentation. The middleware does **not** emit a `[Task]` header; that framing belongs to the driver (e.g. opencode's `agent_profile` wrapping). Emitting `[Task]` here would cause a second header to appear after the driver's wrapper, which some models interpret as an empty/cut-off message.
- **Auth**: when `api_key_env` is set, the API key is sent via `X-API-Key` (LightRAG's server auth scheme), not `Authorization: Bearer`.
- **Failure handling**: controlled by `on_error` (default `warn`, or `fail` when `required: true`). With `warn`, transport / non-2xx errors are logged and the original prompt is passed through unchanged. With `fail`, the middleware throws and the task fails. With `skip`, errors are swallowed silently. An empty retrieval result triggers `fail` only when `required: true` or `on_error: fail`; otherwise it follows the same `warn`/`skip` policy as transport errors.
- The prompt shape produced by this middleware (middleware output):

  ```
  [Knowledge Graph Context]
  <retrieved text>

  <original prompt>
  ```

  If the driver additionally wraps the prompt (e.g. opencode with `agent_profile: senior`), the final payload reaching the model is:

  ```
  [Role]
  senior

  [Task]
  [Knowledge Graph Context]
  <retrieved text>

  <original prompt>
  ```

## License

MIT
