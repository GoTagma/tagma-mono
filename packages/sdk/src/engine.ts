import { resolve } from 'path';
import { readdir, rm } from 'fs/promises';
import type {
  PipelineConfig,
  TaskConfig,
  TaskState,
  TaskStatus,
  TaskResult,
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
  MiddlewareContext,
  DriverContext,
  OnFailure,
  PromptDocument,
  Permissions,
  AbortReason,
  RunEventPayload,
  RunTaskState,
} from './types';
import { buildDag, type Dag } from './dag';
import { defaultRegistry, type PluginRegistry } from './registry';
import { runSpawn, runCommand } from './runner';
import { parseDuration, nowISO, generateRunId } from './utils';
import {
  promptDocumentFromString,
  serializePromptDocument,
  prependContext,
  renderInputsBlock,
  renderOutputSchemaBlock,
} from './prompt-doc';
import {
  extractTaskOutputs,
  inferPromptPorts,
  resolveTaskInputs,
  substituteInputs,
} from './ports';
import type { TaskPorts } from './types';
import {
  executeHook,
  buildPipelineStartContext,
  buildTaskContext,
  buildPipelineCompleteContext,
  buildPipelineErrorContext,
  type PipelineInfo,
  type TrackInfo,
  type TaskInfo,
} from './hooks';
import { Logger, tailLines, clip } from './logger';
import { InMemoryApprovalGateway, type ApprovalGateway } from './approval';

// ═══ A7: Typed trigger errors ═══
// Replace string-matching on error messages with structured error types so
// coincidental substrings don't cause misclassification.

export class TriggerBlockedError extends Error {
  readonly code = 'TRIGGER_BLOCKED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerBlockedError';
  }
}

export class TriggerTimeoutError extends Error {
  readonly code = 'TRIGGER_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerTimeoutError';
  }
}

// ═══ Preflight Validation ═══

