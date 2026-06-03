/**
 * Browser-side opencode SDK client.
 *
 * The editor's server exposes a single bootstrap endpoint
 * (`POST /api/opencode/chat/ensure`) which lazily spawns `opencode serve`
 * scoped to the active workspace's cwd and returns its loopback URL. After
 * that, the renderer talks to opencode *directly* over CORS-enabled HTTP —
 * no express proxy in the middle. That means:
 *
 *   - Rich, fully-typed access to everything opencode exposes
 *     (providers + models with cost/context/reasoning caps, agents, sessions,
 *     full message parts including tool calls / reasoning / step boundaries)
 *   - Streaming via the SDK's native SSE generator; no custom passthrough
 *   - Zero duplication of opencode's API surface on our server
 *
 * Call `getOpencodeClient()` to obtain the memoized singleton. First call
 * bootstraps; subsequent calls return immediately.
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';
import type {
  Agent as SdkAgent,
  Message,
  Part,
  ApiAuth as SdkApiAuth,
  ProviderAuthMethod as SdkProviderAuthMethod,
} from '@opencode-ai/sdk/client';
import { getClientAuthToken, getClientWorkspace } from './client';

/**
 * Opencode 1.14 returns a `hidden: true` marker on internal utility agents
 * (`title`, `summary`, `compaction`, `build`, `plan`) that shouldn't appear in
 * the user-facing agent picker. The field is present in the JSON response but
 * isn't declared in the SDK's generated types, so we widen `Agent` locally
 * instead of reading it through an unsafe cast at each call site. This lets
 * the picker filter purely on server-provided structure — no hardcoded name
 * blocklists — and picks up any future hidden agents automatically.
 */
export type Agent = SdkAgent & { hidden?: boolean };

/**
 * Auth-method prompt shape. Opencode 1.14.x extended `/provider/auth` to let a
 * method declare interactive prompts that must be answered before auth can
 * complete — e.g. `cloudflare-workers-ai` needs `accountId`, `gitlab`'s PAT
 * flow needs `token`, `github-copilot` asks for `deploymentType` (and
 * `enterpriseUrl` when `deploymentType === "enterprise"`).
 *
 * The field isn't declared in the 1.14.x SDK types, so we redeclare it here and
 * widen `ProviderAuthMethod` to pick it up. Kept intentionally narrow —
 * opencode only emits `text` and `select` prompts today; if a future version
 * adds more, the dialog falls through to a generic "unsupported" notice
 * rather than silently dropping the requirement.
 */
export interface AuthPromptWhen {
  key: string;
  op: 'eq';
  value: string;
}
export interface AuthPromptSelectOption {
  label: string;
  value: string;
  hint?: string;
}
export type AuthPrompt =
  | {
      type: 'text';
      key: string;
      message: string;
      placeholder?: string;
      when?: AuthPromptWhen;
    }
  | {
      type: 'select';
      key: string;
      message: string;
      options: AuthPromptSelectOption[];
      when?: AuthPromptWhen;
    };

/**
 * Widened `ProviderAuthMethod` — `prompts` isn't in the 1.14.x SDK types but the
 * server emits it for providers that need pre-auth input.
 */
export type ProviderAuthMethod = SdkProviderAuthMethod & { prompts?: AuthPrompt[] };

/**
 * Widened `ApiAuth`. 1.14.x adds a `metadata` field (arbitrary string map)
 * that opencode stores alongside the key — used to persist answers to
 * `prompts` like Cloudflare's accountId. Not declared in the 1.14.x SDK types.
 */
export type ApiAuth = SdkApiAuth & { metadata?: Record<string, string> };

/**
 * Subtask part — a nested agent invocation surfaced inside the parent
 * assistant message. The SDK declares this inline inside the `Part` union
 * without naming it, so we redeclare the shape locally so renderers (and any
 * future consumer) can take a narrowed type instead of writing the literal
 * shape at every call site.
 */
export interface SubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
}

