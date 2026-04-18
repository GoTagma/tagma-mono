import type express from 'express';
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  serializePipeline,
  loadPipeline,
  validateConfig,
  runPipeline,
  InMemoryApprovalGateway,
  unregisterPlugin,
  generateRunId,
  parseYaml,
  buildRawDag,
  RUN_PROTOCOL_VERSION,
  TASK_LOG_CAP,
} from '@tagma/sdk';
import type {
  RunEventPayload,
  RunSnapshotPayload,
  WireRunEvent,
  RunTaskState,
  TaskLogLine,
  ApprovalRequestInfo,
  TaskStatus,
  EngineResult,
  RawPipelineConfig,
  ApprovalRequest,
} from '@tagma/sdk';
import { assertSafePluginName } from '../plugin-safety.js';
import { errorMessage, atomicWriteFileSync } from '../path-utils.js';
import { S, MAX_LOG_RUNS, lenientParseYaml } from '../state.js';
import { loadedPluginMeta, loadPluginFromWorkDir, classifyServerError } from '../plugins/loader.js';

// ═══ Run lifecycle layer ═══════════════════════════════════════════════
//
// The server owns exactly one RunSession at a time. The session
// encapsulates everything about the live run — abort controller, approval
// gateway, task mirror for snapshots, pipeline-level log buffer, seq
// counter, event ring buffer, and persistence inputs — so callers never
// have to coordinate multiple module-level globals. Per-run reset is free
// by construction: a new session is a new object.
//
// All wire events carry (runId, seq). Client-side dedup keys on that
// tuple: when runId changes, the reducer adopts the new run without
// needing run_start as a magic reset signal. This makes cross-run
// reconnect safe even if run_start has already fallen out of the bounded
// replay buffer.

const EVENT_BUFFER_MAX = 1024;

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
  model: string | null;
  depends_on: string[];
  prompt?: string | null;
  command?: string | null;
  stderrPath?: string | null;
  normalizedOutput?: string | null;
  sessionId?: string | null;
}

interface RunSummaryTrack {
  id: string;
  name: string;
  color?: string;
}

interface RunSummary {
  runId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  error: string | null;
  tasks: RunSummaryTask[];
  tracks: RunSummaryTrack[];
  positions?: Record<string, { x: number }>;
  hasYamlSnapshot?: boolean;
  replayedFromRunId?: string;
}

interface RunHistoryEntry {
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  success?: boolean;
  finishedAt?: string;
  replayedFromRunId?: string;
  taskCounts?: {
    total: number;
    success: number;
    failed: number;
    timeout: number;
    skipped: number;
    blocked: number;
    running: number;
    waiting: number;
    idle: number;
  };
}

