import { join } from 'node:path';

import { redactDiagnosticText, sanitizeDiagnosticValue } from '../shared/diagnostics.js';
import { getOpencodeHandle, type OpencodeHandle } from './opencode-lifecycle.js';
import { fetchOpencodeProxy } from './opencode-proxy.js';
import { workspaceRegistry } from './workspace-registry.js';

const MAX_OPENCODE_DIAGNOSTICS_BYTES = 4 * 1024 * 1024;

export interface DiagnosticsOpencodeMessageOptions {
  limit: number;
  before?: string;
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

function requireLiveOpencode(workspaceKey: string | null): OpencodeHandle {
  if (!workspaceKey) {
    throw new DiagnosticsReadError(409, 'The diagnostics workspace is no longer open.');
  }
  const workspace = workspaceRegistry.get(workspaceKey);
  if (!workspace?.workDir) {
    throw new DiagnosticsReadError(409, 'The diagnostics workspace is no longer open.');
  }
  const handle = getOpencodeHandle(join(workspace.workDir, '.tagma'));
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
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_OPENCODE_DIAGNOSTICS_BYTES
  ) {
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
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

async function requestOpencodeJson(handle: OpencodeHandle, requestUrl: string): Promise<unknown> {
  const response = await fetchOpencodeProxy({
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

async function listScopedSessions(handle: OpencodeHandle): Promise<unknown[]> {
  const query = new URLSearchParams({
    directory: handle.cwd,
    limit: '100',
  });
  return unwrapArray(await requestOpencodeJson(handle, `/session?${query}`), 'session list');
}

function sessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

export async function readDiagnosticsOpencodeSessions(
  workspaceKey: string | null,
): Promise<unknown> {
  const handle = requireLiveOpencode(workspaceKey);
  const sessions = await listScopedSessions(handle);
  return sanitizeDiagnosticValue(
    {
      workspaceKey,
      runtime: { pid: handle.pid, cwd: handle.cwd, baseUrl: handle.baseUrl },
      sessions,
    },
    {
      maxDepth: 10,
      maxArrayItems: 100,
      maxObjectKeys: 150,
      maxStringChars: 32_768,
    },
  );
}

export async function readDiagnosticsOpencodeMessages(
  workspaceKey: string | null,
  requestedSessionId: string,
  options: DiagnosticsOpencodeMessageOptions,
): Promise<unknown> {
  const handle = requireLiveOpencode(workspaceKey);
  const sessions = await listScopedSessions(handle);
  if (!sessions.some((session) => sessionId(session) === requestedSessionId)) {
    throw new DiagnosticsReadError(
      404,
      'The requested OpenCode session does not belong to the diagnostics workspace.',
    );
  }

  const query = new URLSearchParams({
    directory: handle.cwd,
    limit: String(options.limit),
  });
  if (options.before) query.set('before', options.before);
  const messages = unwrapArray(
    await requestOpencodeJson(
      handle,
      `/session/${encodeURIComponent(requestedSessionId)}/message?${query}`,
    ),
    'message list',
  );
  return sanitizeDiagnosticValue(
    {
      workspaceKey,
      sessionId: requestedSessionId,
      limit: options.limit,
      before: options.before ?? null,
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
