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
  latestCursor: number;
  nextCursor: number;
  droppedBeforeCursor: boolean;
  retainedEntryCount: number;
  availableEntryCount: number;
  returnedEntryCount: number;
  omittedEntryCount: number;
  hasMore: boolean;
  retention: {
    layer: 'diagnostics-log-buffer';
    droppedEntryCount: number;
    requestedEntryLossCount: number;
    truncated: boolean;
  };
  page: {
    layer: 'diagnostics-log-page';
    limit: number;
    omittedEntryCount: number;
    truncated: boolean;
  };
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
  logEvidence: {
    layer: 'renderer-report-log-ingest';
    sourceLogCount: number;
    selectedLogCount: number;
    ingestedLogCount: number;
    omittedHeadCount: number;
    invalidSelectedCount: number;
  };
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
  private droppedLogEntryCount = 0;
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
    this.resetCapturedData();
    this.session = {
      id: this.idFactory(),
      token: this.tokenFactory(),
      enabledAt: Date.now(),
      workspaceKey,
    };
    this.recordLog('diagnostics', 'info', 'A temporary read-only diagnostics session was enabled.');
    return this.getStatus(origin) as Extract<DiagnosticsSessionStatus, { enabled: true }>;
  }

  disable(): void {
    this.session = null;
    this.resetCapturedData();
  }

  private resetCapturedData(): void {
    this.logs.length = 0;
    this.logBytes = 0;
    this.logCursor = 0;
    this.droppedLogEntryCount = 0;
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
    if (!this.session) return;
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
      if (removed) {
        this.logBytes -= Buffer.byteLength(removed.message, 'utf8');
        this.droppedLogEntryCount += 1;
      }
    }
  }

  readLogs(afterCursor = 0, limit = 500): DiagnosticLogPage {
    const boundedAfter = Number.isFinite(afterCursor) ? Math.max(0, Math.trunc(afterCursor)) : 0;
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(limit)))
      : 500;
    const oldestCursor = this.logs[0]?.cursor ?? null;
    const available = this.logs.filter((entry) => entry.cursor > boundedAfter);
    const entries = available.slice(0, boundedLimit).map((entry) => ({ ...entry }));
    const omittedEntryCount = Math.max(0, available.length - entries.length);
    const requestedEntryLossCount =
      oldestCursor === null ? 0 : Math.max(0, oldestCursor - (boundedAfter + 1));
    return {
      oldestCursor,
      latestCursor: this.logCursor,
      nextCursor: entries.at(-1)?.cursor ?? this.logCursor,
      droppedBeforeCursor: requestedEntryLossCount > 0,
      retainedEntryCount: this.logs.length,
      availableEntryCount: available.length,
      returnedEntryCount: entries.length,
      omittedEntryCount,
      hasMore: omittedEntryCount > 0,
      retention: {
        layer: 'diagnostics-log-buffer',
        droppedEntryCount: this.droppedLogEntryCount,
        requestedEntryLossCount,
        truncated: requestedEntryLossCount > 0,
      },
      page: {
        layer: 'diagnostics-log-page',
        limit: boundedLimit,
        omittedEntryCount,
        truncated: omittedEntryCount > 0,
      },
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
    const storedReport = {
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
    };
    const selectedLogs = report.logs.slice(-250);
    let ingestedLogCount = 0;
    let invalidSelectedCount = 0;
    for (const entry of selectedLogs) {
      if (
        !entry ||
        typeof entry.message !== 'string' ||
        typeof entry.timestamp !== 'number' ||
        !Number.isFinite(entry.timestamp)
      ) {
        invalidSelectedCount += 1;
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
      ingestedLogCount += 1;
    }
    this.rendererReports.set(instanceId, {
      ...storedReport,
      logEvidence: {
        layer: 'renderer-report-log-ingest',
        sourceLogCount: report.logs.length,
        selectedLogCount: selectedLogs.length,
        ingestedLogCount,
        omittedHeadCount: Math.max(0, report.logs.length - selectedLogs.length),
        invalidSelectedCount,
      },
    });
    return true;
  }

  getRendererReports(): StoredRendererReport[] {
    return Array.from(this.rendererReports.values())
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map((report) => ({ ...report }));
  }
}

export const diagnosticsHub = new DiagnosticsHub();

export interface DesktopLogTail {
  path: string;
  truncated: boolean;
  totalBytes: number;
  readBytes: number;
  sourceReturnedBytes: number;
  returnedBytes: number;
  truncation: {
    layer: 'diagnostics-desktop-log-tail';
    reason: 'byte-limit';
    limitBytes: number;
    omittedHeadBytes: number;
    discardedPartialLineBytes: number;
  } | null;
  text: string;
}

export type DesktopLogTailEvidence =
  | { status: 'not-configured'; path: null; error: null; tail: null }
  | { status: 'available'; path: string; error: null; tail: DesktopLogTail }
  | { status: 'read-error'; path: string; error: string; tail: null };

/** Read the launcher-maintained sidecar log tail when running under Electron. */
export function readDesktopLogTailEvidence(maxBytes = 32 * 1024): DesktopLogTailEvidence {
  const configured = process.env.TAGMA_DESKTOP_LOG_FILE?.trim();
  if (!configured) return { status: 'not-configured', path: null, error: null, tail: null };
  let fd: number | null = null;
  try {
    fd = openSync(configured, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        status: 'read-error',
        path: configured,
        error: 'Configured desktop log path is not a regular file.',
        tail: null,
      };
    }
    const limitBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 32 * 1024;
    const length = Math.min(limitBytes, stat.size);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    let source = buffer.subarray(0, bytesRead);
    let discardedPartialLineBytes = 0;
    if (offset > 0) {
      const firstNewline = source.indexOf(0x0a);
      if (firstNewline >= 0) {
        discardedPartialLineBytes = firstNewline + 1;
        source = source.subarray(discardedPartialLineBytes);
      }
    }
    const text = redactDiagnosticText(source.toString('utf8'));
    const tail: DesktopLogTail = {
      path: configured,
      truncated: offset > 0,
      totalBytes: stat.size,
      readBytes: bytesRead,
      sourceReturnedBytes: source.byteLength,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
      truncation:
        offset > 0
          ? {
              layer: 'diagnostics-desktop-log-tail',
              reason: 'byte-limit',
              limitBytes,
              omittedHeadBytes: offset + discardedPartialLineBytes,
              discardedPartialLineBytes,
            }
          : null,
      text,
    };
    return { status: 'available', path: configured, error: null, tail };
  } catch (error) {
    return {
      status: 'read-error',
      path: configured,
      error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
      tail: null,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readDesktopLogTail(maxBytes = 32 * 1024): DesktopLogTail | null {
  return readDesktopLogTailEvidence(maxBytes).tail;
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
