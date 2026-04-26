// ═══ LightRAG Middleware Plugin ═══
//
// Queries a running LightRAG API server (https://github.com/HKUDS/LightRAG)
// and prepends the retrieved knowledge-graph context to the task prompt.
// This complements `static_context` (fixed file) with dynamic, query-driven
// retrieval from a knowledge graph built with LightRAG's ingestion pipeline.
//
// The middleware is best-effort: if the LightRAG server is unreachable or
// returns an empty context, the original prompt is passed through unchanged
// with a warning. Failing the task on retrieval errors would be a footgun
// when the KG is an augmentation, not a hard dependency.
//
// Usage in pipeline.yaml:
//   plugins: ["@tagma/middleware-lightrag"]
//   tracks:
//     - middlewares:
//         - type: lightrag
//           endpoint: http://localhost:9621
//           mode: hybrid
//           top_k: 20
//           api_key_env: LIGHTRAG_API_KEY

import {
  parseDurationSafe,
  type TagmaPlugin,
  type MiddlewarePlugin,
  type MiddlewareContext,
  type PromptDocument,
} from '@tagma/types';

// Modes are the exact set accepted by LightRAG's QueryRequest.mode
// Literal in lightrag/api/routers/query_routes.py. `bypass` sends the query
// straight to the underlying LLM with no retrieval — useless for a
// retrieval middleware, so we reject it at config validation.
type QueryMode = 'local' | 'global' | 'hybrid' | 'naive' | 'mix';

// LightRAG's own server default is `mix`, so we match it here instead of
// picking something else and surprising users who diffed against the UI.
const DEFAULT_MODE: QueryMode = 'mix';
const DEFAULT_TOP_K = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const VALID_MODES: ReadonlySet<QueryMode> = new Set(['local', 'global', 'hybrid', 'naive', 'mix']);

// Hardened URL parser: rejects anything that isn't http/https so malicious
// pipeline config cannot coerce the middleware into fetching `file://`,
// `ftp://`, `data:` or similar SSRF-adjacent schemes. We intentionally do
// NOT block private-IP targets — loopback and RFC1918 are the *primary*
// LightRAG deployment topologies (default placeholder is
// http://localhost:9621), so a private-IP block would break the feature's
// happy path. Command-exec and arbitrary-path schemes are the only ones
// that aren't dual-use, so those are what we deny.
function validateEndpointUrl(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`lightrag middleware: "endpoint" is not a valid URL: ${endpoint}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `lightrag middleware: "endpoint" protocol must be http or https, got "${url.protocol}"`,
    );
  }
  return url;
}

// Shape of LightRAG's QueryResponse Pydantic model (see
// lightrag/api/routers/query_routes.py). When `only_need_context: true` is
// sent, the server still puts the retrieved context string into `response`
// rather than a separate field — so we just read `response`.
interface LightRAGQueryResponse {
  readonly response?: string;
  readonly references?: unknown;
}

async function queryLightRAG(
  endpoint: string,
  query: string,
  mode: QueryMode,
  topK: number,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<string> {
  // LightRAG API Server exposes POST /query (see query_routes.py). Setting
  // `only_need_context: true` tells the server to skip the LLM synthesis
  // step and return the raw assembled context — which is exactly what we
  // want to hand over to the downstream driver's own model as prompt
  // augmentation.
  //
  // Auth: LightRAG uses an `X-API-Key` header (APIKeyHeader security scheme
  // in utils_api.py), NOT the OAuth2 `Authorization: Bearer` flow. An
  // earlier draft of this plugin had this wrong.
  const url = endpoint.replace(/\/+$/, '') + '/query';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify({
        query,
        mode,
        top_k: topK,
        only_need_context: true,
        // Strip references from the response body — we only want the raw
        // context string; reference metadata would just bloat the prompt.
        include_references: false,
        // Never stream — /query is the non-streaming endpoint, but the
        // field is still honored for consistency with /query/stream.
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LightRAG ${res.status}: ${text.slice(0, 200)}`);
    }
    const payload = (await res.json()) as LightRAGQueryResponse;
    return (payload.response ?? '').toString();
  } finally {
    clearTimeout(timer);
  }
}