function preflight(config: PipelineConfig, dag: Dag, registry: PluginRegistry): void {
  const errors: string[] = [];

  for (const [, node] of dag.nodes) {
    const task = node.task;
    const track = node.track;
    const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';

    // Pure command tasks don't use a driver — skip driver registration check.
    const isCommandOnly = task.command && !task.prompt;

    if (!isCommandOnly && !registry.hasHandler('drivers', driverName)) {
      errors.push(`Task "${node.taskId}": driver "${driverName}" not registered`);
    }

    if (task.trigger && !registry.hasHandler('triggers', task.trigger.type)) {
      errors.push(`Task "${node.taskId}": trigger type "${task.trigger.type}" not registered`);
    }

    if (task.completion && !registry.hasHandler('completions', task.completion.type)) {
      errors.push(
        `Task "${node.taskId}": completion type "${task.completion.type}" not registered`,
      );
    }

    const mws = task.middlewares ?? track.middlewares ?? [];
    for (const mw of mws) {
      if (!registry.hasHandler('middlewares', mw.type)) {
        errors.push(`Task "${node.taskId}": middleware type "${mw.type}" not registered`);
      }
    }

    if (task.continue_from && registry.hasHandler('drivers', driverName)) {
      const driver = registry.getHandler<DriverPlugin>('drivers', driverName);
      if (!driver.capabilities.sessionResume) {
        // buildDag has already qualified `continue_from` and stored the result
        // on the node; preflight runs after buildDag, so the upstream id is
        // always available here without re-resolving.
        const upstreamId = node.resolvedContinueFrom;
        if (upstreamId) {
          const upstream = dag.nodes.get(upstreamId);
          if (upstream) {
            // A handoff is possible via session resume (already ruled out above),
            // OR in-memory text injection through normalizedMap
            // (when the upstream driver implements parseResult and returns normalizedOutput).
            const upstreamDriverName =
              upstream.task.driver ?? upstream.track.driver ?? config.driver ?? 'opencode';
            const upstreamDriver = registry.hasHandler('drivers', upstreamDriverName)
              ? registry.getHandler<DriverPlugin>('drivers', upstreamDriverName)
              : null;
            const canNormalize = typeof upstreamDriver?.parseResult === 'function';

            if (!canNormalize) {
              errors.push(
                `Task "${node.taskId}" uses continue_from: "${task.continue_from}", ` +
                  `but upstream task "${upstreamId}" its driver ` +
                  `does not implement parseResult for text-injection handoff. ` +
                  `Use a driver with parseResult, or remove continue_from.`,
              );
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Preflight validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

// ═══ Engine ═══

export interface EngineResult {
  readonly success: boolean;
  readonly runId: string;
  readonly logPath: string;
  readonly summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    timeout: number;
    blocked: number;
  };
  readonly states: ReadonlyMap<string, TaskState>;
}

// ═══ Pipeline Events ═══
//
// The engine emits RunEventPayload values (defined in @tagma/types) via
// `onEvent`. Every payload carries `runId`; the editor server stamps a
// per-run `seq` before broadcasting. There is one event vocabulary
// end-to-end — no server-side translation layer.

// Re-export so SDK consumers can import the event type without reaching
// into @tagma/types directly.
export type { RunEventPayload } from './types';

// ═══ Helpers ═══

/**
 * Project the engine's internal TaskState onto the wire RunTaskState
 * shape. `logs` / `totalLogCount` default to empty — they are populated
 * on the server side from streamed `task_log` events, not from state.
 */
function toRunTaskState(
  taskId: string,
  trackId: string,
  taskName: string,
  state: TaskState,
): RunTaskState {
  const result = state.result;
  const cfg = state.config;
  return {
    taskId,
    trackId,
    taskName,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    durationMs: result?.durationMs ?? null,
    exitCode: result?.exitCode ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    stdoutPath: result?.stdoutPath ?? null,
    stderrPath: result?.stderrPath ?? null,
    stdoutBytes: result?.stdoutBytes ?? null,
    stderrBytes: result?.stderrBytes ?? null,
    sessionId: result?.sessionId ?? null,
    normalizedOutput: result?.normalizedOutput ?? null,
    resolvedDriver: cfg.driver ?? null,
    resolvedModel: cfg.model ?? null,
    resolvedPermissions: (cfg.permissions as Permissions | undefined) ?? null,
    // Ports not yet wired through the engine's event surface. Null placeholder
    // keeps the wire type honest until the ports extraction pass lands.
    outputs: result?.outputs ?? null,
    inputs: null,
    logs: [],
    totalLogCount: 0,
  };
}

export interface RunPipelineOptions {
  readonly approvalGateway?: ApprovalGateway;
  /**
   * Maximum number of per-run log directories to retain under `<workDir>/.tagma/logs/`.
   * Oldest directories are deleted after each run. Defaults to 20. Set to 0 to disable cleanup.
   */
  readonly maxLogRuns?: number;
  /**
   * Caller-supplied run ID. When provided the engine uses this instead of
   * generating its own via `generateRunId()`, keeping the editor and SDK
   * log directories aligned on the same ID.
   */
  readonly runId?: string;
  /**
   * External AbortSignal — aborting it cancels the pipeline immediately.
   * Equivalent to the pipeline timeout firing, but caller-controlled.
   */
  readonly signal?: AbortSignal;
  /**
   * Called on every pipeline/task status transition.
   * Use for real-time UI updates (e.g. updating a visual workflow graph).
   */
  readonly onEvent?: (event: RunEventPayload) => void;
  /**
   * Skip the engine's built-in `loadPlugins(config.plugins)` call.
   * Use this when the host has already pre-loaded plugins from a custom
   * resolution path (e.g. a user workspace's node_modules) so the engine
   * doesn't re-resolve them via Node's default cwd-based import.
   */
  readonly skipPluginLoading?: boolean;
  /**
   * Plugin registry to resolve drivers/triggers/completions/middlewares from.
   * Defaults to the process-wide `defaultRegistry`. Multi-tenant hosts pass a
   * per-workspace registry so concurrent runs in different workspaces see
   * isolated handler sets.
   */
  readonly registry?: PluginRegistry;
}

// Poll interval when no tasks are in-flight but non-terminal tasks remain
// (e.g. tasks waiting on a file or manual trigger).
const POLL_INTERVAL_MS = 50;

// R15: cap on each normalized-output entry stored in normalizedMap so a
// runaway parseResult can't accumulate hundreds of MB across tasks. 1 MB
// is generous for any text-context handoff between AI tasks.
const MAX_NORMALIZED_BYTES = 1_000_000;

export async function runPipeline(
  config: PipelineConfig,
  workDir: string,
  options: RunPipelineOptions = {},
): Promise<EngineResult> {
  const approvalGateway = options.approvalGateway ?? new InMemoryApprovalGateway();
  const maxLogRuns = options.maxLogRuns ?? 20;
  const registry = options.registry ?? defaultRegistry;

  // Load any plugins declared in the pipeline config before preflight so that
  // drivers, completions, and middlewares referenced in YAML are registered.
  // Hosts that pre-load plugins from a custom path (e.g. the editor loading
  // from the user's workspace node_modules) pass skipPluginLoading: true so
  // we don't re-resolve via Node's cwd-based default import.
  if (!options.skipPluginLoading && config.plugins?.length) {
    await registry.loadPlugins(config.plugins);
  }

  const dag = buildDag(config);
  const runId = options.runId ?? generateRunId();
  preflight(config, dag, registry);

  const startedAt = nowISO();
  const pipelineInfo: PipelineInfo = { name: config.name, run_id: runId, started_at: startedAt };
  // Forward every structured log line to subscribers as task_log events.
  // Reading options.onEvent inside the callback (vs. capturing it once) keeps
  // the SDK behavior correct if callers pass a fresh onEvent on each run.
  const log = new Logger(workDir, runId, (record) => {
    options.onEvent?.({
      type: 'task_log',
      runId,
      taskId: record.taskId,
      level: record.level,
      timestamp: record.timestamp,
      text: record.text,
    });
  });

  try {
    log.info('[pipeline]', `start "${config.name}" run_id=${runId}`);

    // File-only: dump the resolved pipeline shape + DAG topology for post-mortem.
    log.section('Pipeline configuration');
    log.quiet(`name:          ${config.name}`);
    log.quiet(`driver:        ${config.driver ?? '(default: opencode)'}`);
    log.quiet(`timeout:       ${config.timeout ?? '(none)'}`);
    log.quiet(`tracks:        ${config.tracks.length}`);
    log.quiet(`tasks (total): ${dag.nodes.size}`);
    log.quiet(`plugins:       ${(config.plugins ?? []).join(', ') || '(none)'}`);
    log.quiet(
      `hooks:         ${config.hooks ? Object.keys(config.hooks).join(', ') || '(none)' : '(none)'}`,
    );

    log.section('DAG topology');
    for (const [id, node] of dag.nodes) {
      const deps = node.dependsOn.length ? node.dependsOn.join(', ') : '(root)';
      const kind = node.task.prompt ? 'ai' : 'cmd';
      log.quiet(`  • ${id}  [${kind}]  track=${node.track.id}  deps=[${deps}]`);
    }
    log.quiet('');

    // Initialize states (before hook, so we can return them even if blocked)
    const states = new Map<string, TaskState>();
    for (const [id, node] of dag.nodes) {
      states.set(id, {
        config: node.task,
        trackConfig: node.track,
        status: 'idle',
        result: null,
        startedAt: null,
        finishedAt: null,
      });
    }

    // Pipeline start hook (gate). Runs BEFORE the engine emits run_start so
    // a blocked pipeline produces zero wire events (the server treats the
    // thrown error as run_error). Hosts get a rich error message; nothing
    // is ever half-broadcast.
    const startHook = await executeHook(
      config.hooks,
      'pipeline_start',
      buildPipelineStartContext(pipelineInfo),
      workDir,
    );
    if (!startHook.allowed) {
      console.error(`Pipeline blocked by pipeline_start hook (exit code ${startHook.exitCode})`);
      await executeHook(
        config.hooks,
        'pipeline_error',
        buildPipelineErrorContext(pipelineInfo, 'pipeline_blocked', 'pipeline_blocked'),
        workDir,
      );
      return {
        success: false,
        runId,
        logPath: log.path,
        summary: {
          total: dag.nodes.size,
          success: 0,
          failed: 0,
          skipped: 0,
          timeout: 0,
          blocked: 0,
        },
        states: freezeStates(states),
      };
    }

    // Pipeline approved — transition all tasks to waiting.
    for (const [, state] of states) {
      state.status = 'waiting';
    }
    // Emit run_start with a wire-shape snapshot so SSE subscribers can
    // initialize their task maps on the same event stream that carries
    // updates. No separate "server pre-broadcasts run_start" ceremony —
    // the engine owns the lifecycle boundary.
    const runStartTasks: RunTaskState[] = [];
    for (const [id, node] of dag.nodes) {
      const s = states.get(id)!;
      runStartTasks.push(toRunTaskState(id, node.track.id, node.task.name ?? id, s));
    }
    emit({ type: 'run_start', runId, tasks: runStartTasks });

    const sessionMap = new Map<string, string>();
    const normalizedMap = new Map<string, string>();
    // Extracted port outputs keyed by fully-qualified task id. Populated
    // after a task succeeds when its `ports.outputs` is declared; read by
    // downstream tasks via `resolveTaskInputs` to assemble their inputs.
    // Kept separate from normalizedMap so the continue_from text handoff
    // and the typed-port data handoff don't pollute each other — they
    // solve different problems and have different lifetimes.
    const outputValuesMap = new Map<string, Readonly<Record<string, unknown>>>();
    // Resolved port inputs keyed by fully-qualified task id. Written once,
    // just before a task runs, so every subsequent task_update event can
    // echo them to the UI without re-resolving.
    const resolvedInputsMap = new Map<string, Readonly<Record<string, unknown>>>();
    // Reverse adjacency: for each task, list the direct-downstream task ids
    // (tasks whose `depends_on` includes this one after DAG qualification).
    // Computed once up front so Prompt-task port inference — which needs
    // "what Commands directly consume me?" — is O(1) instead of O(tasks)
    // per Prompt start. `dag.nodes` only exposes forward edges via
    // `dependsOn`, so we build this locally.
    const directDownstreams = new Map<string, string[]>();
    for (const [id] of dag.nodes) directDownstreams.set(id, []);
    for (const [id, node] of dag.nodes) {
      for (const upstream of node.dependsOn) {
        const list = directDownstreams.get(upstream);
        if (list) list.push(id);
      }
    }

    // Pipeline timeout + abort reason tracking.
    //
    // `abortReason` replaces the previous `pipelineAborted: boolean`: it
    // carries the concrete cause (timeout / stop_all / external) through
    // to run_end and the pipeline_error hook so downstream consumers can
    // distinguish them without scraping message strings.
    const pipelineTimeoutMs = config.timeout ? parseDuration(config.timeout) : 0;
    let abortReason: AbortReason | null = null;
    const abortController = new AbortController();
    let pipelineTimer: ReturnType<typeof setTimeout> | null = null;

    if (pipelineTimeoutMs > 0) {
      pipelineTimer = setTimeout(() => {
        if (abortReason === null) abortReason = 'timeout';
        abortController.abort();
      }, pipelineTimeoutMs);
    }

    // When the pipeline is aborted (timeout, stop_all, external), drain
    // all pending approvals so waiting triggers unblock immediately.
    abortController.signal.addEventListener('abort', () => {
      approvalGateway.abortAll('pipeline aborted');
    });

    // Wire external cancel signal into the internal abort controller.
    const externalAbortHandler = () => {
      if (abortReason === null) abortReason = 'external';
      abortController.abort();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        externalAbortHandler();
      } else {
        options.signal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }

    // Bridge approval gateway events onto the wire stream so hosts (editor
    // server, CLI adapters) see approvals on the same channel as task
    // updates. The server no longer needs its own gateway subscription.
    const unsubscribeApprovals = approvalGateway.subscribe((ev) => {
      if (ev.type === 'requested') {
        emit({
          type: 'approval_request',
          runId,
          request: {
            id: ev.request.id,
            taskId: ev.request.taskId,
            trackId: ev.request.trackId,
            message: ev.request.message,
            createdAt: ev.request.createdAt,
            timeoutMs: ev.request.timeoutMs,
            metadata: ev.request.metadata,
          },
        });
        return;
      }
      if (ev.type === 'resolved' || ev.type === 'expired' || ev.type === 'aborted') {
        const outcome =
          ev.type === 'resolved'
            ? ev.decision.outcome
            : ev.type === 'expired'
              ? 'timeout'
              : 'aborted';
        emit({
          type: 'approval_resolved',
          runId,
          requestId: ev.request.id,
          outcome,
        });
      }
    });

    // ── Helpers ──

    function emit(event: RunEventPayload): void {
      options.onEvent?.(event);
    }

    function setTaskStatus(taskId: string, newStatus: TaskStatus): void {
      const state = states.get(taskId)!;
      // Terminal lock: once a task reaches a terminal state it must not be
      // re-transitioned. This prevents stop_all from marking running tasks as
      // skipped and then having their in-flight processTask promise overwrite
      // that with success/failed, producing an invalid double transition.
      if (isTerminal(state.status)) return;
      state.status = newStatus;
      const result = state.result;
      const cfg = state.config;
      emit({
        type: 'task_update',
        runId,
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
        inputs: resolvedInputsMap.get(taskId) ?? null,
        outputs: outputValuesMap.get(taskId) ?? null,
        resolvedDriver: cfg.driver ?? null,
        resolvedModel: cfg.model ?? null,
        resolvedPermissions: (cfg.permissions as Permissions | undefined) ?? null,
      });
    }

    function getOnFailure(taskId: string): OnFailure {
      return dag.nodes.get(taskId)?.track.on_failure ?? 'skip_downstream';
    }

    function isDependencySatisfied(depId: string): 'satisfied' | 'unsatisfied' | 'skip' {
      const depState = states.get(depId);
      if (!depState) return 'skip';
      switch (depState.status) {
        case 'success':
          return 'satisfied';
        case 'skipped':
          return 'skip';
        case 'failed':
        case 'timeout':
        case 'blocked':
          return getOnFailure(depId) === 'ignore' ? 'satisfied' : 'skip';
        default:
          return 'unsatisfied';
      }
    }

    /**
     * H3: "stop_all" historically only stopped tasks within the same track,
     * which contradicted both its name and user expectations. It now stops
     * the **entire pipeline**:
     *   - In-flight tasks are signalled via the shared abort controller so
     *     drivers / runner.ts can cancel cooperatively (returning
     *     `failureKind: 'timeout'`).
     *   - Still-waiting tasks across every track are immediately marked
     *     skipped so the run completes promptly.
     * The terminal lock in setTaskStatus prevents any later re-transition
     * should a completed running task try to overwrite the skipped state.
     */
    function applyStopAll(_failedTrackId: string): void {
      if (abortReason === null) abortReason = 'stop_all';
      abortController.abort();
      for (const [id, state] of states) {
        if (state.status === 'waiting') {
          state.finishedAt = nowISO();
          setTaskStatus(id, 'skipped');
        }
      }
    }

    function buildTaskInfoObj(taskId: string): TaskInfo {
      const state = states.get(taskId)!;
      return {
        id: taskId,
        name: state.config.name,
        type: state.config.prompt ? 'ai' : 'command',
        status: state.status,
        exit_code: state.result?.exitCode ?? null,
        duration_ms: state.result?.durationMs ?? null,
        stderr_path: state.result?.stderrPath ?? null,
        session_id: state.result?.sessionId ?? null,
        started_at: state.startedAt,
        finished_at: state.finishedAt,
      };
    }

    function trackInfoOf(taskId: string): TrackInfo {
      const node = dag.nodes.get(taskId)!;
      return { id: node.track.id, name: node.track.name };
    }

    async function fireHook(taskId: string, event: 'task_success' | 'task_failure'): Promise<void> {
      await executeHook(
        config.hooks,
        event,
        buildTaskContext(event, pipelineInfo, trackInfoOf(taskId), buildTaskInfoObj(taskId)),
        workDir,
        abortController.signal,
      );
    }

    // ── Process a single task ──

    async function processTask(taskId: string): Promise<void> {
      const state = states.get(taskId)!;
      const node = dag.nodes.get(taskId)!;
      const task = node.task;
      const track = node.track;

      log.section(`Task ${taskId}`, taskId);
      log.debug(
        `[task:${taskId}]`,
        `type=${task.prompt ? 'ai' : 'cmd'} track=${track.id} deps=[${node.dependsOn.join(', ') || '(root)'}]`,
      );

      // 1. Check dependencies
      for (const depId of node.dependsOn) {
        const result = isDependencySatisfied(depId);
        if (result === 'skip') {
          const depStatus = states.get(depId)?.status ?? 'unknown';
          log.debug(`[task:${taskId}]`, `skipped (upstream "${depId}" status=${depStatus})`);
          state.finishedAt = nowISO();
          setTaskStatus(taskId, 'skipped');
          return;
        }
        if (result === 'unsatisfied') return; // still waiting
      }

      // 2. Check trigger
      if (task.trigger) {
        log.debug(
          `[task:${taskId}]`,
          `trigger wait: type=${task.trigger.type} ${JSON.stringify(task.trigger)}`,
        );
        try {
          const triggerPlugin = registry.getHandler<TriggerPlugin>('triggers', task.trigger.type);
          // R6: race the plugin's watch() against the pipeline's abort signal
          // AND the task-level timeout. Third-party triggers may forget to
          // wire up ctx.signal — without the abort race, an aborted pipeline
          // would hang forever waiting for the plugin's watch promise to
          // resolve. And without the timeout race, a buggy watch() that never
          // settles would ignore the user's `task.timeout` (which the spawn
          // path at step 4 already honours) — a task could wedge the whole
          // pipeline until pipeline-level timeout fires (or forever, if none
          // is set). Honouring task.timeout here makes the two stages
          // symmetric. The cleanup paths in finally never run on the orphaned
          // plugin promise (it's allowed to leak a watcher; the pipeline is
          // being torn down anyway).
          const triggerTimeoutMs = task.timeout ? parseDuration(task.timeout) : 0;
          await new Promise<unknown>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const onAbort = () => {
              if (settled) return;
              settled = true;
              if (timer !== null) clearTimeout(timer);
              reject(new Error('Pipeline aborted'));
            };
            if (abortController.signal.aborted) {
              onAbort();
              return;
            }
            abortController.signal.addEventListener('abort', onAbort, { once: true });
            if (triggerTimeoutMs > 0) {
              timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                abortController.signal.removeEventListener('abort', onAbort);
                reject(
                  new TriggerTimeoutError(
                    `Trigger "${task.trigger!.type}" did not settle within ${task.timeout} (task-level timeout)`,
                  ),
                );
              }, triggerTimeoutMs);
            }
            triggerPlugin
              .watch(task.trigger as Record<string, unknown>, {
                taskId: node.taskId,
                trackId: track.id,
                workDir: task.cwd ?? workDir,
                signal: abortController.signal,
                approvalGateway,
              })
              .then(
                (v) => {
                  if (settled) return;
                  settled = true;
                  if (timer !== null) clearTimeout(timer);
                  abortController.signal.removeEventListener('abort', onAbort);
                  resolve(v);
                },
                (e) => {
                  if (settled) return;
                  settled = true;
                  if (timer !== null) clearTimeout(timer);
                  abortController.signal.removeEventListener('abort', onAbort);
                  reject(e);
                },
              );
          });
          log.debug(`[task:${taskId}]`, `trigger fired`);
        } catch (err: unknown) {
          // If pipeline was aborted while we were still waiting for the trigger,
          // this task never entered running state → skipped, not timeout.
          state.finishedAt = nowISO();
          if (abortReason !== null) {
            setTaskStatus(taskId, 'skipped');
          } else if (err instanceof TriggerBlockedError) {
            setTaskStatus(taskId, 'blocked'); // user/policy rejection
          } else if (err instanceof TriggerTimeoutError) {
            setTaskStatus(taskId, 'timeout'); // genuine trigger wait timeout
          } else {
            // A7 fallback: also check message strings for backward-compat with
            // third-party trigger plugins that don't throw typed errors yet.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('rejected') || msg.includes('denied')) {
              setTaskStatus(taskId, 'blocked');
            } else if (msg.includes('timeout')) {
              setTaskStatus(taskId, 'timeout');
            } else {
              setTaskStatus(taskId, 'failed'); // plugin error, watcher crash, etc.
            }
          }
          try {
            await fireHook(taskId, 'task_failure');
          } catch (hookErr) {
            log.error(
              `[task:${taskId}]`,
              `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
            );
          }
          return;
        }
      }

      // 3. task_start hook (gate)
      const hookResult = await executeHook(
        config.hooks,
        'task_start',
        buildTaskContext('task_start', pipelineInfo, trackInfoOf(taskId), buildTaskInfoObj(taskId)),
        workDir,
        abortController.signal,
      );
      if (hookResult.exitCode !== 0 || config.hooks?.task_start) {
        log.debug(
          `[task:${taskId}]`,
          `task_start hook exit=${hookResult.exitCode} allowed=${hookResult.allowed}`,
        );
      }
      if (!hookResult.allowed) {
        state.finishedAt = nowISO();
        setTaskStatus(taskId, 'blocked');
        try {
          await fireHook(taskId, 'task_failure');
        } catch (hookErr) {
          log.error(
            `[task:${taskId}]`,
            `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
        return;
      }

      // 3.5. Resolve port inputs from upstream outputs. This is the last
      // gate before execution: missing-required inputs block the task
      // without ever spawning a process, so the caller sees a clear
      // "blocked: missing input X" rather than a cryptic runtime error
      // from a command that expanded a placeholder to the empty string.
      // Resolution runs even for tasks that declare no ports — the call
      // is cheap and returns `{kind: 'ready', inputs: {}}` in that case,
      // which downstream code handles uniformly.
      //
      // Prompt Tasks have no declared ports — their I/O contract is
      // inferred from direct-neighbor Command Tasks (see ports.ts:
      // `inferPromptPorts`). We synthesize a `TaskPorts` object and
      // feed it into the same resolve/substitute/render/extract
      // pipeline the Command path uses. Collisions that a Prompt can't
      // disambiguate (same input name on two upstreams, incompatible
      // downstream output types) block the task with a clear message.
      const isPromptTask = task.prompt !== undefined && task.command === undefined;
      let effectivePorts: TaskPorts | undefined = task.ports;
      let promptInferenceBlockReason: string | null = null;

      if (isPromptTask) {
        const inference = inferPromptPorts({
          upstreams: node.dependsOn.map((upstreamId) => {
            const upstream = dag.nodes.get(upstreamId);
            const isUpstreamCommand = !!upstream?.task.command;
            return {
              taskId: upstreamId,
              outputs: isUpstreamCommand ? upstream?.task.ports?.outputs : undefined,
            };
          }),
          downstreams: (directDownstreams.get(taskId) ?? []).map((downstreamId) => {
            const downstream = dag.nodes.get(downstreamId);
            const isDownstreamCommand = !!downstream?.task.command;
            return {
              taskId: downstreamId,
              inputs: isDownstreamCommand ? downstream?.task.ports?.inputs : undefined,
            };
          }),
        });
        effectivePorts = inference.ports;
        if (inference.inputConflicts.length > 0 || inference.outputConflicts.length > 0) {
          const lines: string[] = [];
          for (const c of inference.inputConflicts) lines.push(c.reason);
          for (const c of inference.outputConflicts) lines.push(c.reason);
          promptInferenceBlockReason = lines.join('\n');
        }
      }

      if (promptInferenceBlockReason !== null) {
        log.error(
          `[task:${taskId}]`,
          `blocked — prompt port inference failed:\n${promptInferenceBlockReason}`,
        );
        state.result = {
          exitCode: -1,
          stdout: '',
          stderr: `[engine] prompt port inference failed:\n${promptInferenceBlockReason}`,
          stdoutPath: null,
          stderrPath: null,
          durationMs: 0,
          sessionId: null,
          normalizedOutput: null,
          failureKind: 'spawn_error',
          outputs: null,
        };
        state.finishedAt = nowISO();
        setTaskStatus(taskId, 'blocked');
        try {
          await fireHook(taskId, 'task_failure');
        } catch (hookErr) {
          log.error(
            `[task:${taskId}]`,
            `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
        if (getOnFailure(taskId) === 'stop_all') applyStopAll(node.track.id);
        return;
      }

      // Feed effective ports into `resolveTaskInputs` by shallow-cloning
      // the task. Prompt tasks get the inferred ports; Command tasks are
      // unchanged (effectivePorts === task.ports).
      const taskForResolve: TaskConfig =
        effectivePorts === task.ports ? task : { ...task, ports: effectivePorts };
      const inputResolution = resolveTaskInputs(taskForResolve, outputValuesMap, node.dependsOn);
      if (inputResolution.kind === 'blocked') {
        log.error(
          `[task:${taskId}]`,
          `blocked — cannot resolve port inputs:\n${inputResolution.reason}`,
        );
        state.result = {
          exitCode: -1,
          stdout: '',
          stderr: `[engine] port input resolution failed:\n${inputResolution.reason}`,
          stdoutPath: null,
          stderrPath: null,
          durationMs: 0,
          sessionId: null,
          normalizedOutput: null,
          failureKind: 'spawn_error',
          outputs: null,
        };
        state.finishedAt = nowISO();
        setTaskStatus(taskId, 'blocked');
        try {
          await fireHook(taskId, 'task_failure');
        } catch (hookErr) {
          log.error(
            `[task:${taskId}]`,
            `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
        if (getOnFailure(taskId) === 'stop_all') applyStopAll(node.track.id);
        return;
      }
      const resolvedInputs = inputResolution.inputs;
      resolvedInputsMap.set(taskId, resolvedInputs);
      if (inputResolution.missingOptional.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `optional inputs unresolved (empty in placeholders): ${inputResolution.missingOptional.join(', ')}`,
        );
      }
      if (effectivePorts?.inputs && effectivePorts.inputs.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `resolved inputs: ${JSON.stringify(resolvedInputs)}` +
            (isPromptTask ? ' (inferred from upstream Commands)' : ''),
        );
      }

      // 4. Mark running — set startedAt before emitting so subscribers see a
      // complete task_update (startedAt non-null) on the status transition.
      state.startedAt = nowISO();
      setTaskStatus(taskId, 'running');
      log.info(
        `[task:${taskId}]`,
        task.command ? `running: ${task.command}` : `running (driver task)`,
      );

      // File-only: resolved config for this task
      const resolvedDriver = task.driver ?? track.driver ?? config.driver ?? 'opencode';
      const resolvedModel = task.model ?? track.model ?? config.model ?? '(default)';
      const resolvedPerms = task.permissions ?? track.permissions ?? '(default)';
      const resolvedCwd = task.cwd ?? track.cwd ?? workDir;
      log.debug(
        `[task:${taskId}]`,
        `resolved: driver=${resolvedDriver} model=${resolvedModel} cwd=${resolvedCwd}`,
      );
      log.debug(`[task:${taskId}]`, `permissions: ${JSON.stringify(resolvedPerms)}`);
      if (task.continue_from) {
        log.debug(`[task:${taskId}]`, `continue_from: "${task.continue_from}"`);
      }
      if (task.timeout) {
        log.debug(`[task:${taskId}]`, `timeout: ${task.timeout}`);
      }

      try {
        let result: TaskResult;
        const timeoutMs = task.timeout ? parseDuration(task.timeout) : undefined;

        // Stream child stdout/stderr directly to disk in the logger's run dir
        // and keep only a bounded tail in the returned TaskResult. Filenames
        // mirror the existing `.stderr` naming — dots in task ids are replaced
        // so hierarchical ids (e.g. `track1.task2`) map cleanly to a flat dir.
        const fsSafeTaskId = taskId.replace(/\./g, '_');
        const stdoutPath = resolve(log.dir, `${fsSafeTaskId}.stdout`);
        const stderrPath = resolve(log.dir, `${fsSafeTaskId}.stderr`);
        const runOpts = {
          timeoutMs,
          signal: abortController.signal,
          stdoutPath,
          stderrPath,
        };

        if (task.command) {
          // Substitute `{{inputs.X}}` placeholders into the command
          // string. Tasks with no declared inputs always produce the same
          // string back (no placeholders to match). Unresolved references
          // render empty — validate-raw flags undeclared references as
          // errors, so the only way to land here with an unresolved is an
          // optional input that had no upstream producer and no default,
          // which we surface in the log.
          const { text: expandedCommand, unresolved } = substituteInputs(
            task.command,
            resolvedInputs,
          );
          if (unresolved.length > 0) {
            log.debug(
              `[task:${taskId}]`,
              `command placeholders rendered empty: ${unresolved.join(', ')}`,
            );
          }
          log.debug(`[task:${taskId}]`, `command: ${expandedCommand}`);
          result = await runCommand(expandedCommand, task.cwd ?? workDir, runOpts);
        } else {
          // AI task: apply middleware chain against a structured PromptDocument.
          const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';
          const driver = registry.getHandler<DriverPlugin>('drivers', driverName);

          // Substitute placeholders in the user-authored prompt before
          // wrapping into a PromptDocument so middlewares see the
          // already-resolved task text.
          const { text: expandedPrompt, unresolved } = substituteInputs(
            task.prompt!,
            resolvedInputs,
          );
          if (unresolved.length > 0) {
            log.debug(
              `[task:${taskId}]`,
              `prompt placeholders rendered empty: ${unresolved.join(', ')}`,
            );
          }
          const originalLen = expandedPrompt.length;
          let doc: PromptDocument = promptDocumentFromString(expandedPrompt);
          // Prepend port-related context blocks so the model sees them
          // before any middleware-added retrieval / memory blocks. Order
          // matters: [Output Format] first (sets the deliverable), then
          // [Inputs] (the concrete data to operate on). Empty blocks are
          // filtered out — tasks without ports get no extra blocks at all.
          const outputFormatBlock = renderOutputSchemaBlock(effectivePorts?.outputs);
          if (outputFormatBlock) {
            doc = prependContext(doc, outputFormatBlock);
          }
          const inputsBlock = renderInputsBlock(effectivePorts?.inputs, resolvedInputs);
          if (inputsBlock) {
            doc = prependContext(doc, inputsBlock);
          }
          const mws = task.middlewares !== undefined ? task.middlewares : track.middlewares;
          if (mws && mws.length > 0) {
            log.debug(
              `[task:${taskId}]`,
              `middleware chain: ${mws.map((m) => m.type).join(' → ')}`,
            );
            const mwCtx: MiddlewareContext = {
              task,
              track,
              workDir: task.cwd ?? workDir,
            };
            for (const mwConfig of mws) {
              const mwPlugin = registry.getHandler<MiddlewarePlugin>('middlewares', mwConfig.type);
              const beforeBlocks = doc.contexts.length;
              const beforeLen = serializePromptDocument(doc).length;

              // Prefer the structured API. Fall back to the legacy
              // `enhance(string) → string` path so v0.x plugins keep
              // working — that fallback loses context structure (the
              // middleware's output becomes the new task body) but never
              // silently drops content.
              if (typeof mwPlugin.enhanceDoc === 'function') {
                const next = await mwPlugin.enhanceDoc(
                  doc,
                  mwConfig as Record<string, unknown>,
                  mwCtx,
                );
                if (
                  !next ||
                  typeof next !== 'object' ||
                  !Array.isArray((next as PromptDocument).contexts) ||
                  typeof (next as PromptDocument).task !== 'string'
                ) {
                  throw new Error(
                    `middleware "${mwConfig.type}".enhanceDoc() returned a malformed PromptDocument`,
                  );
                }
                doc = next as PromptDocument;
              } else if (typeof mwPlugin.enhance === 'function') {
                const asString = serializePromptDocument(doc);
                const next = await mwPlugin.enhance(
                  asString,
                  mwConfig as Record<string, unknown>,
                  mwCtx,
                );
                // R3: a middleware that returns undefined / null / a non-string
                // would silently corrupt the prompt. Fail loud.
                if (typeof next !== 'string') {
                  throw new Error(
                    `middleware "${mwConfig.type}".enhance() returned ${next === null ? 'null' : typeof next}, expected string`,
                  );
                }
                // Legacy fallback: collapse the returned string into a
                // fresh doc. Earlier structure is folded into the string
                // (serializePromptDocument just ran), so bytes the driver
                // sees match the old string pipeline.
                doc = { contexts: [], task: next };
              } else {
                throw new Error(
                  `middleware "${mwConfig.type}" provides neither enhanceDoc nor enhance`,
                );
              }
              const afterLen = serializePromptDocument(doc).length;
              const addedBlocks = doc.contexts.length - beforeBlocks;
              log.debug(
                `[task:${taskId}]`,
                `  ${mwConfig.type}: ${beforeLen} → ${afterLen} chars` +
                  (addedBlocks > 0
                    ? ` (+${addedBlocks} context block${addedBlocks > 1 ? 's' : ''})`
                    : ''),
              );
            }
          }
          const prompt = serializePromptDocument(doc);
          log.debug(
            `[task:${taskId}]`,
            `prompt: ${originalLen} chars (final: ${prompt.length} chars, ${doc.contexts.length} block${doc.contexts.length === 1 ? '' : 's'})`,
          );
          log.quiet(`--- prompt (final) ---\n${clip(prompt)}\n--- end prompt ---`, taskId);

          // H1: hand the driver a continue_from that has already been
          // qualified by dag.ts. Without this, drivers like codex/opencode/
          // claude-code look up maps directly with
          // the user's raw (possibly bare) string, which races whenever two
          // tracks share a task name. dag.ts has the only authoritative
          // resolver, so we use its precomputed answer here.
          // Drivers key sessionMap/normalizedMap by fully-qualified id. buildDag
          // guarantees `resolvedContinueFrom` is set for every task that has a
          // `continue_from`, so if we see the bare form here something upstream
          // is broken — fail loud instead of silently miskeying the lookup.
          if (task.continue_from && !node.resolvedContinueFrom) {
            throw new Error(
              `Internal: task "${taskId}" has continue_from "${task.continue_from}" ` +
                `but no resolvedContinueFrom. buildDag should have qualified it.`,
            );
          }
          const enrichedTask: TaskConfig = {
            ...task,
            prompt,
            continue_from: node.resolvedContinueFrom,
            // Hand the driver the EFFECTIVE port schema rather than the
            // raw task.ports. For Prompt tasks this is the one inferred
            // from neighbor Commands; Command tasks are unchanged.
            // Drivers that introspect ports (e.g. to annotate a system
            // prompt with the I/O contract) otherwise saw `undefined`
            // for every prompt and had no way to know the contract.
            ports: effectivePorts,
          };
          const driverCtx: DriverContext = {
            sessionMap,
            normalizedMap,
            workDir: task.cwd ?? workDir,
            // Structured view for drivers that want fine-grained control
            // over serialization (e.g. inserting [Previous Output] between
            // contexts and task). Drivers that read task.prompt see the
            // default serialization and need no changes.
            promptDoc: doc,
            // Ports feature: resolved input values keyed by port name,
            // already coerced to the declared port type. Drivers that
            // need to re-substitute placeholders inside a custom envelope
            // can read this and call `substituteInputs`; most drivers can
            // ignore it because the engine has already expanded
            // `{{inputs.X}}` into `task.prompt` upstream.
            inputs: resolvedInputs,
          };
          const spec = await driver.buildCommand(enrichedTask, track, driverCtx);
          log.debug(`[task:${taskId}]`, `driver=${driverName}`);
          log.debug(`[task:${taskId}]`, `spawn args: ${JSON.stringify(spec.args)}`);
          if (spec.cwd) log.debug(`[task:${taskId}]`, `spawn cwd: ${spec.cwd}`);
          if (spec.env)
            log.debug(
              `[task:${taskId}]`,
              `spawn env overrides: ${Object.keys(spec.env).join(', ')}`,
            );
          if (spec.stdin) log.debug(`[task:${taskId}]`, `spawn stdin: ${spec.stdin.length} chars`);
          result = await runSpawn(spec, driver, runOpts);
        }

        // 6. Determine terminal status (without emitting yet — result must be complete first)
        // H2: branch on failureKind so spawn errors no longer masquerade as
        // timeouts. Old runners that don't set failureKind still work — we
        // fall back to the historical `exitCode === -1 → timeout` heuristic so
        // pre-existing third-party drivers don't regress.
        let terminalStatus: TaskStatus;
        const kind = result.failureKind;
        if (kind === 'timeout') {
          terminalStatus = 'timeout';
        } else if (kind === 'spawn_error') {
          terminalStatus = 'failed';
        } else if (kind === undefined && result.exitCode === -1) {
          // Legacy path: pre-H2 driver returned -1 with no kind. Treat as
          // timeout for backward compatibility (the previous behaviour).
          terminalStatus = 'timeout';
        } else if (result.exitCode !== 0) {
          terminalStatus = 'failed';
        } else if (task.completion) {
          const plugin = registry.getHandler<CompletionPlugin>('completions', task.completion.type);
          const completionCtx = { workDir: task.cwd ?? workDir, signal: abortController.signal };
          const passed = await plugin.check(
            task.completion as Record<string, unknown>,
            result,
            completionCtx,
          );
          // R4: strict boolean check. Truthy strings/numbers used to be coerced
          // to success — a check returning "ok" would let a failing task pass.
          if (typeof passed !== 'boolean') {
            throw new Error(
              `completion "${task.completion.type}".check() returned ${passed === null ? 'null' : typeof passed}, expected boolean`,
            );
          }
          terminalStatus = passed ? 'success' : 'failed';
        } else {
          terminalStatus = 'success';
        }

        // Extract declared port outputs from the task's output stream.
        // Only meaningful on success — a failed task's output is whatever
        // the child happened to emit before exiting, and downstream tasks
        // shouldn't receive partial data. `extractTaskOutputs` is a no-op
        // when the task has no declared outputs, so this is free for
        // pre-ports tasks. Diagnostics are appended to stderr so users
        // see *why* a downstream input is missing without having to dig
        // through driver-specific logs.
        let extractedOutputs: Readonly<Record<string, unknown>> | null = null;
        if (terminalStatus === 'success') {
          // Prompt tasks use inferred ports (from direct-downstream Command
          // inputs); Command tasks use their declared ports. Either way,
          // `extractTaskOutputs` is a no-op when there are no declared
          // outputs to pull, so pre-ports tasks pay nothing for this call.
          const extraction = extractTaskOutputs(
            effectivePorts,
            result.stdout,
            result.normalizedOutput,
          );
          if (effectivePorts?.outputs && effectivePorts.outputs.length > 0) {
            extractedOutputs = extraction.outputs;
            outputValuesMap.set(taskId, extraction.outputs);
            log.debug(
              `[task:${taskId}]`,
              `extracted outputs: ${JSON.stringify(extraction.outputs)}` +
                (isPromptTask ? ' (inferred from downstream Commands)' : ''),
            );
            if (extraction.diagnostic) {
              log.error(`[task:${taskId}]`, extraction.diagnostic);
              const note = `\n[engine] ${extraction.diagnostic}`;
              result = { ...result, stderr: result.stderr + note };
            }
          }
        }
        // Attach outputs to the result (null when task has no declared
        // outputs or extraction failed entirely). Consumers of TaskResult
        // — hooks, wire events, test assertions — all go through this
        // one field rather than re-running extraction.
        result = { ...result, outputs: extractedOutputs };

        // Store normalized text separately (in-memory) for continue_from handoff.
        // R15: clip oversized values so a runaway parseResult can't accumulate
        // hundreds of MB across tasks.
        if (result.normalizedOutput !== null) {
          const clipped =
            result.normalizedOutput.length > MAX_NORMALIZED_BYTES
              ? result.normalizedOutput.slice(0, MAX_NORMALIZED_BYTES) +
                `\n[…clipped at ${MAX_NORMALIZED_BYTES} bytes]`
              : result.normalizedOutput;
          normalizedMap.set(taskId, clipped);
        }

        // Note: stderr is already persisted by runner.ts as it streams; the
        // old "write full string after the fact" block is gone — that's what
        // the streaming rewrite fixed (unbounded in-memory buffering).

        if (result.sessionId) {
          // H1: qualified-only key.
          sessionMap.set(taskId, result.sessionId);
        }

        // Set result and finishedAt before emitting terminal status so listeners see complete state
        state.result = result;
        state.finishedAt = nowISO();
        setTaskStatus(taskId, terminalStatus);

        // Log task outcome with relevant details
        const durSec = (result.durationMs / 1000).toFixed(1);
        if (terminalStatus === 'success') {
          log.info(`[task:${taskId}]`, `success (${durSec}s)`);
        } else {
          log.error(
            `[task:${taskId}]`,
            `${terminalStatus} exit=${result.exitCode} duration=${durSec}s`,
          );
          if (result.stderr) {
            const tail = tailLines(result.stderr, 10);
            log.error(`[task:${taskId}]`, `stderr tail:\n${tail}`);
          }
        }

        // File-only: byte counts (prefer full totals from the runner over the
        // bounded tail length so oversized outputs show their real size) +
        // paths to the on-disk full copies.
        const stdoutSize = result.stdoutBytes ?? result.stdout.length;
        const stderrSize = result.stderrBytes ?? result.stderr.length;
        log.debug(`[task:${taskId}]`, `stdout: ${stdoutSize} bytes, stderr: ${stderrSize} bytes`);
        if (result.sessionId) {
          log.debug(`[task:${taskId}]`, `sessionId: ${result.sessionId}`);
        }
        if (result.stdoutPath) {
          log.debug(`[task:${taskId}]`, `wrote stdout: ${result.stdoutPath}`);
        }
        if (result.stderrPath) {
          log.debug(`[task:${taskId}]`, `wrote stderr: ${result.stderrPath}`);
        }
        if (result.stdout) {
          log.quiet(
            `--- stdout (${taskId}) ---\n${clip(result.stdout)}\n--- end stdout ---`,
            taskId,
          );
        }
        if (result.stderr) {
          log.quiet(
            `--- stderr (${taskId}) ---\n${clip(result.stderr)}\n--- end stderr ---`,
            taskId,
          );
        }
        if (task.completion) {
          log.debug(
            `[task:${taskId}]`,
            `completion check: type=${task.completion.type} result=${terminalStatus}`,
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        log.error(`[task:${taskId}]`, `failed before execution: ${errMsg}`);
        state.result = {
          exitCode: -1,
          stdout: '',
          stderr: errMsg,
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: 0,
          stderrBytes: errMsg.length,
          durationMs: 0,
          sessionId: null,
          normalizedOutput: null,
          // H2: Engine-level pre-execution errors (driver throw, middleware
          // throw, getHandler 404) classify as spawn_error — the process never
          // ran, so calling them "timeout" was actively misleading.
          failureKind: 'spawn_error',
        };
        state.finishedAt = nowISO();
        setTaskStatus(taskId, 'failed');
      }

      // 7. Fire hooks
      const finalStatus: TaskStatus = state.status;
      try {
        await fireHook(taskId, finalStatus === 'success' ? 'task_success' : 'task_failure');
      } catch (hookErr) {
        log.error(
          `[task:${taskId}]`,
          `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }

      // 8. Handle stop_all for failure states
      if (finalStatus !== 'success' && getOnFailure(taskId) === 'stop_all') {
        applyStopAll(node.track.id);
      }
    }

    // ── Event loop ──
    // Each task is launched as soon as ALL its deps reach a terminal state.
    // We track in-flight tasks in `running` so a task completing mid-batch
    // immediately unblocks its dependents without waiting for sibling tasks.
    const running = new Map<string, Promise<void>>();

    try {
      while (abortReason === null) {
        // Launch every task whose deps are all terminal and that isn't already in-flight
        for (const [id, state] of states) {
          if (state.status !== 'waiting' || running.has(id)) continue;
          const node = dag.nodes.get(id)!;
          const allDepsTerminal =
            node.dependsOn.length === 0 ||
            node.dependsOn.every((d) => isTerminal(states.get(d)!.status));
          if (!allDepsTerminal) continue;
          const p = processTask(id).finally(() => running.delete(id));
          running.set(id, p);
        }

        // All tasks terminal — done
        if ([...states.values()].every((s) => isTerminal(s.status))) break;

        if (running.size === 0) {
          // Nothing in-flight but non-terminal tasks exist (e.g. trigger-wait states
          // that processTask hasn't been called for yet). Poll briefly.
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        } else {
          // Wait for any one task to finish, then re-scan for new launchables.
          await Promise.race(running.values());
        }
      }

      if (abortReason !== null) {
        // Wait for in-flight tasks to honour the abort signal before marking states.
        if (running.size > 0) await Promise.allSettled(running.values());
        for (const [id, state] of states) {
          if (!isTerminal(state.status)) {
            // By the time allSettled resolves, processTask's try/finally has already
            // set running tasks to success/failed/timeout. The only non-terminal
            // statuses remaining here are waiting/idle tasks that were never started.
            state.finishedAt = nowISO();
            setTaskStatus(id, 'skipped');
          }
        }
      }
    } finally {
      if (pipelineTimer) clearTimeout(pipelineTimer);
      // Clean up the external abort signal listener to prevent dead references
      // accumulating on long-lived shared AbortControllers.
      if (options.signal) {
        options.signal.removeEventListener('abort', externalAbortHandler);
      }
      // Safety net: drain any approvals still pending at shutdown (e.g. crash path).
      if (approvalGateway.pending().length > 0) {
        approvalGateway.abortAll('pipeline finished');
      }
      // Detach gateway → onEvent bridge so a long-lived gateway (host-supplied)
      // doesn't keep firing into a dead run.
      unsubscribeApprovals();
    }

    // ── Summary ──
    const summary = { total: 0, success: 0, failed: 0, skipped: 0, timeout: 0, blocked: 0 };
    for (const [, state] of states) {
      summary.total++;
      switch (state.status) {
        case 'success':
          summary.success++;
          break;
        case 'failed':
          summary.failed++;
          break;
        case 'skipped':
          summary.skipped++;
          break;
        case 'timeout':
          summary.timeout++;
          break;
        case 'blocked':
          summary.blocked++;
          break;
      }
    }

    const finishedAt = nowISO();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    if (abortReason !== null) {
      const reasonText =
        abortReason === 'timeout'
          ? 'Pipeline timeout exceeded'
          : abortReason === 'stop_all'
            ? 'Pipeline stopped (on_failure: stop_all)'
            : 'Pipeline aborted by host';
      await executeHook(
        config.hooks,
        'pipeline_error',
        buildPipelineErrorContext(pipelineInfo, reasonText, undefined, abortReason),
        workDir,
      );
    } else {
      await executeHook(
        config.hooks,
        'pipeline_complete',
        buildPipelineCompleteContext(
          { ...pipelineInfo, finished_at: finishedAt, duration_ms: durationMs },
          summary,
        ),
        workDir,
      );
    }

    const allSuccess =
      abortReason === null &&
      summary.failed === 0 &&
      summary.timeout === 0 &&
      summary.blocked === 0;

    log.section('Pipeline summary');
    log.quiet(
      `status:   ${abortReason !== null ? `aborted (${abortReason})` : 'completed'}`,
    );
    log.quiet(`duration: ${(durationMs / 1000).toFixed(1)}s`);
    log.quiet(
      `counts:   total=${summary.total} success=${summary.success} ` +
        `failed=${summary.failed} skipped=${summary.skipped} ` +
        `timeout=${summary.timeout} blocked=${summary.blocked}`,
    );
    log.quiet('');
    log.quiet('per-task:');
    for (const [id, state] of states) {
      const dur =
        state.result?.durationMs != null ? `${(state.result.durationMs / 1000).toFixed(1)}s` : '-';
      const exit = state.result?.exitCode ?? '-';
      log.quiet(`  ${state.status.padEnd(8)} ${id}  (exit=${exit}, ${dur})`);
    }

    log.info('[pipeline]', `completed "${config.name}"`);
    log.info(
      '[pipeline]',
      `Total: ${summary.total} | Success: ${summary.success} | Failed: ${summary.failed} | Skipped: ${summary.skipped} | Timeout: ${summary.timeout} | Blocked: ${summary.blocked}`,
    );
    log.info('[pipeline]', `Duration: ${(durationMs / 1000).toFixed(1)}s`);
    log.info('[pipeline]', `Log: ${log.path}`);

    emit({ type: 'run_end', runId, success: allSuccess, abortReason });
    return { success: allSuccess, runId, logPath: log.path, summary, states: freezeStates(states) };
  } finally {
    // Close the persistent log file handle before pruning.
    log.close();
    // Prune old per-run log directories on every exit path (normal, blocked, or thrown).
    // Exclude the current runId so a concurrent run cannot delete its own live directory.
    if (maxLogRuns > 0) {
      await pruneLogDirs(resolve(workDir, '.tagma', 'logs'), maxLogRuns, runId);
    }
  }
}

/**
 * Delete the oldest subdirectories under `logsDir`, keeping only the most recent `keep`
 * total runs (including the currently-live run identified by `excludeRunId`).
 * Directories are sorted lexicographically; because runIds are prefixed with a base-36
 * timestamp, lexicographic order equals chronological order.
 *
 * `excludeRunId` is always skipped from deletion even if it would otherwise be pruned —
 * this prevents a concurrent run from removing a live log directory that is still in use.
 *
 * D10: The live run occupies one slot out of `keep`, so the maximum number of
 * *historical* dirs to retain is `keep - 1`. Without this adjustment the function
 * kept `keep` historical dirs plus 1 live dir = `keep + 1` total on disk.
 */
async function pruneLogDirs(logsDir: string, keep: number, excludeRunId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return; // logsDir doesn't exist yet — nothing to prune
  }

  // Only consider directories that look like run IDs (run_<...>), excluding the live run.
  const runDirs = entries.filter((e) => e.startsWith('run_') && e !== excludeRunId).sort();
  // keep - 1 historical slots (1 slot is reserved for the live excludeRunId).
  const historyKeep = Math.max(0, keep - 1);
  const toDelete = runDirs.slice(0, Math.max(0, runDirs.length - historyKeep));

  await Promise.all(
    toDelete.map((dir) =>
      rm(resolve(logsDir, dir), { recursive: true, force: true }).catch(() => {
        // Ignore deletion errors — stale dirs are better than a crash
      }),
    ),
  );
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === 'success' ||
    status === 'failed' ||
    status === 'timeout' ||
    status === 'skipped' ||
    status === 'blocked'
  );
}

/** Return a deep-copied, caller-safe snapshot of the states map. */
function freezeStates(states: Map<string, TaskState>): ReadonlyMap<string, TaskState> {
  const copy = new Map<string, TaskState>();
  for (const [id, s] of states) {
    copy.set(id, {
      config: { ...s.config },
      trackConfig: { ...s.trackConfig },
      status: s.status,
      result: s.result ? { ...s.result } : null,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    });
  }
  return copy;
}
