import type {
  EnvPolicy,
  PipelineExecutionMode,
  PipelineConfig,
  TaskConfig,
  TaskState,
  RunEventPayload,
  RunTaskState,
} from './types';
import { buildDag } from './dag';
import type { PluginRegistry } from './registry';
import { parseDuration, nowISO, generateRunId, assertValidRunId } from './utils';
import {
  executeHook,
  buildPipelineStartContext,
  buildPipelineCompleteContext,
  buildPipelineErrorContext,
  type PipelineInfo,
} from './hooks';
import { Logger } from './logger';
import { InMemoryApprovalGateway, type ApprovalGateway } from './approval';
import {
  freezeStates,
  summarizeStates,
  toRunTaskState,
} from './core/run-state';
import { preflight } from './core/preflight';
import { RunContext } from './core/run-context';
import {
  allTasksTerminal,
  findLaunchableTasks,
  skipNonTerminalTasks,
} from './core/scheduler';
import { executeTask } from './core/task-executor';
import type { TagmaRuntime } from './types';
export { TriggerBlockedError, TriggerTimeoutError } from './types';

function isPromptTaskConfig(
  task: TaskConfig,
): task is TaskConfig & { readonly prompt: string; readonly command?: undefined } {
  return task.prompt !== undefined && task.command === undefined;
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
  readonly mode?: PipelineExecutionMode;
  readonly safeModeAllowlist?: SafeModeAllowlist;
  readonly envPolicy?: EnvPolicy;
  readonly logPrompt?: boolean;
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
   * Callers pass a per-instance or per-workspace registry so concurrent runs
   * do not share handler state.
   */
  readonly registry: PluginRegistry;
  /**
   * Runtime implementation for command and driver process execution.
   */
  readonly runtime: TagmaRuntime;
}

export interface SafeModeAllowlist {
  readonly drivers?: readonly string[];
  readonly triggers?: readonly string[];
  readonly completions?: readonly string[];
  readonly middlewares?: readonly string[];
}

// Poll interval when no tasks are in-flight but non-terminal tasks remain
// (e.g. tasks waiting on a file or manual trigger).
const POLL_INTERVAL_MS = 50;

const DEFAULT_SAFE_MODE_ALLOWLIST: Required<SafeModeAllowlist> = {
  drivers: ['opencode'],
  triggers: ['manual', 'file'],
  completions: ['exit_code', 'file_exists'],
  middlewares: ['static_context'],
};

function safeSet<T extends keyof Required<SafeModeAllowlist>>(
  allowlist: SafeModeAllowlist | undefined,
  key: T,
): ReadonlySet<string> {
  return new Set([...(DEFAULT_SAFE_MODE_ALLOWLIST[key] ?? []), ...(allowlist?.[key] ?? [])]);
}

