import type {
  CompletionPlugin,
  DriverContext,
  DriverPlugin,
  MiddlewareContext,
  MiddlewarePlugin,
  PromptDocument,
  TaskConfig,
  TaskResult,
  TaskStatus,
  TriggerPlugin,
} from '../types';
import type { PluginRegistry } from '../registry';
import { parseDuration, nowISO } from '../utils';
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
import { TriggerBlockedError, TriggerTimeoutError } from './trigger-errors';

const MAX_NORMALIZED_BYTES = 1_000_000;

function isPromptTaskConfig(task: {
  readonly prompt?: string;
  readonly command?: string;
}): task is { readonly prompt: string; readonly command?: undefined } {
  return task.prompt !== undefined && task.command === undefined;
}

function isCommandTaskConfig(task: {
  readonly command?: string;
  readonly prompt?: string;
}): task is { readonly command: string; readonly prompt?: undefined } {
  return task.command !== undefined && task.prompt === undefined;
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
      ctx.setTaskStatus(taskId, 'skipped');
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
        if (ctx.abortController.signal.aborted) {
          onAbort();
          return;
        }
        ctx.abortController.signal.addEventListener('abort', onAbort, { once: true });
        if (triggerTimeoutMs > 0) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ctx.abortController.signal.removeEventListener('abort', onAbort);
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
            signal: ctx.abortController.signal,
            approvalGateway,
            runtime: ctx.runtime,
          })
          .then(
            (v) => {
              if (settled) return;
              settled = true;
              if (timer !== null) clearTimeout(timer);
              ctx.abortController.signal.removeEventListener('abort', onAbort);
              resolve(v);
            },
            (e) => {
              if (settled) return;
              settled = true;
              if (timer !== null) clearTimeout(timer);
              ctx.abortController.signal.removeEventListener('abort', onAbort);
              reject(e);
            },
          );
      });
      log.debug(`[task:${taskId}]`, `trigger fired`);
    } catch (err: unknown) {
      // If pipeline was aborted while we were still waiting for the trigger,
      // this task never entered running state → skipped, not timeout.
      state.finishedAt = nowISO();
      if (ctx.abortReason !== null) {
        ctx.setTaskStatus(taskId, 'skipped');
      } else if (err instanceof TriggerBlockedError) {
        ctx.setTaskStatus(taskId, 'blocked'); // user/policy rejection
      } else if (err instanceof TriggerTimeoutError) {
        ctx.setTaskStatus(taskId, 'timeout'); // genuine trigger wait timeout
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `[task:${taskId}]`,
          `trigger "${task.trigger.type}" threw an untyped error; treating as failed: ${msg}`,
        );
        ctx.setTaskStatus(taskId, 'failed');
      }
      try {
        await ctx.fireHook(taskId, 'task_failure', log);
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
    buildTaskContext(
      'task_start',
      pipelineInfo,
      ctx.trackInfoOf(taskId),
      ctx.buildTaskInfoObj(taskId),
    ),
    ctx.runtime,
    workDir,
    ctx.abortController.signal,
    log,
    ctx.envPolicy,
  );
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
      await ctx.fireHook(taskId, 'task_failure', log);
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
      await ctx.fireHook(taskId, 'task_failure', log);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    if (ctx.getOnFailure(taskId) === 'stop_all') ctx.applyStopAll();
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
      await ctx.fireHook(taskId, 'task_failure', log);
    } catch (hookErr) {
      log.error(
        `[task:${taskId}]`,
        `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }
    if (ctx.getOnFailure(taskId) === 'stop_all') ctx.applyStopAll();
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
        await ctx.fireHook(taskId, 'task_failure', log);
      } catch (hookErr) {
        log.error(
          `[task:${taskId}]`,
          `hook execution failed: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
        );
      }
      if (ctx.getOnFailure(taskId) === 'stop_all') ctx.applyStopAll();
      return;
    }
    inferredPromptInputs = inputResolution.inputs;
  }

  const resolvedInputs = { ...inferredPromptInputs, ...bindingResolution.inputs };
  ctx.resolvedInputsMap.set(taskId, resolvedInputs);
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
  ctx.setTaskStatus(taskId, 'running');
  log.info(
    `[task:${taskId}]`,
    isCommandTaskConfig(task) ? `running: ${task.command}` : `running (driver task)`,
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
    };

    if (isCommandTaskConfig(task)) {
      // Substitute `{{inputs.X}}` placeholders into the command
      // string. Tasks with no declared inputs always produce the same
      // string back (no placeholders to match). Unresolved references
      // render empty — validate-raw flags undeclared references as
      // errors, so the only way to land here with an unresolved is an
      // optional input that had no upstream producer and no default,
      // which we surface in the log.
      const { text: expandedCommand, unresolved } = substituteInputs(task.command, resolvedInputs);
      if (unresolved.length > 0) {
        log.debug(
          `[task:${taskId}]`,
          `command placeholders rendered empty: ${unresolved.join(', ')}`,
        );
      }
      log.debug(`[task:${taskId}]`, `command: ${expandedCommand}`);
      result = await ctx.runtime.runCommand(expandedCommand, task.cwd ?? workDir, runOpts);
    } else {
      // AI task: apply middleware chain against a structured PromptDocument.
      const driverName = task.driver ?? track.driver ?? config.driver ?? 'opencode';
      const driver = registry.getHandler<DriverPlugin>('drivers', driverName);

      // Substitute placeholders in the user-authored prompt before
      // wrapping into a PromptDocument so middlewares see the
      // already-resolved task text.
      const { text: expandedPrompt, unresolved } = substituteInputs(task.prompt!, resolvedInputs);
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
        log.debug(`[task:${taskId}]`, `middleware chain: ${mws.map((m) => m.type).join(' → ')}`);
        const mwCtx: MiddlewareContext = {
          task,
          track,
          workDir: task.cwd ?? workDir,
        };
        for (const mwConfig of mws) {
          const mwPlugin = registry.getHandler<MiddlewarePlugin>('middlewares', mwConfig.type);
          const beforeBlocks = doc.contexts.length;
          const beforeLen = serializePromptDocument(doc).length;

          if (typeof mwPlugin.enhanceDoc !== 'function') {
            throw new Error(
              `middleware "${mwConfig.type}" must provide enhanceDoc`,
            );
          }
          const next = await mwPlugin.enhanceDoc(doc, mwConfig as Record<string, unknown>, mwCtx);
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
      const enrichedTask: TaskConfig = {
        ...task,
        prompt,
        continue_from: node.resolvedContinueFrom,
      };
      const driverCtx: DriverContext = {
        sessionMap: ctx.sessionMap,
        normalizedMap: ctx.normalizedMap,
        workDir: task.cwd ?? workDir,
        // Structured view for drivers that want fine-grained control
        // over serialization (e.g. inserting [Previous Output] between
        // contexts and task). Drivers that read task.prompt see the
        // default serialization and need no changes.
        promptDoc: doc,
        // Resolved input values keyed by input name. Typed bindings have
        // already been coerced when a binding declares `type`.
        inputs: resolvedInputs,
      };
      const spec = await driver.buildCommand(enrichedTask, track, driverCtx);
      log.debug(`[task:${taskId}]`, `driver=${driverName}`);
      log.debug(`[task:${taskId}]`, `spawn args: ${JSON.stringify(spec.args)}`);
      if (spec.cwd) log.debug(`[task:${taskId}]`, `spawn cwd: ${spec.cwd}`);
      if (spec.env)
        log.debug(`[task:${taskId}]`, `spawn env overrides: ${Object.keys(spec.env).join(', ')}`);
      if (spec.stdin) log.debug(`[task:${taskId}]`, `spawn stdin: ${spec.stdin.length} chars`);
      result = await ctx.runtime.runSpawn(spec, driver, runOpts);
    }

    // 6. Determine terminal status (without emitting yet — result must be complete first)
    // H2: branch on failureKind so spawn and parse errors no longer
    // masquerade as success or timeout.
    let terminalStatus: TaskStatus;
    const kind = result.failureKind;
    if (kind === 'timeout') {
      terminalStatus = 'timeout';
    } else if (kind === 'spawn_error' || kind === 'parse_error') {
      terminalStatus = 'failed';
    } else if (result.exitCode !== 0) {
      terminalStatus = 'failed';
    } else if (task.completion) {
      const plugin = registry.getHandler<CompletionPlugin>('completions', task.completion.type);
      const completionCtx = {
        workDir: task.cwd ?? workDir,
        signal: ctx.abortController.signal,
        runtime: ctx.runtime,
        envPolicy: ctx.envPolicy,
      };
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
          log.debug(`[task:${taskId}]`, outputExtraction.bindingDiagnostic);
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
    ctx.setTaskStatus(taskId, 'failed');
  }

  // 7. Fire hooks
  const finalStatus: TaskStatus = state.status;
  try {
    await ctx.fireHook(taskId, finalStatus === 'success' ? 'task_success' : 'task_failure', log);
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
