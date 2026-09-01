import { join } from 'node:path';

import { redactDiagnosticText, sanitizeDiagnosticValue } from '../shared/diagnostics.js';
import { isWorkspaceRootOpencodeSession } from '../shared/opencode-session-metadata.js';
import { getOpencodeHandle, type OpencodeHandle } from './opencode-lifecycle.js';
import { fetchOpencodeProxy, type OpencodeProxyRequest } from './opencode-proxy.js';
import { workspaceRegistry } from './workspace-registry.js';

const MAX_OPENCODE_DIAGNOSTICS_BYTES = 4 * 1024 * 1024;
const OPENCODE_SESSION_DISCOVERY_LIMIT = 10_000;
const OPENCODE_SCOPED_SESSION_LIMIT = 100;
const HOST_SESSION_AUTHORITY_LIMIT = 10_000;
const DEFAULT_DIAGNOSTICS_SESSION_PAGE_LIMIT = 100;
const MAX_DIAGNOSTICS_SESSION_PAGE_LIMIT = 500;

export interface DiagnosticsOpencodeMessageOptions {
  limit: number;
  before?: string;
}

export interface DiagnosticsOpencodeSessionOptions {
  limit?: number;
  offset?: number;
}

export interface DiagnosticsHostSessionProjection {
  readonly source: 'chat-operation-v2-result';
  readonly operationId: string;
  readonly invocationId: string;
  readonly purpose: 'discussion' | 'diagnosis';
  readonly terminalOutcome: string | null;
  readonly resultId: string | null;
  readonly messages: readonly unknown[];
}

export interface DiagnosticsOpencodeDependencies {
  getWorkspace: (workspaceKey: string) => { workDir: string } | null | undefined;
  getHandle: (cwd: string) => OpencodeHandle | null;
  fetchOpencode: (input: OpencodeProxyRequest) => Promise<Response>;
  getHostSessionProjection?: (
    workspaceKey: string,
    sessionId: string,
  ) => DiagnosticsHostSessionProjection | null;
  getHostSessionAuthority?: (workspaceKey: string) => {
    readonly totalCount: number;
    readonly sessionIds: readonly string[];
  };
}

const DEFAULT_DEPENDENCIES: DiagnosticsOpencodeDependencies = {
  getWorkspace: (workspaceKey) => workspaceRegistry.get(workspaceKey),
  getHandle: getOpencodeHandle,
  fetchOpencode: fetchOpencodeProxy,
};

export function createDiagnosticsOpencodeSessionReader(
  getHostSessionAuthority: NonNullable<DiagnosticsOpencodeDependencies['getHostSessionAuthority']>,
): (workspaceKey: string | null, options: DiagnosticsOpencodeSessionOptions) => Promise<unknown> {
  const dependencies: DiagnosticsOpencodeDependencies = {
    ...DEFAULT_DEPENDENCIES,
    getHostSessionAuthority,
  };
  return (workspaceKey, options) =>
    readDiagnosticsOpencodeSessions(workspaceKey, dependencies, options);
}

export function createDiagnosticsOpencodeMessageReader(
  getHostSessionProjection: NonNullable<
    DiagnosticsOpencodeDependencies['getHostSessionProjection']
  >,
  getHostSessionAuthority?: NonNullable<DiagnosticsOpencodeDependencies['getHostSessionAuthority']>,
  baseDependencies: DiagnosticsOpencodeDependencies = DEFAULT_DEPENDENCIES,
): (
  workspaceKey: string | null,
  sessionId: string,
  options: DiagnosticsOpencodeMessageOptions,
) => Promise<unknown> {
  const dependencies: DiagnosticsOpencodeDependencies = {
    ...baseDependencies,
    getHostSessionProjection,
    ...(getHostSessionAuthority ? { getHostSessionAuthority } : {}),
  };
  return (workspaceKey, sessionId, options) =>
    readDiagnosticsOpencodeMessages(workspaceKey, sessionId, options, dependencies);
}

export class DiagnosticsReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiagnosticsReadError';
  }
}

