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
import {
  createOpencodeClient as createOpencodeV2Client,
  type ApiAuth as V2ApiAuth,
  type Auth as V2Auth,
  type ModelV2Info,
  type OAuth as V2OAuth,
  type OpencodeClient as OpencodeV2Client,
  type ProviderAuthAuthorization as V2ProviderAuthAuthorization,
  type ProviderAuthMethod as V2ProviderAuthMethod,
  type ProviderV2Info,
  type Session as V2Session,
  type WellKnownAuth as V2WellKnownAuth,
} from '@opencode-ai/sdk/v2/client';
import type {
  Agent as SdkAgent,
  Message,
  Model as SdkModel,
  Part,
  Session as SdkSession,
  Provider as SdkProvider,
} from '@opencode-ai/sdk/client';
import { api, getClientAuthToken, getClientWorkspace } from './client';
import { describeOpencodeError, toOpencodeError } from '../../shared/opencode-errors.js';
import { sameFilesystemPathCoordinate } from '../../shared/filesystem-paths.js';

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
 * The legacy SDK's `config.providers()` model omits variants, while the v2
 * model catalog exposes the exact provider/model-specific variant set. Keep
 * that metadata on the shared picker shape so callers do not have to fall
 * back to a fixed reasoning-effort enum.
 */
export type Model = SdkModel & {
  variants?: Record<string, Record<string, unknown>>;
};

export type Provider = Omit<SdkProvider, 'models'> & {
  models: Record<string, Model>;
};

/** Auth shapes are authoritative in the v2 compatibility client. */
export type ApiAuth = V2ApiAuth;
export type Auth = V2Auth;
export type OAuth = V2OAuth;
export type ProviderAuthAuthorization = V2ProviderAuthAuthorization;
export type ProviderAuthMethod = V2ProviderAuthMethod;
export type WellKnownAuth = V2WellKnownAuth;
export type AuthPrompt = NonNullable<ProviderAuthMethod['prompts']>[number];

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

export type ChatOperationBootstrapHandshake =
  | {
      readonly chatOperationProtocolVersion: 2;
      readonly chatOperationMode: 'production';
    }
  | {
      readonly chatOperationProtocolVersion: null;
      readonly chatOperationMode: 'legacy';
    };

interface ClientBootstrapBase {
  client: OpencodeClient;
  historyClient: OpencodeV2Client;
  v2Client: OpencodeV2Client;
  baseUrl: string;
  directory: string | null;
  authHeader?: string;
  workspaceHeader?: string;
  /**
   * Whether the seeded `tagma-chat-context-window` plugin reported ready in the
   * managed opencode process. When the "Limit AI context" setting is on but
   * this is false, the chat store fails closed instead of sending the full
   * history.
   */
  contextWindowPluginReady: boolean;
  /** Ready-marker schema version; 0 when the plugin is not ready. */
  contextWindowPluginSchema: number;
}

export type ClientBootstrap = ClientBootstrapBase & ChatOperationBootstrapHandshake;

