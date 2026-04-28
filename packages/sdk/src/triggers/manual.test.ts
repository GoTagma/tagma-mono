import { describe, expect, test } from 'bun:test';
import { ManualTrigger } from './manual';
import type {
  ApprovalDecision,
  ApprovalGateway,
  ApprovalListener,
  ApprovalRequest,
  ApprovalRequestHandle,
  TriggerContext,
} from '@tagma/types';

function makeGateway(): ApprovalGateway & { readonly requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    request(req: Omit<ApprovalRequest, 'id' | 'createdAt'>): ApprovalRequestHandle {
      const request = {
        ...req,
        id: `approval-${requests.length + 1}`,
        createdAt: '2026-04-28T00:00:00.000Z',
      };
      requests.push(request);
      const decision = new Promise<ApprovalDecision>(() => {
        /* intentionally pending */
      });
      return {
        request,
        decision,
        abort() {
          /* no resources */
        },
      };
    },
    resolve() {
      return false;
    },
    pending() {
      return requests;
    },
    subscribe(_listener: ApprovalListener) {
      return () => {
        /* no resources */
      };
    },
    abortAll() {
      /* no resources */
    },
  };
}

function triggerContext(signal: AbortSignal, approvalGateway = makeGateway()): TriggerContext {
  return {
    taskId: 't.manual',
    trackId: 't',
    workDir: process.cwd(),
    signal,
    approvalGateway,
    runtime: {} as TriggerContext['runtime'],
  };
}

describe('ManualTrigger', () => {
  test('does not enqueue approval when the pipeline is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const gateway = makeGateway();

    expect(() => ManualTrigger.watch({}, triggerContext(controller.signal, gateway))).toThrow(
      /Pipeline aborted/,
    );
    expect(gateway.requests).toHaveLength(0);
  });
});