function approvalToWire(req: ApprovalRequest): ApprovalRequestInfo {
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

class RunSession {
  readonly runId: string;
  readonly startedAt: string;
  readonly gateway: InMemoryApprovalGateway;
  readonly abort: AbortController;
  readonly effectiveConfig: RawPipelineConfig;
  readonly fromRunId: string | null;
  readonly yamlOverride: string | undefined;

  /** Wire-shape task mirror — single source of truth for snapshots. */
  private readonly tasks = new Map<string, RunTaskState>();
  /** Rich per-task record used when persisting summary.json. */
  private readonly summaries = new Map<string, RunSummaryTask>();
  /** Pipeline-level logs (taskId=null on task_log events), bounded at TASK_LOG_CAP. */
  private readonly pipelineLogs: TaskLogLine[] = [];

  private seqCounter = 0;
  private readonly buffer: WireRunEvent[] = [];

  // Engine result fields, populated in finally().
  success: boolean | null = null;
  errorMessage: string | null = null;

  constructor(
    runId: string,
    effectiveConfig: RawPipelineConfig,
    fromRunId: string | null,
    yamlOverride: string | undefined,
  ) {
    this.runId = runId;
    this.startedAt = new Date().toISOString();
    this.gateway = new InMemoryApprovalGateway();
    this.abort = new AbortController();
    this.effectiveConfig = effectiveConfig;
    this.fromRunId = fromRunId;
    this.yamlOverride = yamlOverride;
  }

  /** Seed the task mirror + summary records from the raw config. */
  seedTasks(): void {
    for (const track of this.effectiveConfig.tracks) {
      for (const task of track.tasks) {
        const taskId = `${track.id}.${task.id}`;
        this.tasks.set(taskId, {
          taskId,
          trackId: track.id,
          taskName: task.name || task.id,
          status: 'waiting',
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          stdout: '',
          stderr: '',
          stderrPath: null,
          sessionId: null,
          normalizedOutput: null,
          resolvedDriver: null,
          resolvedModel: null,
          resolvedPermissions: null,
          logs: [],
          totalLogCount: 0,
        });
        const deps = (task.depends_on ?? []).map((dep) =>
          dep.includes('.') ? dep : `${track.id}.${dep}`,
        );
        this.summaries.set(taskId, {
          taskId,
          trackId: track.id,
          trackName: track.name ?? track.id,
          taskName: task.name || task.id,
          status: 'waiting',
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          driver: null,
          model: null,
          depends_on: deps,
        });
      }
    }
  }

  /**
   * Apply an SDK event to the session's task mirror + log buffer, then
   * stamp it with the next seq and append to the ring buffer. Returns the
   * wire-stamped event so the caller can forward it to SSE clients.
   */
  ingest(payload: RunEventPayload): WireRunEvent {
    this._applyToMirror(payload);
    return this._stamp(payload);
  }

  /** Server-initiated snapshot — never carried through the engine. */
  emitSnapshot(): WireRunEvent {
    const snapshot: RunSnapshotPayload = {
      type: 'run_snapshot',
      runId: this.runId,
      tasks: Array.from(this.tasks.values()).map((t) => ({
        ...t,
        logs: [...t.logs],
      })),
      pendingApprovals: this.gateway.pending().map(approvalToWire),
      pipelineLogs: [...this.pipelineLogs],
    };
    return this._stamp(snapshot);
  }

  replayAfter(lastSeen: number): WireRunEvent[] {
    return this.buffer.filter((e) => e.seq > lastSeen);
  }

  /** All events currently in the buffer, oldest-first. */
  allBuffered(): WireRunEvent[] {
    return [...this.buffer];
  }

  buildSummary(endedAt: string, positions: Record<string, { x: number }>): RunSummary {
    return {
      runId: this.runId,
      pipelineName: this.effectiveConfig.name,
      startedAt: this.startedAt,
      finishedAt: endedAt,
      success: this.success ?? false,
      error: this.errorMessage,
      tasks: Array.from(this.summaries.values()),
      tracks: this.effectiveConfig.tracks.map((tr) => ({
        id: tr.id,
        name: tr.name,
        color: tr.color,
      })),
      positions,
      ...(this.fromRunId !== null ? { replayedFromRunId: this.fromRunId } : {}),
    };
  }

  private _applyToMirror(payload: RunEventPayload): void {
    switch (payload.type) {
      case 'run_start':
        // `tasks` in run_start is the engine's authoritative task list
        // (same ids, resolved names). Adopt it wholesale so client and
        // server agree on shape even if the seed was derived differently.
        this.tasks.clear();
        for (const t of payload.tasks) {
          this.tasks.set(t.taskId, { ...t, logs: [...t.logs] });
        }
        return;
      case 'task_update': {
        const prev = this.tasks.get(payload.taskId);
        if (!prev) return;
        const pick = <T>(incoming: T | undefined, previous: T): T =>
          incoming !== undefined ? incoming : previous;
        const next: RunTaskState = {
          ...prev,
          status: payload.status,
          startedAt: pick(payload.startedAt, prev.startedAt),
          finishedAt: pick(payload.finishedAt, prev.finishedAt),
          durationMs: pick(payload.durationMs, prev.durationMs),
          exitCode: pick(payload.exitCode, prev.exitCode),
          stdout: pick(payload.stdout, prev.stdout),
          stderr: pick(payload.stderr, prev.stderr),
          stderrPath: pick(payload.stderrPath, prev.stderrPath),
          sessionId: pick(payload.sessionId, prev.sessionId),
          normalizedOutput: pick(payload.normalizedOutput, prev.normalizedOutput),
          resolvedDriver: pick(payload.resolvedDriver, prev.resolvedDriver),
          resolvedModel: pick(payload.resolvedModel, prev.resolvedModel),
          resolvedPermissions: pick(payload.resolvedPermissions, prev.resolvedPermissions),
        };
        this.tasks.set(payload.taskId, next);
        const s = this.summaries.get(payload.taskId);
        if (s) {
          this.summaries.set(payload.taskId, {
            ...s,
            status: payload.status,
            startedAt: next.startedAt,
            finishedAt: next.finishedAt,
            durationMs: next.durationMs,
            exitCode: next.exitCode,
            driver: next.resolvedDriver ?? s.driver,
            model: next.resolvedModel ?? s.model,
            stderrPath: next.stderrPath ?? s.stderrPath ?? null,
            normalizedOutput: next.normalizedOutput ?? s.normalizedOutput ?? null,
            sessionId: next.sessionId ?? s.sessionId ?? null,
          });
        }
        return;
      }
      case 'task_log': {
        const line: TaskLogLine = {
          level: payload.level,
          timestamp: payload.timestamp,
          text: payload.text,
        };
        if (payload.taskId === null) {
          this.pipelineLogs.push(line);
          if (this.pipelineLogs.length > TASK_LOG_CAP) {
            this.pipelineLogs.splice(0, this.pipelineLogs.length - TASK_LOG_CAP);
          }
          return;
        }
        const prev = this.tasks.get(payload.taskId);
        if (!prev) return;
        const logs =
          prev.logs.length >= TASK_LOG_CAP
            ? [...prev.logs.slice(prev.logs.length - TASK_LOG_CAP + 1), line]
            : [...prev.logs, line];
        this.tasks.set(payload.taskId, {
          ...prev,
          logs,
          totalLogCount: prev.totalLogCount + 1,
        });
        return;
      }
      case 'run_end':
      case 'run_error':
      case 'approval_request':
      case 'approval_resolved':
        // These don't change the task mirror directly. Pending approvals
        // are observable via this.gateway.pending() at snapshot time.
        return;
    }
  }

  private _stamp<T extends RunEventPayload | RunSnapshotPayload>(
    payload: T,
  ): T & { seq: number } {
    this.seqCounter += 1;
    const stamped = { ...payload, seq: this.seqCounter } as T & { seq: number };
    this.buffer.push(stamped as WireRunEvent);
    if (this.buffer.length > EVENT_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_MAX);
    }
    return stamped;
  }
}