function requireLiveOpencode(
  workspaceKey: string | null,
  dependencies: DiagnosticsOpencodeDependencies,
): OpencodeHandle {
  if (!workspaceKey) {
    throw new DiagnosticsReadError(409, 'The diagnostics workspace is no longer open.');
  }
  const workspace = dependencies.getWorkspace(workspaceKey);
  if (!workspace?.workDir) {
    throw new DiagnosticsReadError(409, 'The diagnostics workspace is no longer open.');
  }
  const handle = dependencies.getHandle(join(workspace.workDir, '.tagma'));
  if (!handle) {
    throw new DiagnosticsReadError(
      409,
      'OpenCode is not currently running for the diagnostics workspace.',
    );
  }
  return handle;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENCODE_DIAGNOSTICS_BYTES) {
    throw new DiagnosticsReadError(
      502,
      `OpenCode diagnostics response exceeds ${MAX_OPENCODE_DIAGNOSTICS_BYTES} bytes.`,
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_OPENCODE_DIAGNOSTICS_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DiagnosticsReadError(
        502,
        `OpenCode diagnostics response exceeds ${MAX_OPENCODE_DIAGNOSTICS_BYTES} bytes.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf8');
}

async function requestOpencodeJson(
  handle: OpencodeHandle,
  requestUrl: string,
  dependencies: DiagnosticsOpencodeDependencies,
): Promise<unknown> {
  const response = await dependencies.fetchOpencode({
    baseUrl: handle.baseUrl,
    authorization: handle.auth.authorization,
    requestUrl,
    method: 'GET',
    headers: new Headers({ Accept: 'application/json' }),
  });
  const text = await readBoundedText(response);
  if (!response.ok) {
    const detail = redactDiagnosticText(text).slice(0, 1_000);
    throw new DiagnosticsReadError(
      502,
      `OpenCode returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    throw new DiagnosticsReadError(502, 'OpenCode returned invalid JSON.');
  }
}

function unwrapArray(payload: unknown, label: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: unknown[] }).data;
  }
  throw new DiagnosticsReadError(502, `OpenCode returned an invalid ${label} payload.`);
}

interface OpenCodeMessagePage {
  messages: unknown[];
  previousCursor: string | null;
  nextCursor: string | null;
}

function parseOptionalCursor(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function unwrapMessagePage(payload: unknown): OpenCodeMessagePage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DiagnosticsReadError(502, 'OpenCode returned an invalid message page payload.');
  }
  const data = (payload as { data?: unknown }).data;
  const cursor = (payload as { cursor?: unknown }).cursor;
  if (!Array.isArray(data) || !cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw new DiagnosticsReadError(502, 'OpenCode returned an invalid message page payload.');
  }
  const previous = (cursor as { previous?: unknown }).previous;
  const next = (cursor as { next?: unknown }).next;
  if (
    (previous !== undefined && previous !== null && parseOptionalCursor(previous) === null) ||
    (next !== undefined && next !== null && parseOptionalCursor(next) === null)
  ) {
    throw new DiagnosticsReadError(502, 'OpenCode returned an invalid message page cursor.');
  }
  return {
    messages: data,
    previousCursor: parseOptionalCursor(previous),
    nextCursor: parseOptionalCursor(next),
  };
}

interface WorkspaceSessionDiscovery {
  sessions: unknown[];
  sourceQueries: {
    ownershipMayBeIncomplete: boolean;
    scoped: {
      limit: number;
      returnedCount: number;
      boundaryReached: boolean;
    };
    compatibilityDiscovery: {
      limit: number;
      returnedCount: number;
      boundaryReached: boolean;
      available: boolean;
    };
    hostAuthority: {
      limit: number;
      totalCount: number;
      candidateCount: number;
      matchedCount: number;
      omittedCount: number;
      boundaryReached: boolean;
    };
  };
}