export type {
  Provider,
  Model,
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
  FilePart,
  FilePartSource,
  FileSource,
  SymbolSource,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
  TextPartInput,
  FilePartInput,
  // Auth surface. opencode exposes `GET /provider/auth` (the universe of
  // configurable providers + their methods), `PUT /auth/{id}` (write a
  // credential envelope), and the pair of `POST /provider/{id}/oauth/authorize`
  // and `…/oauth/callback` for browser-mediated OAuth. We re-export the shapes
  // so the connect dialog doesn't have to reach back into the SDK package.
  // `Auth` / `ApiAuth` / `ProviderAuthMethod` are re-declared above with
  // additions; `OAuth`, `WellKnownAuth`, `ProviderAuthAuthorization` pass
  // through unchanged.
  Auth,
  OAuth,
  WellKnownAuth,
  ProviderAuthAuthorization,
} from '@opencode-ai/sdk/client';

/**
 * Coarse-grained activity events — what the model is *doing* over time, as
 * opposed to the structured `parts` it produces. The chat panel renders this
 * as a collapsible "Working · 42 s · 8 events" footer per assistant message
 * so users can see why a long turn is taking a while (slow TTFT, stuck on a
 * tool, provider retry, history compaction) without having to scan every
 * raw part.
 *
 * Renderers belong to `ChatPanel.tsx`; this module only owns the shape so
 * the store and UI agree on it.
 *
 *   - `request-sent` / `assistant-started` — turn boundaries
 *   - `thinking` / `streaming-answer` — text-bearing parts (see `key`)
 *   - `tool-running` / `tool-completed` / `tool-error` — tool lifecycle for
 *     a single call; coalesced by partId so transitions update one row
 *   - `step-start` / `step-finish` — model step boundaries
 *   - `retry` — provider retry between attempts (clears on resumed activity)
 *   - `compacting` — history compaction (driven by `session.compacted`,
 *     not the `compaction` part — the part is a historical record)
 */
export type ActivityKind =
  | 'request-sent'
  | 'assistant-started'
  | 'thinking'
  | 'streaming-answer'
  | 'tool-running'
  | 'tool-completed'
  | 'tool-error'
  | 'step-start'
  | 'step-finish'
  | 'retry'
  | 'compacting';

export interface ActivityEvent {
  kind: ActivityKind;
  /** Wall-clock when this event began. */
  startedAt: number;
  /**
   * Wall-clock when this event ended. `null` while the event is still the
   * latest in its timeline AND the turn is still in flight; sealed (set to
   * `Date.now()`) when a different-key event arrives, or when finishChatTurn
   * fires. Render uses null to draw a live elapsed counter.
   */
  endedAt: number | null;
  /** How many SSE updates were merged into this event. */
  count: number;
  /**
   * Free-form display info — tool name for tool kinds, retry attempt+next
   * for retry, model id for assistant-started, etc. Rendered as the second
   * column in the timeline.
   */
  detail?: string;
  /**
   * Latest known size of the underlying text/reasoning part. Each
   * message.part.updated carries the full accumulated text (not a delta),
   * so this is overwritten on coalesce, not summed.
   */
  bytes?: number;
  /**
   * Coalesce key. Events with the same key merge into one row regardless
   * of time gap — so a single text part that streams over 30 s shows as
   * one "Streaming answer" row, not 60 of them. Falsy keys never coalesce
   * (each event becomes a new row).
   */
  key?: string;
}

/**
 * Aggregate message shape returned by `session.messages()` / `session.prompt()` —
 * opencode pairs the message envelope (`info`) with its ordered list of `parts`.
 * Exported so the store / UI can type threads without hand-rolling the shape.
 *
 * `activity` is a renderer-only field maintained client-side: opencode
 * doesn't return it from `session.messages()`, so historical messages have
 * `undefined` here and the activity panel won't render for them. Only
 * messages produced during the current process's lifetime carry an array.
 */
