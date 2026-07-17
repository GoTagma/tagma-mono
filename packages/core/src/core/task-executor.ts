import {
  linkAbort,
  TriggerBlockedError,
  TriggerTimeoutError,
  type CompletionPlugin,
  type CommandConfig,
  type DriverContext,
  type DriverPlugin,
  type MiddlewareContext,
  type MiddlewarePlugin,
  type PromptDocument,
  type PipelineConfig,
  type TaskConfig,
  type TaskResult,
  type TaskStatus,
  type TrackConfig,
  type TriggerPlugin,
  type TriggerWatchHandle,
} from '../types';
import { isCommandTaskConfig, isPromptTaskConfig } from '../types';
import type { PluginRegistry } from '../registry';
import { parseDuration, nowISO, validatePath } from '../utils';
import { commandLabel, commandToSpawnSpec } from '../command';
import {
  promptDocumentFromString,
  serializePromptDocument,
  prependContext,
  renderInputsBlock,
  renderOutputSchemaBlock,
} from '../prompt-doc';
import { resolveTaskBindingInputs, resolveTaskInputs, substituteInputs } from '../ports';
import { executeHook, buildTaskContext } from '../hooks';
import { clip, tailLines, type Logger } from '../logger';
import type { ApprovalGateway } from '../approval';
import type { RunContext } from './run-context';
import { extractSuccessfulOutputs, inferEffectivePorts } from './dataflow';
import { isTerminal, skippedTaskResult } from './run-state';

const MAX_NORMALIZED_BYTES = 1_000_000;
const MAX_COMPLETION_FEEDBACK_CHARS = 16_000;

function normalizeCompletionOutcome(
  value: unknown,
  completionType: string,
): { readonly passed: boolean; readonly feedback?: string } {
  if (typeof value === 'boolean') return { passed: value };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const outcome = value as Record<string, unknown>;
    const validKeys = Object.keys(outcome).every((key) => key === 'passed' || key === 'feedback');
    if (
      validKeys &&
      typeof outcome.passed === 'boolean' &&
      (outcome.feedback === undefined || typeof outcome.feedback === 'string')
    ) {
      if (typeof outcome.feedback !== 'string' || outcome.feedback.trim().length === 0) {
        return { passed: outcome.passed };
      }
      const trimmed = outcome.feedback.trim();
      const feedback =
        trimmed.length <= MAX_COMPLETION_FEEDBACK_CHARS
          ? trimmed
          : trimmed.slice(-MAX_COMPLETION_FEEDBACK_CHARS);
      return { passed: outcome.passed, feedback };
    }
  }
  throw new Error(
    'completion ' +
      completionType +
      '.check() must return boolean or { passed: boolean, feedback?: string }',
  );
}

function seedTaskContinuation(ctx: RunContext, taskId: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(ctx.taskContinuations, taskId)) return undefined;

  const seed = ctx.taskContinuations[taskId]!;
  if (
    (seed.sessionId === null || seed.sessionId === undefined) &&
    (seed.driver === null || seed.driver === undefined) &&
    (seed.normalizedOutput === null || seed.normalizedOutput === undefined)
  ) {
    return undefined;
  }
  const baseKey = '@tagma/continue_from/' + taskId;
  let syntheticKey = baseKey;
  let suffix = 1;
  while (
    ctx.dag.nodes.has(syntheticKey) ||
    ctx.sessionMap.has(syntheticKey) ||
    ctx.sessionDriverMap.has(syntheticKey) ||
    ctx.normalizedMap.has(syntheticKey)
  ) {
    syntheticKey = baseKey + '/' + suffix;
    suffix += 1;
  }

  if (seed.sessionId !== null && seed.sessionId !== undefined) {
    ctx.sessionMap.set(syntheticKey, seed.sessionId);
  }
  if (seed.driver !== null && seed.driver !== undefined) {
    ctx.sessionDriverMap.set(syntheticKey, seed.driver);
  }
  if (seed.normalizedOutput !== null && seed.normalizedOutput !== undefined) {
    ctx.normalizedMap.set(syntheticKey, seed.normalizedOutput);
  }
  return syntheticKey;
}

class TaskDeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskDeadlineExceededError';
  }
}

function hasStructuredErrorIdentity(
  err: unknown,
  code: 'TRIGGER_BLOCKED' | 'TRIGGER_TIMEOUT',
  name: 'TriggerBlockedError' | 'TriggerTimeoutError',
): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === code || candidate.name === name;
}

function isTriggerBlockedError(err: unknown): boolean {
  return (
    err instanceof TriggerBlockedError ||
    hasStructuredErrorIdentity(err, 'TRIGGER_BLOCKED', 'TriggerBlockedError')
  );
}

function isTriggerTimeoutError(err: unknown): boolean {
  return (
    err instanceof TriggerTimeoutError ||
    hasStructuredErrorIdentity(err, 'TRIGGER_TIMEOUT', 'TriggerTimeoutError')
  );
}

function triggerErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}

function triggerFailureResult(
  message: string,
  failureKind: 'timeout' | 'spawn_error',
  durationMs: number,
): TaskResult {
  const stderr = `[trigger] ${message}`;
  return {
    exitCode: -1,
    stdout: '',
    stderr,
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: new TextEncoder().encode(stderr).byteLength,
    durationMs,
    sessionId: null,
    normalizedOutput: null,
    failureKind,
    outputs: null,
  };
}

