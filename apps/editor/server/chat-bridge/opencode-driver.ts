/**
 * Bot-bridge → opencode driver.
 *
 * Equivalent of chat-store.ts's `sendChatMessage` but on the Node side: ensures
 * an opencode-serve instance for the workspace, creates/reuses a session, and
 * dispatches a prompt. For M1 this uses the blocking `session.prompt()`
 * variant which returns once the model is done — no streaming yet. M2 will
 * switch to `promptAsync` + `event.subscribe` so we can edit a "live" Telegram
 * message as parts arrive.
 *
 * Path-utility note: we call `ensureOpencode` and `ensureRealTagmaDirectory`
 * directly rather than HTTP-looping through `/api/opencode/chat/ensure` —
 * we're in-process with them, and going via HTTP would force us through the
 * sidecar's bearer-token middleware for no reason.
 */

import {
  createOpencodeClient,
  type Event as OpencodeEvent,
  type Message,
  type OpencodeClient,
  type Part,
} from '@opencode-ai/sdk/client';
import { dirname, relative } from 'node:path';
import { ensureOpencode, ensureRealTagmaDirectory } from '../opencode-lifecycle.js';
import { createStreamingLoopbackFetch } from '../loopback-fetch.js';
import { workspaceRegistry } from '../workspace-registry.js';
import { seedOpencodeArtifacts, TAGMA_ROUTER_AGENT } from '../opencode-seed.js';
import { errorMessage } from '../path-utils.js';
import { readEditorSettings } from '../plugins/loader.js';
import { enumerateFlatPipelineYamls, enumeratePipelineYamls } from '../pipeline-paths.js';
import { sameFilesystemPath } from '../state.js';
import { runPipelineManifestSync } from '../pipeline-manifest.js';
import {
  createNewPipelineRequestedActionLines,
  fillManualNewPipelineRequestedActionLines,
} from '../../shared/requested-action.js';

interface ClientCacheEntry {
  baseUrl: string;
  client: OpencodeClient;
}

/** workspaceKey → bound SDK client; flushed when baseUrl drifts (after restart). */
const clientCache = new Map<string, ClientCacheEntry>();

type EventSubscribeOptions = Parameters<OpencodeClient['event']['subscribe']>[0];
type EventSubscribeResult = Awaited<ReturnType<OpencodeClient['event']['subscribe']>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildEventUrl(baseUrl: string, options: EventSubscribeOptions): string {
  const url = new URL('/event', baseUrl);
  const query = options?.query;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.href;
}

function buildEventHeaders(options: EventSubscribeOptions): Headers {
  const raw = options?.headers;
  if (!raw) return new Headers();
  if (raw instanceof Headers || Array.isArray(raw)) return new Headers(raw);

  const headers = new Headers();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

async function* loopbackEventStream(
  baseUrl: string,
  loopbackFetch: typeof fetch,
  options: EventSubscribeOptions,
): AsyncGenerator<OpencodeEvent> {
  let lastEventId: string | undefined;
  let retryDelay = options?.sseDefaultRetryDelay ?? 3000;
  let attempt = 0;
  const signal = options?.signal ?? new AbortController().signal;

  while (!signal.aborted) {
    attempt++;
    const headers = buildEventHeaders(options);
    if (lastEventId !== undefined) headers.set('Last-Event-ID', lastEventId);

    try {
      const response = await loopbackFetch(buildEventUrl(baseUrl, options), {
        headers,
        method: 'GET',
        signal,
      });
      if (!response.ok) throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('No body in SSE response');

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const abortHandler = () => {
        try {
          void reader.cancel();
        } catch {
          /* noop */
        }
      };
      signal.addEventListener('abort', abortHandler);
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + value).replace(/\r\n/g, '\n');
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            const dataLines: string[] = [];
            let eventName: string | undefined;
            for (const line of lines) {
              if (line.startsWith('data:')) {
                dataLines.push(line.replace(/^data:\s*/, ''));
              } else if (line.startsWith('event:')) {
                eventName = line.replace(/^event:\s*/, '');
              } else if (line.startsWith('id:')) {
                lastEventId = line.replace(/^id:\s*/, '');
              } else if (line.startsWith('retry:')) {
                const parsed = Number.parseInt(line.replace(/^retry:\s*/, ''), 10);
                if (!Number.isNaN(parsed)) retryDelay = parsed;
              }
            }
            if (!dataLines.length) continue;

            const rawData = dataLines.join('\n');
            let data: unknown;
            let parsedJson = false;
            try {
              data = JSON.parse(rawData);
              parsedJson = true;
            } catch {
              data = rawData;
            }
            if (parsedJson) {
              if (options?.responseValidator) await options.responseValidator(data);
              if (options?.responseTransformer) data = await options.responseTransformer(data);
            }
            options?.onSseEvent?.({
              data,
              event: eventName,
              id: lastEventId,
              retry: retryDelay,
            });
            yield data as OpencodeEvent;
          }
        }
      } finally {
        signal.removeEventListener('abort', abortHandler);
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        reader.releaseLock();
      }
      break;
    } catch (err) {
      options?.onSseError?.(err);
      if (signal.aborted) break;
      if (options?.sseMaxRetryAttempts !== undefined && attempt >= options.sseMaxRetryAttempts) {
        break;
      }
      const backoff = Math.min(retryDelay * 2 ** (attempt - 1), options?.sseMaxRetryDelay ?? 30000);
      await sleep(backoff);
    }
  }
}

