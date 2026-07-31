import {
  api,
  getClientWorkspace,
  type DiagnosticsSessionStatus,
} from '../api/client';
import { useChatStore } from '../store/chat-store';
import { usePipelineStore } from '../store/pipeline-store';
import { useRunStore } from '../store/run-store';
import {
  sanitizeDiagnosticValue,
  type DiagnosticLogLevel,
  type RendererDiagnosticLog,
} from '../../shared/diagnostics.js';
import { buildRendererDiagnosticsSnapshot } from './renderer-diagnostics';

const STATUS_INTERVAL_MS = 3_000;
const REPORT_INTERVAL_MS = 1_000;
const MAX_PENDING_LOGS = 500;

type ConsoleMethod = 'debug' | 'info' | 'warn' | 'error';

let started = false;
let activeSession: Extract<DiagnosticsSessionStatus, { enabled: true }> | null = null;
let pendingLogs: RendererDiagnosticLog[] = [];
let statusRequest: Promise<void> | null = null;
let reportRequest: Promise<void> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;
let stopCapture: (() => void) | null = null;

const instanceId = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

function diagnosticsActiveForCurrentWorkspace(
  status: DiagnosticsSessionStatus,
): status is Extract<DiagnosticsSessionStatus, { enabled: true }> {
  return status.enabled && status.workspaceKey === getClientWorkspace();
}

function formatDiagnosticLogArgs(args: unknown[]): string {
  if (args.length === 1 && typeof args[0] === 'string') {
    return String(
      sanitizeDiagnosticValue(args[0], {
        maxDepth: 4,
        maxArrayItems: 25,
        maxObjectKeys: 50,
        maxStringChars: 16_384,
      }),
    );
  }
  const sanitized = sanitizeDiagnosticValue(args, {
    maxDepth: 6,
    maxArrayItems: 50,
    maxObjectKeys: 75,
    maxStringChars: 16_384,
  });
  try {
    return JSON.stringify(sanitized);
  } catch {
    return String(sanitized);
  }
}

function recordRendererLog(level: DiagnosticLogLevel, args: unknown[]): void {
  if (!activeSession) return;
  pendingLogs.push({
    timestamp: Date.now(),
    level,
    message: formatDiagnosticLogArgs(args),
  });
  if (pendingLogs.length > MAX_PENDING_LOGS) {
    pendingLogs.splice(0, pendingLogs.length - MAX_PENDING_LOGS);
  }
}

function installRendererLogCapture(): () => void {
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  const methods: ReadonlyArray<[ConsoleMethod, DiagnosticLogLevel]> = [
    ['debug', 'debug'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];
  for (const [method, level] of methods) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      original(...args);
      recordRendererLog(level, args);
    };
  }

  const onWindowError = (event: ErrorEvent) => {
    recordRendererLog('error', [
      'window.error',
      event.message,
      event.filename,
      event.lineno,
      event.colno,
      event.error,
    ]);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    recordRendererLog('error', ['unhandledrejection', event.reason]);
  };
  window.addEventListener('error', onWindowError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  return () => {
    for (const [method, original] of originals) console[method] = original;
    window.removeEventListener('error', onWindowError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}

async function refreshStatus(): Promise<void> {
  if (statusRequest) return statusRequest;
  statusRequest = (async () => {
    try {
      const status = await api.getDiagnosticsSession();
      const nextSession = diagnosticsActiveForCurrentWorkspace(status) ? status : null;
      if (nextSession?.sessionId !== activeSession?.sessionId) pendingLogs = [];
      activeSession = nextSession;
    } catch {
      activeSession = null;
      pendingLogs = [];
    }
  })().finally(() => {
    statusRequest = null;
  });
  return statusRequest;
}

async function reportSnapshot(): Promise<void> {
  if (!activeSession || reportRequest) return reportRequest ?? Promise.resolve();
  const workspaceKey = getClientWorkspace();
  if (workspaceKey !== activeSession.workspaceKey) {
    activeSession = null;
    pendingLogs = [];
    return;
  }

  const sentLogs = pendingLogs.slice();
  const report = {
    instanceId,
    workspaceKey,
    capturedAt: Date.now(),
    snapshot: buildRendererDiagnosticsSnapshot({
      page: {
        href: window.location.href,
        visibilityState: document.visibilityState,
        online: navigator.onLine,
      },
      chat: useChatStore.getState() as unknown as Record<string, unknown>,
      pipeline: usePipelineStore.getState() as unknown as Record<string, unknown>,
      run: useRunStore.getState() as unknown as Record<string, unknown>,
    }),
    logs: sentLogs,
  };

  reportRequest = api
    .reportRendererDiagnostics(report)
    .then(() => {
      pendingLogs.splice(0, sentLogs.length);
    })
    .catch(() => {
      activeSession = null;
    })
    .finally(() => {
      reportRequest = null;
    });
  return reportRequest;
}

/**
 * Re-check the server-side session immediately. Settings uses this after an
 * enable/disable action so the first snapshot does not wait for the polling
 * interval.
 */
export async function refreshRendererDiagnosticsBridge(): Promise<void> {
  await refreshStatus();
  await reportSnapshot();
}

/**
 * Install session-aware console/error capture and the bounded diagnostics
 * reporter. Capture retains nothing until the user explicitly enables a
 * diagnostics session for this renderer's current workspace.
 */
export function startRendererDiagnosticsBridge(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  stopCapture = installRendererLogCapture();
  void refreshRendererDiagnosticsBridge();
  statusTimer = setInterval(() => void refreshStatus(), STATUS_INTERVAL_MS);
  reportTimer = setInterval(() => void reportSnapshot(), REPORT_INTERVAL_MS);
}

export function stopRendererDiagnosticsBridge(): void {
  if (!started) return;
  started = false;
  if (statusTimer) clearInterval(statusTimer);
  if (reportTimer) clearInterval(reportTimer);
  statusTimer = null;
  reportTimer = null;
  stopCapture?.();
  stopCapture = null;
  activeSession = null;
  pendingLogs = [];
}