function substituteCommandInputs(
  command: CommandConfig,
  inputs: Readonly<Record<string, unknown>>,
): {
  readonly command: CommandConfig;
  readonly unresolved: readonly string[];
  readonly unknownFilters: ReadonlyArray<{ name: string; filter: string }>;
} {
  if (typeof command === 'string') {
    const { text, unresolved, unknownFilters } = substituteInputs(command, inputs);
    return { command: text, unresolved, unknownFilters };
  }
  if ('shell' in command) {
    const { text, unresolved, unknownFilters } = substituteInputs(command.shell, inputs);
    return { command: { shell: text }, unresolved, unknownFilters };
  }
  const unresolved = new Set<string>();
  const unknownFilters: { name: string; filter: string }[] = [];
  const argv = command.argv.map((arg) => {
    const result = substituteInputs(arg, inputs);
    for (const name of result.unresolved) unresolved.add(name);
    for (const entry of result.unknownFilters) unknownFilters.push(entry);
    return result.text;
  });
  return { command: { argv }, unresolved: [...unresolved], unknownFilters };
}

function isTriggerWatchHandle(value: unknown): value is TriggerWatchHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Boolean(candidate.fired) &&
    typeof (candidate.fired as Promise<unknown>).then === 'function' &&
    typeof candidate.dispose === 'function'
  );
}

function applyStopAllAfterFailure(ctx: RunContext, taskId: string): void {
  if (ctx.getOnFailure(taskId) === 'stop_all') ctx.applyStopAll();
}

function collectTaskSecretNames(
  config: PipelineConfig,
  track: TrackConfig,
  task: TaskConfig,
): readonly string[] {
  const names = new Set<string>();
  for (const name of config.secrets ?? []) names.add(name);
  for (const name of track.secrets ?? []) names.add(name);
  for (const name of task.secrets ?? []) names.add(name);
  return [...names];
}

function mergeSecretEnv(
  specEnv: Readonly<Record<string, string>> | undefined,
  secretEnv: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (Object.keys(secretEnv).length === 0) {
    return specEnv ? { ...specEnv } : undefined;
  }
  return { ...secretEnv, ...(specEnv ?? {}) };
}

async function resolveTaskSecretEnv(
  ctx: RunContext,
  taskId: string,
  track: TrackConfig,
  task: TaskConfig,
  names: readonly string[],
): Promise<
  | { readonly kind: 'ready'; readonly env: Readonly<Record<string, string>> }
  | { readonly kind: 'blocked'; readonly reason: string }
> {
  if (names.length === 0) return { kind: 'ready', env: {} };
  if (!ctx.secretResolver) {
    return {
      kind: 'blocked',
      reason:
        `task declares secret(s) ${names.join(', ')} but the host did not configure ` +
        'a secret resolver',
    };
  }

  let resolved: Readonly<Record<string, string>>;
  try {
    resolved = await ctx.secretResolver(names, {
      pipelineName: ctx.config.name,
      trackId: track.id,
      taskId,
      workDir: ctx.workDir,
    });
  } catch (err) {
    return {
      kind: 'blocked',
      reason: `secret resolver failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (
      Object.prototype.hasOwnProperty.call(resolved, name) &&
      typeof resolved[name] === 'string'
    ) {
      env[name] = resolved[name]!;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    return {
      kind: 'blocked',
      reason: `missing required secret(s): ${missing.join(', ')}`,
    };
  }
  return { kind: 'ready', env };
}

async function blockTaskBeforeExecution(
  ctx: RunContext,
  taskId: string,
  log: Logger,
  reason: string,
  hookCwd: string,
): Promise<void> {
  const state = ctx.states.get(taskId)!;
  log.error(`[task:${taskId}]`, `blocked - ${reason}`);
  state.result = {
    exitCode: -1,
    stdout: '',
    stderr: `[engine] ${reason}`,
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: new TextEncoder().encode(`[engine] ${reason}`).byteLength,
    durationMs: 0,
    sessionId: null,
    normalizedOutput: null,
    failureKind: 'spawn_error',
    outputs: null,
  };
  state.finishedAt = nowISO();
  ctx.setTaskStatus(taskId, 'blocked');
  try {
    await ctx.fireHook(taskId, 'task_failure', log, hookCwd);
  } catch (hookErr) {
    log.error(
      `[task:${taskId}]`,
      `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
    );
  }
  applyStopAllAfterFailure(ctx, taskId);
}

