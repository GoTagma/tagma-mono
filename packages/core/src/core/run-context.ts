import { getMaxListeners, setMaxListeners } from 'node:events';

import type {
  AbortReason,
  OnFailure,
  PipelineConfig,
  PromptContextBlock,
  RunEventPayload,
  EnvPolicy,
  SecretResolver,
  TaskContinuationSeed,
  TaskState,
  TaskStatus,
  TaskWaitReason,
} from '../types';
import { isPromptTaskConfig } from '../types';
import type { Dag } from '../dag';
import type { UpstreamBindingData } from '../ports';
import {
  executeHook,
  buildTaskContext,
  type PipelineInfo,
  type TaskInfo,
  type TrackInfo,
} from '../hooks';
import type { TagmaRuntime } from '../types';
import type { Logger } from '../logger';
import { isTerminal, resolveExecutionMetadata, skippedTaskResult } from './run-state';
import { nowISO } from '../utils';

const REDACTED_INPUT_VALUE = '[REDACTED]';

function redactInputsForEvent(
  inputs: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | null {
  if (!inputs) return null;
  const redacted: Record<string, unknown> = {};
  for (const key of Object.keys(inputs)) {
    Object.defineProperty(redacted, key, {
      configurable: true,
      enumerable: true,
      value: REDACTED_INPUT_VALUE,
      writable: true,
    });
  }
  return redacted;
}

function cloneTaskWaitReason(reason: TaskWaitReason | null | undefined): TaskWaitReason | null {
  return reason?.kind === 'dependencies'
    ? { kind: 'dependencies', taskIds: [...reason.taskIds] }
    : reason
      ? { kind: 'trigger', triggerType: reason.triggerType }
      : null;
}

function sameTaskWaitReason(
  a: TaskWaitReason | null | undefined,
  b: TaskWaitReason | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === 'trigger' && right.kind === 'trigger') {
    return left.triggerType === right.triggerType;
  }
  if (left.kind !== 'dependencies' || right.kind !== 'dependencies') return false;
  return (
    left.taskIds.length === right.taskIds.length &&
    left.taskIds.every((id, i) => id === right.taskIds[i])
  );
}

export interface RunContextOptions {
  readonly runId: string;
  readonly dag: Dag;
  readonly config: PipelineConfig;
  readonly workDir: string;
  readonly pipelineInfo: PipelineInfo;
  readonly onEvent?: (event: RunEventPayload) => void;
  readonly runtime: TagmaRuntime;
  readonly envPolicy?: EnvPolicy;
  readonly secretResolver?: SecretResolver;
  readonly logPrompt: boolean;
  readonly activeTaskIds?: ReadonlySet<string>;
  readonly taskPromptContexts?: Readonly<Record<string, readonly PromptContextBlock[]>>;
  readonly taskContinuations?: Readonly<Record<string, TaskContinuationSeed>>;
  /**
   * Fallback per-task timeout (ms) when a task has no explicit `timeout`.
   * Undefined means no default — tasks run until completion or pipeline abort.
   */
  readonly defaultTaskTimeoutMs?: number;
}

/**
 * Per-run state container. Owns the maps and abort tracking that
 * `runPipeline` previously held as closure locals, plus the small
 * methods that read/write that state. Scheduler, dataflow, and
 * task-executor extractions in later phases pass `ctx` instead of
 * relying on closure capture.
 */
export function configureRunAbortSignalListenerBudget(
  signal: AbortSignal,
  taskCount: number,
): void {
  // Every concurrently running task links one bounded phase listener to this
  // run-owned signal. A DAG with more than ten ready tasks is legitimate
  // concurrency, not a leak; size the EventTarget to the finite graph while
  // retaining any larger host-provided diagnostic budget.
  const finiteTaskCount = Number.isSafeInteger(taskCount) ? Math.max(0, taskCount) : 0;
  const required = Math.max(10, finiteTaskCount + 4);
  try {
    const current = getMaxListeners(signal);
    if (current < required) setMaxListeners(required, signal);
  } catch {
    // Older runtimes may not expose EventTarget listener controls. Listener
    // cleanup remains authoritative; observability tuning must not block runs.
  }
}

