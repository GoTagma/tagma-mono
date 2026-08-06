import type express from 'express';
import { join, resolve } from 'node:path';

import { DIAGNOSTICS_PROTOCOL_VERSION, sanitizeDiagnosticValue } from '../../shared/diagnostics.js';
import {
  DIAGNOSTICS_AGENT_BASE_PATH,
  diagnosticsAgentAuthorization,
  diagnosticsHub,
  readDesktopLogTailEvidence,
  type DiagnosticsHub,
} from '../diagnostics.js';
import { readGlobalSettings } from '../global-settings.js';
import {
  DiagnosticsReadError,
  readDiagnosticsOpencodeMessages,
  readDiagnosticsOpencodeSessions,
} from '../diagnostics-opencode.js';
import { collectServerDiagnosticsContributors } from '../diagnostics-contributors.js';
import { getOpencodeRuntimeDiagnostics } from '../opencode-lifecycle.js';
import { readEditorSettings } from '../plugins/loader.js';
import { getState } from '../state.js';
import { workspaceRegistry } from '../workspace-registry.js';
import type { WorkspaceState } from '../workspace-state.js';

export interface DiagnosticsRouteDependencies {
  hub?: DiagnosticsHub;
  buildContext?: (workspaceKey: string | null) => unknown | Promise<unknown>;
  readOpencodeSessions?: (
    workspaceKey: string | null,
    options: DiagnosticsOpencodeSessionOptions,
  ) => unknown | Promise<unknown>;
  readOpencodeMessages?: (
    workspaceKey: string | null,
    sessionId: string,
    options: DiagnosticsOpencodeMessageOptions,
  ) => unknown | Promise<unknown>;
}

export interface DiagnosticsOpencodeMessageOptions {
  limit: number;
  before?: string;
}

export interface DiagnosticsOpencodeSessionOptions {
  limit: number;
  offset: number;
}

const DIAGNOSTICS_EVENT_LIMIT = 250;

function requestOrigin(req: express.Request): string {
  const port = req.socket.localPort;
  return `http://127.0.0.1:${port}`;
}

function boundedMessageLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(200, Math.max(1, Math.trunc(parsed))) : 100;
}

function boundedSessionLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.trunc(parsed))) : 100;
}

function boundedSessionOffset(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(10_000, Math.max(0, Math.trunc(parsed))) : 0;
}

function sendDiagnosticsReadError(res: express.Response, error: unknown): void {
  const status = error instanceof DiagnosticsReadError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Diagnostics read failed.';
  res.status(status).json({ error: message });
}