function parseChatOperationBootstrapHandshake(
  value: Record<string, unknown>,
): ChatOperationBootstrapHandshake {
  const hasProtocol = Object.prototype.hasOwnProperty.call(value, 'chatOperationProtocolVersion');
  const hasMode = Object.prototype.hasOwnProperty.call(value, 'chatOperationMode');
  if (!hasProtocol && !hasMode) {
    return { chatOperationProtocolVersion: null, chatOperationMode: 'legacy' };
  }
  if (value.chatOperationProtocolVersion === 2 && value.chatOperationMode === 'production') {
    return { chatOperationProtocolVersion: 2, chatOperationMode: 'production' };
  }
  if (value.chatOperationProtocolVersion === null && value.chatOperationMode === 'legacy') {
    return { chatOperationProtocolVersion: null, chatOperationMode: 'legacy' };
  }
  throw new Error('Sidecar returned an invalid Chat Operation capability handshake.');
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
const HISTORY_DISCOVERY_LIMIT = 10_000;
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

export interface OpencodeEndpointResponse {
  baseUrl?: unknown;
  proxyBaseUrl?: unknown;
  authHeader?: unknown;
}

export interface ResolvedOpencodeBrowserEndpoint {
  baseUrl: string;
  authHeader?: string;
  workspaceHeader?: string;
}

export function resolveOpencodeBrowserEndpoint(
  response: OpencodeEndpointResponse,
  workspaceKey: string,
  sidecarAuthToken: string | null | undefined,
  browserOrigin: string,
): ResolvedOpencodeBrowserEndpoint {
  if (typeof response.baseUrl !== 'string' || !response.baseUrl.trim()) {
    throw new Error('opencode response missing baseUrl');
  }

  const direct = {
    baseUrl: response.baseUrl.trim().replace(/\/+$/, ''),
    ...(typeof response.authHeader === 'string' ? { authHeader: response.authHeader } : {}),
  };
  if (typeof response.proxyBaseUrl !== 'string' || !response.proxyBaseUrl.trim()) {
    return direct;
  }

  const origin = new URL(browserOrigin);
  const proxy = new URL(response.proxyBaseUrl, origin);
  if (proxy.origin !== origin.origin || proxy.search || proxy.hash) {
    throw new Error('opencode proxyBaseUrl must be a same-origin path');
  }
  const workspaceHeader = opencodeWorkspaceHeaderValue(workspaceKey);
  return {
    baseUrl: proxy.toString().replace(/\/+$/, ''),
    ...(sidecarAuthToken ? { authHeader: `Bearer ${sidecarAuthToken}` } : {}),
    ...(workspaceHeader ? { workspaceHeader } : {}),
  };
}

export function buildOpencodeRequestHeaders(
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Record<string, string> {
  return {
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(workspaceHeader ? { 'X-Tagma-Workspace': workspaceHeader } : {}),
    ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
  };
}

export function buildOpencodeClientConfig(
  baseUrl: string,
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Parameters<typeof createOpencodeClient>[0] {
  return {
    baseUrl,
    headers: buildOpencodeRequestHeaders(authHeader, undefined, workspaceHeader),
    ...(directory ? { directory } : {}),
    throwOnError: true,
  };
}

export function buildOpencodeV2ClientConfig(
  baseUrl: string,
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Parameters<typeof createOpencodeV2Client>[0] {
  return {
    baseUrl,
    headers: buildOpencodeRequestHeaders(authHeader, undefined, workspaceHeader),
    ...(directory ? { directory } : {}),
    throwOnError: true,
  };
}

function currentBrowserOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

function fallbackOpencodeDirectory(workspaceKey: string): string | null {
  if (workspaceKey === NO_WORKSPACE_KEY) return null;
  const value = workspaceKey.trim();
  if (!value) return null;
  const separator = value.includes('\\') && !value.includes('/') ? '\\' : '/';
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return `${separator}.tagma`;
  return `${withoutTrailingSeparators}${separator}.tagma`;
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
  const body = (await res.json()) as {
    baseUrl?: string;
    proxyBaseUrl?: unknown;
    directory?: unknown;
    authHeader?: unknown;
    contextWindowPluginReady?: unknown;
    contextWindowPluginSchema?: unknown;
    chatOperationProtocolVersion?: unknown;
    chatOperationMode?: unknown;
  };
  const chatOperationHandshake = parseChatOperationBootstrapHandshake(body);
  const endpoint = resolveOpencodeBrowserEndpoint(
    body,
    workspaceKey,
    authToken,
    currentBrowserOrigin(),
  );
  const directory =
    typeof body.directory === 'string' && body.directory.trim()
      ? body.directory.trim()
      : fallbackOpencodeDirectory(workspaceKey);
  const client = createOpencodeClient(
    buildOpencodeClientConfig(
      endpoint.baseUrl,
      endpoint.authHeader,
      directory,
      endpoint.workspaceHeader,
    ),
  );
  const historyClient = createOpencodeV2Client(
    buildOpencodeV2ClientConfig(
      endpoint.baseUrl,
      endpoint.authHeader,
      undefined,
      endpoint.workspaceHeader,
    ),
  );
  const v2Client = createOpencodeV2Client(
    buildOpencodeV2ClientConfig(
      endpoint.baseUrl,
      endpoint.authHeader,
      directory,
      endpoint.workspaceHeader,
    ),
  );
  const schemaValue = Number(body.contextWindowPluginSchema);
  return {
    client,
    historyClient,
    v2Client,
    directory,
    ...endpoint,
    contextWindowPluginReady: body.contextWindowPluginReady === true,
    contextWindowPluginSchema: Number.isFinite(schemaValue) ? schemaValue : 0,
    ...chatOperationHandshake,
  };
}

export async function getOpencodeClient(
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeClient> {
  const { client } = await getClientBootstrap(workspaceKey);
  return client;
}

export async function getOpencodeV2Client(
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeV2Client> {
  const { v2Client } = await getClientBootstrap(workspaceKey);
  return v2Client;
}

export async function listOpencodeSessions(
  workspaceKey = currentWorkspaceKey(),
): Promise<{ sessions: SdkSession[]; directory: string | null }> {
  const bootstrap = await getClientBootstrap(workspaceKey);
  if (!bootstrap.directory) return { sessions: [], directory: null };

  const [scoped, discovered] = await Promise.all([
    unwrap(bootstrap.client.session.list({ query: { directory: bootstrap.directory } })),
    unwrap(
      bootstrap.historyClient.session.list({
        roots: true,
        limit: HISTORY_DISCOVERY_LIMIT,
      }),
    )
      // Both SDK generations decode the same `/session` payload, but their
      // generated `summary.diffs` declarations differ. History only consumes
      // the shared session and ownership fields.
      .then((sessions) => sessions as unknown as SdkSession[])
      .catch((err) => {
        // Compatibility discovery must never erase the canonical directory
        // result. The caller can still render current history when the older
        // unscoped endpoint is unavailable.
        console.warn('[chat] legacy session discovery failed:', err);
        return [] as SdkSession[];
      }),
  ]);
  const sessionsById = new Map<string, SdkSession>();
  for (const session of discovered) {
    sessionsById.set(session.id, session);
  }
  for (const session of scoped) {
    // Scoped `.tagma` results are the canonical payload for duplicate ids.
    // Keep discovery-only sessions for legacy compatibility, but let the
    // scoped directory win when both queries surface the same session.
    sessionsById.set(session.id, session);
  }
  const sessions = [...sessionsById.values()];
  return { sessions, directory: bootstrap.directory };
}

export interface ProviderModelCatalogV2Snapshot {
  providers: ProviderV2Info[];
  models: ModelV2Info[];
}

export type OpencodeSessionCreateV2Input = NonNullable<
  Parameters<OpencodeV2Client['session']['create']>[0]
>;
export type OpencodeSessionUpdateV2Input = Parameters<OpencodeV2Client['session']['update']>[0];
export type OpencodeSessionV2 = V2Session;

export interface OpencodeSessionDirectoryVerificationOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface MoveOpencodeSessionDirectoryInput {
  sessionID: string;
  destinationDirectory: string;
  expectedSourceDirectories?: readonly string[];
  workspaceKey?: string;
  verification?: OpencodeSessionDirectoryVerificationOptions;
}

export interface MoveOpencodeSessionDirectoryResult {
  moved: boolean;
  sourceDirectory: string;
  destinationDirectory: string;
  session: OpencodeSessionV2;
}

export async function getClientBootstrap(workspaceKey: string): Promise<ClientBootstrap> {
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
  return pending;
}

function isAbsoluteOpencodeDirectory(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
  );
}

function requiredAbsoluteOpencodeDirectory(value: string, label: string): string {
  const directory = value.trim();
  if (!directory || !isAbsoluteOpencodeDirectory(directory)) {
    throw new Error(`${label} must be a non-empty absolute directory`);
  }
  return directory;
}

function requiredOpencodeSessionID(value: string): string {
  const sessionID = value.trim();
  if (!sessionID) throw new Error('opencode session relocation requires a sessionID');
  return sessionID;
}

async function unwrapNoContent(
  request: Promise<{ data?: void; error?: unknown; response: Response }>,
  expectedStatus: number,
): Promise<void> {
  const result = await request.catch((err) => {
    throw toOpencodeError(err);
  });
  if (result.error) throw toOpencodeError(result.error, result.response);
  if (result.response.status !== expectedStatus) {
    throw new Error(
      `opencode returned ${result.response.status}; expected ${expectedStatus} with no content`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('The operation was aborted', 'AbortError');
}

function waitForPollDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        throwIfAborted(signal);
      } catch (err) {
        reject(err);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readOpencodeSessionV2(
  client: OpencodeV2Client,
  sessionID: string,
  signal?: AbortSignal,
): Promise<OpencodeSessionV2> {
  throwIfAborted(signal);
  const session = await unwrap(client.session.get({ sessionID }, signal ? { signal } : undefined));
  if (session.id !== sessionID) {
    throw new Error(
      `opencode returned session ${JSON.stringify(session.id)} while reading ${JSON.stringify(sessionID)}`,
    );
  }
  return session;
}

export async function getOpencodeCanonicalDirectory(
  workspaceKey = currentWorkspaceKey(),
): Promise<string> {
  const { directory } = await getClientBootstrap(workspaceKey);
  if (!directory || !isAbsoluteOpencodeDirectory(directory)) {
    throw new Error('opencode bootstrap did not return an absolute canonical directory');
  }
  return directory;
}

export async function getOpencodeSessionV2(
  sessionID: string,
  workspaceKey = currentWorkspaceKey(),
  signal?: AbortSignal,
): Promise<OpencodeSessionV2> {
  const exactSessionID = requiredOpencodeSessionID(sessionID);
  const client = await getOpencodeV2Client(workspaceKey);
  return readOpencodeSessionV2(client, exactSessionID, signal);
}

export async function waitForOpencodeSessionDirectory(
  sessionID: string,
  expectedDirectory: string,
  workspaceKey = currentWorkspaceKey(),
  options: OpencodeSessionDirectoryVerificationOptions = {},
): Promise<OpencodeSessionV2> {
  const exactSessionID = requiredOpencodeSessionID(sessionID);
  const exactDirectory = requiredAbsoluteOpencodeDirectory(
    expectedDirectory,
    'expected OpenCode session directory',
  );
  const timeoutMs = options.timeoutMs ?? 2_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('OpenCode session-directory timeout must be a non-negative number');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('OpenCode session-directory poll interval must be a non-negative number');
  }

  const client = await getOpencodeV2Client(workspaceKey);
  const startedAt = Date.now();
  let lastDirectory: string | null = null;
  while (true) {
    const session = await readOpencodeSessionV2(client, exactSessionID, options.signal);
    lastDirectory = session.directory;
    if (sameFilesystemPathCoordinate(lastDirectory, exactDirectory)) return session;

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= timeoutMs) break;
    await waitForPollDelay(Math.min(pollIntervalMs, timeoutMs - elapsedMs), options.signal);
  }
  throw new Error(
    `OpenCode session ${JSON.stringify(exactSessionID)} did not move to the expected directory ` +
      `${JSON.stringify(exactDirectory)} within ${timeoutMs}ms (last observed ${JSON.stringify(lastDirectory)})`,
  );
}

export async function moveOpencodeSessionDirectory(
  input: MoveOpencodeSessionDirectoryInput,
): Promise<MoveOpencodeSessionDirectoryResult> {
  const sessionID = requiredOpencodeSessionID(input.sessionID);
  const destinationDirectory = requiredAbsoluteOpencodeDirectory(
    input.destinationDirectory,
    'OpenCode session destination',
  );
  const workspaceKey = input.workspaceKey ?? currentWorkspaceKey();
  const client = await getOpencodeV2Client(workspaceKey);
  const sourceSession = await readOpencodeSessionV2(client, sessionID, input.verification?.signal);
  if (sourceSession.workspaceID !== undefined) {
    throw new Error(
      `OpenCode session ${JSON.stringify(sessionID)} has workspaceID and cannot be relocated safely`,
    );
  }
  const sourceDirectory = sourceSession.directory;
  if (!sourceDirectory) {
    throw new Error(`OpenCode session ${JSON.stringify(sessionID)} has no source directory`);
  }
  if (input.expectedSourceDirectories) {
    const expectedSources = input.expectedSourceDirectories.map((directory) =>
      requiredAbsoluteOpencodeDirectory(directory, 'expected OpenCode session source directory'),
    );
    if (
      expectedSources.length === 0 ||
      !expectedSources.some((expected) => sameFilesystemPathCoordinate(sourceDirectory, expected))
    ) {
      throw new Error(
        `OpenCode session ${JSON.stringify(sessionID)} is in unexpected source directory ${JSON.stringify(sourceDirectory)}`,
      );
    }
  }
  if (sameFilesystemPathCoordinate(sourceDirectory, destinationDirectory)) {
    return {
      moved: false,
      sourceDirectory,
      destinationDirectory,
      session: sourceSession,
    };
  }

  await unwrapNoContent(
    client.experimental.controlPlane.moveSession(
      {
        sessionID,
        destination: { directory: destinationDirectory },
        moveChanges: false,
      },
      input.verification?.signal ? { signal: input.verification.signal } : undefined,
    ),
    204,
  );
  const session = await waitForOpencodeSessionDirectory(
    sessionID,
    destinationDirectory,
    workspaceKey,
    input.verification,
  );
  return { moved: true, sourceDirectory, destinationDirectory, session };
}

export async function fetchProviderModelCatalogV2(
  workspaceKey = currentWorkspaceKey(),
): Promise<ProviderModelCatalogV2Snapshot> {
  const client = await getOpencodeV2Client(workspaceKey);
  const [providerList, modelList] = await Promise.all([
    unwrap(client.v2.provider.list()),
    unwrap(client.v2.model.list()),
  ]);
  return { providers: providerList.data, models: modelList.data };
}

export async function createOpencodeSessionV2(
  body: OpencodeSessionCreateV2Input,
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeSessionV2> {
  const client = await getOpencodeV2Client(workspaceKey);
  return unwrap(client.session.create(body));
}

export async function updateOpencodeSessionV2(
  body: OpencodeSessionUpdateV2Input,
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeSessionV2> {
  const client = await getOpencodeV2Client(workspaceKey);
  return unwrap(client.session.update(body));
}

/** Base URL of the opencode server for workspace-scoped diagnostic fetches. */
export async function getOpencodeBaseUrl(workspaceKey = currentWorkspaceKey()): Promise<string> {
  const { baseUrl } = await getClientBootstrap(workspaceKey);
  return baseUrl;
}

export async function getOpencodeAuthHeader(
  workspaceKey = currentWorkspaceKey(),
): Promise<string | undefined> {
  const { authHeader } = await getClientBootstrap(workspaceKey);
  return authHeader;
}

export async function getOpencodeWorkspaceHeader(
  workspaceKey = currentWorkspaceKey(),
): Promise<string | undefined> {
  const { workspaceHeader } = await getClientBootstrap(workspaceKey);
  return workspaceHeader;
}

/**
 * Drop the cached bootstrap for a selected workspace so the next
 * `getOpencodeClient()` call re-attempts `/api/opencode/chat/ensure`. Called
 * from explicit store retry/recovery paths. Routine remounts should not reset the cache,
 * or we'd re-introduce the "every remount spawns opencode again" behavior.
 */
export function resetOpencodeClient(workspaceKey = currentWorkspaceKey()): void {
  bootstraps.delete(workspaceKey);
}

/**
 * Restart the opencode process for the current workspace and rebind the
 * browser-side SDK client to its new port. Needed after any provider auth
 * change (PUT/DELETE /auth/{id}) because OpenCode doesn't invalidate
 * its in-memory provider cache on auth.json writes — models added/removed on
 * disk stay invisible until the process is restarted. Kill + respawn happens
 * server-side via POST /api/opencode/chat/restart; here we just swap the
 * cached bootstrap over to the returned baseUrl so subsequent
 * `getOpencodeClient()` callers get a client pointed at the fresh process.
 */
export interface RestartOpencodeForConfigOptions {
  forceStop?: boolean;
  yamlEditLockId?: string | null;
}

export async function restartOpencodeForConfig(
  workspaceKey = currentWorkspaceKey(),
  options: RestartOpencodeForConfigOptions = {},
): Promise<void> {
  const key = workspaceKey;
  const lockId = options.forceStop ? options.yamlEditLockId?.trim() : null;
  const body = await api.restartOpencodeChat(key, lockId);
  const chatOperationHandshake = parseChatOperationBootstrapHandshake(
    body as unknown as Record<string, unknown>,
  );
  const endpoint = resolveOpencodeBrowserEndpoint(
    body,
    key,
    getClientAuthToken(),
    currentBrowserOrigin(),
  );
  const directory =
    typeof body.directory === 'string' && body.directory.trim()
      ? body.directory.trim()
      : fallbackOpencodeDirectory(key);
  const schemaValue = Number(body.contextWindowPluginSchema);
  // Overwrite the cached bootstrap with a client bound to the new port so
  // every subsequent `getOpencodeClient()` returns a client talking to the
  // fresh opencode — not the dead one on the old port.
  bootstraps.set(
    key,
    Promise.resolve({
      client: createOpencodeClient(
        buildOpencodeClientConfig(
          endpoint.baseUrl,
          endpoint.authHeader,
          directory,
          endpoint.workspaceHeader,
        ),
      ),
      historyClient: createOpencodeV2Client(
        buildOpencodeV2ClientConfig(
          endpoint.baseUrl,
          endpoint.authHeader,
          undefined,
          endpoint.workspaceHeader,
        ),
      ),
      v2Client: createOpencodeV2Client(
        buildOpencodeV2ClientConfig(
          endpoint.baseUrl,
          endpoint.authHeader,
          directory,
          endpoint.workspaceHeader,
        ),
      ),
      directory,
      ...endpoint,
      contextWindowPluginReady: body.contextWindowPluginReady === true,
      contextWindowPluginSchema: Number.isFinite(schemaValue) ? schemaValue : 0,
      ...chatOperationHandshake,
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
  const res = await p.catch((err) => {
    throw toOpencodeError(err);
  });
  if (res.error) {
    throw toOpencodeError(res.error, res.response);
  }
  if (res.data === undefined) {
    throw new Error(`opencode returned no data (${res.response.status})`);
  }
  return res.data;
}

export { describeOpencodeError };
