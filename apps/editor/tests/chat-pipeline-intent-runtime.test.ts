import { describe, expect, test } from 'bun:test';

import type { ChatPipelineIntentCandidate } from '../src/utils/chat-pipeline-intent-classifier';
import {
  classifyChatPipelineIntentWithModel,
  type ChatPipelineIntentModelGateway,
} from '../src/utils/chat-pipeline-intent-runtime';

const candidates: ChatPipelineIntentCandidate[] = [
  {
    id: 'pipeline-1',
    path: 'C:/repo/.tagma/orders/orders.yaml',
    pipelineName: 'Orders',
    currentCanvas: true,
    sessionOwned: false,
    manualNewDraft: false,
  },
];

describe('Chat pipeline intent model runtime', () => {
  test('uses an isolated structured classifier session and always deletes it', async () => {
    const calls: string[] = [];
    const gateway: ChatPipelineIntentModelGateway = {
      async createSession() {
        calls.push('create');
        return 'classifier-session';
      },
      async prompt(sessionId, request) {
        calls.push(`prompt:${sessionId}:${request.agent}`);
        expect(request.schema).toMatchObject({ type: 'object' });
        expect(request.user).toContain('修改订单管线');
        return { kind: 'edit', targetCandidateId: 'pipeline-1' };
      },
      async deleteSession(sessionId) {
        calls.push(`delete:${sessionId}`);
      },
    };

    await expect(
      classifyChatPipelineIntentWithModel(
        {
          userText: '修改订单管线',
          candidates,
          model: { providerID: 'deepseek', modelID: 'deepseek-chat' },
          variant: null,
        },
        gateway,
      ),
    ).resolves.toEqual({ kind: 'edit', target: candidates[0] });
    expect(calls).toEqual([
      'create',
      'prompt:classifier-session:tagma-pipeline-intent-classifier',
      'delete:classifier-session',
    ]);
  });
});