async function disposeTriggerWatch(
  handle: TriggerWatchHandle,
  log: Logger,
  taskId: string,
  reason: string,
): Promise<void> {
  try {
    await handle.dispose(reason);
  } catch (err) {
    log.warn(
      `[task:${taskId}]`,
      `trigger dispose failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface ExecuteTaskOptions {
  readonly taskId: string;
  readonly ctx: RunContext;
  readonly registry: PluginRegistry;
  readonly log: Logger;
  readonly approvalGateway: ApprovalGateway;
}

export async function executeTask(options: ExecuteTaskOptions): Promise<void> {
  const { taskId, ctx, registry, log, approvalGateway } = options;
  const dag = ctx.dag;
  const config = ctx.config;
  const workDir = ctx.workDir;
  const pipelineInfo = ctx.pipelineInfo;
  const state = ctx.states.get(taskId)!;
  const node = dag.nodes.get(taskId)!;
  const task = node.task;
  const track = node.track;

  log.section(`Task ${taskId}`, taskId);
  log.debug(
    `[task:${taskId}]`,
    `type=${isPromptTaskConfig(task) ? 'ai' : 'cmd'} track=${track.id} deps=[${node.dependsOn.join(', ') || '(root)'}]`,
  );

  // 1. Check dependencies
  for (const depId of node.dependsOn) {
    const result = ctx.isDependencySatisfied(depId);
    if (result === 'skip') {
      const depStatus = ctx.states.get(depId)?.status ?? 'unknown';
      log.debug(`[task:${taskId}]`, `skipped (upstream "${depId}" status=${depStatus})`);
      state.finishedAt = nowISO();
      state.result = skippedTaskResult(`skipped because upstream "${depId}" status=${depStatus}`);
      ctx.setTaskStatus(taskId, 'skipped');
      return;
    }
    if (result === 'unsatisfied') return; // still waiting
  }

  // Resolve effective working directory once at the top so every phase
  // — trigger watch, hook, command spawn, driver buildCommand, middleware,
  // completion — sees the same answer. Without this consistency, only the
  // editor route path (which lowers track.cwd into task.cwd via
  // loadPipeline) actually honored track-level cwd; SDK callers that pass a
  // RawPipelineConfig with track.cwd set saw it silently dropped at every
  // execution context except the resolved-debug-log line below.
  const resolvedCwd = validatePath(task.cwd ?? track.cwd ?? workDir, workDir);

  // Per-task timeout: explicit task.timeout wins, then ctx.defaultTaskTimeoutMs
  // (set by the editor to DEFAULT_TASK_TIMEOUT_MS = 30 min), then undefined
  // (no timeout — task runs until completion or pipeline abort).
  const taskTimeoutMs = task.timeout
    ? parseDuration(task.timeout)
    : (ctx.defaultTaskTimeoutMs ?? undefined);
  const taskDeadlineStartedAtMs = Date.now();
  const taskDeadlineMs =
    taskTimeoutMs === undefined ? undefined : taskDeadlineStartedAtMs + taskTimeoutMs;
  const remainingTaskTimeoutMs = (): number | undefined => {
    if (taskTimeoutMs === undefined) return undefined;
    return Math.max(0, taskTimeoutMs - (Date.now() - taskDeadlineStartedAtMs));
  };
  const withTaskDeadline = async <T>(
    phase: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const remaining = remainingTaskTimeoutMs();
    if (remaining !== undefined && remaining <= 0) {
      throw new TaskDeadlineExceededError(
        `Task "${taskId}" exceeded timeout ${task.timeout} before ${phase}`,
      );
    }
    const phaseController = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlinkParent = linkAbort(ctx.abortController.signal, () => phaseController.abort());
    let unlinkPhase = () => {
      /* assigned below */
    };
    const abortPromise = new Promise<never>((_, reject) => {
      unlinkPhase = linkAbort(phaseController.signal, () => {
        unlinkPhase();
        reject(
          timedOut
            ? new TaskDeadlineExceededError(
                `Task "${taskId}" exceeded timeout ${task.timeout} during ${phase}`,
              )
            : new Error('Pipeline aborted'),
        );
      });
    });
    if (remaining !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        phaseController.abort();
      }, remaining);
    }
    try {
      return await Promise.race([run(phaseController.signal), abortPromise]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      unlinkParent();
      unlinkPhase();
    }
  };

  // 2. Check trigger
  if (task.trigger) {
    log.debug(
      `[task:${taskId}]`,
      `trigger wait: type=${task.trigger.type} ${JSON.stringify(task.trigger)}`,
    );
    try {
      const triggerPlugin = registry.getHandler<TriggerPlugin>('triggers', task.trigger.type);
      // Own the trigger resource lifecycle in the engine. Plugins return a
      // watch handle, not a bare promise, so timeout/abort paths can always
      // call dispose() even if the trigger condition never settles.
      const triggerTimeoutMs = remainingTaskTimeoutMs() ?? 0;
      if (taskTimeoutMs !== undefined && triggerTimeoutMs <= 0) {
        throw new TriggerTimeoutError(
          `Trigger "${task.trigger.type}" did not settle before task timeout ${task.timeout}`,
        );
      }
      const watchHandle = triggerPlugin.watch(task.trigger as Record<string, unknown>, {
        taskId: node.taskId,
        trackId: track.id,
        workDir: resolvedCwd,
        signal: ctx.abortController.signal,
        approvalGateway,
        runtime: ctx.runtime,
      });
      if (!isTriggerWatchHandle(watchHandle)) {
        throw new Error(
          `Trigger "${task.trigger.type}" returned an invalid watch handle; expected { fired: Promise, dispose() }`,
        );
      }

      let timer: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener = () => {
        /* no-op until listener is installed */
      };
      let disposeReason = 'trigger settled';
      try {
        let rejectAbort: (err: Error) => void = () => {
          /* assigned before listener can fire */
        };
        const abortPromise = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        const onAbort = () => {
          if (timer !== null) clearTimeout(timer);
          disposeReason = 'pipeline aborted';
          rejectAbort(new Error('Pipeline aborted'));
        };
        if (ctx.abortController.signal.aborted) {
          disposeReason = 'pipeline aborted';
          throw new Error('Pipeline aborted');
        }
        ctx.abortController.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
          ctx.abortController.signal.removeEventListener('abort', onAbort);

        const timeoutPromise =
          triggerTimeoutMs > 0
            ? new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  disposeReason = `task timeout ${task.timeout}`;
                  reject(
                    new TriggerTimeoutError(
                      `Trigger "${task.trigger!.type}" did not settle within ${task.timeout} (task-level timeout)`,
                    ),
                  );
                }, triggerTimeoutMs);
              })
            : new Promise<never>(() => {
                /* no timeout */
              });

        await Promise.race([watchHandle.fired, abortPromise, timeoutPromise]);
      } finally {
        if (triggerTimeoutMs > 0) {
          // clearTimeout tolerates timers that already fired.
          if (timer !== null) clearTimeout(timer);
        }
        removeAbortListener();
        await disposeTriggerWatch(watchHandle, log, taskId, disposeReason);
      }
      log.debug(`[task:${taskId}]`, `trigger fired`);
    } catch (err: unknown) {
      // If pipeline was aborted while we were still waiting for the trigger,
      // this task never entered running state → skipped, not timeout.
      state.finishedAt = nowISO();
      const triggerMessage = triggerErrorMessage(err);
      const triggerDurationMs = Math.max(0, Date.now() - taskDeadlineStartedAtMs);
      if (ctx.abortReason !== null) {
        if (!isTerminal(state.status)) {
          state.result = skippedTaskResult(
            `skipped because the pipeline was aborted before trigger "${task.trigger.type}" fired`,
          );
          ctx.setTaskStatus(taskId, 'skipped');
        }
      } else if (isTriggerBlockedError(err)) {
        state.result = triggerFailureResult(triggerMessage, 'spawn_error', triggerDurationMs);
        ctx.setTaskStatus(taskId, 'blocked'); // user/policy rejection
      } else if (isTriggerTimeoutError(err)) {
        state.result = triggerFailureResult(triggerMessage, 'timeout', triggerDurationMs);
        ctx.setTaskStatus(taskId, 'timeout'); // genuine trigger wait timeout
      } else {
        const msg = triggerMessage;
        log.warn(
          `[task:${taskId}]`,
          `trigger "${task.trigger.type}" threw an untyped error; treating as failed: ${msg}`,
        );
        state.result = triggerFailureResult(msg, 'spawn_error', triggerDurationMs);
        ctx.setTaskStatus(taskId, 'failed');
      }
      try {
        await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
      } catch (hookErr) {
        log.error(
          `[task:${taskId}]`,
          `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
      applyStopAllAfterFailure(ctx, taskId);
      return;
    }
  }

  // 3. task_start hook (gate)
  let hookResult;
  try {
    hookResult = await withTaskDeadline('task_start hook', (signal) =>
      executeHook(
        config.hooks,
        'task_start',
        buildTaskContext(
          'task_start',
          pipelineInfo,
          ctx.trackInfoOf(taskId),
          ctx.buildTaskInfoObj(taskId),
        ),
        ctx.runtime,
        resolvedCwd,
        signal,
        log,
        ctx.envPolicy,
        remainingTaskTimeoutMs(),
      ),
    );
  } catch (err) {
    const isDeadlineTimeout = err instanceof TaskDeadlineExceededError;
    const errMsg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`[task:${taskId}]`, `task_start hook failed: ${errMsg}`);
    state.result = {
      exitCode: -1,
      stdout: '',
      stderr: errMsg,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: new TextEncoder().encode(errMsg).byteLength,
      durationMs: 0,
      sessionId: null,
      normalizedOutput: null,
      failureKind: isDeadlineTimeout
        ? 'timeout'
        : ctx.abortReason !== null
          ? 'aborted'
          : 'spawn_error',
    };
    state.finishedAt = nowISO();
    ctx.setTaskStatus(
      taskId,
      isDeadlineTimeout ? 'timeout' : ctx.abortReason !== null ? 'skipped' : 'failed',
    );
    try {
      await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    applyStopAllAfterFailure(ctx, taskId);
    return;
  }
  if (hookResult.exitCode !== 0 || config.hooks?.task_start) {
    log.debug(
      `[task:${taskId}]`,
      `task_start hook exit=${hookResult.exitCode} allowed=${hookResult.allowed}`,
    );
  }
  if (!hookResult.allowed) {
    state.finishedAt = nowISO();
    ctx.setTaskStatus(taskId, 'blocked');
    try {
      await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    applyStopAllAfterFailure(ctx, taskId);
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
  const effectivePortsResult = inferEffectivePorts(ctx, taskId);

  if (effectivePortsResult.kind === 'blocked') {
    log.error(
      `[task:${taskId}]`,
      `blocked — prompt port inference failed:\n${effectivePortsResult.reason}`,
    );
    state.result = {
      exitCode: -1,
      stdout: '',
      stderr: `[engine] prompt port inference failed:\n${effectivePortsResult.reason}`,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      sessionId: null,
      normalizedOutput: null,
      failureKind: 'spawn_error',
      outputs: null,
    };
    state.finishedAt = nowISO();
    ctx.setTaskStatus(taskId, 'blocked');
    try {
      await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    applyStopAllAfterFailure(ctx, taskId);
    return;
  }
  const isPromptTask = effectivePortsResult.isPromptTask;
  const effectivePorts = effectivePortsResult.effectivePorts;

  const bindingResolution = resolveTaskBindingInputs(task, ctx.bindingDataMap, node.dependsOn);
  if (bindingResolution.kind === 'blocked') {
    log.error(
      `[task:${taskId}]`,
      `blocked — cannot resolve task input bindings:\n${bindingResolution.reason}`,
    );
    state.result = {
      exitCode: -1,
      stdout: '',
      stderr: `[engine] task input binding resolution failed:\n${bindingResolution.reason}`,
      stdoutPath: null,
      stderrPath: null,
      durationMs: 0,
      sessionId: null,
      normalizedOutput: null,
      failureKind: 'spawn_error',
      outputs: null,
    };
    state.finishedAt = nowISO();
    ctx.setTaskStatus(taskId, 'blocked');
    try {
      await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    applyStopAllAfterFailure(ctx, taskId);
    return;
  }
  if (bindingResolution.missingOptional.length > 0) {
    log.debug(
      `[task:${taskId}]`,
      `optional input bindings unresolved (empty in placeholders): ${bindingResolution.missingOptional.join(', ')}`,
    );
  }

  let inferredPromptInputs: Readonly<Record<string, unknown>> = {};
  if (isPromptTask && effectivePorts?.inputs && effectivePorts.inputs.length > 0) {
    const inputResolution = resolveTaskInputs(
      { ...task, ports: effectivePorts },
      ctx.outputValuesMap,
      node.dependsOn,
    );
    if (inputResolution.kind === 'blocked') {
      log.error(
        `[task:${taskId}]`,
        `blocked — cannot resolve inferred prompt inputs:\n${inputResolution.reason}`,
      );
      state.result = {
        exitCode: -1,
        stdout: '',
        stderr: `[engine] inferred prompt input resolution failed:\n${inputResolution.reason}`,
        stdoutPath: null,
        stderrPath: null,
        durationMs: 0,
        sessionId: null,
        normalizedOutput: null,
        failureKind: 'spawn_error',
        outputs: null,
      };
      state.finishedAt = nowISO();
      ctx.setTaskStatus(taskId, 'blocked');
      try {
        await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
      } catch (hookErr) {
        log.error(
          `[task:${taskId}]`,
          `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
      applyStopAllAfterFailure(ctx, taskId);
      return;
    }
    inferredPromptInputs = inputResolution.inputs;
  }

  const resolvedInputs = { ...inferredPromptInputs, ...bindingResolution.inputs };
  ctx.resolvedInputsMap.set(taskId, resolvedInputs);
  if (effectivePorts?.inputs && effectivePorts.inputs.length > 0) {
    const inputNames = Object.keys(resolvedInputs).sort();
    log.debug(
      `[task:${taskId}]`,
      `resolved inputs: ${inputNames.length > 0 ? inputNames.join(', ') : '(none)'}` +
        (isPromptTask ? ' (inferred from upstream Commands)' : ''),
    );
  }

  // 4. Mark running — set startedAt before emitting so subscribers see a
  // complete task_update (startedAt non-null) on the status transition.
  const secretNames = collectTaskSecretNames(config, track, task);
  const secretResolution = await resolveTaskSecretEnv(ctx, taskId, track, task, secretNames);
  if (secretResolution.kind === 'blocked') {
    await blockTaskBeforeExecution(ctx, taskId, log, secretResolution.reason, resolvedCwd);
    return;
  }
  const secretEnv = secretResolution.env;
  if (secretNames.length > 0) {
    log.debug(`[task:${taskId}]`, `secrets: ${secretNames.join(', ')}`);
  }

  state.startedAt = nowISO();
  ctx.setTaskStatus(taskId, 'running');
  log.info(
    `[task:${taskId}]`,
    isCommandTaskConfig(task) ? `running: ${commandLabel(task.command)}` : `running (driver task)`,
  );

  // File-only: resolved config for this task
  const resolvedDriver = task.driver ?? track.driver ?? config.driver ?? 'opencode';
  const resolvedModel = task.model ?? track.model ?? config.model ?? '(default)';
  const resolvedPerms = task.permissions ?? track.permissions ?? '(default)';
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
    const timeoutMs = remainingTaskTimeoutMs();
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new TaskDeadlineExceededError(
        `Task "${taskId}" exceeded timeout ${task.timeout} before process execution`,
      );
    }

    // Stream child stdout/stderr directly to disk in the logger's run dir
    // and keep only a bounded tail in the returned TaskResult. Filenames
    // mirror the existing `.stderr` naming — dots in task ids are replaced
    // so hierarchical ids (e.g. `track1.task2`) map cleanly to a flat dir.
    const stdoutPath = ctx.runtime.logStore.taskOutputPath({
      workDir,
      runId: ctx.runId,
      taskId,
      stream: 'stdout',
    });
    const stderrPath = ctx.runtime.logStore.taskOutputPath({
      workDir,
      runId: ctx.runId,
      taskId,
      stream: 'stderr',
    });
    const runOpts = {
      timeoutMs,
      signal: ctx.abortController.signal,
      stdoutPath,
      stderrPath,
      envPolicy: ctx.envPolicy,
      // Surface the child's output live, while the task is still running.
      // The authoritative bounded tail still arrives with the terminal
      // task_update once the process exits; this is the streaming view
      // that lets the UI show a running node's output before it finishes.
      onOutputChunk: (stream: 'stdout' | 'stderr', text: string) => {
        ctx.emit({
          type: 'task_output',
          runId: ctx.runId,
          taskId,
          stream,
          chunk: text,
        });
      },
    };

    if (isCommandTaskConfig(task)) {
      // Substitute `{{inputs.X}}` placeholders into the command
      // string. Tasks with no declared inputs always produce the same
      // string back (no placeholders to match). Unresolved references
      // render empty — validate-raw flags undeclared references as
      // errors, so the only way to land here with an unresolved is an
      // optional input that had no upstream producer and no default,
      // which we surface in the log.
      const {
        command: expandedCommand,
        unresolved,
        unknownFilters,
      } = substituteCommandInputs(task.command, resolvedInputs);
      if (unknownFilters.length > 0) {
        // Unknown filters in a command placeholder hard-fail. A typo like
        // `{{inputs.x | shelquote}}` would otherwise interpolate `x`
        // verbatim and silently re-open the shell-injection vector the
        // filter exists to close. Surface a clear diagnostic that names
        // each offending filter so the YAML author can fix it.
        const detail = unknownFilters.map(({ name, filter }) => `${name} | ${filter}`).join(', ');
        const reason =
          `command placeholder uses unknown filter(s): ${detail}. ` +
          `Supported filter: shellquote.`;
        log.error(`[task:${taskId}]`, `blocked — ${reason}`);
        state.result = {
          exitCode: -1,
          stdout: '',
          stderr: `[engine] ${reason}`,
          stdoutPath: null,
          stderrPath: null,
          durationMs: 0,
          sessionId: null,
          normalizedOutput: null,
          failureKind: 'spawn_error',
          outputs: null,
        };
        state.finishedAt = nowISO();
        ctx.setTaskStatus(taskId, 'blocked');
        try {
          await ctx.fireHook(taskId, 'task_failure', log, resolvedCwd);
        } catch (hookErr) {
          log.error(
            `[task:${taskId}]`,
            `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }
        applyStopAllAfterFailure(ctx, taskId);
        return;
      }
      if (unresolved.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `command placeholders rendered empty: ${unresolved.join(', ')}`,
        );
      }
      log.debug(`[task:${taskId}]`, `command: ${commandLabel(expandedCommand)}`);
      if (Object.keys(secretEnv).length > 0) {
        result = await ctx.runtime.runSpawn(
          { ...commandToSpawnSpec(expandedCommand, resolvedCwd), env: secretEnv },
          null,
          runOpts,
        );
      } else {
        result = await ctx.runtime.runCommand(expandedCommand, resolvedCwd, runOpts);
      }
    } else {
      // AI task: apply middleware chain against a structured PromptDocument.
      const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';
      const driver = registry.getHandler<DriverPlugin>('drivers', driverName);

      // Substitute placeholders in the user-authored prompt before
      // wrapping into a PromptDocument so middlewares see the
      // already-resolved task text.
      const {
        text: expandedPrompt,
        unresolved,
        unknownFilters,
      } = substituteInputs(task.prompt!, resolvedInputs);
      if (unresolved.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `prompt placeholders rendered empty: ${unresolved.join(', ')}`,
        );
      }
      if (unknownFilters.length > 0) {
        // AI tasks don't hard-fail on unknown filters the way command
        // tasks do — the value just lands in the model's prompt as the
        // raw string, no shell layer involved. We still surface a warning
        // so a typo doesn't silently mean the YAML author got something
        // different from what they expected (e.g. `| shelquote` left the
        // value unquoted in a sentence about quoting).
        const detail = unknownFilters.map(({ name, filter }) => `${name} | ${filter}`).join(', ');
        log.warn(
          `[task:${taskId}]`,
          `prompt uses unknown placeholder filter(s): ${detail}. Supported filter: shellquote.`,
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
        log.debug(`[task:${taskId}]`, `middleware chain: ${mws.map((m) => m.type).join(' → ')}`);
        const mwCtxBase: Omit<MiddlewareContext, 'signal'> = {
          task,
          track,
          workDir: resolvedCwd,
          ...(taskDeadlineMs !== undefined ? { deadlineMs: taskDeadlineMs } : {}),
        };
        for (const mwConfig of mws) {
          const mwPlugin = registry.getHandler<MiddlewarePlugin>('middlewares', mwConfig.type);
          const beforeBlocks = doc.contexts.length;
          const beforeLen = serializePromptDocument(doc).length;

          if (typeof mwPlugin.enhanceDoc !== 'function') {
            throw new Error(`middleware "${mwConfig.type}" must provide enhanceDoc`);
          }
          const next = await withTaskDeadline(`middleware "${mwConfig.type}"`, (signal) =>
            mwPlugin.enhanceDoc(doc, mwConfig as Record<string, unknown>, {
              ...mwCtxBase,
              signal,
            }),
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
      const hostContextBlocks = ctx.taskPromptContexts[taskId];
      if (hostContextBlocks && hostContextBlocks.length > 0) {
        doc = { contexts: [...doc.contexts, ...hostContextBlocks], task: doc.task };
      }
      const prompt = serializePromptDocument(doc);
      log.debug(
        `[task:${taskId}]`,
        `prompt: ${originalLen} chars (final: ${prompt.length} chars, ${doc.contexts.length} block${doc.contexts.length === 1 ? '' : 's'})`,
      );
      if (ctx.logPrompt) {
        log.quiet(`--- prompt (final) ---\n${clip(prompt)}\n--- end prompt ---`, taskId);
      }

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
      const seededContinueFrom = node.resolvedContinueFrom
        ? undefined
        : seedTaskContinuation(ctx, taskId);
      const enrichedTrack = track.cwd ? { ...track, cwd: validatePath(track.cwd, workDir) } : track;
      const enrichedTask: TaskConfig = {
        ...task,
        cwd: resolvedCwd,
        prompt,
        continue_from: seededContinueFrom ?? node.resolvedContinueFrom,
      };
      const buildDriverCtx = (signal: AbortSignal): DriverContext => ({
        sessionMap: ctx.sessionMap,
        sessionDriverMap: ctx.sessionDriverMap,
        normalizedMap: ctx.normalizedMap,
        workDir: resolvedCwd,
        signal,
        ...(taskDeadlineMs !== undefined ? { deadlineMs: taskDeadlineMs } : {}),
        // Structured view for drivers that want fine-grained control
        // over serialization (e.g. inserting [Previous Output] between
        // contexts and task). Drivers that read task.prompt see the
        // default serialization and need no changes.
        promptDoc: doc,
        // Resolved input values keyed by input name. Typed bindings have
        // already been coerced when a binding declares `type`.
        inputs: resolvedInputs,
      });
      const spec = await withTaskDeadline(`driver "${driverName}" buildCommand`, (signal) =>
        driver.buildCommand(enrichedTask, enrichedTrack, buildDriverCtx(signal)),
      );
      const spawnSpec =
        Object.keys(secretEnv).length > 0
          ? { ...spec, env: mergeSecretEnv(spec.env, secretEnv) }
          : spec;
      log.debug(`[task:${taskId}]`, `driver=${driverName}`);
      log.debug(`[task:${taskId}]`, `spawn args: ${JSON.stringify(spawnSpec.args)}`);
      if (spawnSpec.cwd) log.debug(`[task:${taskId}]`, `spawn cwd: ${spawnSpec.cwd}`);
      if (spawnSpec.env)
        log.debug(
          `[task:${taskId}]`,
          `spawn env overrides: ${Object.keys(spawnSpec.env).join(', ')}`,
        );
      if (spawnSpec.stdin)
        log.debug(`[task:${taskId}]`, `spawn stdin: ${spawnSpec.stdin.length} chars`);
      result = await ctx.runtime.runSpawn(spawnSpec, driver, runOpts);
    }

    // 6. Determine terminal status (without emitting yet — result must be complete first)
    // H2: branch on failureKind so spawn and parse errors no longer
    // masquerade as success or timeout.
    let terminalStatus: TaskStatus;
    const kind = result.failureKind;
    if (kind === 'timeout') {
      terminalStatus = 'timeout';
    } else if (kind === 'aborted') {
      terminalStatus = ctx.abortReason === 'timeout' ? 'timeout' : 'skipped';
    } else if (kind === 'spawn_error' || kind === 'parse_error') {
      terminalStatus = 'failed';
    } else if (task.completion) {
      const plugin = registry.getHandler<CompletionPlugin>('completions', task.completion.type);
      const completionCtxBase = {
        workDir: resolvedCwd,
        runtime: ctx.runtime,
        envPolicy: ctx.envPolicy,
      };
      const rawOutcome = await withTaskDeadline(`completion "${task.completion.type}"`, (signal) =>
        plugin.check(task.completion as Record<string, unknown>, result, {
          ...completionCtxBase,
          signal,
        }),
      );
      // R4: only literal booleans or the exact structured shape are valid.
      const outcome = normalizeCompletionOutcome(rawOutcome, task.completion.type);
      terminalStatus = outcome.passed ? 'success' : 'failed';
      if (!outcome.passed) {
        const feedbackNote = outcome.feedback ? '[completion] ' + outcome.feedback : '';
        const feedbackSuffix = feedbackNote
          ? (result.stderr.length > 0 ? '\n' : '') + feedbackNote
          : '';
        const stderr = result.stderr + feedbackSuffix;
        const stderrBytes =
          (result.stderrBytes ?? new TextEncoder().encode(result.stderr).byteLength) +
          new TextEncoder().encode(feedbackSuffix).byteLength;
        result = {
          ...result,
          stderr,
          stderrBytes,
          failureKind: 'completion_failed',
        };
      }
    } else {
      terminalStatus = result.exitCode === 0 ? 'success' : 'failed';
    }

    // Extract declared outputs from the task's output stream. Only
    // meaningful on success — a failed task's output is whatever the
    // child happened to emit before exiting, and downstream tasks
    // shouldn't receive partial data.
    let extractedOutputs: Readonly<Record<string, unknown>> | null = null;
    if (terminalStatus === 'success') {
      const outputExtraction = extractSuccessfulOutputs({
        task,
        effectivePorts,
        result,
      });
      extractedOutputs = outputExtraction.outputs;
      if (task.outputs && Object.keys(task.outputs).length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `extracted binding outputs: ${JSON.stringify(extractedOutputs ?? {})}`,
        );
        if (outputExtraction.bindingDiagnostic) {
          log.error(`[task:${taskId}]`, outputExtraction.bindingDiagnostic);
          const note = `\n[engine] ${outputExtraction.bindingDiagnostic}`;
          result = { ...result, stderr: result.stderr + note };
        }
      }

      if (effectivePorts?.outputs && effectivePorts.outputs.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `extracted outputs: ${JSON.stringify(extractedOutputs ?? {})}` +
            (isPromptTask ? ' (inferred from downstream Commands)' : ''),
        );
        if (outputExtraction.portDiagnostic) {
          log.error(`[task:${taskId}]`, outputExtraction.portDiagnostic);
          const note = `\n[engine] ${outputExtraction.portDiagnostic}`;
          result = { ...result, stderr: result.stderr + note };
        }
      }
      if (outputExtraction.bindingDiagnostic || outputExtraction.portDiagnostic) {
        terminalStatus = 'failed';
        extractedOutputs = null;
        result = { ...result, failureKind: 'output_error' };
      }
    }
    // Attach outputs to the result (null when task has no declared
    // outputs or extraction failed entirely). Consumers of TaskResult
    // — hooks, wire events, test assertions — all go through this
    // one field rather than re-running extraction.
    result = { ...result, outputs: extractedOutputs };
    if (extractedOutputs !== null) {
      ctx.outputValuesMap.set(taskId, extractedOutputs);
    }
    ctx.bindingDataMap.set(taskId, {
      outputs: extractedOutputs,
      stdout: result.stdout,
      stderr: result.stderr,
      normalizedOutput: result.normalizedOutput,
      exitCode: result.exitCode,
    });

    // Store normalized text separately (in-memory) for continue_from handoff.
    // R15: clip oversized values so a runaway parseResult can't accumulate
    // hundreds of MB across tasks.
    if (result.normalizedOutput !== null) {
      const clipped =
        result.normalizedOutput.length > MAX_NORMALIZED_BYTES
          ? result.normalizedOutput.slice(0, MAX_NORMALIZED_BYTES) +
            `\n[…clipped at ${MAX_NORMALIZED_BYTES} bytes]`
          : result.normalizedOutput;
      ctx.normalizedMap.set(taskId, clipped);
    }

    // Note: stderr is already persisted by runner.ts as it streams; the
    // old "write full string after the fact" block is gone — that's what
    // the streaming rewrite fixed (unbounded in-memory buffering).

    if (result.sessionId) {
      // H1: qualified-only key.
      ctx.sessionMap.set(taskId, result.sessionId);
      ctx.sessionDriverMap.set(taskId, resolvedDriver);
    }

    // Set result and finishedAt before emitting terminal status so listeners see complete state
    state.result = result;
    state.finishedAt = nowISO();
    ctx.setTaskStatus(taskId, terminalStatus);

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
      log.quiet(`--- stdout (${taskId}) ---\n${clip(result.stdout)}\n--- end stdout ---`, taskId);
    }
    if (result.stderr) {
      log.quiet(`--- stderr (${taskId}) ---\n${clip(result.stderr)}\n--- end stderr ---`, taskId);
    }
    if (task.completion) {
      log.debug(
        `[task:${taskId}]`,
        `completion check: type=${task.completion.type} result=${terminalStatus}`,
      );
    }
  } catch (err: unknown) {
    const isDeadlineTimeout = err instanceof TaskDeadlineExceededError;
    const isPipelineAbort = !isDeadlineTimeout && ctx.abortReason !== null;
    const errMsg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`[task:${taskId}]`, `failed before execution: ${errMsg}`);
    state.result = {
      exitCode: -1,
      stdout: '',
      stderr: errMsg,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: new TextEncoder().encode(errMsg).byteLength,
      durationMs: 0,
      sessionId: null,
      normalizedOutput: null,
      // H2: Engine-level pre-execution errors (driver throw, middleware
      // throw, getHandler 404) classify as spawn_error — the process never
      // ran, so calling them "timeout" was actively misleading.
      failureKind: isDeadlineTimeout ? 'timeout' : isPipelineAbort ? 'aborted' : 'spawn_error',
    };
    state.finishedAt = nowISO();
    ctx.setTaskStatus(
      taskId,
      isDeadlineTimeout ? 'timeout' : isPipelineAbort ? 'skipped' : 'failed',
    );
  }

  // 7. Fire hooks
  const finalStatus: TaskStatus = state.status;
  try {
    await ctx.fireHook(
      taskId,
      finalStatus === 'success' ? 'task_success' : 'task_failure',
      log,
      resolvedCwd,
    );
  } catch (hookErr) {
    log.error(
      `[task:${taskId}]`,
      `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
    );
  }

  // 8. Handle stop_all for failure states
  if (finalStatus !== 'success' && ctx.getOnFailure(taskId) === 'stop_all') {
    ctx.applyStopAll();
  }
}
