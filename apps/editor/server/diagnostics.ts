import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  redactDiagnosticText,
  sanitizeDiagnosticValue,
  type DiagnosticLogLevel,
  type DiagnosticsConnection,
  type DiagnosticsSessionStatus,
  type RendererDiagnosticsReport,
} from '../shared/diagnostics.js';

export const DIAGNOSTICS_AGENT_BASE_PATH = '/api/diagnostics/v1';

export interface DiagnosticLogEntry {
  cursor: number;
  timestamp: number;
  source:
    | 'sidecar.stdout'
    | 'sidecar.stderr'
    | 'opencode.stdout'
    | 'opencode.stderr'
    | 'renderer.console'
    | 'renderer.error'
    | 'diagnostics';
  level: DiagnosticLogLevel;
  message: string;
}

export interface DiagnosticLogPage {
  oldestCursor: number | null;
  nextCursor: number;
  droppedBeforeCursor: boolean;
  entries: DiagnosticLogEntry[];
}

interface DiagnosticsSession {
  id: string;
  token: string;
  enabledAt: number;
  workspaceKey: string | null;
}

interface StoredRendererReport {
  instanceId: string;
  workspaceKey: string | null;
  capturedAt: number;
  snapshot: unknown;
}

export interface DiagnosticsHubOptions {
  maxLogEntries?: number;
  maxLogBytes?: number;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

export class DiagnosticsHub {
  private readonly maxLogEntries: number;
  private readonly maxLogBytes: number;
  private readonly tokenFactory: () => string;
  private readonly idFactory: () => string;
  private readonly logs: DiagnosticLogEntry[] = [];
  private readonly rendererReports = new Map<string, StoredRendererReport>();
  private logBytes = 0;
  private logCursor = 0;
  private session: DiagnosticsSession | null = null;

  constructor(options: DiagnosticsHubOptions = {}) {
    this.maxLogEntries = Math.max(1, options.maxLogEntries ?? 2_000);
    this.maxLogBytes = Math.max(1_024, options.maxLogBytes ?? 2 * 1024 * 1024);
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.idFactory = options.idFactory ?? (() => randomBytes(12).toString('base64url'));
  }

  enable(
    workspaceKey: string | null,
    origin: string,
  ): Extract<DiagnosticsSessionStatus, { enabled: true }> {
    this.session = {
      id: this.idFactory(),
      token: this.tokenFactory(),
      enabledAt: Date.now(),
      workspaceKey,
    };
    this.rendererReports.clear();
    this.recordLog('diagnostics', 'info', 'A temporary read-only diagnostics session was enabled.');
    return this.getStatus(origin) as Extract<DiagnosticsSessionStatus, { enabled: true }>;
  }

  disable(): void {
    if (this.session) {
      this.recordLog('diagnostics', 'info', 'The temporary diagnostics session was disabled.');
    }
    this.session = null;
    this.rendererReports.clear();
  }

  getStatus(origin: string): DiagnosticsSessionStatus {
    const session = this.session;
    if (!session) return { enabled: false };
    return {
      enabled: true,
      sessionId: session.id,
      enabledAt: session.enabledAt,
      workspaceKey: session.workspaceKey,
      connection: this.connection(origin, session),
    };
  }

  private connection(origin: string, session: DiagnosticsSession): DiagnosticsConnection {
    return {
      protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
      baseUrl: `${origin.replace(/\/+$/, '')}${DIAGNOSTICS_AGENT_BASE_PATH}`,
      token: session.token,
      workspaceKey: session.workspaceKey,
    };
  }

  authorize(candidate: string | null | undefined): boolean {
    const expected = this.session?.token;
    if (!expected || !candidate) return false;
    const expectedBytes = Buffer.from(expected);
    const candidateBytes = Buffer.from(candidate);
    return (
      expectedBytes.length === candidateBytes.length &&
      timingSafeEqual(expectedBytes, candidateBytes)
    );
  }

  activeWorkspaceKey(): string | null {
    return this.session?.workspaceKey ?? null;
  }

  recordLog(
    source: DiagnosticLogEntry['source'],
    level: DiagnosticLogLevel,
    message: string,
    timestamp = Date.now(),
  ): void {
    const redacted = redactDiagnosticText(message);
    const entry: DiagnosticLogEntry = {
      cursor: ++this.logCursor,
      timestamp,
      source,
      level,
      message: redacted,
    };
    this.logs.push(entry);
    this.logBytes += Buffer.byteLength(redacted, 'utf8');
    while (
      this.logs.length > 1 &&
      (this.logs.length > this.maxLogEntries || this.logBytes > this.maxLogBytes)
    ) {
      const removed = this.logs.shift();
      if (removed) this.logBytes -= Buffer.byteLength(removed.message, 'utf8');
    }
  }

  readLogs(afterCursor = 0, limit = 500): DiagnosticLogPage {
    const boundedAfter = Number.isFinite(afterCursor) ? Math.max(0, Math.trunc(afterCursor)) : 0;
    const boundedLimit = Number.isFinite(limit) ? Math.min(1_000, Math.max(1, Math.trunc(limit))) : 500;
    const oldestCursor = this.logs[0]?.cursor ?? null;
    const entries = this.logs
      .filter((entry) => entry.cursor > boundedAfter)
      .slice(0, boundedLimit)
      .map((entry) => ({ ...entry }));
    return {
      oldestCursor,
      nextCursor: entries.at(-1)?.cursor ?? this.logCursor,
      droppedBeforeCursor: oldestCursor !== null && boundedAfter < oldestCursor,
      entries,
    };
  }

