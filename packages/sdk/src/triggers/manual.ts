import type { TriggerPlugin, TriggerContext } from '../types';
import { parseDuration, TriggerBlockedError, TriggerTimeoutError } from '@tagma/core';

export const ManualTrigger: TriggerPlugin = {
  name: 'manual',
  schema: {
    description: 'Pause the task until a user approves via the approval gateway.',
    fields: {
      message: {
        type: 'string',
        description: 'Prompt shown to the approver. Defaults to a generic message if empty.',
        placeholder: 'Confirm deployment to production?',
      },
      timeout: {
        type: 'duration',
        description: 'Maximum wait time (e.g. 10m). Omit or 0 to wait indefinitely.',
        placeholder: '10m',
      },
    },
  },

  async watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown> {
    const message =
      (config.message as string | undefined) ??
      `Manual confirmation required for task "${ctx.taskId}"`;
    const timeoutMs = config.timeout ? parseDuration(config.timeout as string) : 0;
    const metadata =
      config.metadata && typeof config.metadata === 'object'
        ? (config.metadata as Record<string, unknown>)
        : undefined;

    const decisionPromise = ctx.approvalGateway.request({
      taskId: ctx.taskId,
      trackId: ctx.trackId,
      message,
      timeoutMs,
      metadata,
    });

    // Wire AbortSignal → try to resolve this specific request as aborted.
    // We can't directly cancel via the gateway (no id yet at .request() call site),
    // so instead we race against an abort promise and let engine status logic
    // fall back to pipelineAborted → skipped. abortAll() on gateway still runs
    // from engine shutdown path to clean up any truly-pending entries.
    const onAbort = () => {};
    const abortPromise = new Promise<never>((_, reject) => {
      if (ctx.signal.aborted) {
        reject(new Error('Pipeline aborted'));
        return;
      }
      const handler = () => reject(new Error('Pipeline aborted'));
      // Store reference so we can remove it after the race settles.
      (onAbort as { handler?: () => void }).handler = handler;
      ctx.signal.addEventListener('abort', handler, { once: true });
    });

    let decision: Awaited<typeof decisionPromise>;
    try {
      decision = await Promise.race([decisionPromise, abortPromise]);
    } finally {
      // Clean up the abort listener to prevent leaking on normal completion.
      const handler = (onAbort as { handler?: () => void }).handler;
      if (handler) ctx.signal.removeEventListener('abort', handler);
    }

    switch (decision.outcome) {
      case 'approved':
        return { confirmed: true, approvalId: decision.approvalId, actor: decision.actor };
      case 'rejected':
        // A7: Use typed error for proper classification in the engine.
        throw new TriggerBlockedError(
          `Manual trigger rejected by ${decision.actor ?? 'user'}` +
            (decision.reason ? `: ${decision.reason}` : ''),
        );
      case 'timeout':
        throw new TriggerTimeoutError(
          `Manual trigger timeout: ${decision.reason ?? 'no decision made'}`,
        );
      case 'aborted':
        throw new TriggerBlockedError(
          `Manual trigger aborted: ${decision.reason ?? 'pipeline aborted'}`,
        );
    }
  },
};
