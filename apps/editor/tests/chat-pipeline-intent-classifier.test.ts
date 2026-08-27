import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

import * as sharedIntentClassifier from '../shared/chat-pipeline-intent-classifier.js';
import * as compatibilityIntentClassifier from '../src/utils/chat-pipeline-intent-classifier';
import type { ChatPipelineIntentCandidate } from '../shared/chat-pipeline-intent-classifier.js';

const {
  buildChatPipelineIntentCandidates,
  buildChatPipelineIntentClassificationPrompt,
  resolveStructuredChatPipelineIntent,
} = sharedIntentClassifier;

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
  test('shares one sidecar-safe implementation through the renderer compatibility facade', () => {
    expect(Object.keys(compatibilityIntentClassifier).sort()).toEqual(
      Object.keys(sharedIntentClassifier).sort(),
    );
    expect(compatibilityIntentClassifier.buildChatPipelineIntentCandidates).toBe(
      sharedIntentClassifier.buildChatPipelineIntentCandidates,
    );
    expect(compatibilityIntentClassifier.buildChatPipelineIntentClassificationPrompt).toBe(
      sharedIntentClassifier.buildChatPipelineIntentClassificationPrompt,
    );
    expect(compatibilityIntentClassifier.resolveStructuredChatPipelineIntent).toBe(
      sharedIntentClassifier.resolveStructuredChatPipelineIntent,
    );

    const sharedSource = readFileSync(
      new URL('../shared/chat-pipeline-intent-classifier.ts', import.meta.url),
      'utf8',
    );
    const compatibilitySource = readFileSync(
      new URL('../src/utils/chat-pipeline-intent-classifier.ts', import.meta.url),
      'utf8',
    );
    const sharedImports = [...sharedSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );

    expect(sharedImports).toEqual(['./filesystem-paths.js']);
    expect(sharedSource).not.toMatch(
      /\b(?:window|document|navigator|localStorage|sessionStorage)\b/,
    );
    expect(compatibilitySource.trim()).toBe(
      "export * from '../../shared/chat-pipeline-intent-classifier.js';",
    );
  });

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

  test('deduplicates Windows aliases without folding POSIX path casing', () => {
    const built = buildChatPipelineIntentCandidates(
      [
        { path: 'C:\\Repo\\.tagma\\Orders\\Orders.yaml', pipelineName: 'Windows original' },
        { path: 'c:/repo/.tagma/orders/orders.yaml', pipelineName: 'Windows alias' },
        { path: '/repo/.tagma/Orders/Orders.yaml', pipelineName: 'POSIX upper' },
        { path: '/repo/.tagma/orders/orders.yaml', pipelineName: 'POSIX lower' },
      ],
      {},
    );

    expect(built).toHaveLength(3);
    expect(built.filter((candidate) => /^[A-Za-z]:[\\/]/.test(candidate.path))).toEqual([
      expect.objectContaining({
        path: 'C:\\Repo\\.tagma\\Orders\\Orders.yaml',
        pipelineName: 'Windows original',
      }),
    ]);
    expect(built.map((candidate) => candidate.path)).toContain('/repo/.tagma/Orders/Orders.yaml');
    expect(built.map((candidate) => candidate.path)).toContain('/repo/.tagma/orders/orders.yaml');
    expect(built.map((candidate) => candidate.id).sort()).toEqual([
      'pipeline-1',
      'pipeline-2',
      'pipeline-3',
    ]);
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

    expect(prompt.schema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'targetCandidateId', 'clarification', 'candidateIds'],
      properties: {
        kind: {
          type: 'string',
          enum: ['discussion', 'diagnosis', 'create', 'edit', 'clarify'],
        },
        targetCandidateId: {
          anyOf: [{ type: 'string', enum: ['pipeline-1', 'pipeline-2'] }, { type: 'null' }],
        },
        clarification: {
          anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }],
        },
        candidateIds: {
          type: 'array',
          uniqueItems: true,
          maxItems: 2,
          items: { type: 'string', enum: ['pipeline-1', 'pipeline-2'] },
        },
      },
    });
    expect(prompt.user).toContain('session-owned="true"');
    expect(prompt.user).toContain('current-canvas="true"');
    expect(prompt.user).toContain('<name>Orders</name>');
    expect(prompt.user).toContain('<path>C:/repo/.tagma/orders/orders.yaml</path>');
    expect(JSON.stringify(prompt.schema)).not.toContain('Orders');
    expect(JSON.stringify(prompt.schema)).not.toContain('C:/repo/.tagma/orders/orders.yaml');

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

  test('resolves every intent kind with the existing strict target semantics', () => {
    expect(
      resolveStructuredChatPipelineIntent(
        { kind: 'discussion', targetCandidateId: null },
        candidates,
      ),
    ).toEqual({ kind: 'discussion' });
    expect(
      resolveStructuredChatPipelineIntent(
        { kind: 'diagnosis', targetCandidateId: null },
        candidates,
      ),
    ).toEqual({ kind: 'diagnosis', target: null });
    expect(
      resolveStructuredChatPipelineIntent(
        { kind: 'diagnosis', targetCandidateId: 'pipeline-1' },
        candidates,
      ),
    ).toEqual({ kind: 'diagnosis', target: candidates[0] });
    expect(
      resolveStructuredChatPipelineIntent({ kind: 'create', targetCandidateId: null }, candidates),
    ).toEqual({ kind: 'create' });
    expect(
      resolveStructuredChatPipelineIntent(
        { kind: 'edit', targetCandidateId: 'pipeline-2' },
        candidates,
      ),
    ).toEqual({ kind: 'edit', target: candidates[1] });
    expect(
      resolveStructuredChatPipelineIntent(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: '  Which pipeline should I change?  ',
          candidateIds: ['pipeline-2', 'pipeline-1'],
        },
        candidates,
      ),
    ).toEqual({
      kind: 'clarify',
      question: 'Which pipeline should I change?',
      candidates: [candidates[1], candidates[0]],
    });

    expect(() =>
      resolveStructuredChatPipelineIntent(
        { kind: 'discussion', targetCandidateId: 'pipeline-1' },
        candidates,
      ),
    ).toThrow('discussion classification cannot select');
    expect(() =>
      resolveStructuredChatPipelineIntent(
        { kind: 'create', targetCandidateId: 'pipeline-1' },
        candidates,
      ),
    ).toThrow('create classification cannot reuse');
    expect(() =>
      resolveStructuredChatPipelineIntent({ kind: 'edit', targetCandidateId: null }, candidates),
    ).toThrow('edit classification requires one Host pipeline candidate');
    expect(() =>
      resolveStructuredChatPipelineIntent(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: '   ',
          candidateIds: ['pipeline-1'],
        },
        candidates,
      ),
    ).toThrow('requires a clarification question');
  });
});
