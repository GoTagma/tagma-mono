import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import yaml from 'js-yaml';
import {
  TASK_LOG_CAP,
  appendLiveOutput,
  bunRuntime,
  type RuntimeRunOptions,
  type TagmaRuntime,
} from '@tagma/sdk';
import { serializePipeline } from '@tagma/sdk/yaml';
import { buildRawDag } from '@tagma/sdk/config';
import { InMemoryApprovalGateway } from '@tagma/sdk/approval';
import type { CommandConfig, DriverPlugin, SpawnSpec } from '@tagma/types';
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
  PipelineGraphEventPayload,
  PipelineGraphAbortReason,
  PipelineGraphNodeState,
} from '@tagma/sdk';
import { atomicWriteFileSync, isPathWithin } from '../path-utils.js';
import type { WorkspaceState } from '../workspace-state.js';
import { readYamlRunVersion } from '../yaml-run-version.js';

// ═══ Run Session ════════════════════════════════════════════════════════
//
// Each workspace can own multiple live `RunSession` objects at a time,
// keyed by runId on `ws.runSessions`. A session encapsulates one live run:
// — abort controller, approval gateway, task mirror for snapshots,
// pipeline-level log buffer, seq counter, event ring buffer, and
// persistence inputs — so callers never have to coordinate multiple
// module-level globals. Per-run reset is free by construction: a new
// session is a new object.
//
// All wire events carry (runId, seq). Client-side dedup keys on that
// tuple: when runId changes, the reducer adopts the new run without
// needing run_start as a magic reset signal. This makes cross-run
// reconnect safe even if run_start has already fallen out of the bounded
// replay buffer.

const EVENT_BUFFER_MAX = 1024;
const HISTORY_CONTEXT_TEXT_BYTES = 128 * 1024;
const HISTORY_CONTEXT_OUTPUT_BYTES = 64 * 1024;
const HISTORY_CONTEXT_TOTAL_OUTPUT_BYTES = 256 * 1024;
const HISTORY_CONTEXT_JSON_BYTES = 64 * 1024;
const TASK_OUTPUT_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The driver task-executor falls back to when nothing in the task / track /
 * pipeline scope sets `driver`. Mirrors the literal used in
 * `packages/core/src/core/task-executor.ts` so the run summary advertises
 * the same name the engine actually picks. If you change this, change the
 * engine's default in lock-step.
 */
const DEFAULT_PROMPT_DRIVER = 'opencode';

// ═══ Runtime helpers ════════════════════════════════════════════════════

function runRouteShellArgs(command: string): string[] {
  const override = process.env.PIPELINE_SHELL;
  if (override) {
    return process.platform === 'win32' && /cmd(?:\.exe)?$/i.test(override)
      ? [override, '/c', command]
      : [override, process.platform === 'win32' ? '-Command' : '-c', command];
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (existsSync(powershell)) return [powershell, '-Command', command];
    return [`${systemRoot}\\System32\\cmd.exe`, '/c', command];
  }
  return ['/bin/sh', '-c', command];
}

function commandToSpawnSpecForRunRoute(command: CommandConfig, cwd: string): SpawnSpec {
  if (typeof command === 'string') return { args: runRouteShellArgs(command), cwd };
  if ('shell' in command) return { args: runRouteShellArgs(command.shell), cwd };
  return { args: command.argv, cwd };
}

function mergeRuntimeEnv(
  specEnv: Readonly<Record<string, string>> | undefined,
  runtimeEnv: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (Object.keys(runtimeEnv).length === 0) {
    return specEnv ? { ...specEnv } : undefined;
  }
  return { ...runtimeEnv, ...(specEnv ?? {}) };
}

const REDACTED_SECRET = '[redacted secret]';
type OutputStreamName = 'stdout' | 'stderr';
type OutputRedactor = NonNullable<RuntimeRunOptions['outputRedactor']>;

function replaceAllSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED_SECRET);
  return out;
}

export function createSecretOutputRedactor(
  values: readonly string[],
): OutputRedactor | undefined {
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return undefined;

  const maxSecretLength = Math.max(...secrets.map((secret) => secret.length));
  const states: Record<OutputStreamName, { carry: string }> = {
    stdout: { carry: '' },
    stderr: { carry: '' },
  };

  return (stream, text, final = false) => {
    const state = states[stream];
    const combined = state.carry + text;
    let safeLength = final ? combined.length : Math.max(0, combined.length - maxSecretLength + 1);

    if (!final && safeLength > 0) {
      for (const secret of secrets) {
        let idx = combined.indexOf(secret, Math.max(0, safeLength - secret.length + 1));
        while (idx !== -1) {
          const end = idx + secret.length;
          if (idx < safeLength && end > safeLength) safeLength = idx;
          idx = combined.indexOf(secret, idx + 1);
        }
      }
    }

    const emit = combined.slice(0, safeLength);
    state.carry = final ? '' : combined.slice(safeLength);
    return replaceAllSecrets(emit, secrets);
  };
}

function withOutputRedactor(
  opts: RuntimeRunOptions,
  redactor: OutputRedactor | undefined,
): RuntimeRunOptions {
  if (!redactor) return opts;
  const existing = opts.outputRedactor;
  if (!existing) return { ...opts, outputRedactor: redactor };
  return {
    ...opts,
    outputRedactor(stream, text, final) {
      return redactor(stream, existing(stream, text, final), final);
    },
  };
}

