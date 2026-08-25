import { describe, expect, test } from 'bun:test';

import {
  buildChatPipelineIntentCandidates,
  buildChatPipelineIntentClassificationPrompt,
  resolveStructuredChatPipelineIntent,
  type ChatPipelineIntentCandidate,
} from '../src/utils/chat-pipeline-intent-classifier';

const candidates: ChatPipelineIntentCandidate[] = [
  {
    id: 'pipeline-1',
    path: 'C:/repo/.tagma/current/current.yaml',
    pipelineName: 'Untitled Pipeline',
    currentCanvas: true,
    sessionOwned: false,
    manualNewDraft: true,
  },
  {
    id: 'pipeline-2',
    path: 'C:/repo/.tagma/orders/orders.yaml',
    pipelineName: 'Orders',
    currentCanvas: false,
    sessionOwned: true,
    manualNewDraft: false,
  },
];

describe('Chat pipeline semantic intent classification', () => {
  test('marks canvas and session targets independently without using paths as model ids', () => {
    const built = buildChatPipelineIntentCandidates(
      [
        { path: 'C:/repo/.tagma/orders/orders.yaml', pipelineName: 'Orders' },
        { path: 'C:/repo/.tagma/current/current.yaml', pipelineName: 'Untitled Pipeline' },
      ],
      {
        currentCanvasPath: 'c:\\repo\\.tagma\\current\\current.yaml',
        sessionOwnedPath: 'C:/repo/.tagma/orders/orders.yaml',
        manualNewDraftPath: 'C:/repo/.tagma/current/current.yaml',
      },
    );

    expect(built.map((candidate) => candidate.id)).toEqual(['pipeline-1', 'pipeline-2']);
    expect(built.find((candidate) => candidate.pipelineName === 'Untitled Pipeline')).toMatchObject(
      {
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: true,
      },
    );
    expect(built.find((candidate) => candidate.pipelineName === 'Orders')).toMatchObject({
      currentCanvas: false,
      sessionOwned: true,
      manualNewDraft: false,
    });
    expect(built.every((candidate) => !candidate.id.includes(candidate.path))).toBe(true);
  });

  test('keeps an empty inventory schema valid without inventing an editable target', () => {
    const prompt = buildChatPipelineIntentClassificationPrompt('create something new', []);
    const targetSchema = (prompt.schema.properties as Record<string, unknown>)
      .targetCandidateId as Record<string, unknown>;
    const candidateSchema = (prompt.schema.properties as Record<string, unknown>)
      .candidateIds as Record<string, unknown>;

    expect(targetSchema).toEqual({ type: 'null' });
    expect(candidateSchema).toMatchObject({ type: 'array', maxItems: 0 });
    expect(JSON.stringify(prompt.schema)).not.toContain('"enum":[]');
    expect(
      resolveStructuredChatPipelineIntent({ kind: 'create', targetCandidateId: null }, []),
    ).toEqual({
      kind: 'create',
    });
  });

  test('binds an edit only through a Host-issued candidate id', () => {
    const prompt = buildChatPipelineIntentClassificationPrompt(
      '继续修改刚才会话里的订单管线',
      candidates,
    );

    expect(prompt.schema).toMatchObject({ type: 'object' });
    expect(prompt.schema.required as string[]).toContain('kind');
    expect(prompt.schema.required as string[]).toContain('targetCandidateId');
    expect(JSON.stringify(prompt.schema)).toContain('pipeline-1');
    expect(JSON.stringify(prompt.schema)).toContain('pipeline-2');
    expect(prompt.user).toContain('session-owned="true"');
    expect(prompt.user).toContain('current-canvas="true"');

    expect(
      resolveStructuredChatPipelineIntent(
        { kind: 'edit', targetCandidateId: 'pipeline-2' },
        candidates,
      ),
    ).toEqual({
      kind: 'edit',
      target: candidates[1],
    });

    expect(() =>
      resolveStructuredChatPipelineIntent(
        { kind: 'edit', targetCandidateId: 'C:/repo/.tagma/orders/orders.yaml' },
        candidates,
      ),
    ).toThrow('unknown Host pipeline candidate');
  });
});