// ═══ Module-level run state ═══════════════════════════════════════════
//
// Exactly one session at a time. `sessionStarting` is the atomic lock
// covering the async window between /api/run/start being called and
// the session being fully installed. Without it two concurrent POSTs
// could both pass the "no session active" check.

let currentSession: RunSession | null = null;
let sessionStarting = false;
const sseClients = new Set<import('express').Response>();

function broadcastToClients(event: WireRunEvent): void {
  const frame = `id: ${event.runId}:${event.seq}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      // One broken client (ERR_STREAM_WRITE_AFTER_END etc.) must not abort
      // the loop and starve the rest; drop it from the set and continue.
      sseClients.delete(client);
    }
  }
}

function persistRunSummary(
  cwd: string,
  runId: string,
  summary: RunSummary,
  executedConfig: RawPipelineConfig,
  yamlOverride?: string,
): void {
  const logsDir = join(cwd, '.tagma', 'logs', runId);
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  let hasYamlSnapshot = false;
  try {
    const executedYaml = serializePipeline(executedConfig);
    let snapshotText = yamlOverride ?? executedYaml;
    if (yamlOverride === undefined && S.yamlPath && existsSync(S.yamlPath)) {
      try {
        const diskText = readFileSync(S.yamlPath, 'utf-8');
        const diskParsed = yaml.load(diskText) as unknown;
        const diskReserialized =
          diskParsed && typeof diskParsed === 'object'
            ? serializePipeline(diskParsed as RawPipelineConfig)
            : null;
        if (diskReserialized === executedYaml) {
          snapshotText = diskText;
        }
      } catch {
        /* fall through to serialized executedConfig */
      }
    }
    atomicWriteFileSync(join(logsDir, 'pipeline.yaml'), snapshotText);
    hasYamlSnapshot = true;
  } catch (e) {
    console.warn('[run] failed to snapshot pipeline.yaml:', e);
  }
  atomicWriteFileSync(
    join(logsDir, 'summary.json'),
    JSON.stringify({ ...summary, hasYamlSnapshot }, null, 2),
  );
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

function computeTaskCounts(tasks: RunSummaryTask[]): NonNullable<RunHistoryEntry['taskCounts']> {
  const counts = {
    total: tasks.length,
    success: 0,
    failed: 0,
    timeout: 0,
    skipped: 0,
    blocked: 0,
    running: 0,
    waiting: 0,
    idle: 0,
  };
  for (const t of tasks) {
    const k = t.status;
    if (k in counts) (counts as Record<string, number>)[k] += 1;
  }
  return counts;
}

/** Parse a Last-Event-ID header of the form `<runId>:<seq>`. */
function parseLastEventId(raw: string | undefined): { runId: string; seq: number } | null {
  if (!raw) return null;
  const colon = raw.lastIndexOf(':');
  if (colon <= 0 || colon === raw.length - 1) return null;
  const runId = raw.slice(0, colon);
  const seqStr = raw.slice(colon + 1);
  if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) return null;
  const seq = parseInt(seqStr, 10);
  if (!Number.isFinite(seq) || seq < 0) return null;
  return { runId, seq };
}

/** Called from graceful shutdown to close any in-flight run + SSE clients. */
export function shutdownRuns(): void {
  if (currentSession) {
    currentSession.abort.abort();
    currentSession = null;
    sessionStarting = false;
  }
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      /* best-effort */
    }
  }
  sseClients.clear();
}

export function registerRunRoutes(app: express.Express): void {
  app.get('/api/run/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Tagma-Run-Protocol': String(RUN_PROTOCOL_VERSION),
    });
    res.write('\n');
    sseClients.add(res);

    const parsed = parseLastEventId(req.header('Last-Event-ID'));
    const session = currentSession;
    if (session) {
      // Same runId → replay only missed events. Different runId (or no
      // Last-Event-ID) → dump the whole buffer so the client sees
      // run_start. The follow-up snapshot then reconciles whatever the
      // buffer couldn't replay (e.g. long runs where run_start has
      // aged out).
      const sameRun = parsed !== null && parsed.runId === session.runId;
      const replay = sameRun ? session.replayAfter(parsed!.seq) : session.allBuffered();
      for (const e of replay) {
        res.write(`id: ${e.runId}:${e.seq}\nevent: run_event\ndata: ${JSON.stringify(e)}\n\n`);
      }
      const snap = session.emitSnapshot();
      broadcastToClients(snap);
    }
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/api/run/start', async (req, res) => {
    if (currentSession || sessionStarting) {
      return res.status(409).json({ error: 'A run is already in progress' });
    }
    sessionStarting = true;

    // Outer guard mirrors the earlier implementation: if we exit this
    // handler any way other than actually launching the pipeline, the
    // finally clears the lock so the server isn't wedged into 409.
    let sessionLaunched = false;
    try {
      const cwd = S.workDir || process.cwd();

      const fromRunId: string | null =
        typeof req.body?.fromRunId === 'string' && /^run_[A-Za-z0-9_-]+$/.test(req.body.fromRunId)
          ? req.body.fromRunId
          : null;

      let effectiveConfig: RawPipelineConfig;
      let content: string;
      let yamlOverride: string | undefined;
      if (fromRunId !== null) {
        const yamlPath = join(cwd, '.tagma', 'logs', fromRunId, 'pipeline.yaml');
        if (!existsSync(yamlPath)) {
          return res
            .status(404)
            .json({ error: `No yaml snapshot found for run ${fromRunId}; cannot replay` });
        }
        try {
          const diskYaml = readFileSync(yamlPath, 'utf-8');
          try {
            effectiveConfig = parseYaml(diskYaml);
          } catch {
            effectiveConfig = lenientParseYaml(diskYaml, `Replay ${fromRunId}`);
          }
          content = serializePipeline(effectiveConfig);
          yamlOverride = diskYaml;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return res.status(400).json({ error: `Failed to load snapshot yaml: ${message}` });
        }
      } else {
        effectiveConfig = S.config;
        content = serializePipeline(effectiveConfig);
      }

      // Pre-load plugins atomically: validate every name first, then load
      // in order; on any failure unregister everything we loaded so the
      // SDK registry never ends up half-populated.
      const pluginsToLoad = effectiveConfig.plugins ?? [];
      if (pluginsToLoad.length > 0) {
        for (const name of pluginsToLoad) {
          try {
            assertSafePluginName(name);
          } catch (err: unknown) {
            const { message } = classifyServerError(err);
            return res.status(400).json({ error: `Plugin load error: ${message}` });
          }
        }
        const newlyLoaded: string[] = [];
        let preloadError: { message: string } | null = null;
        for (const name of pluginsToLoad) {
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
          for (const name of newlyLoaded) {
            const meta = loadedPluginMeta.get(name);
            if (meta) {
              try {
                unregisterPlugin(meta.category, meta.type);
              } catch {
                /* best-effort */
              }
              if (meta.stageDir) {
                try {
                  rmSync(meta.stageDir, { recursive: true, force: true });
                } catch {
                  /* best-effort */
                }
              }
              loadedPluginMeta.delete(name);
            }
          }
          return res.status(400).json({ error: `Plugin load error: ${preloadError.message}` });
        }
      }

      let pipelineConfig;
      try {
        pipelineConfig = await loadPipeline(content, cwd);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: `Configuration error: ${message}` });
      }

      const configErrors = validateConfig(pipelineConfig);
      if (configErrors.length > 0) {
        return res.status(400).json({ error: configErrors.join('; ') });
      }

      const runId = generateRunId();
      const session = new RunSession(runId, effectiveConfig, fromRunId, yamlOverride);
      session.seedTasks();
      currentSession = session;

      runPipeline(pipelineConfig, cwd, {
        approvalGateway: session.gateway,
        signal: session.abort.signal,
        maxLogRuns: MAX_LOG_RUNS,
        runId,
        skipPluginLoading: true,
        onEvent: (event: RunEventPayload) => {
          const stamped = session.ingest(event);
          broadcastToClients(stamped);
        },
      })
        .then((result: EngineResult) => {
          session.success = result.success;
          // Engine has already emitted run_end via onEvent before this
          // .then fires, so there is nothing to broadcast here.
        })
        .catch((err: unknown) => {
          session.success = false;
          const isAbort =
            err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
          if (isAbort) {
            // Synthesize a run_end so clients transition to a terminal
            // UI state even if the engine never got far enough to emit
            // one itself.
            broadcastToClients(
              session.ingest({
                type: 'run_end',
                runId,
                success: false,
                abortReason: 'external',
              }),
            );
          } else {
            const message = err instanceof Error ? err.message : String(err);
            session.errorMessage = message;
            broadcastToClients(session.ingest({ type: 'run_error', runId, error: message }));
          }
        })
        .finally(() => {
          // Drain lingering approvals in case the engine rejected before
          // reaching its own finally.
          if (session.gateway.pending().length > 0) {
            session.gateway.abortAll('run finished');
          }
          try {
            let persistedPositions: Record<string, { x: number }> = {};
            if (fromRunId === null) {
              persistedPositions = { ...S.layout.positions };
            } else {
              const priorSummary = readRunSummary(cwd, fromRunId);
              if (priorSummary?.positions) {
                persistedPositions = { ...priorSummary.positions };
              }
            }
            persistRunSummary(
              cwd,
              runId,
              session.buildSummary(new Date().toISOString(), persistedPositions),
              effectiveConfig,
              yamlOverride,
            );
          } catch (persistErr) {
            console.error('[run] failed to persist summary.json:', persistErr);
          }
          if (currentSession === session) {
            currentSession = null;
          }
          sessionStarting = false;
        });

      sessionLaunched = true;
      res.json({ ok: true, runId });
    } catch (err: unknown) {
      currentSession = null;
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Run setup failed: ${message}` });
    } finally {
      if (!sessionLaunched) {
        currentSession = null;
        sessionStarting = false;
      }
    }
  });

  app.post('/api/run/abort', (_req, res) => {
    if (!currentSession) {
      return res.status(404).json({ error: 'No run in progress' });
    }
    currentSession.abort.abort();
    res.json({ ok: true });
  });

  app.post('/api/run/approval/:requestId', (req, res) => {
    const { requestId } = req.params;
    const { outcome, reason, actor } = req.body ?? {};
    if (outcome !== 'approved' && outcome !== 'rejected') {
      return res.status(400).json({ error: 'outcome must be approved|rejected' });
    }
    if (!currentSession) {
      return res.status(503).json({
        error: 'approval gateway not available — no run in progress',
      });
    }
    const ok = currentSession.gateway.resolve(requestId, {
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
              replayedFromRunId: summary?.replayedFromRunId,
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
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
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
      let content: string;
      if (stat.size <= MAX_LOG_BYTES) {
        content = readFileSync(logFile, 'utf-8');
      } else {
        const readLen = MAX_LOG_BYTES;
        const offset = stat.size - readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const fd = openSync(logFile, 'r');
        try {
          readSync(fd, buf, 0, readLen, offset);
        } finally {
          closeSync(fd);
        }
        const raw = buf.toString('utf-8');
        const newline = raw.indexOf('\n');
        content = newline !== -1 ? raw.slice(newline + 1) : raw;
      }
      res.json({ runId, content });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

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

  app.get('/api/run/history/:runId/yaml', (req, res) => {
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = S.workDir || process.cwd();
    const yamlPath = join(cwd, '.tagma', 'logs', runId, 'pipeline.yaml');
    if (!existsSync(yamlPath)) {
      return res.status(404).json({ error: 'yaml snapshot not found' });
    }
    res.type('text/yaml').send(readFileSync(yamlPath, 'utf-8'));
  });

  app.get('/api/run/history/:runId/replay-info', (req, res) => {
    const { runId } = req.params;
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      return res.status(400).json({ error: 'invalid runId' });
    }
    const cwd = S.workDir || process.cwd();
    const yamlPath = join(cwd, '.tagma', 'logs', runId, 'pipeline.yaml');
    if (!existsSync(yamlPath)) {
      return res.status(404).json({ error: 'yaml snapshot not found' });
    }
    try {
      const diskYaml = readFileSync(yamlPath, 'utf-8');
      let config: RawPipelineConfig;
      try {
        config = parseYaml(diskYaml);
      } catch {
        config = lenientParseYaml(diskYaml, `Replay ${runId}`);
      }
      const dag = buildRawDag(config);
      const priorSummary = readRunSummary(cwd, runId);
      const positions = priorSummary?.positions ?? {};
      res.json({ config, dagEdges: dag.edges, positions });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