export function runtimeWithInjectedEnv(
  runtimeEnv: Readonly<Record<string, string>>,
  secretValues: readonly string[] = [],
): TagmaRuntime {
  const base = bunRuntime();
  const redactor = createSecretOutputRedactor(secretValues);
  if (Object.keys(runtimeEnv).length === 0 && !redactor) return base;
  return {
    ...base,
    runSpawn(spec: SpawnSpec, driver: DriverPlugin | null, opts: RuntimeRunOptions = {}) {
      return base.runSpawn(
        { ...spec, env: mergeRuntimeEnv(spec.env, runtimeEnv) },
        driver,
        withOutputRedactor(opts, redactor),
      );
    },
    runCommand(command: CommandConfig, cwd: string, opts: RuntimeRunOptions = {}) {
      return base.runSpawn(
        {
          ...commandToSpawnSpecForRunRoute(command, cwd),
          env: mergeRuntimeEnv(undefined, runtimeEnv),
        },
        null,
        withOutputRedactor(opts, redactor),
      );
    },
  };
}
function isPromptTaskShape(task: { prompt?: unknown; command?: unknown }): boolean {
  return task.prompt !== undefined && task.command === undefined;
}

// ═══ Target task validation ═════════════════════════════════════════════

export function normalizeRunTargetTaskIds(
  raw: unknown,
  config: RawPipelineConfig,
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('targetTaskIds must be an array of qualified task ids');
  }
  if (raw.length === 0) {
    throw new Error('targetTaskIds must contain at least one task id');
  }

  const validTaskIds = new Set<string>();
  for (const track of config.tracks) {
    for (const task of track.tasks) validTaskIds.add(`${track.id}.${task.id}`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !value.includes('.')) {
      throw new Error('targetTaskIds must contain qualified task id values');
    }
    if (!validTaskIds.has(value)) {
      throw new Error(`Target task "${value}" not found`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

// ═══ Workflow graph helpers ═════════════════════════════════════════════

function publicPipelineGraphResultFromEndEvent(
  event: Extract<PipelineGraphEventPayload, { type: 'graph_end' }>,
): unknown {
  return {
    graphRunId: event.graphRunId,
    success: event.success,
    abortReason: event.abortReason,
    pipelines: event.pipelines,
  };
}

function cloneWorkflowPipelines(
  pipelines: readonly PipelineGraphNodeState[],
): PipelineGraphNodeState[] {
  return pipelines.map((pipeline) => ({
    ...pipeline,
    dependsOn: [...pipeline.dependsOn],
    attempts: pipeline.attempts.map((attempt) => ({ ...attempt })),
  }));
}

function applyWorkflowPipelineUpdate(
  pipelines: readonly PipelineGraphNodeState[],
  event: Extract<PipelineGraphEventPayload, { type: 'pipeline_update' }>,
): PipelineGraphNodeState[] {
  return pipelines.map((pipeline) => {
    if (pipeline.pipelineId !== event.pipelineId) return pipeline;
    return {
      ...pipeline,
      status: event.status,
      runId: 'runId' in event ? (event.runId ?? null) : pipeline.runId,
      runCount: 'runCount' in event ? (event.runCount ?? pipeline.runCount) : pipeline.runCount,
      maxRuns: 'maxRuns' in event ? (event.maxRuns ?? pipeline.maxRuns) : pipeline.maxRuns,
      startedAt: 'startedAt' in event ? (event.startedAt ?? null) : pipeline.startedAt,
      finishedAt: 'finishedAt' in event ? (event.finishedAt ?? null) : pipeline.finishedAt,
      error: 'error' in event ? (event.error ?? null) : pipeline.error,
    };
  });
}

function isWorkflowPipelineTerminal(status: PipelineGraphNodeState['status']): boolean {
  return (
    status === 'success' || status === 'failed' || status === 'skipped' || status === 'aborted'
  );
}

export function buildFatalWorkflowGraphEndEvent(
  graphRunId: string,
  pipelines: readonly PipelineGraphNodeState[],
  message: string,
  abortReason: PipelineGraphAbortReason = null,
): Extract<PipelineGraphEventPayload, { type: 'graph_end' }> {
  const finishedAt = new Date().toISOString();
  const status = abortReason === 'external' ? 'aborted' : 'failed';
  return {
    type: 'graph_end',
    graphRunId,
    success: false,
    abortReason,
    pipelines: cloneWorkflowPipelines(pipelines).map((pipeline) => {
      if (isWorkflowPipelineTerminal(pipeline.status)) return pipeline;
      return {
        ...pipeline,
        status,
        finishedAt: pipeline.finishedAt ?? finishedAt,
        error: pipeline.error ?? message,
        attempts: pipeline.attempts.map((attempt) =>
          isWorkflowPipelineTerminal(attempt.status)
            ? attempt
            : {
                ...attempt,
                status,
                finishedAt: attempt.finishedAt ?? finishedAt,
                error: attempt.error ?? message,
              },
        ),
      };
    }),
  };
}

import { PipelineGraphRunner } from '@tagma/sdk';

// ═══ WorkflowRunSession ═════════════════════════════════════════════════

export type WorkflowRunSessionEvent = PipelineGraphEventPayload & { readonly seq: number };

export class WorkflowRunSession {
  readonly graphRunId: string;
  readonly startedAt: string;
  readonly events: WorkflowRunSessionEvent[] = [];
  private latestPipelines: PipelineGraphNodeState[] = [];
  private seqCounter = 0;
  result: unknown = null;
  error: string | null = null;
  done = false;

  constructor(
    readonly runner: PipelineGraphRunner,
    readonly abort: AbortController,
  ) {
    this.graphRunId = runner.graphRunId;
    this.startedAt = new Date().toISOString();
  }

  ingest(event: PipelineGraphEventPayload): WorkflowRunSessionEvent {
    const stamped = { ...event, seq: ++this.seqCounter } as WorkflowRunSessionEvent;
    if (stamped.type === 'graph_start' || stamped.type === 'graph_end') {
      this.latestPipelines = cloneWorkflowPipelines(stamped.pipelines);
    } else if (stamped.type === 'pipeline_update') {
      this.latestPipelines = applyWorkflowPipelineUpdate(this.latestPipelines, stamped);
    }
    this.events.push(stamped);
    if (this.events.length > EVENT_BUFFER_MAX) {
      this.events.splice(0, this.events.length - EVENT_BUFFER_MAX);
    }
    if (stamped.type === 'graph_end') {
      this.result = publicPipelineGraphResultFromEndEvent(stamped);
      this.done = true;
    }
    if (stamped.type === 'graph_error') this.error = stamped.error;
    return stamped;
  }

  fatalEndEvent(message: string): Extract<PipelineGraphEventPayload, { type: 'graph_end' }> {
    return buildFatalWorkflowGraphEndEvent(
      this.graphRunId,
      this.latestPipelines,
      message,
      this.abort.signal.aborted ? 'external' : null,
    );
  }

  allBuffered(): WorkflowRunSessionEvent[] {
    return [...this.events];
  }

  replayAfter(seq: number): WorkflowRunSessionEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }
}

// ═══ RunSession types ═══════════════════════════════════════════════════

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
  stdoutPath?: string | null;
  stderrPath?: string | null;
  normalizedOutput?: string | null;
  sessionId?: string | null;
}

interface RunSummaryTrack {
  id: string;
  name: string;
  color?: string;
}

type TaskUpdatePayload = Extract<RunEventPayload, { type: 'task_update' }>;
type EngineTaskState =
  EngineResult['states'] extends ReadonlyMap<string, infer State> ? State : never;

export function mergeRunTaskUpdate(prev: RunTaskState, payload: TaskUpdatePayload): RunTaskState {
  const pick = <T>(incoming: T | undefined, previous: T): T =>
    incoming !== undefined ? incoming : previous;
  return {
    ...prev,
    status: payload.status,
    startedAt: pick(payload.startedAt, prev.startedAt),
    finishedAt: pick(payload.finishedAt, prev.finishedAt),
    durationMs: pick(payload.durationMs, prev.durationMs),
    exitCode: pick(payload.exitCode, prev.exitCode),
    stdout: pick(payload.stdout, prev.stdout),
    stderr: pick(payload.stderr, prev.stderr),
    stdoutPath: pick(payload.stdoutPath, prev.stdoutPath),
    stderrPath: pick(payload.stderrPath, prev.stderrPath),
    stdoutBytes: pick(payload.stdoutBytes, prev.stdoutBytes),
    stderrBytes: pick(payload.stderrBytes, prev.stderrBytes),
    sessionId: pick(payload.sessionId, prev.sessionId),
    normalizedOutput: pick(payload.normalizedOutput, prev.normalizedOutput),
    inputs: pick(payload.inputs, prev.inputs),
    outputs: pick(payload.outputs, prev.outputs),
    resolvedDriver: pick(payload.resolvedDriver, prev.resolvedDriver),
    resolvedModel: pick(payload.resolvedModel, prev.resolvedModel),
    resolvedPermissions: pick(payload.resolvedPermissions, prev.resolvedPermissions),
  };
}

export function engineStateToTaskUpdate(
  runId: string,
  taskId: string,
  state: EngineTaskState,
): TaskUpdatePayload {
  const isPromptTask = state.config.prompt !== undefined && state.config.command === undefined;
  // Resolved-config fields come pre-seeded from the pipeline-aware seed pass
  // in seedTasks (so pipeline-level defaults like `driver: opencode` already
  // appear in the wire shape). engineStateToTaskUpdate only refines them
  // when this state actually carries a more specific value at the task or
  // track scope. Returning `undefined` here lets mergeRunTaskUpdate keep
  // the seeded value via `pick(undefined, prev) === prev`.
  const taskOrTrackDriver = isPromptTask
    ? (state.config.driver ?? state.trackConfig.driver)
    : undefined;
  const taskOrTrackModel = isPromptTask
    ? (state.config.model ?? state.trackConfig.model)
    : undefined;
  const taskOrTrackPermissions = state.config.permissions ?? state.trackConfig.permissions;
  return {
    type: 'task_update',
    runId,
    taskId,
    status: state.status,
    startedAt: state.startedAt ?? undefined,
    finishedAt: state.finishedAt ?? undefined,
    durationMs: state.result?.durationMs,
    exitCode: state.result?.exitCode,
    stdout: state.result?.stdout,
    stderr: state.result?.stderr,
    stdoutPath: state.result?.stdoutPath ?? null,
    stderrPath: state.result?.stderrPath ?? null,
    stdoutBytes: state.result?.stdoutBytes ?? null,
    stderrBytes: state.result?.stderrBytes ?? null,
    sessionId: state.result?.sessionId ?? null,
    normalizedOutput: state.result?.normalizedOutput ?? null,
    outputs: state.result?.outputs ?? null,
    inputs: null,
    resolvedDriver: taskOrTrackDriver ?? undefined,
    resolvedModel: taskOrTrackModel ?? undefined,
    resolvedPermissions: taskOrTrackPermissions ?? undefined,
  };
}

export function shouldMirrorEngineResult(buffered: readonly Pick<WireRunEvent, 'type'>[]): boolean {
  return !buffered.some(
    (event) => event.type === 'run_start' || event.type === 'run_end' || event.type === 'run_error',
  );
}

export function shouldResolveStartResponse(event: Pick<WireRunEvent, 'type'>): boolean {
  return event.type === 'run_end' || event.type === 'run_error';
}

// ═══ Summary / History types ════════════════════════════════════════════

export interface RunSummary {
  runId: string;
  pipelineName: string;
  startedAt: string;
  finishedAt: string | null;
  yamlRunVersion?: number;
  success: boolean;
  running?: boolean;
  error: string | null;
  tasks: RunSummaryTask[];
  tracks: RunSummaryTrack[];
  positions?: Record<string, { x: number; y?: number }>;
  hasYamlSnapshot?: boolean;
  replayedFromRunId?: string;
}

interface RunHistoryEntry {
  runId: string;
  path: string;
  startedAt: string;
  sizeBytes: number;
  pipelineName?: string;
  yamlRunVersion?: number;
  success?: boolean;
  running?: boolean;
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

// ═══ Approval wire conversion ═══════════════════════════════════════════

function approvalToWire(req: ApprovalRequest): ApprovalRequestInfo {
  return {
    id: req.id,
    runId: req.runId,
    taskId: req.taskId,
    trackId: req.trackId,
    message: req.message,
    createdAt: req.createdAt,
    timeoutMs: req.timeoutMs,
    metadata: req.metadata ? { ...req.metadata } : undefined,
  };
}

// ═══ RunSession class ═══════════════════════════════════════════════════

export class RunSession {
  readonly runId: string;
  readonly startedAt: string;
  readonly gateway: InMemoryApprovalGateway;
  readonly abort: AbortController;
  readonly effectiveConfig: RawPipelineConfig;
  readonly fromRunId: string | null;
  readonly yamlOverride: string | undefined;
  readonly yamlRunVersion: number | undefined;

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
    yamlRunVersion?: number,
  ) {
    this.runId = runId;
    this.startedAt = new Date().toISOString();
    this.gateway = new InMemoryApprovalGateway();
    this.abort = new AbortController();
    this.effectiveConfig = effectiveConfig;
    this.fromRunId = fromRunId;
    this.yamlOverride = yamlOverride;
    this.yamlRunVersion = yamlRunVersion;
  }

  /** Seed the task mirror + summary records from the raw config. */
  seedTasks(): void {
    // Use the core resolver so cross-track `depends_on` references show up
    // in the seeded summary (and run history) the same way the engine will
    // execute them. The previous string-prefixing branch silently treated a
    // bare task id as same-track, even when the actual DAG resolution
    // matched it against a different track — making the editor's
    // pre-execution view diverge from the running graph.
    let resolvedDepsByTaskId: Map<string, readonly string[]>;
    try {
      const dag = buildRawDag(this.effectiveConfig);
      resolvedDepsByTaskId = new Map(
        Array.from(dag.nodes, ([taskId, node]) => [taskId, node.dependsOn] as const),
      );
    } catch {
      // buildRawDag is intentionally lenient and shouldn't throw. Fall back
      // to the legacy heuristic if it ever does so we still seed the run.
      resolvedDepsByTaskId = new Map();
    }
    const pipelineDriver = this.effectiveConfig.driver ?? null;
    const pipelineModel = this.effectiveConfig.model ?? null;
    const pipelinePerms = this.effectiveConfig.permissions ?? null;

    for (const track of this.effectiveConfig.tracks) {
      for (const task of track.tasks) {
        const taskId = `${track.id}.${task.id}`;
        const isPromptTask = isPromptTaskShape(task);
        // Resolved values exposed for the run summary mirror what
        // task-executor uses (task → track → pipeline). Driver and model
        // only apply to prompt tasks: command tasks spawn a shell, no
        // model is involved, so attributing one to them in the summary
        // would lie to the user about what executed.
        const resolvedDriver = isPromptTask
          ? (task.driver ?? track.driver ?? pipelineDriver ?? DEFAULT_PROMPT_DRIVER)
          : null;
        const resolvedModel = isPromptTask
          ? (task.model ?? track.model ?? pipelineModel ?? null)
          : null;
        // Permissions DO apply to command tasks (they gate filesystem /
        // network / process access regardless of driver), so keep the
        // pipeline-level fallback for both shapes.
        const resolvedPermissions = task.permissions ?? track.permissions ?? pipelinePerms ?? null;
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
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: null,
          stderrBytes: null,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
          missingBinary: null,
          resolvedDriver,
          resolvedModel,
          resolvedPermissions,
          outputs: null,
          inputs: null,
          logs: [],
          totalLogCount: 0,
        });
        const resolved = resolvedDepsByTaskId.get(taskId);
        const deps =
          resolved !== undefined && resolved.length > 0
            ? [...resolved]
            : (task.depends_on ?? []).map((dep) =>
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
          driver: typeof resolvedDriver === 'string' ? resolvedDriver : null,
          model: typeof resolvedModel === 'string' ? resolvedModel : null,
          depends_on: deps,
        });
      }
    }
  }

  /**
   * Core can finish before emitting run_start when a pre-run gate blocks the
   * pipeline. Mirror that EngineResult so the editor still receives a snapshot
   * and terminal event instead of staying in "starting".
   */
  applyEngineResult(result: EngineResult): void {
    for (const [taskId, state] of result.states) {
      this._applyToMirror(engineStateToTaskUpdate(this.runId, taskId, state));
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

  buildSummary(endedAt: string, positions: Record<string, { x: number; y?: number }>): RunSummary {
    return {
      runId: this.runId,
      pipelineName: this.effectiveConfig.name,
      startedAt: this.startedAt,
      finishedAt: endedAt,
      ...(this.yamlRunVersion !== undefined ? { yamlRunVersion: this.yamlRunVersion } : {}),
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

  buildLiveSummary(positions: Record<string, { x: number; y?: number }>): RunSummary {
    return {
      runId: this.runId,
      pipelineName: this.effectiveConfig.name,
      startedAt: this.startedAt,
      finishedAt: null,
      ...(this.yamlRunVersion !== undefined ? { yamlRunVersion: this.yamlRunVersion } : {}),
      success: false,
      running: true,
      error: this.errorMessage,
      tasks: Array.from(this.summaries.values()),
      tracks: this.effectiveConfig.tracks.map((tr) => ({
        id: tr.id,
        name: tr.name,
        color: tr.color,
      })),
      positions,
      hasYamlSnapshot: false,
      ...(this.fromRunId !== null ? { replayedFromRunId: this.fromRunId } : {}),
    };
  }

  buildLiveHistoryEntry(cwd: string): RunHistoryEntry {
    const runDir = safeRunLogDir(cwd, this.runId);
    const logFile = join(runDir, 'pipeline.log');
    const logStat =
      existsSync(logFile) && !lstatSync(logFile).isSymbolicLink() ? statSync(logFile) : null;
    return {
      runId: this.runId,
      path: runDir,
      startedAt: this.startedAt,
      sizeBytes: logStat?.size ?? 0,
      pipelineName: this.effectiveConfig.name,
      ...(this.yamlRunVersion !== undefined ? { yamlRunVersion: this.yamlRunVersion } : {}),
      running: true,
      ...(this.fromRunId !== null ? { replayedFromRunId: this.fromRunId } : {}),
      taskCounts: computeTaskCounts(Array.from(this.summaries.values())),
    };
  }

  private _applyToMirror(payload: RunEventPayload): void {
    switch (payload.type) {
      case 'run_start':
        this.tasks.clear();
        for (const t of payload.tasks) {
          this.tasks.set(t.taskId, { ...t, logs: [...t.logs] });
          const s = this.summaries.get(t.taskId);
          if (s) {
            this.summaries.set(t.taskId, {
              ...s,
              status: t.status,
              startedAt: t.startedAt,
              finishedAt: t.finishedAt,
              durationMs: t.durationMs,
              exitCode: t.exitCode,
              driver: t.resolvedDriver ?? s.driver,
              model: t.resolvedModel ?? s.model,
              stdoutPath: t.stdoutPath ?? s.stdoutPath ?? null,
              stderrPath: t.stderrPath ?? s.stderrPath ?? null,
              normalizedOutput: t.normalizedOutput ?? s.normalizedOutput ?? null,
              sessionId: t.sessionId ?? s.sessionId ?? null,
            });
          }
        }
        return;
      case 'task_update': {
        const prev = this.tasks.get(payload.taskId);
        if (!prev) return;
        const next = mergeRunTaskUpdate(prev, payload);
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
            stdoutPath: next.stdoutPath ?? s.stdoutPath ?? null,
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
      case 'task_output': {
        // Accumulate live child output into the mirror so a client that
        // (re)connects mid-run gets the running task's output-so-far in the
        // snapshot. The terminal task_update later overwrites this with the
        // canonical disk-backed tail via mergeRunTaskUpdate's `pick`.
        const prev = this.tasks.get(payload.taskId);
        if (!prev) return;
        this.tasks.set(
          payload.taskId,
          payload.stream === 'stdout'
            ? { ...prev, stdout: appendLiveOutput(prev.stdout, payload.chunk) }
            : { ...prev, stderr: appendLiveOutput(prev.stderr, payload.chunk) },
        );
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

  private _stamp<T extends RunEventPayload | RunSnapshotPayload>(payload: T): T & { seq: number } {
    this.seqCounter += 1;
    const stamped = { ...payload, seq: this.seqCounter } as T & { seq: number };
    this.buffer.push(stamped as WireRunEvent);
    if (this.buffer.length > EVENT_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_MAX);
    }
    return stamped;
  }
}

// ═══ Run YAML snapshot ══════════════════════════════════════════════════

export function buildRunSnapshotYamlText(
  executedConfig: RawPipelineConfig,
  diskText?: string,
): string {
  const executedYaml = serializePipeline(executedConfig);
  if (diskText === undefined) return executedYaml;
  try {
    const diskParsed = yaml.load(diskText) as unknown;
    const diskPipeline =
      diskParsed &&
      typeof diskParsed === 'object' &&
      !Array.isArray(diskParsed) &&
      'pipeline' in diskParsed
        ? (diskParsed as { pipeline?: unknown }).pipeline
        : diskParsed;
    if (diskPipeline && typeof diskPipeline === 'object' && !Array.isArray(diskPipeline)) {
      const diskReserialized = serializePipeline(diskPipeline as RawPipelineConfig);
      if (diskReserialized === executedYaml) return diskText;
    }
  } catch {
    /* fall through to serialized executedConfig */
  }
  return executedYaml;
}

// ═══ Run persistence ════════════════════════════════════════════════════

export function persistRunSummary(
  ws: WorkspaceState,
  cwd: string,
  runId: string,
  summary: RunSummary,
  executedConfig: RawPipelineConfig,
  yamlOverride?: string,
): void {
  const logsDir = safeRunLogDir(cwd, runId);
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  let hasYamlSnapshot = false;
  try {
    const diskText =
      yamlOverride === undefined && ws.yamlPath && existsSync(ws.yamlPath)
        ? readFileSync(ws.yamlPath, 'utf-8')
        : undefined;
    const snapshotText =
      yamlOverride !== undefined
        ? yamlOverride
        : buildRunSnapshotYamlText(executedConfig, diskText);
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

export function readRunSummary(cwd: string, runId: string): RunSummary | null {
  let summaryPath: string;
  try {
    summaryPath = safeRunHistoryFile(cwd, runId, 'summary.json');
  } catch {
    return null;
  }
  if (!existsSync(summaryPath)) return null;
  try {
    return JSON.parse(readFileSync(summaryPath, 'utf-8')) as RunSummary;
  } catch {
    return null;
  }
}

// ═══ Text snapshot helpers ══════════════════════════════════════════════

type TextSnapshotMode = 'head' | 'tail';

function truncateTextSnapshot(text: string, maxBytes: number, mode: TextSnapshotMode): string {
  const size = Buffer.byteLength(text, 'utf-8');
  if (size <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf-8');
  if (mode === 'tail') {
    const raw = buf.subarray(size - maxBytes).toString('utf-8');
    const newline = raw.indexOf('\n');
    const clean = newline !== -1 ? raw.slice(newline + 1) : raw;
    return `[truncated to last ${maxBytes} bytes of ${size}]\n\n${clean}`;
  }
  return `${buf.subarray(0, maxBytes).toString('utf-8')}\n\n[truncated at ${maxBytes} bytes of ${size}]`;
}

function readTextSnapshot(
  filePath: string,
  maxBytes: number,
  mode: TextSnapshotMode = 'head',
): string {
  const st = statSync(filePath);
  if (st.size <= maxBytes) return readFileSync(filePath, 'utf-8');
  const buf = Buffer.allocUnsafe(maxBytes);
  const fd = openSync(filePath, 'r');
  const offset = mode === 'tail' ? st.size - maxBytes : 0;
  try {
    readSync(fd, buf, 0, maxBytes, offset);
  } finally {
    closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  if (mode === 'tail') {
    const newline = raw.indexOf('\n');
    const clean = newline !== -1 ? raw.slice(newline + 1) : raw;
    return `[truncated to last ${maxBytes} bytes of ${st.size}]\n\n${clean}`;
  }
  return `${raw}\n\n[truncated at ${maxBytes} bytes of ${st.size}]`;
}

function readOptionalTextSnapshot(
  filePath: string | null,
  maxBytes: number,
  mode: TextSnapshotMode = 'head',
): string | null {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return readTextSnapshot(filePath, maxBytes, mode);
  } catch {
    return null;
  }
}

function appendSnapshotSection(
  lines: string[],
  title: string,
  content: string | null,
  maxBytes = HISTORY_CONTEXT_TEXT_BYTES,
  mode: TextSnapshotMode = 'head',
): void {
  if (content === null) return;
  const clipped = truncateTextSnapshot(content, maxBytes, mode);
  lines.push(`## ${title}`, '', '```', clipped.trimEnd(), '```', '');
}

// ═══ Path safety ════════════════════════════════════════════════════════

function assertNotSymlink(path: string, label: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
}

export function safeRunLogDir(cwd: string, runId: string): string {
  if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error('invalid runId');
  }
  const tagmaDir = join(cwd, '.tagma');
  const logsRoot = join(tagmaDir, 'logs');
  const runDir = join(logsRoot, runId);
  assertNotSymlink(tagmaDir, '.tagma');
  assertNotSymlink(logsRoot, '.tagma/logs');
  assertNotSymlink(runDir, `run history directory ${runId}`);
  return runDir;
}

export function safeRunHistoryFile(cwd: string, runId: string, fileName: string): string {
  const runDir = safeRunLogDir(cwd, runId);
  const filePath = join(runDir, fileName);
  assertNotSymlink(filePath, `run history file ${runId}/${fileName}`);
  return filePath;
}

// ═══ Task output helpers ════════════════════════════════════════════════

function isSafeTaskOutputId(taskId: string): boolean {
  return taskId.length > 0 && TASK_OUTPUT_ID_RE.test(taskId);
}

function taskOutputFileName(taskId: string, stream: 'stdout' | 'stderr'): string {
  return `${taskId.replace(/\./g, '_')}.${stream}`;
}

export function safeRunTaskOutputFile(
  cwd: string,
  runId: string,
  taskId: string,
  stream: 'stdout' | 'stderr',
): string {
  const fileName = taskOutputFileName(taskId, stream);
  const filePath = safeRunHistoryFile(cwd, runId, fileName);
  const runDir = safeRunLogDir(cwd, runId);
  if (!isPathWithin(filePath, runDir)) {
    throw new Error('resolved path escapes run directory');
  }
  return filePath;
}

function readHistoricalTaskOutputs(
  cwd: string,
  runId: string,
  task: RunSummaryTask,
): string | null {
  if (!isSafeTaskOutputId(task.taskId)) return null;
  const sections: string[] = [];
  let remaining = HISTORY_CONTEXT_TOTAL_OUTPUT_BYTES;
  for (const stream of ['stdout', 'stderr'] as const) {
    if (remaining <= 0) {
      sections.push('[remaining task outputs omitted: context byte budget exhausted]');
      return sections.join('\n\n');
    }
    const hasStream = stream === 'stdout' ? task.stdoutPath : task.stderrPath;
    if (!hasStream) continue;
    let filePath: string;
    try {
      filePath = safeRunTaskOutputFile(cwd, runId, task.taskId, stream);
    } catch {
      continue;
    }
    const content = readOptionalTextSnapshot(
      filePath,
      Math.min(HISTORY_CONTEXT_OUTPUT_BYTES, remaining),
      'tail',
    );
    if (content === null) continue;
    remaining -= Buffer.byteLength(content, 'utf-8');
    sections.push(`### ${task.taskId} ${stream}\n\n\`\`\`\n${content.trimEnd()}\n\`\`\``);
  }
  if (task.normalizedOutput) {
    if (remaining <= 0) {
      sections.push('[normalized output omitted: context byte budget exhausted]');
      return sections.join('\n\n');
    }
    const normalized = truncateTextSnapshot(
      task.normalizedOutput,
      Math.min(HISTORY_CONTEXT_OUTPUT_BYTES, remaining),
      'head',
    );
    remaining -= Buffer.byteLength(normalized, 'utf-8');
    sections.push(
      `### ${task.taskId} normalized output\n\n\`\`\`\n${normalized.trimEnd()}\n\`\`\``,
    );
  }
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function summarizeTaskForContext(task: RunSummaryTask): string {
  const { normalizedOutput: _normalizedOutput, ...summary } = task;
  return JSON.stringify(summary, null, 2);
}

function summarizeRunHistoryForContext(summary: RunSummary): string {
  return JSON.stringify(
    {
      ...summary,
      tasks: summary.tasks.map(({ normalizedOutput: _normalizedOutput, ...task }) => task),
    },
    null,
    2,
  );
}

// ═══ History context builder ════════════════════════════════════════════

interface MatchingLatestRunContext {
  readonly runId: string;
  readonly summary: RunSummary;
  readonly log: string | null;
  readonly selectedTask: RunSummaryTask | null;
  readonly selectedTaskOutputs: string | null;
}

function findLatestRunContextForCurrentYaml(
  cwd: string,
  selectedRunId: string,
  taskId: string,
  currentYaml: string | null,
  currentYamlVersion: number,
): MatchingLatestRunContext | null {
  if (!currentYaml || currentYamlVersion <= 0) return null;
  const logsDir = join(cwd, '.tagma', 'logs');
  if (!existsSync(logsDir)) return null;
  try {
    assertNotSymlink(logsDir, '.tagma/logs');
  } catch {
    return null;
  }
  const candidates: Array<{ runId: string; summary: RunSummary }> = [];
  for (const name of readdirSync(logsDir)) {
    if (!name.startsWith('run_') || name === selectedRunId) continue;
    try {
      const dir = safeRunLogDir(cwd, name);
      if (!lstatSync(dir).isDirectory()) continue;
      const summary = readRunSummary(cwd, name);
      if (!summary || summary.yamlRunVersion !== currentYamlVersion) continue;
      const yamlPath = safeRunHistoryFile(cwd, name, 'pipeline.yaml');
      if (!existsSync(yamlPath) || readFileSync(yamlPath, 'utf-8') !== currentYaml) continue;
      candidates.push({ runId: name, summary });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => (a.summary.startedAt < b.summary.startedAt ? 1 : -1));
  const latest = candidates[0];
  if (!latest) return null;
  let log: string | null = null;
  try {
    log = readOptionalTextSnapshot(
      safeRunHistoryFile(cwd, latest.runId, 'pipeline.log'),
      HISTORY_CONTEXT_TEXT_BYTES,
      'tail',
    );
  } catch {
    log = null;
  }
  const selectedTask = latest.summary.tasks.find((task) => task.taskId === taskId) ?? null;
  return {
    runId: latest.runId,
    summary: latest.summary,
    log,
    selectedTask,
    selectedTaskOutputs: selectedTask
      ? readHistoricalTaskOutputs(cwd, latest.runId, selectedTask)
      : null,
  };
}

export function buildRunHistoryAskAiContext(
  ws: WorkspaceState,
  cwd: string,
  runId: string,
  taskId: string,
): { label: string; content: string } | null {
  const summary = readRunSummary(cwd, runId);
  const selectedTask = summary?.tasks.find((task) => task.taskId === taskId) ?? null;
  if (!summary || !selectedTask) return null;

  let historicalYamlPath: string;
  let historicalLogPath: string;
  try {
    historicalYamlPath = safeRunHistoryFile(cwd, runId, 'pipeline.yaml');
    historicalLogPath = safeRunHistoryFile(cwd, runId, 'pipeline.log');
  } catch {
    return null;
  }
  const historicalYaml = readOptionalTextSnapshot(historicalYamlPath, HISTORY_CONTEXT_TEXT_BYTES);
  if (historicalYaml === null) return null;

  let currentYamlFull: string | null = null;
  try {
    currentYamlFull =
      ws.yamlPath && existsSync(ws.yamlPath) ? readFileSync(ws.yamlPath, 'utf-8') : null;
  } catch {
    currentYamlFull = null;
  }
  const currentYaml = currentYamlFull
    ? truncateTextSnapshot(currentYamlFull, HISTORY_CONTEXT_TEXT_BYTES, 'head')
    : null;
  const currentYamlVersion = readYamlRunVersion(cwd, ws.yamlPath);
  const latestRun = findLatestRunContextForCurrentYaml(
    cwd,
    runId,
    taskId,
    currentYamlFull,
    currentYamlVersion,
  );
  const currentCompileLog = readOptionalTextSnapshot(
    currentPipelineArtifactPath(ws.yamlPath, '.compile.log'),
    HISTORY_CONTEXT_TEXT_BYTES,
    'tail',
  );
  const currentRequirements = readOptionalTextSnapshot(
    currentPipelineArtifactPath(ws.yamlPath, '.requirements.md'),
    HISTORY_CONTEXT_TEXT_BYTES,
  );
  const historicalLog = readOptionalTextSnapshot(
    historicalLogPath,
    HISTORY_CONTEXT_TEXT_BYTES,
    'tail',
  );
  const historicalOutputs = readHistoricalTaskOutputs(cwd, runId, selectedTask);

  const lines: string[] = [
    '<history-version-compare>',
    `selected-run-id: ${runId}`,
    `selected-task-id: ${taskId}`,
    `selected-run-yaml-version: ${summary.yamlRunVersion ?? 'unknown'}`,
    `latest-yaml-path: ${ws.yamlPath ?? 'none'}`,
    `latest-yaml-version: ${currentYamlVersion}`,
    `latest-run-id: ${latestRun?.runId ?? 'none'}`,
    'router-directive: delegate this turn to the stateless tagma-history-compare agent. For follow-up turns that are still about this historical version, rewrite the follow-up with the needed conversation context before calling that agent again.',
    '</history-version-compare>',
    '',
    '# Historical Version Comparison Context',
    '',
    'The user opened Ask AI from a run-history task output. Compare the latest workspace pipeline artifacts with the selected historical run snapshot and task output.',
    '',
  ];

  appendSnapshotSection(lines, 'Latest workspace YAML', currentYaml);
  appendSnapshotSection(lines, 'Latest compile log', currentCompileLog);
  appendSnapshotSection(lines, 'Latest requirements', currentRequirements);
  if (latestRun) {
    appendSnapshotSection(
      lines,
      `Latest matching run summary JSON (${latestRun.runId})`,
      summarizeRunHistoryForContext(latestRun.summary),
      HISTORY_CONTEXT_JSON_BYTES,
    );
    appendSnapshotSection(
      lines,
      `Latest matching run pipeline log (${latestRun.runId})`,
      latestRun.log,
      HISTORY_CONTEXT_TEXT_BYTES,
      'tail',
    );
    appendSnapshotSection(
      lines,
      `Latest matching run selected task output snapshots (${latestRun.runId})`,
      latestRun.selectedTaskOutputs,
      HISTORY_CONTEXT_TOTAL_OUTPUT_BYTES,
    );
  }
  appendSnapshotSection(lines, 'Historical snapshot YAML', historicalYaml);
  appendSnapshotSection(
    lines,
    'Historical summary JSON',
    summarizeRunHistoryForContext(summary),
    HISTORY_CONTEXT_JSON_BYTES,
  );
  appendSnapshotSection(
    lines,
    'Historical pipeline log',
    historicalLog,
    HISTORY_CONTEXT_TEXT_BYTES,
    'tail',
  );
  appendSnapshotSection(
    lines,
    'Selected historical task summary',
    summarizeTaskForContext(selectedTask),
    HISTORY_CONTEXT_JSON_BYTES,
  );
  appendSnapshotSection(lines, 'Historical task output snapshots', historicalOutputs);

  return {
    label: `History ${runId} ${taskId}`,
    content: lines.join('\n').trimEnd(),
  };
}

// ═══ Misc helpers ═══════════════════════════════════════════════════════

function currentPipelineArtifactPath(
  yamlPath: string | null | undefined,
  ext: '.compile.log' | '.requirements.md',
): string | null {
  if (!yamlPath) return null;
  const stem = basename(yamlPath, '.yaml');
  return join(dirname(yamlPath), `${stem}${ext}`);
}

export function computeTaskCounts(
  tasks: RunSummaryTask[],
): NonNullable<RunHistoryEntry['taskCounts']> {
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

export function positionsForSession(
  ws: WorkspaceState,
  cwd: string,
  session: RunSession,
): Record<string, { x: number; y?: number }> {
  if (session.fromRunId === null) return { ...ws.layout.positions };
  const priorSummary = readRunSummary(cwd, session.fromRunId);
  return priorSummary?.positions ? { ...priorSummary.positions } : {};
}
