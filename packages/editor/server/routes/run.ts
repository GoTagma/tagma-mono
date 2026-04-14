import type express from 'express';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  serializePipeline,
  loadPipeline,
  validateConfig,
  runPipeline,
  InMemoryApprovalGateway,
  clip,
  unregisterPlugin,
  generateRunId,
} from '@tagma/sdk';
import type {
  PipelineEvent,
  EngineResult,
} from '@tagma/sdk';
import type {
  TaskState,
  TaskStatus,
  ApprovalRequest,
  ApprovalEvent,
  Permissions,
} from '@tagma/types';
import { assertSafePluginName } from '../plugin-safety.js';
import { S, MAX_LOG_RUNS } from '../state.js';
import {
  loadedPluginMeta,
  loadPluginFromWorkDir,
  classifyServerError,
} from '../plugins/loader.js';

// ═══ Pipeline Run ═══

interface RunTaskLogLine {
  level: 'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet';
  timestamp: string;
  text: string;
}

interface RunTaskWire {
  taskId: string;
  trackId: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputPath: string | null;
  stderrPath: string | null;
  sessionId: string | null;
  normalizedOutput: string | null;
  resolvedDriver: string | null;
  resolvedModelTier: string | null;
  resolvedPermissions: Permissions | null;
  logs: RunTaskLogLine[];
  totalLogCount: number;
}

type RunEvent =
  | { type: 'run_start'; runId: string; tasks: RunTaskWire[] }
  | { type: 'run_snapshot'; runId: string; tasks: RunTaskWire[]; pendingApprovals: Array<{ id: string; taskId: string; trackId?: string; message: string; createdAt: string; timeoutMs: number; metadata?: Record<string, unknown> }> }
  | {
      type: 'task_update';
      runId: string;
      taskId: string;
      status: TaskStatus;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      outputPath?: string | null;
      stderrPath?: string | null;
      sessionId?: string | null;
      normalizedOutput?: string | null;
      resolvedDriver?: string | null;
      resolvedModelTier?: string | null;
      resolvedPermissions?: Permissions | null;
    }
  | { type: 'run_end'; runId: string; success: boolean }
  | { type: 'run_error'; runId: string; error: string }
  | { type: 'log'; runId: string; line: string }
  | {
      type: 'task_log';
      runId: string;
      taskId: string | null;
      level: 'info' | 'warn' | 'error' | 'debug' | 'section' | 'quiet';
      timestamp: string;
      text: string;
    }
  | { type: 'approval_request'; runId: string; request: { id: string; taskId: string; trackId?: string; message: string; createdAt: string; timeoutMs: number; metadata?: Record<string, unknown> } }
  | { type: 'approval_resolved'; runId: string; requestId: string; outcome: 'approved' | 'rejected' | 'timeout' | 'aborted' };

// ── In-process pipeline run state ──
// We embed the SDK directly instead of spawning `tagma-cli` as a subprocess
// and regex-parsing its stdout. The server becomes the authoritative host
// for the pipeline so the full TaskState (including TaskResult with stdout,
// stderr, outputPath, sessionId, etc.) is available on every event.
let activeRunAbort: AbortController | null = null;
let activeRunGateway: InMemoryApprovalGateway | null = null;
let activeRunId: string | null = null;
let activeRunTasksSnapshot = new Map<string, RunTaskWire>();
// B4: Synchronous lock to prevent TOCTOU race between checking activeRunAbort
// and setting it (loadPipeline + validateConfig are async).
let runStarting = false;
const sseClients = new Set<import('express').Response>();

// ── Event seq + replay buffer (§1.3 / §4.5) ──
// Every broadcast RunEvent is stamped with a monotonic `seq` field tied
// to the current run. A bounded ring buffer holds the most recent events
// so that SSE clients reconnecting with `Last-Event-ID: <seq>` can replay
// everything they missed. The buffer resets at run_start.
const RUN_EVENT_BUFFER_MAX = 1024;
let currentRunSeq = 0;
let runEventBuffer: Array<RunEvent & { seq: number }> = [];