export interface OpencodeThreadEntry {
  info: Message;
  parts: Part[];
  activity?: ActivityEvent[];
}

interface ClientBootstrap {
  client: OpencodeClient;
  baseUrl: string;
  authHeader?: string;
}

// One client per workspace. The sidecar runs a separate `opencode serve` per
// workspace cwd (see server/opencode-lifecycle.ts), so each workspace gets its
// own baseUrl + client. Key the cache by the workspace path the client module
// currently has set — switching workspaces in the same window then hands out
// a client scoped to the new workspace without tearing down the old one.
//
// The key `__no_workspace__` is used before a workspace is opened (welcome
// screen). In that state the server falls back to its own process.cwd() — the
// chat panel shouldn't be reachable there, but guarding avoids a null-key
// crash if something triggers bootstrap early.
const NO_WORKSPACE_KEY = '__no_workspace__';
const bootstraps = new Map<string, Promise<ClientBootstrap>>();

function currentWorkspaceKey(): string {
  return getClientWorkspace() ?? NO_WORKSPACE_KEY;
}

export function getOpencodeWorkspaceKey(): string {
  return currentWorkspaceKey();
}

export function opencodeWorkspaceHeaderValue(
  workspaceKey: string | null | undefined,
): string | undefined {
  if (!workspaceKey || workspaceKey === NO_WORKSPACE_KEY) return undefined;
  return workspaceKey;
}

export function buildOpencodeRequestHeaders(
  authHeader: string | undefined,
): Record<string, string> {
  return authHeader ? { Authorization: authHeader } : {};
}

export function buildOpencodeClientConfig(
  baseUrl: string,
  authHeader: string | undefined,
): Parameters<typeof createOpencodeClient>[0] {
  return {
    baseUrl,
    headers: buildOpencodeRequestHeaders(authHeader),
  };
}

