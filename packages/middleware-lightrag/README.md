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
    - "@tagma/middleware-lightrag"
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
          prompt: "Draft a migration guide for the new event bus API"
          output: ./output/draft.md
```

Or load it programmatically:

```ts
import { bootstrapBuiltins, loadPlugins } from '@tagma/sdk';

bootstrapBuiltins();
await loadPlugins(['@tagma/middleware-lightrag']);
```

## Config

| Field         | Type       | Default                  | Notes                                                                                |
|---------------|------------|--------------------------|--------------------------------------------------------------------------------------|
| `endpoint`    | string     | *(required)*             | LightRAG API server base URL (default port 9621)                                     |
| `mode`        | enum       | `mix`                    | One of `local`, `global`, `hybrid`, `naive`, `mix` — matches LightRAG's server default |
| `top_k`       | number     | `10`                     | Top-k entities (local mode) / relationships (global mode)                            |
| `api_key_env` | string     | *(none)*                 | Env var holding the API key; sent via `X-API-Key` header                             |
| `timeout`     | duration   | `30s`                    | Max time to wait for the LightRAG response                                           |
| `label`       | string     | `Knowledge Graph Context`| Header rendered above the retrieved context in the final prompt                      |
| `query`       | string     | *(task prompt)*          | Override the retrieval query; useful when the prompt itself is not a good KG query   |

## Behavior

- Calls `POST /query` on the LightRAG server (see `lightrag/api/routers/query_routes.py`) with:
  - `only_need_context: true` — LightRAG skips the LLM synthesis step and returns the raw assembled context in the `response` field
  - `include_references: false` — strips reference metadata so the prompt stays focused
  - `stream: false`
- The raw context is then prepended to the task prompt as `[<label>]\n<context>\n\n[Task]\n<prompt>` so the downstream driver's model consumes it as prompt augmentation.
- **Auth**: when `api_key_env` is set, the API key is sent via `X-API-Key` (LightRAG's server auth scheme), not `Authorization: Bearer`.
- **Best-effort**: if the server is unreachable, returns an empty response, or errors, the middleware logs a warning and passes the original prompt through unchanged. Tasks never fail purely because the KG was offline.
- The final prompt shape is:

  ```
  [Knowledge Graph Context]
  <retrieved text>

  [Task]
  <original prompt>
  ```

## License

MIT
