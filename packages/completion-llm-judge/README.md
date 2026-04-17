# @tagma/completion-llm-judge

LLM-as-judge completion plugin for [@tagma/sdk](https://www.npmjs.com/package/@tagma/sdk).

Uses an OpenAI-compatible chat completions endpoint to verify whether a task's output satisfies a rubric. Complements the deterministic built-in completions (`exit_code`, `file_exists`, `output_check`) when task success is defined semantically rather than by a grep-able pattern.

**Default backend**: local [Ollama](https://ollama.com/) with `qwen3:4b` — a small reasoning model that runs on CPU with no API key. Swap `endpoint` + `model` to point at any OpenAI-compatible server (OpenAI, vLLM, llama.cpp, LM Studio, Groq, Together, OpenRouter, ...).

## Install

```bash
bun add @tagma/completion-llm-judge
```

Then make sure Ollama is running with the default model pulled:

```bash
ollama pull qwen3:4b
ollama serve  # usually auto-started
```

## Usage

```yaml
pipeline:
  name: qa-loop
  plugins:
    - '@tagma/completion-llm-judge'
  tracks:
    - id: qa
      name: QA
      driver: claude-code
      tasks:
        - id: find-bugs
          name: Find failing tests
          prompt: 'List all failing tests in the current workspace with their file paths.'
          completion:
            type: llm_judge
            rubric: |
              The output must list at least 3 failing tests. Each entry must
              include the test name, the file path, and the assertion that
              failed. The output must not be an empty placeholder.
            # endpoint / model / api_key_env all default to local Ollama + qwen3:4b
            timeout: 120s
```

Swap to a hosted backend:

```yaml
completion:
  type: llm_judge
  rubric: '...'
  endpoint: https://api.openai.com/v1/chat/completions
  model: gpt-4o-mini
  api_key_env: OPENAI_API_KEY
```

Or load it programmatically:

```ts
import { bootstrapBuiltins, loadPlugins } from '@tagma/sdk';

bootstrapBuiltins();
await loadPlugins(['@tagma/completion-llm-judge']);
```

## Config

| Field              | Type     | Default                                      | Notes                                                                                      |
| ------------------ | -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `rubric`           | string   | _(required)_                                 | Plain-language success criteria the judge should verify                                    |
| `model`            | string   | `qwen3:4b`                                   | Judge model name. Swap for `qwen3:8b`, `deepseek-r1:7b`, `gpt-4o-mini`, etc.               |
| `endpoint`         | string   | `http://localhost:11434/v1/chat/completions` | OpenAI-compatible chat completions URL. Default points at local Ollama                     |
| `api_key_env`      | string   | _(none)_                                     | Env var holding the bearer token. Leave unset for local Ollama; set for hosted backends    |
| `timeout`          | duration | `120s`                                       | Max time to wait for the judge response (reasoning models need more time than chat models) |
| `max_output_chars` | number   | `8000`                                       | Truncate task stdout before judging (head+tail preserved)                                  |

## Behavior

- **Verdict format**: the judge is instructed to answer `PASS` or `FAIL` on the first line. Missing or ambiguous answers are treated as FAIL — a judge that errs open defeats the purpose of the gate.
- **Reasoning-model support**: `<think>...</think>` and `<thinking>...</thinking>` blocks are stripped from the response before verdict parsing, so qwen3, DeepSeek-R1, and other thinkers work without any extra config.
- **Truncation**: task stdout longer than `max_output_chars` is truncated head-and-tail (70/30 split) with a marker in the middle, so the judge still sees the task's intent and its final summary.
- **Error handling**: network errors, auth errors, timeout, or malformed responses all mark the task as not-complete and log a warning with the judge's verbatim response (if any).
- **Abort propagation**: the pipeline abort signal is wired into the judge fetch call, so cancelling a pipeline also cancels any in-flight judge request.
- **Determinism**: the call uses `temperature: 0` to keep verdicts as stable as the model allows.

## Alternative endpoints

Any OpenAI-compatible endpoint works — just point `endpoint` and `api_key_env` at it:

- **Local Ollama** (default): `http://localhost:11434/v1/chat/completions`, no API key
- **OpenAI**: `https://api.openai.com/v1/chat/completions`, `api_key_env: OPENAI_API_KEY`
- **Local models** via LM Studio, vLLM, llama.cpp OpenAI-compatible servers
- **Hosted**: Groq, Together, Fireworks, OpenRouter, DeepInfra, etc.
- **Anthropic** via an OpenAI-compat proxy (e.g. `anthropic-openai-proxy`)

## License

MIT
