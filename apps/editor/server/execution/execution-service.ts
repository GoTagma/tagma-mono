import type {
  CommandConfig,
  DriverPlugin,
  RunOptions,
  SpawnSpec,
  TaskFailureKind,
  TaskResult,
} from '@tagma/types';
import { randomUUID } from 'node:crypto';
import { ExecutionEventJournal } from './run-journal.js';

export type ExecutionOutcome =
  | 'succeeded'
  | 'exit_nonzero'
  | 'spawn_error'
  | 'binary_missing'
  | 'policy_denied'
  | 'capability_missing'
  | 'backend_unavailable'
  | 'timeout'
  | 'aborted'
  | 'orphaned'
  | 'infra_error';

export type ExecutionEvent =
  | { readonly type: 'started'; readonly seq: number; readonly backendId: string }
  | { readonly type: 'stdout'; readonly seq: number; readonly bytes: Uint8Array }
  | { readonly type: 'stderr'; readonly seq: number; readonly bytes: Uint8Array }
  | { readonly type: 'diagnostic'; readonly seq: number; readonly code: string }
  | {
      readonly type: 'cancel-state';
      readonly seq: number;
      readonly state: 'requested';
    }
  | { readonly type: 'terminal'; readonly seq: number; readonly outcome: ExecutionOutcome };

type WithoutSequence<T> = T extends unknown ? Omit<T, 'seq'> : never;
type PendingExecutionEvent = WithoutSequence<ExecutionEvent>;

export type CancelResponse = {
  readonly status: 'cancel_requested' | 'already_requested' | 'already_terminal';
};

export interface ExecutionOutputPolicy {
  readonly persist: boolean;
  readonly stdoutTailBytes: number;
  readonly stderrTailBytes: number;
}

/**
 * Transitional, sidecar-private plan. Legacy invocations are deliberately
 * labelled host-specific while core still produces CommandConfig/SpawnSpec.
 * Structured exec plans will replace this adapter shape without publishing it
 * as a package protocol.
 */
export interface ExecutionPlan {
  readonly planId: string;
  readonly idempotencyKey: string;
  readonly invocation:
    | {
        readonly kind: 'legacy-spawn';
        readonly portability: 'host-specific';
        readonly spec: SpawnSpec;
      }
    | {
        readonly kind: 'legacy-command';
        readonly portability: 'host-specific';
        readonly command: CommandConfig;
        readonly cwd: string;
      };
  readonly requestedCapabilities: readonly string[];
  readonly minimumEnforcement: readonly string[];
  readonly outputPolicy: ExecutionOutputPolicy;
}

export interface ExecutionBackendContext {
  readonly driver: DriverPlugin | null;
  readonly options: RunOptions;
}

export interface ExecutionBackend<TResolved = unknown> {
  readonly id: string;
  resolve(plan: ExecutionPlan, context: ExecutionBackendContext): Promise<TResolved>;
  discard?(
    resolved: TResolved,
    context: ExecutionBackendContext,
    reason: unknown,
  ): Promise<void> | void;
  execute(resolved: TResolved, context: ExecutionBackendContext): Promise<TaskResult>;
}

export interface ExecutionStartContext {
  readonly driver?: DriverPlugin | null;
  readonly options?: RunOptions;
}

export interface ExecutionHandle {
  readonly executionId: string;
  readonly events: AsyncIterable<ExecutionEvent>;
  readonly result: Promise<TaskResult>;
  cancel(reason?: string): Promise<CancelResponse>;
}

export interface NativeExecutionServiceOptions {
  readonly executionId?: () => string;
  readonly maxBufferedEvents?: number;
  readonly maxBufferedBytes?: number;
}

function bufferedEventBytes(event: ExecutionEvent): number {
  return event.type === 'stdout' || event.type === 'stderr' ? event.bytes.byteLength : 0;
}

function outcomeFromResult(result: TaskResult): ExecutionOutcome {
  const failure: TaskFailureKind = result.failureKind;
  if (failure === null && result.exitCode === 0) return 'succeeded';
  if (failure === 'binary_missing') return 'binary_missing';
  if (failure === 'spawn_error') return 'spawn_error';
  if (failure === 'timeout') return 'timeout';
  if (failure === 'aborted') return 'aborted';
  if (failure === 'exit_nonzero' || result.exitCode !== 0) return 'exit_nonzero';
  return 'infra_error';
}

function abortedBeforeSpawnResult(startedAt: number): TaskResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr: 'Pipeline aborted before spawn',
    stdoutPath: null,
    stderrPath: null,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    sessionId: null,
    normalizedOutput: null,
    failureKind: 'aborted',
  };
}

export class NativeExecutionService {
  private readonly executionId: () => string;
  private readonly maxBufferedEvents: number;
  private readonly maxBufferedBytes: number;