async function bootstrap(workspaceKey: string): Promise<ClientBootstrap> {
  const headers: Record<string, string> = {};
  // Route the ensure call to the correct WorkspaceState on the server. Without
  // this, the server's resolveWorkspace middleware sees no header and the
  // route falls back to process.cwd() (= the sidecar's own dir in dev),
  // which is how opencode ended up scoped to the developer's editor folder
  // instead of the user's workspace.
  const workspaceHeader = opencodeWorkspaceHeaderValue(workspaceKey);
  if (workspaceHeader) headers['X-Tagma-Workspace'] = workspaceHeader;
  const authToken = getClientAuthToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/opencode/chat/ensure', { method: 'POST', headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: unknown };
      if (typeof errBody.error === 'string') detail = errBody.error;
      else if (
        errBody.error &&
        typeof errBody.error === 'object' &&
        'message' in (errBody.error as object)
      )
        detail = String((errBody.error as { message: unknown }).message);
    } catch {
      /* best-effort */
    }
    throw new Error(`Failed to start opencode (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { baseUrl?: string; authHeader?: unknown };
  if (!body.baseUrl) throw new Error('opencode ensure response missing baseUrl');
  const authHeader = typeof body.authHeader === 'string' ? body.authHeader : undefined;
  const client = createOpencodeClient(buildOpencodeClientConfig(body.baseUrl, authHeader));
  return { client, baseUrl: body.baseUrl, authHeader };
}

export async function getOpencodeClient(
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeClient> {
  const key = workspaceKey;
  let pending = bootstraps.get(key);
  if (!pending) {
    // A rejected bootstrap stays cached so every subsequent caller sees the
    // same failure instead of silently kicking off a fresh spawn. The only way
    // to clear it is `resetOpencodeClient()`, wired to the chat panel's Retry
    // button.
    pending = bootstrap(key);
    bootstraps.set(key, pending);
  }
  const { client } = await pending;
  return client;
}

/**
 * Base URL of the opencode server for the active workspace. Needed for the
 * handful of endpoints the 1.14.x SDK client doesn't cover — today just
 * `DELETE /auth/{id}` (provider logout). Shares the same bootstrap cache as
 * `getOpencodeClient`, so calling this before the client is ready still
 * spawns `opencode serve` exactly once.
 */
export async function getOpencodeBaseUrl(
  workspaceKey = currentWorkspaceKey(),
): Promise<string> {
  const key = workspaceKey;
  let pending = bootstraps.get(key);
  if (!pending) {
    pending = bootstrap(key);
    bootstraps.set(key, pending);
  }
  const { baseUrl } = await pending;
  return baseUrl;
}

export async function getOpencodeAuthHeader(
  workspaceKey = currentWorkspaceKey(),
): Promise<string | undefined> {
  const key = workspaceKey;
  let pending = bootstraps.get(key);
  if (!pending) {
    pending = bootstrap(key);
    bootstraps.set(key, pending);
  }
  const { authHeader } = await pending;
  return authHeader;
}

/**
 * Drop the cached bootstrap for the current workspace so the next
 * `getOpencodeClient()` call re-attempts `/api/opencode/chat/ensure`. Called
 * from the store's `retryBootstrap` — no other path should reset the cache,
 * or we'd re-introduce the "every remount spawns opencode again" behavior.
 */
export function resetOpencodeClient(): void {
  bootstraps.delete(currentWorkspaceKey());
}

/**
 * Restart the opencode process for the current workspace and rebind the
 * browser-side SDK client to its new port. Needed after any provider auth
 * change (PUT/DELETE /auth/{id}) because opencode 1.14.x doesn't invalidate
 * its in-memory provider cache on auth.json writes — models added/removed on
 * disk stay invisible until the process is restarted. Kill + respawn happens
 * server-side via POST /api/opencode/chat/restart; here we just swap the
 * cached bootstrap over to the returned baseUrl so subsequent
 * `getOpencodeClient()` callers get a client pointed at the fresh process.
 */
export async function restartOpencodeForConfig(
  workspaceKey = currentWorkspaceKey(),
): Promise<void> {
  const key = workspaceKey;
  const headers: Record<string, string> = {};
  const workspaceHeader = opencodeWorkspaceHeaderValue(key);
  if (workspaceHeader) headers['X-Tagma-Workspace'] = workspaceHeader;
  const authToken = getClientAuthToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/opencode/chat/restart', { method: 'POST', headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: unknown };
      if (typeof errBody.error === 'string') detail = errBody.error;
      else if (
        errBody.error &&
        typeof errBody.error === 'object' &&
        'message' in (errBody.error as object)
      )
        detail = String((errBody.error as { message: unknown }).message);
    } catch {
      /* best-effort */
    }
    throw new Error(`Failed to restart opencode (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { baseUrl?: string; authHeader?: unknown };
  if (!body.baseUrl) throw new Error('opencode restart response missing baseUrl');
  const authHeader = typeof body.authHeader === 'string' ? body.authHeader : undefined;
  // Overwrite the cached bootstrap with a client bound to the new port so
  // every subsequent `getOpencodeClient()` returns a client talking to the
  // fresh opencode — not the dead one on the old port.
  bootstraps.set(
    key,
    Promise.resolve({
      client: createOpencodeClient(buildOpencodeClientConfig(body.baseUrl, authHeader)),
      baseUrl: body.baseUrl,
      authHeader,
    }),
  );
}

/**
 * Unwrap a RequestResult Promise. The SDK returns `{ data, error, response }`
 * envelopes when ThrowOnError is false; this helper throws on `error` or on a
 * missing `data`, returning the payload directly. Kept centralized because
 * every call site needs identical handling.
 */
export async function unwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const res = await p;
  if (res.error) {
    const msg =
      typeof res.error === 'object' && res.error !== null && 'message' in res.error
        ? String((res.error as { message: unknown }).message)
        : `opencode request failed (${res.response.status})`;
    throw new Error(msg);
  }
  if (res.data === undefined) {
    throw new Error(`opencode returned no data (${res.response.status})`);
  }
  return res.data;
}