async function listWorkspaceSessions(
  workspaceKey: string,
  handle: OpencodeHandle,
  dependencies: DiagnosticsOpencodeDependencies,
): Promise<WorkspaceSessionDiscovery> {
  const scopedQuery = new URLSearchParams({
    directory: handle.cwd,
    limit: String(OPENCODE_SCOPED_SESSION_LIMIT),
  });
  const discoveryQuery = new URLSearchParams({
    limit: String(OPENCODE_SESSION_DISCOVERY_LIMIT),
  });
  let compatibilityDiscoveryAvailable = true;
  const [scoped, discovered] = await Promise.all([
    requestOpencodeJson(handle, `/session?${scopedQuery}`, dependencies).then((payload) =>
      unwrapArray(payload, 'session list'),
    ),
    requestOpencodeJson(handle, `/session?${discoveryQuery}`, dependencies)
      .then((payload) => unwrapArray(payload, 'session discovery list'))
      .catch(() => {
        compatibilityDiscoveryAvailable = false;
        return [] as unknown[];
      }),
  ]);

  const sessionsById = new Map<string, unknown>();
  for (const session of discovered) {
    const id = sessionId(session);
    if (id) sessionsById.set(id, session);
  }
  for (const session of scoped) {
    const id = sessionId(session);
    if (id) {
      // The canonical scoped payload wins when discovery returns the same id.
      sessionsById.set(id, session);
    }
  }

  const ownedSessionIds = new Set<string>();
  const rawHostAuthority = dependencies.getHostSessionAuthority?.(workspaceKey) ?? {
    totalCount: 0,
    sessionIds: [],
  };
  const hostSessionIds = [
    ...new Set(
      rawHostAuthority.sessionIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512,
      ),
    ),
  ].slice(0, HOST_SESSION_AUTHORITY_LIMIT);
  const hostAuthorityTotalCount = Math.max(
    hostSessionIds.length,
    Number.isSafeInteger(rawHostAuthority.totalCount) && rawHostAuthority.totalCount >= 0
      ? rawHostAuthority.totalCount
      : hostSessionIds.length,
  );
  let hostAuthorityMatchedCount = 0;
  for (const id of hostSessionIds) {
    if (!sessionsById.has(id)) continue;
    ownedSessionIds.add(id);
    hostAuthorityMatchedCount += 1;
  }
  for (const [id, session] of sessionsById) {
    if (isWorkspaceRootOpencodeSession(session, handle.cwd, workspaceKey)) {
      ownedSessionIds.add(id);
    }
  }
  let admittedDescendant = true;
  while (admittedDescendant) {
    admittedDescendant = false;
    for (const [id, session] of sessionsById) {
      if (ownedSessionIds.has(id)) continue;
      const parentId = sessionParentId(session);
      if (!parentId || !ownedSessionIds.has(parentId)) continue;
      ownedSessionIds.add(id);
      admittedDescendant = true;
    }
  }
  const ownershipMayBeIncomplete = compatibilityDiscoveryAvailable
    ? discovered.length >= OPENCODE_SESSION_DISCOVERY_LIMIT
    : scoped.length >= OPENCODE_SCOPED_SESSION_LIMIT;
  return {
    sessions: [...sessionsById].flatMap(([id, session]) =>
      ownedSessionIds.has(id) ? [session] : [],
    ),
    sourceQueries: {
      ownershipMayBeIncomplete,
      scoped: {
        limit: OPENCODE_SCOPED_SESSION_LIMIT,
        returnedCount: scoped.length,
        boundaryReached: scoped.length >= OPENCODE_SCOPED_SESSION_LIMIT,
      },
      compatibilityDiscovery: {
        limit: OPENCODE_SESSION_DISCOVERY_LIMIT,
        returnedCount: discovered.length,
        boundaryReached: discovered.length >= OPENCODE_SESSION_DISCOVERY_LIMIT,
        available: compatibilityDiscoveryAvailable,
      },
      hostAuthority: {
        limit: HOST_SESSION_AUTHORITY_LIMIT,
        totalCount: hostAuthorityTotalCount,
        candidateCount: hostSessionIds.length,
        matchedCount: hostAuthorityMatchedCount,
        omittedCount: Math.max(0, hostAuthorityTotalCount - hostSessionIds.length),
        boundaryReached: hostAuthorityTotalCount > hostSessionIds.length,
      },
    },
  };
}

function sessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function sessionParentId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const parentId = (value as { parentID?: unknown }).parentID;
  return typeof parentId === 'string' && parentId.trim() ? parentId.trim() : null;
}

