// ═══ LLM-as-Judge Completion Plugin ═══
//
// Uses an OpenAI-compatible chat completions endpoint to verify whether a
// task's output satisfies a rubric. Complements the deterministic built-in
// completions (`exit_code`, `file_exists`, `output_check`) with AI-powered
// checks — useful when success is defined semantically rather than by a
// grep-able pattern or a file on disk.
//
// Default backend is a **local Ollama** server using its OpenAI-compatible
// route (`/v1/chat/completions`, available since Ollama 0.1.29+), with
// `qwen3:4b` as a small, cheap-to-run reasoning model. No API key is
// required for local Ollama; remote endpoints can set `api_key_env` to
// whatever header the server expects.
//
// The judge is instructed to answer PASS/FAIL on the first line. Reasoning
// models (qwen3, deepseek-r1, etc.) emit `<think>...</think>` blocks in
// their message content — we strip those before parsing, so the rubric
// works the same whether the judge model is a thinker or not.
//
// Usage in pipeline.yaml:
//   plugins: ["@tagma/completion-llm-judge"]
//   tracks:
//     - tasks:
//         - id: draft
//           completion:
//             type: llm_judge
//             rubric: "Output must list at least 3 failing tests with file paths."
//             # endpoint / model / api_key_env all default to local Ollama + qwen3:4b

import type {
  CompletionPlugin, CompletionContext, TaskResult,
} from '@tagma/types';

// Ollama exposes an OpenAI-compatible `/v1/chat/completions` route on port
// 11434 by default. Point this at any OpenAI-compatible server (OpenAI,
// vLLM, llama.cpp, LM Studio, Groq, Together, etc.) to swap backends.
const DEFAULT_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
// qwen3:4b is a small reasoning model (~2.5 GB on disk, runs on CPU) that
// reliably follows the PASS/FAIL-on-first-line instruction. Swap to
// `qwen3:8b`, `deepseek-r1:7b`, or a hosted model for stricter judging.
const DEFAULT_MODEL = 'qwen3:4b';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 8_000;

const SYSTEM_PROMPT =
  'You are a strict quality judge for task outputs.\n' +
  'Given the task rubric and actual output, answer on the FIRST LINE with exactly "PASS" or "FAIL".\n' +
  'On subsequent lines you may provide a one-sentence justification.\n' +
  'Do not use any other format. Do not wrap the answer in code fences.\n' +
  'If you reason step-by-step internally, still put PASS or FAIL on the first line of your final answer.';

interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
}

function parseDurationSafe(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  const str = String(raw).trim();
  const m = str.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return fallback;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'ms': return n;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    case 's':
    default:   return n * 1000;
  }
}

// Head-and-tail truncation preserves the start of the output (where agents
// usually declare intent) and the end (where they summarize results),
// dropping the middle when the combined length exceeds the budget. This
// keeps the judge's view of the output meaningful even for very long runs.
function truncateForJudge(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n...[truncated]...\n';
  const budget = maxChars - marker.length;
  if (budget <= 0) return text.slice(0, maxChars);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return text.slice(0, head) + marker + text.slice(-tail);
}