export function createLoopbackOpencodeClient(baseUrl: string, authHeader?: string): OpencodeClient {
  const loopbackFetch = createStreamingLoopbackFetch(baseUrl);
  const client = createOpencodeClient({
    baseUrl,
    ...(authHeader ? { headers: { Authorization: authHeader } } : {}),
    fetch: loopbackFetch,
  });
  // The generated non-v2 SDK SSE helper currently calls global fetch instead
  // of the configured fetch. Override only /event so it uses the same
  // proxy-proof streaming loopback transport as ordinary SDK requests.
  client.event.subscribe = (async (
    options?: EventSubscribeOptions,
  ): Promise<EventSubscribeResult> => ({
    stream: loopbackEventStream(baseUrl, loopbackFetch, options),
  })) as OpencodeClient['event']['subscribe'];
  return client;
}

async function getClientFor(workspaceKey: string): Promise<OpencodeClient> {
  const ws = workspaceRegistry.get(workspaceKey);
  if (!ws?.workDir) {
    throw new Error(`bot-bridge: workspace "${workspaceKey}" not registered or has no workDir`);
  }
  const tagmaCwd = ensureRealTagmaDirectory(ws.workDir);
  seedOpencodeArtifacts(tagmaCwd);
  const { baseUrl, auth } = await ensureOpencode(tagmaCwd);
  const cached = clientCache.get(workspaceKey);
  if (cached && cached.baseUrl === baseUrl) return cached.client;
  // Talk to the loopback `opencode serve` over a raw socket. The SDK otherwise
  // falls back to Bun's global fetch, which honors HTTP(S)_PROXY/ALL_PROXY and
  // tunnels even 127.0.0.1 through a local proxy when NO_PROXY lacks loopback —
  // the proxy then answers 502 ("opencode request failed (502)"). The loopback
  // fetch streams the body so the per-turn `event.subscribe` SSE still works.
  const client = createLoopbackOpencodeClient(baseUrl, auth.authorization);
  clientCache.set(workspaceKey, { baseUrl, client });
  return client;
}

function workspaceRelativePath(workDir: string, absPath: string | null | undefined): string | null {
  if (!workDir || !absPath) return null;
  const rel = relative(workDir, absPath).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !/^[A-Za-z]:\//.test(rel) ? rel : null;
}

interface WorkspaceYamlFolderEntry {
  readonly folder: string;
  readonly yaml: string;
  readonly manifest: string;
  readonly legacyFlat?: boolean;
}