export class RunContext {
  readonly runId: string;
  readonly dag: Dag;
  readonly config: PipelineConfig;
  readonly workDir: string;
  readonly pipelineInfo: PipelineInfo;
  readonly onEvent?: (event: RunEventPayload) => void;
  readonly runtime: TagmaRuntime;
  readonly envPolicy?: EnvPolicy;
  readonly secretResolver?: SecretResolver;
  readonly logPrompt: boolean;
  readonly activeTaskIds: ReadonlySet<string> | null;
  readonly taskPromptContexts: Readonly<Record<string, readonly PromptContextBlock[]>>;
  readonly taskContinuations: Readonly<Record<string, TaskContinuationSeed>>;
  /**
   * Fallback per-task timeout (ms) when a task has no explicit `timeout`.
   * Undefined means no default safety net — tasks run until completion or
   * pipeline abort. Editor hosts pass their workspace-configured default.
   */
  readonly defaultTaskTimeoutMs?: number;

  readonly states = new Map<string, TaskState>();
  readonly sessionMap = new Map<string, string>();
  readonly sessionDriverMap = new Map<string, string>();
  readonly normalizedMap = new Map<string, string>();
  readonly outputValuesMap = new Map<string, Readonly<Record<string, unknown>>>();
  readonly bindingDataMap = new Map<string, UpstreamBindingData>();
  readonly resolvedInputsMap = new Map<string, Readonly<Record<string, unknown>>>();
  readonly directDownstreams: Map<string, string[]>;
  readonly abortController = new AbortController();
  abortReason: AbortReason | null = null;

  constructor(options: RunContextOptions) {
    this.runId = options.runId;
    this.dag = options.dag;
    configureRunAbortSignalListenerBudget(this.abortController.signal, this.dag.nodes.size);
    this.config = options.config;
    this.workDir = options.workDir;
    this.pipelineInfo = options.pipelineInfo;
    this.onEvent = options.onEvent;
    this.runtime = options.runtime;
    this.envPolicy = options.envPolicy;
    this.secretResolver = options.secretResolver;
    this.logPrompt = options.logPrompt;
    this.activeTaskIds = options.activeTaskIds ?? null;
    this.taskPromptContexts = options.taskPromptContexts ?? {};
    this.taskContinuations = options.taskContinuations ?? {};
    this.defaultTaskTimeoutMs = options.defaultTaskTimeoutMs;

    for (const [id, node] of this.dag.nodes) {
      this.states.set(id, {
        config: node.task,
        trackConfig: node.track,
        status: 'idle',
        waitReason: null,
        result: null,
        startedAt: null,
        finishedAt: null,
      });
    }

    this.directDownstreams = new Map<string, string[]>();
    for (const [id] of this.dag.nodes) this.directDownstreams.set(id, []);
    for (const [id, node] of this.dag.nodes) {
      if (this.activeTaskIds && !this.activeTaskIds.has(id)) continue;
      for (const upstream of node.dependsOn) {
        if (this.activeTaskIds && !this.activeTaskIds.has(upstream)) continue;
        const list = this.directDownstreams.get(upstream);
        if (list) list.push(id);
      }
    }
  }

  emit(event: RunEventPayload): void {
    this.onEvent?.(event);
  }

  private emitTaskUpdate(taskId: string): void {
    const state = this.states.get(taskId)!;
    const result = state.result;
    const cfg = state.config;
    const resolved = resolveExecutionMetadata(cfg, state.trackConfig, this.config);
    this.emit({
      type: 'task_update',
      runId: this.runId,
      taskId,
      status: state.status,
      waitReason: cloneTaskWaitReason(state.waitReason),
      startedAt: state.startedAt ?? undefined,
      finishedAt: state.finishedAt ?? undefined,
      durationMs: result?.durationMs,
      exitCode: result?.exitCode,
      stdout: result?.stdout,
      stderr: result?.stderr,
      stdoutPath: result?.stdoutPath ?? null,
      stderrPath: result?.stderrPath ?? null,
      stdoutBytes: result?.stdoutBytes ?? null,
      stderrBytes: result?.stderrBytes ?? null,
      sessionId: result?.sessionId ?? null,
      normalizedOutput: result?.normalizedOutput ?? null,
      failureKind: result?.failureKind ?? null,
      missingBinary: result?.missingBinary ?? null,
      inputs: redactInputsForEvent(this.resolvedInputsMap.get(taskId)),
      outputs: this.outputValuesMap.get(taskId) ?? null,
      resolvedDriver: resolved.resolvedDriver,
      resolvedModel: resolved.resolvedModel,
      resolvedPermissions: resolved.resolvedPermissions,
    });
  }