// Strip reasoning-model thinking blocks so verdict parsing sees the real
// answer. Qwen3 and DeepSeek-R1 both emit `<think>...</think>` inline in
// message content when served via Ollama's OpenAI-compat route. We also
// drop the legacy `<thinking>` variant some fine-tunes use. Applied
// before any trimming so leading whitespace from the stripped block
// doesn't leak into the first line.
function stripThinking(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

async function callJudge(
  endpoint: string,
  model: string,
  apiKey: string | undefined,
  messages: readonly ChatMessage[],
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    // Only send Authorization when we actually have a key — local Ollama
    // doesn't require one, and some OpenAI-compat proxies reject bogus
    // placeholder tokens like "ollama" with 401 instead of ignoring them.
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        // `stream: false` is already the default but we set it explicitly
        // because Ollama's OpenAI-compat route streams by default in some
        // older versions.
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`judge endpoint ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('judge endpoint returned no message content');
    }
    return stripThinking(content);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

const LlmJudgeCompletion: CompletionPlugin = {
  name: 'llm_judge',
  schema: {
    description:
      'Use an LLM to judge whether the task output satisfies a rubric. Answers PASS/FAIL.',
    fields: {
      rubric: {
        type: 'string',
        required: true,
        description: 'Criteria the judge should verify. Plain language.',
        placeholder: 'Output must list at least 3 failing tests with file paths.',
      },
      model: {
        type: 'string',
        default: DEFAULT_MODEL,
        description:
          'Judge model name. Default is a small Ollama reasoning model (qwen3:4b). Swap for qwen3:8b, deepseek-r1:7b, or a hosted model for stricter judging.',
        placeholder: DEFAULT_MODEL,
      },
      endpoint: {
        type: 'string',
        default: DEFAULT_ENDPOINT,
        description:
          'OpenAI-compatible chat completions endpoint. Defaults to local Ollama (http://localhost:11434/v1/chat/completions).',
        placeholder: DEFAULT_ENDPOINT,
      },
      api_key_env: {
        type: 'string',
        description:
          'Env var containing the bearer token for the judge endpoint. Leave unset for local Ollama; set to OPENAI_API_KEY etc. for hosted backends.',
        placeholder: 'OPENAI_API_KEY',
      },
      timeout: {
        type: 'duration',
        default: '120s',
        description:
          'Maximum time to wait for the judge response. Reasoning models need more time than chat models.',
      },
      max_output_chars: {
        type: 'number',
        default: DEFAULT_MAX_OUTPUT_CHARS,
        min: 500,
        max: 200_000,
        description: 'Truncate task stdout to this many chars before judging.',
      },
    },
  },

  async check(
    config: Record<string, unknown>,
    result: TaskResult,
    ctx: CompletionContext,
  ): Promise<boolean> {
    const rubric = config.rubric as string | undefined;
    if (!rubric) throw new Error('llm_judge completion: "rubric" is required');

    // api_key_env is optional — when unset we talk to the endpoint
    // anonymously (correct for local Ollama). When the user names an env
    // var, we require it to be populated so config errors fail loudly
    // instead of silently stripping auth.
    const apiKeyEnv = config.api_key_env as string | undefined;
    let apiKey: string | undefined;
    if (apiKeyEnv) {
      apiKey = process.env[apiKeyEnv];
      if (!apiKey) {
        throw new Error(`llm_judge completion: env var ${apiKeyEnv} is not set`);
      }
    }

    const model = (config.model as string | undefined) ?? DEFAULT_MODEL;
    const endpoint = (config.endpoint as string | undefined) ?? DEFAULT_ENDPOINT;
    const timeoutMs = parseDurationSafe(config.timeout, DEFAULT_TIMEOUT_MS);
    const maxChars = typeof config.max_output_chars === 'number' && config.max_output_chars > 0
      ? Math.floor(config.max_output_chars)
      : DEFAULT_MAX_OUTPUT_CHARS;

    const userContent =
      `[Rubric]\n${rubric}\n\n` +
      `[Exit Code]\n${result.exitCode}\n\n` +
      `[Task Output]\n${truncateForJudge(result.stdout, maxChars)}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ];

    try {
      const content = await callJudge(
        endpoint, model, apiKey, messages, timeoutMs, ctx.signal,
      );
      const firstLine = (content.split(/\r?\n/, 1)[0] ?? '').trim().toUpperCase();
      const passed = firstLine.startsWith('PASS');
      if (!passed) {
        // Surface the judge's reasoning in logs so pipeline operators can
        // see why an output was rejected without re-running it themselves.
        console.warn(
          `[llm_judge] verdict=${firstLine || '<empty>'} — full judge response:\n${content}`,
        );
      }
      return passed;
    } catch (err) {
      // Treat judge failures as FAIL: a completion gate that errors open
      // is worse than one that errors closed. Operators can re-run the
      // task once the judge endpoint is healthy again.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[llm_judge] judge call failed, marking task as not-complete: ${msg}`);
      return false;
    }
  },
};

// ═══ Plugin self-description exports ═══
export const pluginCategory = 'completions';
export const pluginType = 'llm_judge';
export default LlmJudgeCompletion;