function eventSequence(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const seq = (value as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? Math.trunc(seq) : null;
}

export function buildDiagnosticsEventWindow(source: readonly unknown[]): {
  retainedEventCount: number;
  returnedEventCount: number;
  omittedEventCount: number;
  sourceBuffer: {
    layer: 'run-event-buffer';
    state: 'not-truncated' | 'truncated' | 'unknown';
    firstSequence: number | null;
    lastSequence: number | null;
    omittedBeforeCount: number | null;
  };
  diagnosticsContext: {
    layer: 'diagnostics-context-event-window';
    limit: number;
    truncated: boolean;
    omittedEventCount: number;
  };
  events: unknown[];
} {
  const events = source.slice(-DIAGNOSTICS_EVENT_LIMIT);
  const omittedEventCount = Math.max(0, source.length - events.length);
  const firstSequence = eventSequence(source[0]);
  const lastSequence = eventSequence(source.at(-1));
  const omittedBeforeCount = firstSequence === null ? null : Math.max(0, firstSequence - 1);
  return {
    retainedEventCount: source.length,
    returnedEventCount: events.length,
    omittedEventCount,
    sourceBuffer: {
      layer: 'run-event-buffer',
      state: firstSequence === null ? 'unknown' : firstSequence > 1 ? 'truncated' : 'not-truncated',
      firstSequence,
      lastSequence,
      omittedBeforeCount,
    },
    diagnosticsContext: {
      layer: 'diagnostics-context-event-window',
      limit: DIAGNOSTICS_EVENT_LIMIT,
      truncated: omittedEventCount > 0,
      omittedEventCount,
    },
    events,
  };
}

function activeRunDiagnostics(ws: WorkspaceState): unknown[] {
  const runs: unknown[] = [];
  for (const rawSession of ws.runSessions.values()) {
    const session = rawSession as {
      runId?: unknown;
      startedAt?: unknown;
      success?: unknown;
      errorMessage?: unknown;
      allBuffered?: () => unknown[];
    };
    let eventWindow = buildDiagnosticsEventWindow([]);
    let eventReadError: string | null = null;
    try {
      eventWindow = buildDiagnosticsEventWindow(
        typeof session.allBuffered === 'function' ? session.allBuffered() : [],
      );
    } catch (error) {
      eventWindow = buildDiagnosticsEventWindow([]);
      eventReadError = error instanceof Error ? error.message : String(error);
    }
    runs.push({
      runId: session.runId ?? null,
      startedAt: session.startedAt ?? null,
      success: session.success ?? null,
      errorMessage: session.errorMessage ?? null,
      eventCount: eventWindow.retainedEventCount,
      returnedEventCount: eventWindow.returnedEventCount,
      omittedEventCount: eventWindow.omittedEventCount,
      eventEvidence: {
        sourceBuffer: eventWindow.sourceBuffer,
        diagnosticsContext: eventWindow.diagnosticsContext,
      },
      eventReadError,
      events: eventWindow.events,
    });
  }
  return runs;
}

function workflowRunDiagnostics(ws: WorkspaceState): unknown {
  const raw = ws.workflowRunSession as {
    graphRunId?: unknown;
    startedAt?: unknown;
    running?: unknown;
    result?: unknown;
    events?: unknown[];
  } | null;
  if (!raw) return null;
  const eventWindow = buildDiagnosticsEventWindow(Array.isArray(raw.events) ? raw.events : []);
  return {
    graphRunId: raw.graphRunId ?? null,
    startedAt: raw.startedAt ?? null,
    running: raw.running ?? null,
    result: raw.result ?? null,
    eventCount: eventWindow.retainedEventCount,
    returnedEventCount: eventWindow.returnedEventCount,
    omittedEventCount: eventWindow.omittedEventCount,
    eventEvidence: {
      sourceBuffer: eventWindow.sourceBuffer,
      diagnosticsContext: eventWindow.diagnosticsContext,
    },
    events: eventWindow.events,
  };
}

function parseMetadata(): unknown {
  try {
    return JSON.parse(process.env.TAGMA_METADATA_JSON ?? '{}') as unknown;
  } catch {
    return {};
  }
}

export function buildDefaultDiagnosticsContext(
  hub: DiagnosticsHub,
  workspaceKey: string | null,
): unknown {
  const ws = workspaceKey ? (workspaceRegistry.get(workspaceKey) ?? null) : null;
  const expectedOpencodeCwd = ws?.workDir ? resolve(join(ws.workDir, '.tagma')) : null;
  const opencode = getOpencodeRuntimeDiagnostics().filter(
    (runtime) => expectedOpencodeCwd === null || resolve(runtime.cwd) === expectedOpencodeCwd,
  );
  const memory = process.memoryUsage();
  const desktopLogEvidence = readDesktopLogTailEvidence();
  const { tail: desktopLogTail, ...desktopLogTailRead } = desktopLogEvidence;
  return sanitizeDiagnosticValue(
    {
      protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
      generatedAt: Date.now(),
      application: {
        editorVersion: process.env.TAGMA_EDITOR_BUNDLED_VERSION ?? null,
        sidecarVersion:
          process.env.TAGMA_SIDECAR_ACTIVE_VERSION ??
          process.env.TAGMA_SIDECAR_BUNDLED_VERSION ??
          null,
        sidecarSource: process.env.TAGMA_SIDECAR_ACTIVE_SOURCE ?? null,
        bundledOpencodeVersion: process.env.TAGMA_OPENCODE_BUNDLED_VERSION ?? null,
        release: parseMetadata(),
      },
      process: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        uptimeSec: process.uptime(),
        versions: process.versions,
        memoryBytes: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
      },
      workspace: ws
        ? {
            key: ws.key,
            state: getState(ws),
            editorSettings: readEditorSettings(ws),
            activeRuns: activeRunDiagnostics(ws),
            workflowRun: workflowRunDiagnostics(ws),
            stateEventSubscriberCount: ws.stateEventClients.size,
            runEventSubscriberCount: ws.runSseClients.size,
            workflowEventSubscriberCount: ws.workflowSseClients.size,
          }
        : null,
      openWorkspaces: Array.from(workspaceRegistry.keys()),
      globalSettings: readGlobalSettings(),
      opencode,
      features: collectServerDiagnosticsContributors({ workspaceKey, workspace: ws }),
      renderer: hub.getRendererReports(),
      runtimeLogs: hub.readLogs(0, 250),
      desktopLogTail,
      desktopLogTailRead,
    },
    {
      maxDepth: 12,
      maxArrayItems: 250,
      maxObjectKeys: 200,
      maxStringChars: 32_768,
    },
  );
}