function enforceExecutionMode(
  config: PipelineConfig,
  mode: PipelineExecutionMode,
  allowlist?: SafeModeAllowlist,
): void {
  if (mode !== 'trusted' && mode !== 'safe') {
    throw new Error(`Invalid pipeline execution mode "${mode}". Expected "trusted" or "safe".`);
  }
  if (mode !== 'safe') return;
  const errors: string[] = [];
  if (config.plugins?.length) {
    errors.push('safe mode blocks automatic plugin loading via pipeline.plugins');
  }
  if (config.hooks && Object.keys(config.hooks).length > 0) {
    errors.push('safe mode blocks lifecycle hooks');
  }

  const allowedDrivers = safeSet(allowlist, 'drivers');
  const allowedTriggers = safeSet(allowlist, 'triggers');
  const allowedCompletions = safeSet(allowlist, 'completions');
  const allowedMiddlewares = safeSet(allowlist, 'middlewares');

  for (const track of config.tracks) {
    const trackDriver = track.driver ?? config.driver ?? 'opencode';
    const trackMiddlewares = track.middlewares ?? [];
    for (const mw of trackMiddlewares) {
      if (!allowedMiddlewares.has(mw.type)) {
        errors.push(`safe mode blocks middleware "${mw.type}" on track "${track.id}"`);
      }
    }
    for (const task of track.tasks) {
      const taskLabel = `${track.id}.${task.id}`;
      if (task.command !== undefined) {
        errors.push(`safe mode blocks command task "${taskLabel}"`);
      }
      const driver = task.driver ?? trackDriver;
      if (task.prompt !== undefined && !allowedDrivers.has(driver)) {
        errors.push(`safe mode blocks driver "${driver}" on task "${taskLabel}"`);
      }
      if (task.trigger && !allowedTriggers.has(task.trigger.type)) {
        errors.push(`safe mode blocks trigger "${task.trigger.type}" on task "${taskLabel}"`);
      }
      if (task.completion && !allowedCompletions.has(task.completion.type)) {
        errors.push(`safe mode blocks completion "${task.completion.type}" on task "${taskLabel}"`);
      }
      const middlewares = task.middlewares ?? trackMiddlewares;
      for (const mw of middlewares) {
        if (!allowedMiddlewares.has(mw.type)) {
          errors.push(`safe mode blocks middleware "${mw.type}" on task "${taskLabel}"`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Safe mode validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

export async function runPipeline(
  config: PipelineConfig,
  workDir: string,
  options: RunPipelineOptions,
): Promise<EngineResult> {
  const approvalGateway = options.approvalGateway ?? new InMemoryApprovalGateway();
  const maxLogRuns = options.maxLogRuns ?? 20;
  const registry = options.registry;
  const runtime = options.runtime;
  if (!registry) {
    throw new Error(
      'runPipeline requires options.registry. Use createTagma().run(...) for the public SDK API.',
    );
  }

  const mode = options.mode ?? config.mode ?? 'trusted';
  enforceExecutionMode(config, mode, options.safeModeAllowlist);

  // Load any plugins declared in the pipeline config before preflight so that
  // drivers, completions, and middlewares referenced in YAML are registered.
  // Hosts that pre-load plugins from a custom path (e.g. the editor loading
  // from the user's workspace node_modules) pass skipPluginLoading: true so
  // we don't re-resolve via Node's cwd-based default import.
  if (!options.skipPluginLoading && config.plugins?.length) {
    await registry.loadPlugins(config.plugins, workDir);
  }

  const dag = buildDag(config);
  const runId = options.runId ?? generateRunId();
  assertValidRunId(runId);
  preflight(config, dag, registry);

  const startedAt = nowISO();
  const pipelineInfo: PipelineInfo = { name: config.name, run_id: runId, started_at: startedAt };
  // Forward every structured log line to subscribers as task_log events.
  // Reading options.onEvent inside the callback (vs. capturing it once) keeps
  // the SDK behavior correct if callers pass a fresh onEvent on each run.
  const log = new Logger(workDir, runId, runtime.logStore, (record) => {
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
      const kind = isPromptTaskConfig(node.task) ? 'ai' : 'cmd';
      log.quiet(`  • ${id}  [${kind}]  track=${node.track.id}  deps=[${deps}]`);
    }
    log.quiet('');

    // Per-run state container. Constructed before the pipeline_start hook
    // so the early-return path (blocked pipeline) can call freezeStates on
    // the populated idle-state map. The constructor has no side effects —
    // no listeners installed, no events emitted.
    const ctx = new RunContext({
      runId,
      dag,
      config,
      workDir,
      pipelineInfo,
      onEvent: options.onEvent,
      runtime,
      envPolicy: options.envPolicy,
      logPrompt: options.logPrompt ?? false,
    });

    // Pipeline start hook (gate). Runs BEFORE the engine emits run_start so
    // a blocked pipeline produces zero wire events (the server treats the
    // thrown error as run_error). Hosts get a rich error message; nothing
    // is ever half-broadcast.
    const startHook = await executeHook(
      config.hooks,
      'pipeline_start',
      buildPipelineStartContext(pipelineInfo),
      runtime,
      workDir,
      undefined,
      log,
      options.envPolicy,
    );
    if (!startHook.allowed) {
      log.error('[pipeline]', `blocked by pipeline_start hook (exit code ${startHook.exitCode})`);
      await executeHook(
        config.hooks,
        'pipeline_error',
        buildPipelineErrorContext(pipelineInfo, 'pipeline_blocked', 'pipeline_blocked'),
        runtime,
        workDir,
        undefined,
        log,
        options.envPolicy,
      );
      const blockedAt = nowISO();
      for (const [, state] of ctx.states) {
        state.status = 'blocked';
        state.finishedAt = blockedAt;
      }
      const summary = summarizeStates(ctx.states);
      return {
        success: false,
        runId,
        logPath: log.path,
        summary,
        states: freezeStates(ctx.states),
      };
    }

    // Pipeline approved — transition all tasks to waiting.
    for (const [, state] of ctx.states) {
      state.status = 'waiting';
    }
    // Emit run_start with a wire-shape snapshot so SSE subscribers can
    // initialize their task maps on the same event stream that carries
    // updates. No separate "server pre-broadcasts run_start" ceremony —
    // the engine owns the lifecycle boundary.
    const runStartTasks: RunTaskState[] = [];
    for (const [id, node] of dag.nodes) {
      const s = ctx.states.get(id)!;
      runStartTasks.push(toRunTaskState(id, node.track.id, node.task.name ?? id, s));
    }
    ctx.emit({ type: 'run_start', runId, tasks: runStartTasks });

    // Pipeline timeout. `ctx.abortReason` carries the concrete cause
    // (timeout / stop_all / external) through to run_end and the
    // pipeline_error hook so downstream consumers can distinguish them
    // without scraping message strings.
    const pipelineTimeoutMs = config.timeout ? parseDuration(config.timeout) : 0;
    let pipelineTimer: ReturnType<typeof setTimeout> | null = null;

    if (pipelineTimeoutMs > 0) {
      pipelineTimer = setTimeout(() => {
        if (ctx.abortReason === null) ctx.abortReason = 'timeout';
        ctx.abortController.abort();
      }, pipelineTimeoutMs);
    }

    // When the pipeline is aborted (timeout, stop_all, external), drain
    // all pending approvals so waiting triggers unblock immediately.
    ctx.abortController.signal.addEventListener('abort', () => {
      approvalGateway.abortAll('pipeline aborted');
    });

    // Wire external cancel signal into the internal abort controller.
    const externalAbortHandler = () => {
      if (ctx.abortReason === null) ctx.abortReason = 'external';
      ctx.abortController.abort();
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
        ctx.emit({
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
        ctx.emit({
          type: 'approval_resolved',
          runId,
          requestId: ev.request.id,
          outcome,
        });
      }
    });

    // ── Process a single task ──
    // ── Event loop ──
    // Each task is launched as soon as ALL its deps reach a terminal state.
    // We track in-flight tasks in `running` so a task completing mid-batch
    // immediately unblocks its dependents without waiting for sibling tasks.
    const running = new Map<string, Promise<void>>();

    try {
      while (ctx.abortReason === null) {
        // Launch every task whose deps are all terminal and that isn't already in-flight
        for (const id of findLaunchableTasks(ctx, new Set(running.keys()))) {
          const p = executeTask({
            taskId: id,
            ctx,
            registry,
            log,
            approvalGateway,
          }).finally(() => running.delete(id));
          running.set(id, p);
        }

        // All tasks terminal — done
        if (allTasksTerminal(ctx)) break;

        if (running.size === 0) {
          // Nothing in-flight but non-terminal tasks exist (e.g. trigger-wait states
          // that processTask hasn't been called for yet). Poll briefly.
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        } else {
          // Wait for any one task to finish, then re-scan for new launchables.
          await Promise.race(running.values());
        }
      }

      if (ctx.abortReason !== null) {
        // Wait for in-flight tasks to honour the abort signal before marking states.
        if (running.size > 0) await Promise.allSettled(running.values());
        // By the time allSettled resolves, processTask's try/finally has already
        // set running tasks to success/failed/timeout. The only non-terminal
        // statuses remaining here are waiting/idle tasks that were never started.
        skipNonTerminalTasks(ctx);
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
    const summary = summarizeStates(ctx.states);

    const finishedAt = nowISO();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    if (ctx.abortReason !== null) {
      const reasonText =
        ctx.abortReason === 'timeout'
          ? 'Pipeline timeout exceeded'
          : ctx.abortReason === 'stop_all'
            ? 'Pipeline stopped (on_failure: stop_all)'
            : 'Pipeline aborted by host';
      await executeHook(
        config.hooks,
        'pipeline_error',
        buildPipelineErrorContext(pipelineInfo, reasonText, undefined, ctx.abortReason),
        runtime,
        workDir,
        undefined,
        log,
        options.envPolicy,
      );
    } else {
      await executeHook(
        config.hooks,
        'pipeline_complete',
        buildPipelineCompleteContext(
          { ...pipelineInfo, finished_at: finishedAt, duration_ms: durationMs },
          summary,
        ),
        runtime,
        workDir,
        undefined,
        log,
        options.envPolicy,
      );
    }

    const allSuccess =
      ctx.abortReason === null &&
      summary.failed === 0 &&
      summary.timeout === 0 &&
      summary.blocked === 0;

    log.section('Pipeline summary');
    log.quiet(
      `status:   ${ctx.abortReason !== null ? `aborted (${ctx.abortReason})` : 'completed'}`,
    );
    log.quiet(`duration: ${(durationMs / 1000).toFixed(1)}s`);
    log.quiet(
      `counts:   total=${summary.total} success=${summary.success} ` +
        `failed=${summary.failed} skipped=${summary.skipped} ` +
        `timeout=${summary.timeout} blocked=${summary.blocked}`,
    );
    log.quiet('');
    log.quiet('per-task:');
    for (const [id, state] of ctx.states) {
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

    ctx.emit({ type: 'run_end', runId, success: allSuccess, abortReason: ctx.abortReason });
    return { success: allSuccess, runId, logPath: log.path, summary, states: freezeStates(ctx.states) };
  } finally {
    // Close the persistent log file handle before pruning.
    log.close();
    // Prune old per-run log directories on every exit path (normal, blocked, or thrown).
    // Exclude the current runId so a concurrent run cannot delete its own live directory.
    if (maxLogRuns > 0 && runtime.logStore.prune) {
      await runtime.logStore.prune({ workDir, keep: maxLogRuns, excludeRunId: runId });
    }
  }
}