export async function readDiagnosticsOpencodeSessions(
  workspaceKey: string | null,
  dependencies: DiagnosticsOpencodeDependencies = DEFAULT_DEPENDENCIES,
  options: DiagnosticsOpencodeSessionOptions = {},
): Promise<unknown> {
  const handle = requireLiveOpencode(workspaceKey, dependencies);
  const discovery = await listWorkspaceSessions(workspaceKey!, handle, dependencies);
  const limit = Number.isFinite(options.limit)
    ? Math.min(
        MAX_DIAGNOSTICS_SESSION_PAGE_LIMIT,
        Math.max(1, Math.trunc(options.limit ?? DEFAULT_DIAGNOSTICS_SESSION_PAGE_LIMIT)),
      )
    : DEFAULT_DIAGNOSTICS_SESSION_PAGE_LIMIT;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset ?? 0)) : 0;
  const sessions = discovery.sessions.slice(offset, offset + limit);
  const omittedBeforeCount = Math.min(offset, discovery.sessions.length);
  const omittedAfterCount = Math.max(
    0,
    discovery.sessions.length - omittedBeforeCount - sessions.length,
  );
  return sanitizeDiagnosticValue(
    {
      workspaceKey,
      runtime: { pid: handle.pid, cwd: handle.cwd, baseUrl: handle.baseUrl },
      totalSessionCount: discovery.sessions.length,
      returnedSessionCount: sessions.length,
      sourceQueries: discovery.sourceQueries,
      pagination: {
        layer: 'diagnostics-opencode-session-page',
        offset,
        limit,
        omittedBeforeCount,
        omittedAfterCount,
        hasMore: omittedAfterCount > 0,
        nextOffset: omittedAfterCount > 0 ? offset + sessions.length : null,
      },
      sessions,
    },
    {
      maxDepth: 10,
      maxArrayItems: MAX_DIAGNOSTICS_SESSION_PAGE_LIMIT,
      maxObjectKeys: 150,
      maxStringChars: 32_768,
    },
  );
}

export async function readDiagnosticsOpencodeMessages(
  workspaceKey: string | null,
  requestedSessionId: string,
  options: DiagnosticsOpencodeMessageOptions,
  dependencies: DiagnosticsOpencodeDependencies = DEFAULT_DEPENDENCIES,
): Promise<unknown> {
  const handle = requireLiveOpencode(workspaceKey, dependencies);
  const discovery = await listWorkspaceSessions(workspaceKey!, handle, dependencies);
  const session = discovery.sessions.find(
    (candidate) => sessionId(candidate) === requestedSessionId,
  );
  if (!session) {
    if (discovery.sourceQueries.ownershipMayBeIncomplete) {
      throw new DiagnosticsReadError(
        409,
        'OpenCode session discovery reached its source query limit, so ownership of the requested session could not be determined.',
      );
    }
    throw new DiagnosticsReadError(
      404,
      'The requested OpenCode session does not belong to the diagnostics workspace.',
    );
  }

  const query = new URLSearchParams({
    limit: String(options.limit),
    order: 'desc',
  });
  if (options.before) query.set('cursor', options.before);
  const page = unwrapMessagePage(
    await requestOpencodeJson(
      handle,
      `/api/session/${encodeURIComponent(requestedSessionId)}/message?${query}`,
      dependencies,
    ),
  );
  const hostProjection =
    page.messages.length === 0 && options.before === undefined
      ? (dependencies.getHostSessionProjection?.(workspaceKey!, requestedSessionId) ?? null)
      : null;
  const messages = hostProjection?.messages ?? page.messages;
  const messageSource = hostProjection
    ? {
        kind: hostProjection.source,
        operationId: hostProjection.operationId,
        invocationId: hostProjection.invocationId,
        purpose: hostProjection.purpose,
        terminalOutcome: hostProjection.terminalOutcome,
        resultId: hostProjection.resultId,
      }
    : { kind: 'opencode-v2-projection' as const };
  const paginationLayer = hostProjection ? 'chat-operation-v2-result' : 'opencode-v2-message-page';
  return sanitizeDiagnosticValue(
    {
      workspaceKey,
      sessionId: requestedSessionId,
      limit: options.limit,
      before: options.before ?? null,
      returnedMessageCount: messages.length,
      messageSource,
      pagination: {
        layer: paginationLayer,
        limit: options.limit,
        before: options.before ?? null,
        returnedCount: messages.length,
        boundaryReached: hostProjection ? false : page.nextCursor !== null,
        previousBefore: hostProjection ? null : page.previousCursor,
        nextBefore: hostProjection ? null : page.nextCursor,
      },
      sessionDiscovery: discovery.sourceQueries,
      messages,
    },
    {
      maxDepth: 14,
      maxArrayItems: 200,
      maxObjectKeys: 200,
      maxStringChars: 32_768,
    },
  );
}
