/**
 * Browser-side client for the custom-providers HTTP routes
 * (`apps/editor/server/routes/custom-providers.ts`).
 *
 * Mirrors the workspace-header / auth-token plumbing that opencode-chat.ts
 * uses for its own server-side bootstrap call — the editor's `api` helper
 * (`api/client.ts`) carries an `If-Match`/revision protocol that's specific
 * to the pipeline mutation flow and would noisily attach itself to every
 * config write here. A handful of small fetch wrappers stay simpler.
 */

import { getClientAuthToken, getClientWorkspace } from './client';
import { opencodeWorkspaceHeaderValue } from './opencode-chat';

export type ConfigScope = 'global' | 'workspace';

export interface CustomProviderModelDef {
  name?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  /**
   * Preserve OpenCode/AI-SDK advanced model-level settings such as per-model
   * `npm` overrides or provider-specific `options`. The modal only edits
   * name/limit, but it must not erase hand-written config when saving.
   */
  [key: string]: unknown;
}

export interface CustomProviderDef {
  name: string;
  npm: string;
  options: {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  models: Record<string, CustomProviderModelDef>;
  [key: string]: unknown;
}

/**
 * Wire shape for entries returned from `/api/opencode/custom-providers`. The
 * server redacts `def.options.apiKey` to the literal `__redacted__` so a
 * compromised renderer cannot exfiltrate the raw key. `hasApiKey` /
 * `apiKeyPreview` / `apiKeyKind` describe the on-disk value without
 * surfacing it.
 *
 * `def.options.headers` gets the same treatment per-entry: any header whose
 * name matches a known credential pattern (Authorization, x-api-key,
 * X-Anthropic-API-Key, …) or whose value looks like a plaintext secret is
 * replaced with the redacted sentinel, with a parallel `headerPreview` map
 * the UI can use to surface "(set)" indicators without showing the value.
 *
 * Round-tripping any redacted sentinel back via `saveCustomProvider` tells
 * the server "keep the existing key" — see opencode-config.ts.
 */
export interface CustomProviderEntry {
  id: string;
  scope: ConfigScope;
  def: CustomProviderDef & {
    hasApiKey?: boolean;
    apiKeyPreview?: string | null;
    apiKeyKind?: 'plaintext' | 'env' | 'sentinel' | null;
    headerPreview?: Record<
      string,
      {
        redacted: boolean;
        preview: string | null;
        kind: 'plaintext' | 'env' | 'sentinel' | null;
      }
    >;
  };
}

/** Sentinel returned by the server in place of a real apiKey value. */
export const REDACTED_API_KEY = '__redacted__';

export interface CustomProviderListResponse {
  providers: CustomProviderEntry[];
  paths: {
    global: string | null;
    workspace: string | null;
  };
}

export interface DiscoverModelsResponse {
  ok: true;
  models: Array<{ id: string; name: string }>;
  /** Path the server actually got a usable list from (e.g. `/v1/models`). */
  endpoint: string;
  /** Which response shape the server parsed — useful for hint text. */
  format: 'openai' | 'ollama';
}

function buildHeaders(opts?: { method?: string; workspaceKey?: string }): Record<string, string> {
  const headers: Record<string, string> = {};
  const method = (opts?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }
  const workspaceKey = opencodeWorkspaceHeaderValue(opts?.workspaceKey ?? getClientWorkspace());
  if (workspaceKey) headers['X-Tagma-Workspace'] = workspaceKey;
  const auth = getClientAuthToken();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return headers;
}

async function readError(res: Response): Promise<string> {
  let detail = res.statusText;
  try {
    const errBody = (await res.json()) as { error?: unknown };
    if (typeof errBody.error === 'string') detail = errBody.error;
  } catch {
    /* best-effort */
  }
  return detail;
}

export async function listCustomProviders(
  workspaceKey?: string | null,
): Promise<CustomProviderListResponse> {
  const res = await fetch('/api/opencode/custom-providers', {
    headers: buildHeaders({ workspaceKey: workspaceKey ?? undefined }),
  });
  if (!res.ok) {
    throw new Error(`Failed to list custom providers (${res.status}): ${await readError(res)}`);
  }
  return (await res.json()) as CustomProviderListResponse;
}

export async function saveCustomProvider(
  id: string,
  scope: ConfigScope,
  def: CustomProviderDef,
  workspaceKey?: string | null,
): Promise<void> {
  const res = await fetch(`/api/opencode/custom-providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: buildHeaders({ method: 'PUT', workspaceKey: workspaceKey ?? undefined }),
    body: JSON.stringify({ scope, def }),
  });
  if (!res.ok) {
    throw new Error(`Failed to save custom provider (${res.status}): ${await readError(res)}`);
  }
}

export async function deleteCustomProvider(
  id: string,
  scope: ConfigScope,
  workspaceKey?: string | null,
): Promise<void> {
  const params = new URLSearchParams({ scope });
  const res = await fetch(
    `/api/opencode/custom-providers/${encodeURIComponent(id)}?${params.toString()}`,
    {
      method: 'DELETE',
      headers: buildHeaders({ method: 'DELETE', workspaceKey: workspaceKey ?? undefined }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to delete custom provider (${res.status}): ${await readError(res)}`);
  }
}

/**
 * Server-side proxy that probes the user's baseURL for a model list. The
 * renderer can't hit local LLM daemons directly — most (Ollama, LM Studio,
 * vLLM, …) don't send CORS headers — so the editor server fetches and
 * returns a normalized `{ id, name }` list.
 *
 * The server tries `{baseURL}/models`, `{origin}/v1/models`, and
 * `{origin}/api/tags` in order and reports back which path actually produced
 * the list (`endpoint`) along with the parsed shape (`format`). The caller
 * just hands over whatever baseURL is in the modal field.
 *
 * `apiKey` is optional and only needed for cloud providers (OpenAI,
 * OpenRouter, …) that authenticate the model-list endpoint. Local servers
 * ignore the header. Must be the actual key — `{env:VAR_NAME}` references
 * are rejected here because resolving them server-side would let the server
 * be tricked into leaking other env-var values to a user-supplied baseURL.
 */
export async function discoverModels(
  baseURL: string,
  apiKey?: string,
): Promise<DiscoverModelsResponse> {
  const res = await fetch('/api/opencode/custom-providers/discover-models', {
    method: 'POST',
    headers: buildHeaders({ method: 'POST' }),
    body: JSON.stringify({ baseURL, ...(apiKey ? { apiKey } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`Could not detect models (${res.status}): ${await readError(res)}`);
  }
  return (await res.json()) as DiscoverModelsResponse;
}