function formatWorkspaceYamlFolderEntry(entry: WorkspaceYamlFolderEntry): string[] {
  const legacyAttr = entry.legacyFlat ? ' legacy="flat"' : '';
  return [
    `    <pipeline${legacyAttr}>`,
    `      <folder>${entry.folder}</folder>`,
    `      <yaml>${entry.yaml}</yaml>`,
    `      <manifest>${entry.manifest}</manifest>`,
    '    </pipeline>',
  ];
}

function manifestPathForYamlEntry(yaml: string): string {
  return yaml.replace(/\.ya?ml$/i, '.manifest.json');
}

function workspaceYamlFolders(workDir: string): WorkspaceYamlFolderEntry[] {
  try {
    const seen = new Set<string>();
    const out: WorkspaceYamlFolderEntry[] = [];
    const push = (entry: WorkspaceYamlFolderEntry) => {
      const key = `${entry.folder}\0${entry.yaml}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(entry);
    };
    const entries = enumeratePipelineYamls(workDir);
    for (const entry of entries) {
      const folder = workspaceRelativePath(workDir, entry.folderPath);
      const yaml = workspaceRelativePath(workDir, entry.yamlPath);
      if (!folder || !yaml) continue;
      runPipelineManifestSync(entry.yamlPath);
      push({ folder, yaml, manifest: manifestPathForYamlEntry(yaml) });
    }
    for (const entry of enumerateFlatPipelineYamls(workDir)) {
      const folder = workspaceRelativePath(workDir, dirname(entry.yamlPath));
      const yaml = workspaceRelativePath(workDir, entry.yamlPath);
      if (!folder || !yaml) continue;
      runPipelineManifestSync(entry.yamlPath);
      push({ folder, yaml, manifest: manifestPathForYamlEntry(yaml), legacyFlat: true });
    }
    return out;
  } catch {
    return [];
  }
}

function buildBotEditorContext(workspaceKey: string, userText?: string): string {
  const ws = workspaceRegistry.get(workspaceKey);
  const workDir = ws?.workDir ?? workspaceKey;
  if (!workDir) return '';

  const lines = [`  <workspace>${workDir}</workspace>`];
  const requestContext = {
    currentPipelineIsManualNewDraft: sameFilesystemPath(
      ws?.manualNewPipelineYamlPath,
      ws?.yamlPath,
    ),
  };
  lines.push(...fillManualNewPipelineRequestedActionLines(userText, requestContext));
  lines.push(...createNewPipelineRequestedActionLines(userText, requestContext));
  const currentFile = workspaceRelativePath(workDir, ws?.yamlPath);
  if (currentFile) lines.push(`  <current-file>${currentFile}</current-file>`);
  const yamlFolders = workspaceYamlFolders(workDir);
  if (yamlFolders.length) {
    lines.push(
      '  <workspace-yaml-folders>',
      ...yamlFolders.flatMap(formatWorkspaceYamlFolderEntry),
      '  </workspace-yaml-folders>',
    );
  }

  if (ws?.registry) {
    const pluginLines: string[] = [];
    const categories = [
      ['drivers', 'drivers'],
      ['triggers', 'triggers'],
      ['completions', 'completions'],
      ['middlewares', 'middlewares'],
    ] as const;
    for (const [tag, category] of categories) {
      const values = ws.registry.listRegistered(category);
      if (values.length) pluginLines.push(`    <${tag}>${values.join(', ')}</${tag}>`);
    }
    if (pluginLines.length) {
      lines.push('  <plugins>', ...pluginLines, '  </plugins>');
    }
  }

  return `<editor-context>\n${lines.join('\n')}\n</editor-context>\n\n`;
}

interface BotModelPick {
  providerID: string;
  modelID: string;
}

export function resolveBotChatModel(workspaceKey: string): BotModelPick | null {
  const ws = workspaceRegistry.get(workspaceKey);
  if (!ws?.workDir) return null;
  return readEditorSettings(ws).opencodeChatModel;
}

export function buildBotPromptAsyncBody(
  workspaceKey: string,
  text: string,
): {
  agent: string;
  model?: BotModelPick;
  parts: Array<{ type: 'text'; text: string }>;
} {
  const model = resolveBotChatModel(workspaceKey);
  return {
    ...(model ? { model } : {}),
    agent: TAGMA_ROUTER_AGENT,
    parts: [{ type: 'text', text: buildBotEditorContext(workspaceKey, text) + text }],
  };
}

async function unwrap<T>(
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

export async function ensureSession(
  workspaceKey: string,
  sessionId: string | null,
  title?: string,
): Promise<string> {
  const client = await getClientFor(workspaceKey);
  if (sessionId) return sessionId;
  // Title only at creation: it makes this bot conversation discoverable and
  // readable in the desktop chat session list (same opencode store).
  const s = await unwrap(client.session.create({ body: title ? { title } : {} }));
  return s.id;
}

export function describeDriverError(err: unknown): string {
  if (err && typeof err === 'object' && ('name' in err || 'data' in err)) {
    return describeOpencodeSessionError(err as OpencodeSessionErrorPayload);
  }
  return errorMessage(err);
}

interface OpencodeSessionErrorPayload {
  name?: unknown;
  message?: unknown;
  data?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function sessionErrorData(err: OpencodeSessionErrorPayload): {
  message: string | null;
  statusCode: number | string | null;
} {
  const data = err.data;
  if (!data || typeof data !== 'object') return { message: null, statusCode: null };
  const record = data as Record<string, unknown>;
  const statusCode =
    typeof record.statusCode === 'number' || typeof record.statusCode === 'string'
      ? record.statusCode
      : null;
  return {
    message: nonEmptyString(record.message),
    statusCode,
  };
}

export function describeOpencodeSessionError(
  err: OpencodeSessionErrorPayload | null | undefined,
): string {
  if (!err) return 'session.error with no payload';

  const name = nonEmptyString(err.name);
  if (name === 'MessageOutputLengthError') {
    return 'Model output was cut off by a length limit.';
  }

  const data = sessionErrorData(err);
  if (data.message) {
    const label =
      name && name !== 'Error'
        ? `${name}${data.statusCode != null ? ` ${data.statusCode}` : ''}`
        : data.statusCode != null
          ? `HTTP ${data.statusCode}`
          : null;
    return label ? `${label}: ${data.message}` : data.message;
  }

  const message = nonEmptyString(err.message);
  if (message) {
    return name && name !== 'Error' && message !== name ? `${name}: ${message}` : message;
  }
  return name ?? 'unknown error';
}

export function dropClientCache(): void {
  clientCache.clear();
}

/** Permission event payload as opencode emits it on the wire. */
export interface PermissionRequest {
  id: string;
  sessionID: string;
  type: string;
  title: string;
  metadata?: Record<string, unknown>;
}

export type PermissionResponse = 'once' | 'always' | 'reject';

export interface StreamingCallbacks {
  /** Called for every `message.part.updated` event scoped to our session. */
  onPart: (part: Part) => void;
  /** Called for every `permission.updated` event scoped to our session. */
  onPermission: (perm: PermissionRequest, handle: StreamingHandle) => void;
  /** Called when `session.idle` for our session arrives. */
  onIdle: () => void;
  /** Called on `session.error`. err.name === 'MessageAbortedError' on user abort. */
  onError: (err: { name?: string; message?: string; data?: unknown }) => void;
}

export interface StreamingHandle {
  /** Session id this stream is bound to (created if input was null). */
  sessionId: string;
  /** Aborts subscription + signals opencode to cancel the turn. */
  abort: () => void;
  /** Resolves once session.idle or session.error has fired for this turn. */
  done: Promise<void>;
  /** Reply to a permission request raised during this turn. */
  replyPermission: (permissionID: string, response: PermissionResponse) => Promise<void>;
}

export interface AssistantPartGate {
  observeMessage(info: Message): Part[];
  observePart(part: Part): Part[];
}

function isSuppressedBridgePart(part: Part): boolean {
  const flags = part as { synthetic?: boolean; ignored?: boolean };
  return flags.synthetic === true || flags.ignored === true;
}

function isBridgePromptTextPart(part: Part): boolean {
  return part.type === 'text' && part.text.trimStart().startsWith('<editor-context>');
}

export function createAssistantPartGate(): AssistantPartGate {
  const roles = new Map<string, Message['role']>();

  return {
    observeMessage(info) {
      roles.set(info.id, info.role);
      return [];
    },
    observePart(part) {
      if (isSuppressedBridgePart(part)) return [];
      const role = roles.get(part.messageID);
      if (role === 'assistant') return [part];
      if (role === 'user') return [];
      // The bridge always prefixes the user prompt with editor-context. If a
      // text part arrives before its envelope and has that prefix, suppress it
      // immediately so Slack/Telegram/Discord never see the hidden context.
      if (isBridgePromptTextPart(part)) return [];
      // Fast turns can deliver the final assistant text part before the
      // assistant envelope. Rendering safe orphan parts keeps the bot from
      // finalizing a turn with only progress/tool lines when idle wins the race.
      return [part];
    },
  };
}

// Each turn opens a FRESH `event.subscribe` (per-turn lifetime), which is
// structurally a reconnect every turn. opencode can late-deliver / replay a
// `session.idle` (or `session.status{idle}`) envelope from a reused session's
// PRIOR turn onto that new subscription — chat-store.ts guards the same hazard
// with its confirmIdleTurn re-check. We treat an idle that arrives before this
// turn has produced ANY part or permission as stale: ignore it and keep
// consuming. To avoid hanging a turn that legitimately produces nothing, a
// pre-activity idle arms this bounded floor instead, after which we end the
// turn anyway. A real turn emits a part well within this window (the router
// delegates via a tool part almost immediately), disarming the floor.
const IDLE_GRACE_FLOOR_MS = 8000;

/**
 * Streaming send: subscribe to opencode's SSE first, fire promptAsync,
 * dispatch matched events to the callback bundle. Returns a handle whose
 * `done` promise settles on session.idle / session.error.
 *
 * NB: each call opens a fresh `event.subscribe` (per-turn lifetime). For
 * burst load (many concurrent bot chats) we'd want one mux per workspace,
 * but per-turn is good enough for M2.
 */
export async function sendPromptStreaming(
  workspaceKey: string,
  sessionId: string | null,
  text: string,
  callbacks: StreamingCallbacks,
  newSessionTitle?: string,
): Promise<StreamingHandle> {
  const client = await getClientFor(workspaceKey);
  const resolvedSession = await ensureSession(workspaceKey, sessionId, newSessionTitle);
  const controller = new AbortController();
  const { stream } = await client.event.subscribe({ signal: controller.signal });

  let settled = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const handle: StreamingHandle = {
    sessionId: resolvedSession,
    abort: () => {
      if (!settled) {
        settled = true;
        resolveDone();
      }
      controller.abort();
      // Best-effort: tell opencode to drop the in-flight turn. Failure is
      // ignored because we're shutting down anyway.
      void unwrap(client.session.abort({ path: { id: resolvedSession } })).catch(() => {
        /* best-effort */
      });
    },
    done,
    replyPermission: async (permissionID, response) => {
      await unwrap(
        client.postSessionIdPermissionsPermissionId({
          path: { id: resolvedSession, permissionID },
          body: { response },
        }),
      );
    },
  };

  // Turn-end idle guard (see IDLE_GRACE_FLOOR_MS above).
  let observedTurnActivity = false;
  let idleFloorTimer: ReturnType<typeof setTimeout> | null = null;
  const partGate = createAssistantPartGate();
  const clearIdleFloor = () => {
    if (idleFloorTimer) {
      clearTimeout(idleFloorTimer);
      idleFloorTimer = null;
    }
  };
  const settleIdle = () => {
    clearIdleFloor();
    if (settled) return;
    settled = true;
    try {
      callbacks.onIdle();
    } catch (err) {
      console.warn('[bot-bridge] onIdle callback threw:', err);
    }
    resolveDone();
  };
  const armIdleFloor = () => {
    if (idleFloorTimer || settled) return;
    idleFloorTimer = setTimeout(() => {
      idleFloorTimer = null;
      settleIdle();
      controller.abort(); // unblock the for-await; this turn is done
    }, IDLE_GRACE_FLOOR_MS);
    (idleFloorTimer as unknown as { unref?: () => void }).unref?.();
  };
  const emitAssistantPart = (part: Part) => {
    observedTurnActivity = true;
    clearIdleFloor();
    try {
      callbacks.onPart(part);
    } catch (err) {
      console.warn('[bot-bridge] onPart callback threw:', err);
    }
  };

  // Consume the event stream in the background. Each branch matches the
  // exact shape opencode emits and filters by sessionID so events from
  // other sessions sharing this opencode instance don't leak into our
  // callbacks. We invoke user callbacks inside try/catch — a throw in
  // user code must not poison the stream consumer.
  (async () => {
    try {
      for await (const event of stream as AsyncIterable<OpencodeEvent>) {
        if (controller.signal.aborted) break;
        const t = event.type;
        if (t === 'message.updated') {
          const info = event.properties.info;
          if (info.sessionID !== resolvedSession) continue;
          const parts = partGate.observeMessage(info);
          for (const part of parts) emitAssistantPart(part);
        } else if (t === 'message.part.updated') {
          const part = event.properties.part as Part;
          if ((part as { sessionID?: string }).sessionID !== resolvedSession) continue;
          for (const assistantPart of partGate.observePart(part)) emitAssistantPart(assistantPart);
        } else if (t === 'permission.updated') {
          const perm = event.properties as PermissionRequest;
          if (perm.sessionID !== resolvedSession) continue;
          observedTurnActivity = true;
          clearIdleFloor();
          try {
            callbacks.onPermission(perm, handle);
          } catch (err) {
            console.warn('[bot-bridge] onPermission callback threw:', err);
          }
        } else if (t === 'session.idle') {
          if (event.properties.sessionID !== resolvedSession) continue;
          // Pre-activity idle ⇒ likely a stale replay: ignore, arm the floor,
          // keep consuming. Real activity later disarms it; a real post-
          // activity idle ends the turn.
          if (!observedTurnActivity) {
            armIdleFloor();
            continue;
          }
          settleIdle();
          break;
        } else if (t === 'session.status') {
          if (event.properties.sessionID !== resolvedSession) continue;
          const status = (event.properties as { status?: { type?: string } }).status;
          if (status?.type !== 'idle') continue;
          if (!observedTurnActivity) {
            armIdleFloor();
            continue;
          }
          settleIdle();
          break;
        } else if (t === 'session.error') {
          const errSessionID = (event.properties as { sessionID?: string }).sessionID;
          if (errSessionID && errSessionID !== resolvedSession) continue;
          const err = (event.properties as { error?: { name?: string; message?: string } })
            .error ?? { message: 'session.error with no payload' };
          if (!settled) {
            settled = true;
            try {
              callbacks.onError(err);
            } catch (cbErr) {
              console.warn('[bot-bridge] onError callback threw:', cbErr);
            }
            resolveDone(); // resolve, not reject — caller observes via onError
          }
          break;
        }
      }
      if (!settled && !controller.signal.aborted) {
        settled = true;
        try {
          callbacks.onError({ message: 'opencode event stream closed before the turn finished' });
        } catch {
          /* best-effort */
        }
        resolveDone();
      }
    } catch (err) {
      if (!settled && !controller.signal.aborted) {
        settled = true;
        try {
          callbacks.onError({ message: errorMessage(err) });
        } catch {
          /* best-effort */
        }
        resolveDone();
      }
    } finally {
      clearIdleFloor();
      controller.abort();
    }
  })();

  // Now actually send the prompt — the SSE consumer is live and will see
  // events emitted by this call.
  try {
    await unwrap(
      client.session.promptAsync({
        path: { id: resolvedSession },
        body: buildBotPromptAsyncBody(workspaceKey, text),
      }),
    );
  } catch (err) {
    controller.abort();
    if (!settled) {
      settled = true;
      resolveDone();
    }
    throw err;
  }

  return handle;
}