export const LightRAGMiddleware: MiddlewarePlugin = {
  name: 'lightrag',
  schema: {
    description:
      'Query a LightRAG knowledge-graph server and prepend retrieved context to the prompt.',
    fields: {
      endpoint: {
        type: 'string',
        required: true,
        description: 'LightRAG API server base URL (default port: 9621).',
        placeholder: 'http://localhost:9621',
      },
      mode: {
        type: 'enum',
        enum: ['local', 'global', 'hybrid', 'naive', 'mix'],
        default: 'mix',
        description: 'LightRAG retrieval mode. `mix` matches the LightRAG server default.',
      },
      top_k: {
        type: 'number',
        default: 10,
        min: 1,
        max: 200,
        description: 'Number of top-k results to retrieve.',
      },
      api_key_env: {
        type: 'string',
        description:
          'Env var containing the LightRAG API key. Sent via the X-API-Key header. Omit for unauthenticated local servers.',
        placeholder: 'LIGHTRAG_API_KEY',
      },
      timeout: {
        type: 'duration',
        default: '30s',
        description: 'Maximum time to wait for the LightRAG response.',
      },
      label: {
        type: 'string',
        description: 'Header shown above the retrieved context.',
        placeholder: 'Knowledge Graph Context',
      },
      query: {
        type: 'string',
        description: 'Override query text. Defaults to the task prompt.',
      },
    },
  },

  async enhanceDoc(
    doc: PromptDocument,
    config: Record<string, unknown>,
    _ctx: MiddlewareContext,
  ): Promise<PromptDocument> {
    const endpoint = config.endpoint as string | undefined;
    if (!endpoint) throw new Error('lightrag middleware: "endpoint" is required');
    validateEndpointUrl(endpoint);

    const rawMode = (config.mode as string | undefined) ?? DEFAULT_MODE;
    if (!VALID_MODES.has(rawMode as QueryMode)) {
      throw new Error(
        `lightrag middleware: "mode" must be one of ${[...VALID_MODES].join(', ')}, got ${rawMode}`,
      );
    }
    const mode = rawMode as QueryMode;

    const topK =
      typeof config.top_k === 'number' && config.top_k > 0
        ? Math.floor(config.top_k)
        : DEFAULT_TOP_K;

    const apiKeyEnv = config.api_key_env as string | undefined;
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

    const timeoutMs = parseDurationSafe(config.timeout, DEFAULT_TIMEOUT_MS);
    const label = (config.label as string | undefined) ?? 'Knowledge Graph Context';
    // Default retrieval query: the user's task instruction (doc.task), not
    // the already-serialized prompt. Using doc.task keeps retrieval focused
    // on user intent; upstream context blocks added by other middlewares
    // should not re-influence the query unless the user explicitly overrides.
    const query = (config.query as string | undefined) ?? doc.task;

    try {
      const context = await queryLightRAG(endpoint, query, mode, topK, apiKey, timeoutMs);
      if (!context.trim()) {
        console.warn('[lightrag] query returned empty context, passing prompt through');
        return doc;
      }
      // Append a labeled context block; the engine serializes these before
      // the task, blank-line separated. No `[Task]` / `[Role]` headers here
      // — those belong to the driver's final framing.
      return { contexts: [...doc.contexts, { label, content: context }], task: doc.task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lightrag] retrieval failed, passing prompt through: ${msg}`);
      return doc;
    }
  },
};

export default {
  name: '@tagma/middleware-lightrag',
  capabilities: {
    middlewares: {
      lightrag: LightRAGMiddleware,
    },
  },
} satisfies TagmaPlugin;