  constructor(
    private readonly backend: ExecutionBackend,
    options: NativeExecutionServiceOptions = {},
  ) {
    this.executionId = options.executionId ?? randomUUID;
    this.maxBufferedEvents = options.maxBufferedEvents ?? 1024;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  }

  async start(
    plan: ExecutionPlan,
    startContext: ExecutionStartContext = {},
  ): Promise<ExecutionHandle> {
    const executionId = this.executionId();
    const journal = new ExecutionEventJournal<ExecutionEvent>(
      this.maxBufferedEvents,
      this.maxBufferedBytes,
      bufferedEventBytes,
    );
    const controller = new AbortController();
    const externalSignal = startContext.options?.signal;
    const encoder = new TextEncoder();
    let seq = 0;
    let terminal = false;
    let cancelRequested = false;
    let backendStarted = false;
    let discardFailed = false;

    const publish = (event: PendingExecutionEvent): void => {
      journal.publish({ ...event, seq: ++seq } as ExecutionEvent);
    };
    const terminalize = (outcome: ExecutionOutcome): void => {
      if (terminal) return;
      terminal = true;
      const dropped = journal.takeDroppedCount();
      if (dropped > 0) {
        publish({ type: 'diagnostic', code: `execution.events_dropped:${dropped}` });
      }
      publish({ type: 'terminal', outcome });
      journal.close();
    };
    const requestCancel = (reason?: unknown): CancelResponse => {
      if (terminal) return { status: 'already_terminal' };
      if (cancelRequested) return { status: 'already_requested' };
      cancelRequested = true;
      publish({ type: 'cancel-state', state: 'requested' });
      controller.abort(reason);
      return { status: 'cancel_requested' };
    };
    const externalAbort = (): void => {
      requestCancel(externalSignal?.reason);
    };
    if (externalSignal?.aborted) externalAbort();
    else externalSignal?.addEventListener('abort', externalAbort, { once: true });

    const originalOptions = startContext.options ?? {};
    const originalOutput = originalOptions.onOutputChunk;
    const context: ExecutionBackendContext = {
      driver: startContext.driver ?? null,
      options: {
        ...originalOptions,
        signal: controller.signal,
        onOutputChunk(stream, text) {
          publish({ type: stream, bytes: encoder.encode(text) });
          originalOutput?.(stream, text);
        },
      },
    };
    const startedAt = performance.now();

    const result = (async (): Promise<TaskResult> => {
      try {
        if (controller.signal.aborted) {
          const aborted = abortedBeforeSpawnResult(startedAt);
          terminalize('aborted');
          return aborted;
        }
        const resolved = await this.backend.resolve(plan, context);
        if (controller.signal.aborted) {
          try {
            await this.backend.discard?.(resolved, context, controller.signal.reason);
          } catch (error) {
            discardFailed = true;
            throw error;
          }
          const aborted = abortedBeforeSpawnResult(startedAt);
          terminalize('aborted');
          return aborted;
        }
        backendStarted = true;
        publish({ type: 'started', backendId: this.backend.id });
        const backendResult = await this.backend.execute(resolved, context);
        terminalize(outcomeFromResult(backendResult));
        return backendResult;
      } catch (error) {
        if (controller.signal.aborted && !backendStarted && !discardFailed) {
          const aborted = abortedBeforeSpawnResult(startedAt);
          terminalize('aborted');
          return aborted;
        }
        publish({
          type: 'diagnostic',
          code: discardFailed
            ? 'execution.discard_failed'
            : backendStarted
              ? 'execution.backend_failed'
              : 'execution.resolution_failed',
        });
        terminalize(discardFailed || controller.signal.aborted ? 'orphaned' : 'infra_error');
        throw error;
      } finally {
        externalSignal?.removeEventListener('abort', externalAbort);
      }
    })();

    return {
      executionId,
      events: journal,
      result,
      async cancel(reason?: string) {
        return requestCancel(reason);
      },
    };
  }
}

export function createExecutionPlan(
  invocation: ExecutionPlan['invocation'],
  options: RunOptions = {},
  ids: { readonly planId?: string; readonly idempotencyKey?: string } = {},
): ExecutionPlan {
  const planId = ids.planId ?? randomUUID();
  return {
    planId,
    idempotencyKey: ids.idempotencyKey ?? randomUUID(),
    invocation,
    requestedCapabilities: [],
    minimumEnforcement: [],
    outputPolicy: {
      persist: options.stdoutPath !== undefined || options.stderrPath !== undefined,
      stdoutTailBytes: options.maxStdoutTailBytes ?? 64 * 1024,
      stderrTailBytes: options.maxStderrTailBytes ?? 64 * 1024,
    },
  };
}
