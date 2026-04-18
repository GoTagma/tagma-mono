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
} from '@tagma/sdk';
import type { PipelineEvent, EngineResult, RawPipelineConfig } from '@tagma/sdk';
import type {
  TaskState,
  TaskStatus,
  ApprovalRequest,
  ApprovalEvent,
  Permissions,
} from '@tagma/types';
import { assertSafePluginName } from '../plugin-safety.js';
import { errorMessage, atomicWriteFileSync } from '../path-utils.js';
import { S, MAX_LOG_RUNS, lenientParseYaml } from '../state.js';
import { loadedPluginMeta, loadPluginFromWorkDir, classifyServerError } from '../plugins/loader.js';

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
  stderrPath: string | null;
  sessionId: string | null;
  normalizedOutput: string | null;
  resolvedDriver: string | null;
  resolvedModel: string | null;
  resolvedPermissions: Permissions | null;
  logs: RunTaskLogLine[];
  totalLogCount: number;
}

type RunEvent =
  | { type: 'run_start'; runId: string; tasks: RunTaskWire[] }
  | {
      type: 'run_snapshot';
      runId: string;
      tasks: RunTaskWire[];
      pendingApprovals: Array<{
        id: string;
        taskId: string;
        trackId?: string;
        message: string;
        createdAt: string;
        timeoutMs: number;
        metadata?: Record<string, unknown>;
      }>;
    }
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
      stderrPath?: string | null;
      sessionId?: string | null;
      normalizedOutput?: string | null;
      resolvedDriver?: string | null;
      resolvedModel?: string | null;
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
  | {
      type: 'approval_request';
      runId: string;
      request: {
        id: string;
        taskId: string;
        trackId?: string;
        message: string;
        createdAt: string;
        timeoutMs: number;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      type: 'approval_resolved';
      runId: string;
      requestId: string;
      outcome: 'approved' | 'rejected' | 'timeout' | 'aborted';
    };

// ── In-process pipeline run state ──
// We embed the SDK directly instead of spawning `tagma-cli` as a subprocess
// and regex-parsing its stdout. The server becomes the authoritative host
// for the pipeline so the full TaskState (including TaskResult with stdout,
// stderr, sessionId, etc.) is available on every event.
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
    // D4: Wrap each write individually so a single broken/ended client
    // (ERR_STREAM_WRITE_AFTER_END) cannot abort the loop and starve the
    // remaining clients. Failed clients are removed from the set.
    try {
      client.write(`id: ${currentRunSeq}\nevent: run_event\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
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
  model: string | null;
  depends_on: string[];
  // Resolved task config + result references captured at run time so the
  // history view can show "what did this task actually do" without us
  // having to re-derive anything from the live yaml.
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
  // Editor layout snapshot — qualified task id → { x } — so HistoryFlowView
  // can rebuild the exact left-to-right layout the user designed, instead
  // of falling back to a sequential per-track packing that tangles
  // cross-track dependency edges.
  positions?: Record<string, { x: number }>;
  // True when a sibling pipeline.yaml was written next to summary.json so
  // the history view can offer a "view yaml" toggle without us having to
  // probe the filesystem.
  hasYamlSnapshot?: boolean;
  // Origin tracking for replay-from-history runs. Set to the runId of the
  // immediate source snapshot this run was replayed from. Absent for runs
  // launched from the editor (the "classic" path).
  //
  // Deliberately records only ONE level of provenance: if C was replayed
  // from B which was replayed from A, C.replayedFromRunId = "B" — we do
  // NOT chain back to A. This keeps the history view easy to reason about
  // (every replay is anchored to a concrete, still-inspectable snapshot)
  // and sidesteps unbounded lineage growth when users iterate on a run.
  replayedFromRunId?: string;
}

/**
 * Persist summary.json + pipeline.yaml for a completed run.
 *
 * `executedConfig` is the config the engine actually ran against — captured
 * at run-start and held stable until persistence, so a user who edits the
 * editor mid-run cannot cause the snapshot or summary fields to drift. This
 * also makes snapshot-replay runs (which run a historical yaml without
 * touching `S.config`) record their own identity, not the editor's.
 *
 * `yamlOverride`, if provided, is written verbatim as pipeline.yaml instead
 * of re-serializing `executedConfig`. Used by replay runs to preserve the
 * exact bytes (and comments) of the source snapshot.
 */
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
  // Snapshot the pipeline definition next to summary.json so the history
  // view can show the exact config this run executed against, even after
  // the user has since edited or renamed the file.
  //
  // The engine ran against `executedConfig`, which may diverge from both
  // the current in-memory S.config (user kept editing) and the on-disk
  // yaml (unsaved edits, or a replay of a historical snapshot). We prefer
  // the on-disk file ONLY when its parsed form matches executedConfig —
  // that lets us preserve user comments/formatting for normal runs while
  // guaranteeing accuracy when the two have drifted apart.
  let hasYamlSnapshot = false;
  try {
    const executedYaml = serializePipeline(executedConfig);
    let snapshotText = yamlOverride ?? executedYaml;
    if (yamlOverride === undefined && S.yamlPath && existsSync(S.yamlPath)) {
      try {
        const diskText = readFileSync(S.yamlPath, 'utf-8');
        // Re-serialize the parsed disk yaml through the same code path to
        // neutralize cosmetic differences (indentation, key order, trailing
        // newlines) and compare semantically. If equal, prefer the original
        // disk text so user comments survive.
        const diskParsed = yaml.load(diskText) as unknown;
        const diskReserialized =
          diskParsed && typeof diskParsed === 'object'
            ? serializePipeline(diskParsed as RawPipelineConfig)
            : null;
        if (diskReserialized === executedYaml) {
          snapshotText = diskText;
        }
      } catch {
        /* disk read/parse failed — fall through to serialized executedConfig */
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

// Summaries persisted before depends_on was tracked (pre-9555457) have no
// deps field, so HistoryFlowView renders a flowchart with no edges. When the
// summary's pipeline still matches the currently loaded yaml, we can recover
// the DAG from S.config without snapshotting any editor state — the yaml is
// already the source of truth for structure.
function backfillSummaryDeps(summary: RunSummary): RunSummary {
  const needsDeps = summary.tasks.some((t) => !Array.isArray(t.depends_on));
  const needsPositions = !summary.positions || Object.keys(summary.positions).length === 0;
  if (!needsDeps && !needsPositions) return summary;
  if (summary.pipelineName !== S.config.name) return summary;
  const depMap = new Map<string, string[]>();
  for (const track of S.config.tracks) {
    for (const tc of track.tasks) {
      const qid = `${track.id}.${tc.id}`;
      const deps = (tc.depends_on ?? []).map((d) => (d.includes('.') ? d : `${track.id}.${d}`));
      depMap.set(qid, deps);
    }
  }
  return {
    ...summary,
    tasks: needsDeps
      ? summary.tasks.map((t) =>
          Array.isArray(t.depends_on) ? t : { ...t, depends_on: depMap.get(t.taskId) ?? [] },
        )
      : summary.tasks,
    positions: needsPositions ? { ...S.layout.positions } : summary.positions,
  };
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
): Extract<RunEvent, { type: 'task_update' }> {
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
    stderrPath: result?.stderrPath ?? null,
    sessionId: result?.sessionId ?? null,
    normalizedOutput: result?.normalizedOutput ?? null,
    resolvedDriver: cfg.driver ?? null,
    resolvedModel: cfg.model ?? null,
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
  /** Source snapshot runId when this run was launched via replay. */
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
        res.write(
          `event: run_event\ndata: ${JSON.stringify({
            type: 'run_snapshot',
            runId: activeRunId,
            tasks: Array.from(activeRunTasksSnapshot.values()),
            pendingApprovals: pending,
          })}\n\n`,
        );
      }
    }
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/api/run/start', async (req, res) => {
    // B4: Check both the active controller AND the synchronous lock so two
    // concurrent POST requests can't both pass the check before either sets it.
    if (activeRunAbort || runStarting) {
      return res.status(409).json({ error: 'A run is already in progress' });
    }
    runStarting = true;

    // D17: outer safety-net. The run-setup path below has several async/sync
    // operations (existsSync, parseYaml, serializePipeline, plugin preload,
    // loadPipeline, validateConfig) — earlier revisions sprinkled
    // `runStarting = false` before every error return, and a single missed
    // branch wedged the server into a permanent 409 until restart.
    // `runLaunched` flips to true exactly once, right before we reply to the
    // client after attaching `runPipeline().finally()`. If we exit the
    // handler any other way — thrown error, a new codepath added without a
    // matching release — the finally below clears the lock.
    let runLaunched = false;
    try {

    const cwd = S.workDir || process.cwd();

    // Replay-from-history support: when the client passes `{ fromRunId }`,
    // load the pipeline.yaml captured in that run's log dir and execute it
    // as-is. This deliberately does NOT touch `S.config` — the editor keeps
    // whatever the user is currently editing; the replay run is isolated
    // and records itself as a brand-new entry under .tagma/logs/<newRunId>.
    //
    // Body parsing is tolerant: JSON body may be missing (classic start).
    const fromRunId: string | null =
      typeof req.body?.fromRunId === 'string' && /^run_[A-Za-z0-9_-]+$/.test(req.body.fromRunId)
        ? req.body.fromRunId
        : null;

    // Resolve the "effective config" for this run. Normal path: the editor's
    // in-memory S.config (round-tripped through serializePipeline so we
    // exercise the same load path a CLI user would hit). Replay path: parse
    // the historical yaml snapshot. Either way we never mutate S.config.
    let effectiveConfig: RawPipelineConfig;
    let content: string;
    let yamlOverride: string | undefined;
    if (fromRunId !== null) {
      const yamlPath = join(cwd, '.tagma', 'logs', fromRunId, 'pipeline.yaml');
      if (!existsSync(yamlPath)) {
        runStarting = false;
        return res
          .status(404)
          .json({ error: `No yaml snapshot found for run ${fromRunId}; cannot replay` });
      }
      try {
        const diskYaml = readFileSync(yamlPath, 'utf-8');
        try {
          effectiveConfig = parseYaml(diskYaml);
        } catch {
          // Strict parse failed (e.g. the snapshot is from an older version
          // with missing fields) — fall back to the same lenient loader the
          // editor uses for historical yaml files.
          effectiveConfig = lenientParseYaml(diskYaml, `Replay ${fromRunId}`);
        }
        content = serializePipeline(effectiveConfig);
        yamlOverride = diskYaml; // keep the original bytes (comments intact)
      } catch (err: unknown) {
        runStarting = false;
        const message = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: `Failed to load snapshot yaml: ${message}` });
      }
    } else {
      effectiveConfig = S.config;
      // Round-trip through the SDK's serializer so replay and classic runs
      // both go through the same load path — any normalization the SDK
      // applies to yaml content stays consistent across both entrypoints.
      content = serializePipeline(effectiveConfig);
    }

    // H6: Pre-load plugins atomically — validate every name first, then load
    // them in order, and on any failure unregister everything we already
    // loaded so the SDK registry never ends up half-populated. The previous
    // path returned mid-iteration with whatever it had managed to register,
    // leaving stale handlers visible to subsequent runs.
    const pluginsToLoad = effectiveConfig.plugins ?? [];
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
            try {
              unregisterPlugin(meta.category, meta.type);
            } catch {
              /* best-effort */
            }
            // D13: Also clean up the staging directory left by stagePluginForImport
            // so failed plugin loads don't accumulate orphan dirs in plugin-runtime/.
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

    // Validate the resolved config before execution.
    const configErrors = validateConfig(pipelineConfig);
    if (configErrors.length > 0) {
      runStarting = false; // B4: release lock on error
      return res.status(400).json({ error: configErrors.join('; ') });
    }

    // B4: From here on, wrap all setup in try/catch so any unexpected synchronous
    // throw (e.g. from flatMap / broadcast / gateway constructor under future
    // refactors) still releases `runStarting` and clears partially-set globals.
    // Without this, a mid-setup exception would leave the lock stuck at `true`
    // and block every subsequent /api/run/start until server restart.
    try {
      // Build initial task list from the effective raw config. This keeps
      // the qualified taskIds aligned with the pipeline DAG that the SDK
      // produces internally (`{trackId}.{taskId}`). For replay runs this
      // draws from the historical snapshot, not the editor.
      const initialTasks: RunTaskWire[] = effectiveConfig.tracks.flatMap((track) =>
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
          stderrPath: null,
          sessionId: null,
          normalizedOutput: null,
          resolvedDriver: null,
          resolvedModel: null,
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
        const track = effectiveConfig.tracks.find((tr) => tr.id === t.trackId);
        const taskConfig = track?.tasks.find((tc) => `${track!.id}.${tc.id}` === t.taskId);
        const deps = (taskConfig?.depends_on ?? []).map((dep) =>
          dep.includes('.') ? dep : `${t.trackId}.${dep}`,
        );
        taskSnapshots.set(t.taskId, {
          taskId: t.taskId,
          trackId: t.trackId,
          trackName: track?.name ?? t.trackId,
          taskName: t.taskName,
          status: t.status,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          driver: null,
          model: null,
          depends_on: deps,
        });
      }

      activeRunAbort = abortController;
      activeRunGateway = gateway;
      activeRunId = runId;
      activeRunTasksSnapshot = new Map(
        initialTasks.map((task) => [task.taskId, structuredClone(task)]),
      );
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
            const outcome =
              event.type === 'resolved'
                ? event.decision.outcome
                : event.type === 'expired'
                  ? 'timeout'
                  : 'aborted';
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
                model: state.config.model ?? existing.model,
                prompt: state.config.prompt ?? existing.prompt ?? null,
                command: state.config.command ?? existing.command ?? null,
                stderrPath: result?.stderrPath ?? existing.stderrPath ?? null,
                normalizedOutput: result?.normalizedOutput ?? existing.normalizedOutput ?? null,
                sessionId: result?.sessionId ?? existing.sessionId ?? null,
              });
            }
            const wireEvent: Extract<RunEvent, { type: 'task_update' }> = taskStateChangeToWire(
              runId,
              event.taskId,
              event.status,
              event.state,
            );
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
              stderrPath: null,
              sessionId: null,
              normalizedOutput: null,
              resolvedDriver: null,
              resolvedModel: null,
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
              stderrPath: wireEvent.stderrPath ?? baseTask.stderrPath,
              sessionId: wireEvent.sessionId ?? baseTask.sessionId,
              normalizedOutput: wireEvent.normalizedOutput ?? baseTask.normalizedOutput,
              resolvedDriver: wireEvent.resolvedDriver ?? baseTask.resolvedDriver,
              resolvedModel: wireEvent.resolvedModel ?? baseTask.resolvedModel,
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
                stderrPath: null,
                sessionId: null,
                normalizedOutput: null,
                resolvedDriver: null,
                resolvedModel: null,
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
              const nextLogs =
                baseLogs.length >= 500
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
      })
        .then((result: EngineResult) => {
          runSuccess = result.success;
          broadcast({ type: 'run_end', runId, success: result.success });
        })
        .catch((err: unknown) => {
          // AbortError from an explicit abort() → emit run_end with success:false
          // so the UI transitions to "Aborted" rather than "Error".
          const isAbort =
            err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
          runSuccess = false;
          if (isAbort) {
            broadcast({ type: 'run_end', runId, success: false });
          } else {
            const message = err instanceof Error ? err.message : String(err);
            runErrorMessage = message;
            broadcast({ type: 'run_error', runId, error: message });
          }
        })
        .finally(() => {
          unsubscribeApprovals();
          // Abort any dangling approvals so consumers get a deterministic
          // timeout/aborted event rather than a silent drop.
          gateway.abortAll('run finished');
          // Persist a rich summary.json so RunHistoryBrowser can render a
          // per-task timeline for this run (§3.12).
          try {
            // For positions: classic runs get the live editor layout (the
            // tasks we ran match S.config, so those coords make sense); for
            // replay runs, carry the original snapshot's positions forward
            // if that run still has them, otherwise leave empty so history
            // view falls back to its default layout. We deliberately do NOT
            // read S.layout.positions for replays — those are for a possibly
            // completely different pipeline the user is now editing.
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
              {
                runId,
                pipelineName: effectiveConfig.name,
                startedAt: runStartedAt,
                finishedAt: new Date().toISOString(),
                success: runSuccess ?? false,
                error: runErrorMessage,
                tasks: Array.from(taskSnapshots.values()),
                tracks: effectiveConfig.tracks.map((tr) => ({
                  id: tr.id,
                  name: tr.name,
                  color: tr.color,
                })),
                positions: persistedPositions,
                // Only record the IMMEDIATE source. If fromRunId itself was
                // already a replay, we deliberately ignore its own upstream
                // — single-level provenance keeps the history view linear
                // and the inspection target always a file that still exists.
                ...(fromRunId !== null ? { replayedFromRunId: fromRunId } : {}),
              },
              effectiveConfig,
              yamlOverride,
            );
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

      runLaunched = true; // D17: ownership of `runStarting` transfers to runPipeline's .finally()
      res.json({ ok: true, runId });
    } catch (err: unknown) {
      // Release the lock and clear any globals we may have set before the throw
      // so a subsequent /api/run/start can proceed. Without this, a synchronous
      // failure between `runStarting = true` and the runPipeline() call would
      // wedge the server into a permanent 409 state.
      runStarting = false;
      activeRunAbort = null;
      activeRunGateway = null;
      activeRunId = null;
      activeRunTasksSnapshot = new Map();
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: `Run setup failed: ${message}` });
    }
    } finally {
      // D17: safety net. If anything threw (or a new early-return codepath
      // is added without a matching `runStarting = false`), ensure the lock
      // is released so the server isn't wedged. When the happy path attached
      // `runPipeline().finally()`, `runLaunched` is true and we leave the
      // lock alone — it stays held for the duration of the actual run and
      // is released by that finally handler when the pipeline completes.
      if (!runLaunched) {
        runStarting = false;
        activeRunAbort = null;
        activeRunGateway = null;
        activeRunId = null;
        activeRunTasksSnapshot = new Map();
      }
    }
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
        // Small file: read normally.
        content = readFileSync(logFile, 'utf-8');
      } else {
        // D5: Large file — read only the tail MAX_LOG_BYTES to avoid loading
        // hundreds of MB into the heap before clipping. Using openSync/readSync
        // so we never materialise the full file in memory.
        const readLen = MAX_LOG_BYTES;
        const offset = stat.size - readLen;
        const buf = Buffer.allocUnsafe(readLen);
        const fd = openSync(logFile, 'r');
        try {
          readSync(fd, buf, 0, readLen, offset);
        } finally {
          closeSync(fd);
        }
        // Drop the first (potentially incomplete) line so we don't start mid-UTF8.
        const raw = buf.toString('utf-8');
        const newline = raw.indexOf('\n');
        content = newline !== -1 ? raw.slice(newline + 1) : raw;
      }
      res.json({ runId, content });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
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
    res.json(backfillSummaryDeps(summary));
  });

  // Return the per-run yaml snapshot as text/yaml so the history view can
  // render or download the exact pipeline definition that ran. Returns 404
  // for old runs that predate the snapshot feature — the client should
  // fall back to "no snapshot available" rather than guess.
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

  // Replay preview: returns everything the RunView needs to render the
  // historical pipeline as if it were running, without actually starting
  // it. The UI calls this first so it can populate the run-store's
  // snapshot / dagEdges / positions overrides, THEN issues the real
  // /api/run/start with { fromRunId } to execute. Splitting the two steps
  // keeps the render path identical to a normal live run (the store gets
  // the same data shape) and avoids racing the SSE run_start against
  // still-loading yaml.
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
        // Tolerate older/partial snapshots the strict parser rejects.
        config = lenientParseYaml(diskYaml, `Replay ${runId}`);
      }
      const dag = buildRawDag(config);
      // Carry the captured task positions forward so the replay renders
      // with the same layout the original run used. An older snapshot
      // without positions falls back to {} and the UI auto-lays-out.
      const priorSummary = readRunSummary(cwd, runId);
      const positions = priorSummary?.positions ?? {};
      res.json({ config, dagEdges: dag.edges, positions });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
