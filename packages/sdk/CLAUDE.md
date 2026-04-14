# tagma-sdk

A local AI task orchestration SDK. Consumers (editor extensions, CLI tools, scripts) import and drive it programmatically.

## Packages

| Package | NPM | Role |
|---|---|---|
| `@tagma/sdk` | `@tagma/sdk` | Core engine |
| `@tagma/types` | `@tagma/types` | Shared type surface — no runtime code |
| `@tagma/driver-codex` | `@tagma/driver-codex` | Codex CLI driver plugin |
| `@tagma/driver-opencode` | `@tagma/driver-opencode` | OpenCode CLI driver plugin |

All packages live in the monorepo under `packages/`.

## Tech Stack

- Runtime: Bun >= 1.2, TypeScript 5.x
- Subprocess: `Bun.spawn()`, File I/O: `Bun.file()`, WebSocket: `Bun.serve()`
- YAML parsing: js-yaml, file watching: chokidar
- Tests: `bun test`

## Project Structure

```
src/
├── sdk.ts             # Public entry point — all exports live here
├── engine.ts          # Event-loop pipeline engine
├── pipeline-runner.ts # PipelineRunner class — multi-pipeline lifecycle management
├── config-ops.ts      # Immutable CRUD helpers for RawPipelineConfig (visual editor)
├── validate-raw.ts    # Raw config validation — structural + DAG, no runtime deps
├── dag.ts             # DAG construction & topological sort
├── runner.ts          # Task executor (Bun.spawn wrapper)
├── schema.ts          # YAML parsing, validation & template expansion
├── templates.ts       # Node-compatible template discovery (discoverTemplates / loadTemplateManifest)
├── types.ts           # Re-exports @tagma/types + runtime constants
├── registry.ts        # Plugin registry
├── hooks.ts           # Hook lifecycle management
├── bootstrap.ts       # Built-in plugin pre-registration
├── approval.ts        # InMemoryApprovalGateway implementation
├── logger.ts          # Dual-channel logger
├── utils.ts           # Shared utilities
├── adapters/          # stdin and WebSocket approval adapters
├── drivers/           # Built-in driver: claude-code
├── triggers/          # Built-in triggers: file, manual
├── completions/       # Built-in completions: exit-code, file-exists, output-check
└── middlewares/       # Built-in middleware: static-context
```

## Key Conventions

- All public exports live in `src/sdk.ts` — never import from internal modules directly
- All type definitions live in `@tagma/types`; `src/types.ts` is a re-export layer only
- External drivers are separate packages (packages/driver-codex, packages/driver-opencode)
- All file path handling must use `validatePath` — no `..` traversal, no absolute paths
- `prompt` and `command` are mutually exclusive on a Task
- Trigger/Completion/Middleware plugins may expose an optional `schema: PluginSchema` field (declarative metadata for visual editors); schemas are descriptive only and do not replace runtime validation
- Anything that needs to run from the editor server (Node runtime) must avoid Bun-only APIs — see `src/templates.ts` for the Node-safe template discovery helpers vs the Bun-only `loadTemplate` inside `schema.ts`

## Publishing

From monorepo root:

```bash
bun run publish:all
```

Or individually:

```bash
bun run publish:types
bun run publish:driver-codex
bun run publish:driver-opencode
bun run publish:sdk
```

Publish order: `@tagma/types` → drivers → `@tagma/sdk`.