  acceptRendererReport(report: RendererDiagnosticsReport): boolean {
    if (!this.session) return false;
    if (
      !report ||
      typeof report.instanceId !== 'string' ||
      report.instanceId.trim().length === 0 ||
      typeof report.capturedAt !== 'number' ||
      !Number.isFinite(report.capturedAt) ||
      !Array.isArray(report.logs)
    ) {
      return false;
    }
    const instanceId = report.instanceId.slice(0, 128);
    this.rendererReports.set(instanceId, {
      instanceId,
      workspaceKey:
        typeof report.workspaceKey === 'string' ? report.workspaceKey.slice(0, 4_096) : null,
      capturedAt: report.capturedAt,
      snapshot: sanitizeDiagnosticValue(report.snapshot, {
        maxDepth: 10,
        maxArrayItems: 100,
        maxObjectKeys: 150,
        maxStringChars: 16_384,
      }),
    });
    for (const entry of report.logs.slice(-250)) {
      if (
        !entry ||
        typeof entry.message !== 'string' ||
        typeof entry.timestamp !== 'number' ||
        !Number.isFinite(entry.timestamp)
      ) {
        continue;
      }
      const level: DiagnosticLogLevel =
        entry.level === 'debug' ||
        entry.level === 'info' ||
        entry.level === 'warn' ||
        entry.level === 'error'
          ? entry.level
          : 'info';
      this.recordLog(
        level === 'error' ? 'renderer.error' : 'renderer.console',
        level,
        entry.message,
        entry.timestamp,
      );
    }
    return true;
  }

  getRendererReports(): StoredRendererReport[] {
    return Array.from(this.rendererReports.values())
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map((report) => ({ ...report }));
  }
}

export const diagnosticsHub = new DiagnosticsHub();

let processCaptureInstalled = false;
const processOutputCarry: Record<'stdout' | 'stderr', string> = {
  stdout: '',
  stderr: '',
};

function processLogSource(
  stream: 'stdout' | 'stderr',
  line: string,
): DiagnosticLogEntry['source'] {
  if (line.startsWith('[opencode]')) {
    return stream === 'stderr' ? 'opencode.stderr' : 'opencode.stdout';
  }
  return stream === 'stderr' ? 'sidecar.stderr' : 'sidecar.stdout';
}

function captureProcessChunk(
  hub: DiagnosticsHub,
  stream: 'stdout' | 'stderr',
  chunk: string | Uint8Array,
  encoding?: BufferEncoding,
): void {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(encoding ?? 'utf8');
  const combined = processOutputCarry[stream] + text;
  const lines = combined.split(/\r?\n/);
  processOutputCarry[stream] = lines.pop() ?? '';
  for (const line of lines) {
    if (!line) continue;
    hub.recordLog(
      processLogSource(stream, line),
      stream === 'stderr' ? 'error' : 'info',
      line,
    );
  }
  if (processOutputCarry[stream].length > 32_768) {
    hub.recordLog(
      processLogSource(stream, processOutputCarry[stream]),
      stream === 'stderr' ? 'error' : 'info',
      processOutputCarry[stream],
    );
    processOutputCarry[stream] = '';
  }
}

/**
 * Mirror sidecar and managed OpenCode stdout/stderr into the bounded in-memory
 * diagnostics ring while preserving the original process streams verbatim.
 */
export function installProcessDiagnosticsCapture(hub = diagnosticsHub): void {
  if (processCaptureInstalled) return;
  processCaptureInstalled = true;
  for (const [name, stream] of [
    ['stdout', process.stdout],
    ['stderr', process.stderr],
  ] as const) {
    const original = stream.write;
    stream.write = function writeWithDiagnosticsCapture(
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean {
      const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
      try {
        captureProcessChunk(hub, name, chunk, encoding);
      } catch {
        // Diagnostics must never interfere with the real output stream.
      }
      return Reflect.apply(original, this, [chunk, encodingOrCallback, callback]) as boolean;
    } as typeof stream.write;
  }
}

export interface DesktopLogTail {
  path: string;
  truncated: boolean;
  text: string;
}

/** Read the launcher-maintained sidecar log tail when running under Electron. */
export function readDesktopLogTail(maxBytes = 256 * 1024): DesktopLogTail | null {
  const configured = process.env.TAGMA_DESKTOP_LOG_FILE?.trim();
  if (!configured) return null;
  let fd: number | null = null;
  try {
    fd = openSync(configured, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(Math.max(1, maxBytes), stat.size);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return {
      path: configured,
      truncated: offset > 0,
      text: redactDiagnosticText(buffer.subarray(0, bytesRead).toString('utf8')),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function isDiagnosticsAgentPath(path: string): boolean {
  return path === DIAGNOSTICS_AGENT_BASE_PATH || path.startsWith(`${DIAGNOSTICS_AGENT_BASE_PATH}/`);
}

type DiagnosticsAgentAuthorization =
  | { kind: 'not-diagnostics' }
  | { kind: 'authorized' }
  | { kind: 'rejected'; status: 401 | 403 | 405; error: string };

export function diagnosticsAgentAuthorization(
  hub: DiagnosticsHub,
  path: string,
  method: string,
  authorization: string | undefined,
): DiagnosticsAgentAuthorization {
  if (!isDiagnosticsAgentPath(path)) return { kind: 'not-diagnostics' };
  if (method.toUpperCase() !== 'GET') {
    return {
      kind: 'rejected',
      status: 405,
      error: 'Diagnostics agent API is read-only.',
    };
  }
  if (!authorization?.startsWith('Bearer ')) {
    return {
      kind: 'rejected',
      status: 401,
      error: 'Missing diagnostics token. Provide: Authorization: Bearer <token>.',
    };
  }
  if (!hub.authorize(authorization.slice(7))) {
    return {
      kind: 'rejected',
      status: 403,
      error: 'Invalid diagnostics token.',
    };
  }
  return { kind: 'authorized' };
}
