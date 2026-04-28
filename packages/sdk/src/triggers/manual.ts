import {
  TriggerBlockedError,
  TriggerTimeoutError,
  linkAbort,
  type TriggerPlugin,
  type TriggerContext,
  type TriggerWatchHandle,
} from '@tagma/types';
import { parseOptionalPluginTimeout } from '../duration';

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

  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle {
    if (ctx.signal.aborted) {
      throw new Error('Pipeline aborted');
    }

    const message =
      (config.message as string | undefined) ??
      `Manual confirmation required for task "${ctx.taskId}"`;
    const timeoutMs = parseOptionalPluginTimeout(config.timeout, 0);
    const metadata =
      config.metadata && typeof config.metadata === 'object'
        ? (config.metadata as Record<string, unknown>)
        : undefined;

    const request = ctx.approvalGateway.request({
      taskId: ctx.taskId,
      trackId: ctx.trackId,
      message,
      timeoutMs,
      metadata,
    });

    let removeAbortListener = () => {
      /* no-op until installed */
    };
    const fired = (async () => {
      removeAbortListener = linkAbort(ctx.signal, () => request.abort('Pipeline aborted'));
      try {
        const decision = await request.decision;
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
      } finally {
        removeAbortListener();
      }
    })();

    return {
      fired,
      dispose(reason = 'manual trigger disposed') {
        removeAbortListener();
        request.abort(reason);
      },
    };
  },
};
