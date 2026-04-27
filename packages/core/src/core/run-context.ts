import type {
  AbortReason,
  OnFailure,
  Permissions,
  PipelineConfig,
  RunEventPayload,
  EnvPolicy,
  TaskConfig,
  TaskState,
  TaskStatus,
} from '../types';
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
import { isTerminal } from './run-state';
import { nowISO } from '../utils';

function isPromptTaskConfig(
  task: TaskConfig,
): task is TaskConfig & { readonly prompt: string; readonly command?: undefined } {
  return task.prompt !== undefined && task.command === undefined;
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
  readonly logPrompt: boolean;
}

/**
 * Per-run state container. Owns the maps and abort tracking that
 * `runPipeline` previously held as closure locals, plus the small
 * methods that read/write that state. Scheduler, dataflow, and
 * task-executor extractions in later phases pass `ctx` instead of
 * relying on closure capture.
 */
export class RunContext {
  readonly runId: string;
  readonly dag: Dag;
  readonly config: PipelineConfig;
  readonly workDir: string;
  readonly pipelineInfo: PipelineInfo;
  readonly onEvent?: (event: RunEventPayload) => void;
  readonly runtime: TagmaRuntime;
  readonly envPolicy?: EnvPolicy;
  readonly logPrompt: boolean;

  readonly states = new Map<string, TaskState>();
  readonly sessionMap = new Map<string, string>();
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
    this.config = options.config;
    this.workDir = options.workDir;
    this.pipelineInfo = options.pipelineInfo;
    this.onEvent = options.onEvent;
    this.runtime = options.runtime;
    this.envPolicy = options.envPolicy;
    this.logPrompt = options.logPrompt;

    for (const [id, node] of this.dag.nodes) {
      this.states.set(id, {
        config: node.task,
        trackConfig: node.track,
        status: 'idle',
        result: null,
        startedAt: null,
        finishedAt: null,
      });
    }

    this.directDownstreams = new Map<string, string[]>();
    for (const [id] of this.dag.nodes) this.directDownstreams.set(id, []);
    for (const [id, node] of this.dag.nodes) {
      for (const upstream of node.dependsOn) {
        const list = this.directDownstreams.get(upstream);
        if (list) list.push(id);
      }
    }
  }

  emit(event: RunEventPayload): void {
    this.onEvent?.(event);
  }

  setTaskStatus(taskId: string, newStatus: TaskStatus): void {
    const state = this.states.get(taskId)!;
    // Terminal lock: once a task reaches a terminal state it must not be
    // re-transitioned. This prevents stop_all from marking running tasks as
    // skipped and then having their in-flight processTask promise overwrite
    // that with success/failed, producing an invalid double transition.
    if (isTerminal(state.status)) return;
    state.status = newStatus;
    const result = state.result;
    const cfg = state.config;
    this.emit({
      type: 'task_update',
      runId: this.runId,
      taskId,
      status: newStatus,
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
      inputs: this.resolvedInputsMap.get(taskId) ?? null,
      outputs: this.outputValuesMap.get(taskId) ?? null,
      resolvedDriver: cfg.driver ?? null,
      resolvedModel: cfg.model ?? null,
      resolvedPermissions: (cfg.permissions as Permissions | undefined) ?? null,
    });
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
      this.workDir,
      this.abortController.signal,
      log,
      this.envPolicy,
    );
  }
}