function broadcast(event: RunEvent) {
  currentRunSeq += 1;
  const stamped = { ...event, seq: currentRunSeq };
  runEventBuffer.push(stamped);
  if (runEventBuffer.length > RUN_EVENT_BUFFER_MAX) {
    runEventBuffer.splice(0, runEventBuffer.length - RUN_EVENT_BUFFER_MAX);
  }
  const data = JSON.stringify(stamped);
  for (const client of sseClients) {
    client.write(`id: ${currentRunSeq}\nevent: run_event\ndata: ${data}\n\n`);
  }
}

function resetRunEventBuffer() {
  runEventBuffer = [];
  currentRunSeq = 0;
}

// ── Run summary persistence (§3.12) ──
interface RunSummaryTask {
  taskId: string;
  trackId: string;
  trackName: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  driver: string | null;
  modelTier: string | null;
}

interface RunSummary {
  runId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  error: string | null;
  tasks: RunSummaryTask[];
}

function persistRunSummary(cwd: string, runId: string, summary: RunSummary): void {
  const logsDir = join(cwd, '.tagma', 'logs', runId);
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  writeFileSync(join(logsDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
}

function readRunSummary(cwd: string, runId: string): RunSummary | null {
  const summaryPath = join(cwd, '.tagma', 'logs', runId, 'summary.json');
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8')) as RunSummary;
  } catch {
    return null;
  }
}

// Translate an SDK ApprovalRequest into the wire shape consumed by the
// editor's ApprovalDialog.
function approvalRequestToWire(req: ApprovalRequest): {
  id: string;
  taskId: string;
  trackId?: string;
  message: string;
  createdAt: string;
  timeoutMs: number;
  metadata?: Record<string, unknown>;
} {
  return {
    id: req.id,
    taskId: req.taskId,
    trackId: req.trackId,
    message: req.message,
    createdAt: req.createdAt,
    timeoutMs: req.timeoutMs,
    metadata: req.metadata ? { ...req.metadata } : undefined,
  };
}

// Translate a task_status_change PipelineEvent into a RunEvent.task_update.
// We project the full TaskState onto the wire shape, flattening TaskResult
// fields and pulling resolved driver / tier / permissions from state.config
// (which is the post-inheritance TaskConfig the engine actually used).
function taskStateChangeToWire(
  runId: string,
  taskId: string,
  status: TaskStatus,
  state: TaskState,
): RunEvent {
  const result = state.result;
  const cfg = state.config;
  return {
    type: 'task_update',
    runId,
    taskId,
    status,
    startedAt: state.startedAt ?? undefined,
    finishedAt: state.finishedAt ?? undefined,
    durationMs: result?.durationMs,
    exitCode: result?.exitCode,
    stdout: result?.stdout,
    stderr: result?.stderr,
    outputPath: result?.outputPath ?? null,
    stderrPath: result?.stderrPath ?? null,
    sessionId: result?.sessionId ?? null,
    normalizedOutput: result?.normalizedOutput ?? null,
    resolvedDriver: cfg.driver ?? null,
    resolvedModelTier: cfg.model_tier ?? null,
    resolvedPermissions: cfg.permissions ?? null,
  };
}

interface RunHistoryEntry {
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  success?: boolean;
  finishedAt?: string;
  taskCounts?: { total: number; success: number; failed: number; timeout: number; skipped: number; blocked: number; running: number; waiting: number; idle: number };
}

function computeTaskCounts(tasks: RunSummaryTask[]): NonNullable<RunHistoryEntry['taskCounts']> {
  const counts = { total: tasks.length, success: 0, failed: 0, timeout: 0, skipped: 0, blocked: 0, running: 0, waiting: 0, idle: 0 };
  for (const t of tasks) {
    const k = t.status;
    if (k in counts) (counts as any)[k] += 1;
  }
  return counts;
}

/** Called from graceful shutdown to close any in-flight run + SSE clients. */
export function shutdownRuns(): void {
  if (activeRunAbort) {
    activeRunAbort.abort();
    activeRunAbort = null;
    activeRunGateway = null;
    activeRunId = null;
    activeRunTasksSnapshot = new Map();
    runStarting = false;
  }
  for (const client of sseClients) {
    try { client.end(); } catch { /* best-effort */ }
  }
  sseClients.clear();
}

export function registerRunRoutes(app: express.Express): void {
  app.get('/api/run/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // EventSource sends its last-seen event id in `Last-Event-ID` on
    // automatic reconnect. We replay every buffered event with seq > that
    // value so the client's task map can be brought back up to date
    // without refetching anything.
    //
    // First-connect race fix: when a run is actively starting/running, replay
    // the entire current-run buffer. The browser's `runStore.startRun`
    // creates the EventSource and immediately POSTs `/api/run/start`, so
    // the server may emit `run_start` + `approval_request` before this
    // GET handler has added `res` to `sseClients`. Replaying lastSeen=0
    // closes the gap; the reducer's `seq <= lastEventSeq` dedupe makes
    // duplicates harmless.
    //
    // What we DO NOT want is a fresh client connection (no Last-Event-ID,
    // no run in flight) to replay events left over from a previously
    // completed run — that makes switching pipelines look like the new
    // run instantly succeeded with the old run's task states.
    const lastSeenRaw = parseInt(String(req.header('Last-Event-ID') ?? ''), 10);
    const lastSeen = Number.isFinite(lastSeenRaw) && lastSeenRaw > 0 ? lastSeenRaw : 0;
    res.write('\n');
    sseClients.add(res);
    const isResuming = lastSeen > 0;
    const runInFlight = activeRunAbort !== null || runStarting;
    if (isResuming || runInFlight) {
      const missed = runEventBuffer.filter((e) => e.seq > lastSeen);
      for (const e of missed) {
        res.write(`id: ${e.seq}\nevent: run_event\ndata: ${JSON.stringify(e)}\n\n`);
      }
    }
    // M7: Emit a seq-less snapshot after replay so reconnecting clients can
    // rebuild the current task map + pending approvals even if the bounded
    // replay buffer has already dropped the original run_start / approval_request
    // events. We send it AFTER replay so it wins over any older buffered state.
    if (runInFlight && activeRunId) {
      const pending = activeRunGateway ? activeRunGateway.pending().map(approvalRequestToWire) : [];
      if (activeRunTasksSnapshot.size > 0 || pending.length > 0) {
        res.write(`event: run_event\ndata: ${JSON.stringify({
          type: 'run_snapshot',
          runId: activeRunId,
          tasks: Array.from(activeRunTasksSnapshot.values()),
          pendingApprovals: pending,
        })}\n\n`);
      }
    }
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/api/run/start', async (_req, res) => {
    // B4: Check both the active controller AND the synchronous lock so two
    // concurrent POST requests can't both pass the check before either sets it.
    if (activeRunAbort || runStarting) {
      return res.status(409).json({ error: 'A run is already in progress' });
    }
    runStarting = true;

    // Serialize the in-memory editor config to YAML and hand it to the SDK.
    // The round-trip is intentional: it exercises the same load path the CLI
    // uses (parse + template expansion + inheritance resolution) so the run
    // sees exactly what YAML-driven consumers would see.
    const content = serializePipeline(S.config);
    const cwd = S.workDir || process.cwd();

    // H6: Pre-load plugins atomically — validate every name first, then load
    // them in order, and on any failure unregister everything we already
    // loaded so the SDK registry never ends up half-populated. The previous
    // path returned mid-iteration with whatever it had managed to register,
    // leaving stale handlers visible to subsequent runs.
    const pluginsToLoad = S.config.plugins ?? [];
    if (pluginsToLoad.length > 0) {
      for (const name of pluginsToLoad) {
        try {
          assertSafePluginName(name);
        } catch (err: unknown) {
          runStarting = false;
          const { message } = classifyServerError(err);
          return res.status(400).json({ error: `Plugin load error: ${message}` });
        }
      }
      const newlyLoaded: string[] = [];
      let preloadError: { message: string } | null = null;
      for (const name of pluginsToLoad) {
        // Skip plugins that were already loaded by a previous run / autoload —
        // their lifecycle is owned elsewhere and we should not unregister them
        // on rollback.
        if (loadedPluginMeta.has(name)) continue;
        try {
          await loadPluginFromWorkDir(name);
          newlyLoaded.push(name);
        } catch (err: unknown) {
          const { message } = classifyServerError(err);
          preloadError = { message };
          break;
        }
      }
      if (preloadError) {
        // Roll back partial load so the SDK registry matches the on-disk state.
        for (const name of newlyLoaded) {
          const meta = loadedPluginMeta.get(name);
          if (meta) {
            try { unregisterPlugin(meta.category, meta.type); } catch { /* best-effort */ }
            loadedPluginMeta.delete(name);
          }
        }
        runStarting = false;
        return res.status(400).json({ error: `Plugin load error: ${preloadError.message}` });
      }
    }

    let pipelineConfig;
    try {
      pipelineConfig = await loadPipeline(content, cwd);
    } catch (err: unknown) {
      runStarting = false; // B4: release lock on error
      const message = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: `Configuration error: ${message}` });
    }

    // Plugins are already registered from the workDir's node_modules above; the
    // engine will see skipPluginLoading: true and won't re-resolve them via
    // Node's cwd-based default import.

    // Validate the resolved config (catches DAG errors introduced by template
    // expansion, e.g. duplicate qualified IDs, broken cross-template references).
    const configErrors = validateConfig(pipelineConfig);
    if (configErrors.length > 0) {
      runStarting = false; // B4: release lock on error
      return res.status(400).json({ error: configErrors.join('; ') });
    }

    // Build initial task list from the raw (editor-side) config. This keeps
    // the qualified taskIds aligned with the pipeline DAG that the SDK
    // produces internally (`{trackId}.{taskId}`).
    const initialTasks: RunTaskWire[] = S.config.tracks.flatMap((track) =>
      track.tasks.map((task) => ({
        taskId: `${track.id}.${task.id}`,
        trackId: track.id,
        taskName: task.name || task.id,
        status: 'waiting',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        stdout: '',
        stderr: '',
        outputPath: null,
        stderrPath: null,
        sessionId: null,
        normalizedOutput: null,
        resolvedDriver: null,
        resolvedModelTier: null,
        resolvedPermissions: null,
        logs: [],
        totalLogCount: 0,
      })),
    );

    // H6: only reset the per-run event buffer once everything that could fail
    // (plugin pre-load, loadPipeline, validateConfig) has succeeded. The old
    // code reset it at the top of the handler — failing validation later left
    // SSE consumers with no replay for the *previous* completed run.
    resetRunEventBuffer();

    // H4: use the SDK's own collision-resistant id generator. The previous
    // `run_${Date.now().toString(36)}` lost the per-process counter + random
    // suffix the SDK builds in (see utils.ts:generateRunId), so two starts
    // landing in the same millisecond — common in test loops or rapid
    // restarts — would share a runId, mix logs, and overwrite each other's
    // summary.json under .tagma/logs/<runId>.
    const runId = generateRunId();
    const runStartedAt = new Date().toISOString();
    const abortController = new AbortController();
    const gateway = new InMemoryApprovalGateway();

    // Running tally of the most recent TaskState per qualified id. Populated
    // from the SDK's task_status_change events and flushed to summary.json
    // at run completion so the RunHistoryBrowser can render a rich per-task
    // timeline instead of a plaintext log (§3.12).
    const taskSnapshots = new Map<string, RunSummaryTask>();
    for (const t of initialTasks) {
      taskSnapshots.set(t.taskId, {
        taskId: t.taskId,
        trackId: t.trackId,
        trackName: S.config.tracks.find((tr) => tr.id === t.trackId)?.name ?? t.trackId,
        taskName: t.taskName,
        status: t.status,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        exitCode: null,
        driver: null,
        modelTier: null,
      });
    }

    activeRunAbort = abortController;
    activeRunGateway = gateway;
    activeRunId = runId;
    activeRunTasksSnapshot = new Map(initialTasks.map((task) => [task.taskId, structuredClone(task)]));
    // Buffer was already reset at the top of this handler so any EventSource
    // connection that arrives during validation never replays stale events
    // from the prior run.

    // Subscribe to approval gateway events and forward them to the SSE
    // clients. This replaces the old WebSocket-bridge-to-CLI path — the
    // gateway lives in-process now so there's no IPC hop.
    const unsubscribeApprovals = gateway.subscribe((event: ApprovalEvent) => {
      try {
        if (event.type === 'requested') {
          broadcast({
            type: 'approval_request',
            runId,
            request: approvalRequestToWire(event.request),
          });
          return;
        }
        if (event.type === 'resolved' || event.type === 'expired' || event.type === 'aborted') {
          const outcome = event.type === 'resolved'
            ? event.decision.outcome
            : event.type === 'expired' ? 'timeout' : 'aborted';
          broadcast({
            type: 'approval_resolved',
            runId,
            requestId: event.request.id,
            outcome: outcome as 'approved' | 'rejected' | 'timeout' | 'aborted',
          });
        }
      } catch (e) {
        console.warn('Failed to broadcast approval event:', e);
      }
    });

    broadcast({ type: 'run_start', runId, tasks: initialTasks });

    // Kick off the run in the background. Event translation happens in
    // onEvent; errors and finalization flow through .then/.catch/.finally.
    let runSuccess: boolean | null = null;
    let runErrorMessage: string | null = null;

    runPipeline(pipelineConfig, cwd, {
      approvalGateway: gateway,
      signal: abortController.signal,
      maxLogRuns: MAX_LOG_RUNS,
      runId,
      skipPluginLoading: true,
      onEvent: (event: PipelineEvent) => {
        if (event.type === 'task_status_change') {
          // Update local snapshot for summary persistence.
          const existing = taskSnapshots.get(event.taskId);
          if (existing) {
            const state = event.state;
            const result = state.result;
            taskSnapshots.set(event.taskId, {
              ...existing,
              status: event.status,
              startedAt: state.startedAt ?? existing.startedAt,
              finishedAt: state.finishedAt ?? existing.finishedAt,
              durationMs: result?.durationMs ?? existing.durationMs,
              exitCode: result?.exitCode ?? existing.exitCode,
              driver: state.config.driver ?? existing.driver,
              modelTier: state.config.model_tier ?? existing.modelTier,
            });
          }
          const wireEvent = taskStateChangeToWire(runId, event.taskId, event.status, event.state);
          broadcast(wireEvent);
          const prevTask = activeRunTasksSnapshot.get(event.taskId);
          const dotIdx = event.taskId.indexOf('.');
          const fallbackTrackId = dotIdx >= 0 ? event.taskId.slice(0, dotIdx) : '';
          const baseTask: RunTaskWire = prevTask ?? {
            taskId: event.taskId,
            trackId: fallbackTrackId,
            taskName: event.taskId,
            status: wireEvent.status,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            exitCode: null,
            stdout: '',
            stderr: '',
            outputPath: null,
            stderrPath: null,
            sessionId: null,
            normalizedOutput: null,
            resolvedDriver: null,
            resolvedModelTier: null,
            resolvedPermissions: null,
            logs: [],
            totalLogCount: 0,
          };
          activeRunTasksSnapshot.set(event.taskId, {
            ...baseTask,
            status: wireEvent.status,
            startedAt: wireEvent.startedAt ?? baseTask.startedAt,
            finishedAt: wireEvent.finishedAt ?? baseTask.finishedAt,
            durationMs: wireEvent.durationMs ?? baseTask.durationMs,
            exitCode: wireEvent.exitCode ?? baseTask.exitCode,
            stdout: wireEvent.stdout ?? baseTask.stdout,
            stderr: wireEvent.stderr ?? baseTask.stderr,
            outputPath: wireEvent.outputPath ?? baseTask.outputPath,
            stderrPath: wireEvent.stderrPath ?? baseTask.stderrPath,
            sessionId: wireEvent.sessionId ?? baseTask.sessionId,
            normalizedOutput: wireEvent.normalizedOutput ?? baseTask.normalizedOutput,
            resolvedDriver: wireEvent.resolvedDriver ?? baseTask.resolvedDriver,
            resolvedModelTier: wireEvent.resolvedModelTier ?? baseTask.resolvedModelTier,
            resolvedPermissions: wireEvent.resolvedPermissions ?? baseTask.resolvedPermissions,
            logs: baseTask.logs,
            totalLogCount: baseTask.totalLogCount,
          });
        } else if (event.type === 'task_log') {
          // Stream every pipeline.log line out to SSE clients so the RunTaskPanel
          // can show the same process detail the log file has.
          const wireLog = {
            type: 'task_log' as const,
            runId,
            taskId: event.taskId,
            level: event.level,
            timestamp: event.timestamp,
            text: event.text,
          };
          broadcast(wireLog);
          if (event.taskId) {
            const prevTask = activeRunTasksSnapshot.get(event.taskId);
            const dotIdx = event.taskId.indexOf('.');
            const fallbackTrackId = dotIdx >= 0 ? event.taskId.slice(0, dotIdx) : '';
            const baseTask: RunTaskWire = prevTask ?? {
              taskId: event.taskId,
              trackId: fallbackTrackId,
              taskName: event.taskId,
              status: 'running',
              startedAt: null,
              finishedAt: null,
              durationMs: null,
              exitCode: null,
              stdout: '',
              stderr: '',
              outputPath: null,
              stderrPath: null,
              sessionId: null,
              normalizedOutput: null,
              resolvedDriver: null,
              resolvedModelTier: null,
              resolvedPermissions: null,
              logs: [],
              totalLogCount: 0,
            };
            const nextLine: RunTaskLogLine = {
              level: event.level,
              timestamp: event.timestamp,
              text: event.text,
            };
            const baseLogs = baseTask.logs ?? [];
            const nextTotalLogCount = (baseTask.totalLogCount ?? baseLogs.length) + 1;
            const nextLogs = baseLogs.length >= 500
              ? [...baseLogs.slice(baseLogs.length - 499), nextLine]
              : [...baseLogs, nextLine];
            activeRunTasksSnapshot.set(event.taskId, {
              ...baseTask,
              logs: nextLogs,
              totalLogCount: nextTotalLogCount,
            });
          }
        }
        // pipeline_start and pipeline_end are implicit in run_start / run_end
        // — we already broadcast run_start above, and run_end is emitted in
        // the .then/.catch below so we can include the actual success flag.
      },
    }).then((result: EngineResult) => {
      runSuccess = result.success;
      broadcast({ type: 'run_end', runId, success: result.success });
    }).catch((err: unknown) => {
      // AbortError from an explicit abort() → emit run_end with success:false
      // so the UI transitions to "Aborted" rather than "Error".
      const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
      runSuccess = false;
      if (isAbort) {
        broadcast({ type: 'run_end', runId, success: false });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        runErrorMessage = message;
        broadcast({ type: 'run_error', runId, error: message });
      }
    }).finally(() => {
      unsubscribeApprovals();
      // Abort any dangling approvals so consumers get a deterministic
      // timeout/aborted event rather than a silent drop.
      gateway.abortAll('run finished');
      // Persist a rich summary.json so RunHistoryBrowser can render a
      // per-task timeline for this run (§3.12).
      try {
        persistRunSummary(cwd, runId, {
          runId,
          pipelineName: S.config.name,
          startedAt: runStartedAt,
          finishedAt: new Date().toISOString(),
          success: runSuccess ?? false,
          error: runErrorMessage,
          tasks: Array.from(taskSnapshots.values()),
        });
      } catch (persistErr) {
        console.error('[run] failed to persist summary.json:', persistErr);
      }
      if (activeRunId === runId) {
        activeRunAbort = null;
        activeRunGateway = null;
        activeRunId = null;
        activeRunTasksSnapshot = new Map();
      }
      runStarting = false; // B4: release lock when run completes
    });

    res.json({ ok: true, runId });
  });

  app.post('/api/run/abort', (_req, res) => {
    if (!activeRunAbort) {
      return res.status(404).json({ error: 'No run in progress' });
    }
    activeRunAbort.abort();
    // run_end (success: false) is emitted in the runPipeline chain's .catch
    // once the engine actually tears down, so we do not broadcast it here —
    // doing so would race with the engine's own final events.
    res.json({ ok: true });
  });

  // ── Approval (F3) ──
  // POST a decision for a pending approval request. The request originates
  // from the in-process InMemoryApprovalGateway bound to the active run, so
  // we resolve it directly — no IPC bridge, no stdout parsing.
  app.post('/api/run/approval/:requestId', (req, res) => {
    const { requestId } = req.params;
    const { outcome, reason, actor } = req.body ?? {};
    if (outcome !== 'approved' && outcome !== 'rejected') {
      return res.status(400).json({ error: 'outcome must be approved|rejected' });
    }
    if (!activeRunGateway) {
      return res.status(503).json({
        error: 'approval gateway not available — no run in progress',
      });
    }
    const ok = activeRunGateway.resolve(requestId, {
      outcome,
      reason,
      actor: actor ?? 'editor',
    });
    if (!ok) {
      return res.status(404).json({
        error: `approval ${requestId} not pending (already resolved or expired)`,
      });
    }
    res.json({ ok: true });
  });

  // ── Run History (F8 / §3.12) ──
  // Lists prior run directories under `<workDir>/.tagma/logs/` sorted by
  // mtime desc, capped at 20. Each entry surfaces the summary.json data
  // (if present) so the history browser can show per-run success/failure
  // counts without loading individual logs. The raw pipeline.log is still
  // fetchable via /api/run/history/:runId for debugging.
  app.get('/api/run/history', (_req, res) => {
    const cwd = S.workDir || process.cwd();
    const logsDir = join(cwd, '.tagma', 'logs');
    if (!existsSync(logsDir)) {
      return res.json({ runs: [] });
    }
    try {
      const entries = readdirSync(logsDir)
        .filter((name) => name.startsWith('run_'))
        .map((name): RunHistoryEntry | null => {
          const full = join(logsDir, name);
          try {
            const st = statSync(full);
            if (!st.isDirectory()) return null;
            const logFile = join(full, 'pipeline.log');
            const logStat = existsSync(logFile) ? statSync(logFile) : null;
            const summary = readRunSummary(cwd, name);
            return {
              runId: name,
              path: full,
              startedAt: summary?.startedAt ?? st.mtime.toISOString(),
              sizeBytes: logStat?.size ?? 0,
              pipelineName: summary?.pipelineName,
              success: summary?.success,
              finishedAt: summary?.finishedAt,
              taskCounts: summary ? computeTaskCounts(summary.tasks) : undefined,
            };
          } catch {
            return null;
          }
        })
        .filter((x): x is RunHistoryEntry => x !== null)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, MAX_LOG_RUNS);
      res.json({ runs: entries });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/run/history/:runId', (req, res) => {
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = S.workDir || process.cwd();
    const logFile = join(cwd, '.tagma', 'logs', runId, 'pipeline.log');
    if (!existsSync(logFile)) {
      return res.status(404).json({ error: 'log not found' });
    }
    try {
      const MAX_LOG_BYTES = 1024 * 1024; // 1 MB cap
      const stat = statSync(logFile);
      const raw = readFileSync(logFile, 'utf-8');
      const content = stat.size > MAX_LOG_BYTES ? clip(raw, MAX_LOG_BYTES) : raw;
      res.json({ runId, content });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Rich summary view — lets the browser render per-task status + timing
  // without parsing the pipeline.log text.
  app.get('/api/run/history/:runId/summary', (req, res) => {
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = S.workDir || process.cwd();
    const summary = readRunSummary(cwd, runId);
    if (!summary) {
      return res.status(404).json({ error: 'summary not found' });
    }
    res.json(summary);
  });
}