  setTaskStatus(taskId: string, newStatus: TaskStatus): void {
    const state = this.states.get(taskId)!;
    // Terminal lock: once a task reaches a terminal state it must not be
    // re-transitioned. This prevents stop_all from marking running tasks as
    // skipped and then having their in-flight processTask promise overwrite
    // that with success/failed, producing an invalid double transition.
    if (isTerminal(state.status)) return;
    state.status = newStatus;
    if (newStatus !== 'waiting') state.waitReason = null;
    this.emitTaskUpdate(taskId);
  }

  /**
   * Update the structured reason for a still-waiting task. Identical reasons
   * are suppressed so dependency rescans do not create event-stream churn.
   */
  setTaskWaitReason(taskId: string, reason: TaskWaitReason | null): void {
    const state = this.states.get(taskId)!;
    if (state.status !== 'waiting' || isTerminal(state.status)) return;
    const next = cloneTaskWaitReason(reason);
    if (sameTaskWaitReason(state.waitReason, next)) return;
    state.waitReason = next;
    this.emitTaskUpdate(taskId);
  }

  getOnFailure(taskId: string): OnFailure {
    return this.dag.nodes.get(taskId)?.track.on_failure ?? 'skip_downstream';
  }

  isDependencySatisfied(depId: string): 'satisfied' | 'unsatisfied' | 'skip' {
    const depState = this.states.get(depId);
    if (!depState) return 'skip';
    switch (depState.status) {
      case 'success':
        return 'satisfied';
      case 'skipped':
        return 'skip';
      case 'failed':
      case 'timeout':
      case 'blocked':
        return this.getOnFailure(depId) === 'ignore' ? 'satisfied' : 'skip';
      default:
        return 'unsatisfied';
    }
  }

  /**
   * H3: stop_all marks every still-waiting task across every track as
   * skipped and aborts in-flight tasks via the shared signal. The
   * terminal lock in setTaskStatus prevents any later re-transition
   * should a completed running task try to overwrite the skipped state.
   */
  applyStopAll(): void {
    if (this.abortReason === null) this.abortReason = 'stop_all';
    this.abortController.abort();
    for (const [id, state] of this.states) {
      if (state.status === 'waiting') {
        state.finishedAt = nowISO();
        state.result = skippedTaskResult(
          'skipped because the pipeline stopped after a task failure',
        );
        this.setTaskStatus(id, 'skipped');
      }
    }
  }

  buildTaskInfoObj(taskId: string): TaskInfo {
    const state = this.states.get(taskId)!;
    return {
      id: taskId,
      name: state.config.name,
      type: isPromptTaskConfig(state.config) ? 'ai' : 'command',
      status: state.status,
      exit_code: state.result?.exitCode ?? null,
      duration_ms: state.result?.durationMs ?? null,
      stderr_path: state.result?.stderrPath ?? null,
      session_id: state.result?.sessionId ?? null,
      started_at: state.startedAt,
      finished_at: state.finishedAt,
    };
  }

  trackInfoOf(taskId: string): TrackInfo {
    const node = this.dag.nodes.get(taskId)!;
    return { id: node.track.id, name: node.track.name };
  }

  async fireHook(
    taskId: string,
    event: 'task_success' | 'task_failure',
    log?: Logger,
    cwd: string = this.workDir,
  ): Promise<void> {
    await executeHook(
      this.config.hooks,
      event,
      buildTaskContext(
        event,
        this.pipelineInfo,
        this.trackInfoOf(taskId),
        this.buildTaskInfoObj(taskId),
      ),
      this.runtime,
      cwd,
      this.abortController.signal,
      log,
      this.envPolicy,
    );
  }
}