export function registerDiagnosticsRoutes(
  app: express.Express,
  dependencies: DiagnosticsRouteDependencies = {},
): void {
  const hub = dependencies.hub ?? diagnosticsHub;
  const buildContext =
    dependencies.buildContext ??
    ((workspaceKey) => buildDefaultDiagnosticsContext(hub, workspaceKey));
  const readOpencodeSessions =
    dependencies.readOpencodeSessions ??
    ((workspaceKey, options) => readDiagnosticsOpencodeSessions(workspaceKey, undefined, options));
  const readOpencodeMessages = dependencies.readOpencodeMessages ?? readDiagnosticsOpencodeMessages;

  app.get('/api/diagnostics/session', (req, res) => {
    res.json(hub.getStatus(requestOrigin(req)));
  });

  app.post('/api/diagnostics/session', (req, res) => {
    const workspaceKey = req.workspace?.workDir || null;
    if (!workspaceKey) {
      return res.status(400).json({ error: 'Open a workspace before enabling diagnostics.' });
    }
    res.json(hub.enable(workspaceKey, requestOrigin(req)));
  });

  app.delete('/api/diagnostics/session', (_req, res) => {
    hub.disable();
    res.json({ enabled: false });
  });

  app.post('/api/diagnostics/renderer', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const workspaceKey = req.workspace?.workDir || null;
    const activeWorkspaceKey = hub.activeWorkspaceKey();
    if (activeWorkspaceKey !== null && workspaceKey !== activeWorkspaceKey) {
      return res.status(409).json({
        error: 'Diagnostics are enabled for a different workspace.',
      });
    }
    const accepted = hub.acceptRendererReport({
      ...(body as import('../../shared/diagnostics.js').RendererDiagnosticsReport),
      workspaceKey,
    });
    if (!accepted) {
      return res.status(409).json({ error: 'Diagnostics are not enabled.' });
    }
    res.json({ ok: true });
  });

  app.use(DIAGNOSTICS_AGENT_BASE_PATH, (req, res, next) => {
    const decision = diagnosticsAgentAuthorization(
      hub,
      DIAGNOSTICS_AGENT_BASE_PATH,
      req.method,
      req.get('authorization'),
    );
    if (decision.kind === 'authorized') return next();
    if (decision.kind === 'not-diagnostics') return next();
    return res.status(decision.status).json({ error: decision.error });
  });

  app.get(`${DIAGNOSTICS_AGENT_BASE_PATH}/manifest`, (_req, res) => {
    res.json({
      protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
      readOnly: true,
      sessionScoped: true,
      transport: 'loopback-http',
      authentication: 'Authorization: Bearer <diagnostics-token>',
      endpoints: {
        manifest: `${DIAGNOSTICS_AGENT_BASE_PATH}/manifest`,
        context: `${DIAGNOSTICS_AGENT_BASE_PATH}/context`,
        logs: `${DIAGNOSTICS_AGENT_BASE_PATH}/logs`,
        opencodeSessions: `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions`,
        opencodeMessages: `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions/{sessionId}/messages`,
      },
      logPolling: {
        query: { after: 'cursor from the previous response', limit: '1-1000' },
        next: 'Use nextCursor as the next after value.',
        bounds:
          'Inspect retention and page separately; buffer loss is not the same as response pagination.',
      },
      sessionPagination: {
        query: { offset: 'zero-based owned-session offset', limit: '1-500' },
        next: 'Use pagination.nextOffset until pagination.hasMore is false.',
        source:
          'Inspect sourceQueries separately; an OpenCode discovery query boundary is not diagnostics response pagination.',
      },
      extensibility: {
        contextNamespace: 'features',
        rendererRegistration: 'registerRendererDiagnosticsContributor',
        serverRegistration: 'registerServerDiagnosticsContributor',
        execution: 'Contributors are lazy and run only while diagnostics context is collected.',
      },
      coverage: [
        'Electron launcher sidecar log tail, including managed OpenCode stdout/stderr',
        'managed OpenCode runtime metadata',
        'workspace-scoped OpenCode session list and bounded message history',
        'renderer console/errors and transient OpenCode chat state',
        'current editor pipeline state and active run events',
      ],
      privacy:
        'Known credential fields and common token forms are redacted and payloads are bounded. User-authored text can still contain sensitive data; do not share diagnostics without review.',
    });
  });

  app.get(`${DIAGNOSTICS_AGENT_BASE_PATH}/context`, async (_req, res) => {
    res.json(await buildContext(hub.activeWorkspaceKey()));
  });

  app.get(`${DIAGNOSTICS_AGENT_BASE_PATH}/logs`, (req, res) => {
    const after = Number(req.query.after ?? 0);
    const limit = Number(req.query.limit ?? 500);
    const desktopLogEvidence = readDesktopLogTailEvidence();
    const { tail: desktopLogTail, ...desktopLogTailRead } = desktopLogEvidence;
    res.json({
      ...hub.readLogs(after, limit),
      desktopLogTail,
      desktopLogTailRead,
    });
  });

  app.get(`${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions`, async (_req, res) => {
    try {
      res.json(
        await readOpencodeSessions(hub.activeWorkspaceKey(), {
          limit: boundedSessionLimit(_req.query.limit),
          offset: boundedSessionOffset(_req.query.offset),
        }),
      );
    } catch (error) {
      sendDiagnosticsReadError(res, error);
    }
  });

  app.get(
    `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions/:sessionId/messages`,
    async (req, res) => {
      const sessionId = req.params.sessionId;
      if (
        typeof sessionId !== 'string' ||
        sessionId.trim().length === 0 ||
        sessionId.length > 512
      ) {
        return res.status(400).json({ error: 'A valid OpenCode session id is required.' });
      }
      const before =
        typeof req.query.before === 'string' && req.query.before.length > 0
          ? req.query.before.slice(0, 512)
          : undefined;
      try {
        res.json(
          await readOpencodeMessages(hub.activeWorkspaceKey(), sessionId, {
            limit: boundedMessageLimit(req.query.limit),
            ...(before ? { before } : {}),
          }),
        );
      } catch (error) {
        sendDiagnosticsReadError(res, error);
      }
    },
  );
}
