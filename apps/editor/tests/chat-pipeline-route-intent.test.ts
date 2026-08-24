import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OpencodeThreadEntry } from '../src/api/opencode-chat';
import { resolveChatPipelineRouteIntent } from '../src/utils/chat-pipeline-route-intent';

function assistant(parts: unknown[]): OpencodeThreadEntry {
  return {
    info: { id: 'assistant-1', sessionID: 'session-1', role: 'assistant' },
    parts,
  } as OpencodeThreadEntry;
}

describe('Chat pipeline router intent', () => {
  test('requires the route marker at stage start and forwards it to Host compile', () => {
    const storeSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'store', 'chat-store.ts'),
      'utf-8',
    );
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(storeSource).toMatch(
      /api\.startChatYamlStage\([\s\S]*?requestedAction,\s*requestedAction === null,?\s*\)/,
    );
    expect(appSource).toContain(
      'resolveChatPipelineRouteIntent(finishedSessionMessages, snapshot.staging.id)',
    );
    expect(appSource).toMatch(
      /api\.compileChatYamlStage\([\s\S]*?snapshot\.workDir,\s*routeIntent \?\? undefined,?\s*\)/,
    );
  });

  test('reads an exact stage-bound create marker from a pipeline subtask', () => {
    expect(
      resolveChatPipelineRouteIntent(
        [
          assistant([
            {
              id: 'subtask-1',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'subtask',
              agent: 'tagma-pipeline',
              description: 'Create pipeline',
              prompt: 'TAGMA_ROUTE_MODE: stage-123 create\nCreate the requested sibling.',
            },
          ]),
        ],
        'stage-123',
      ),
    ).toBe('create');
  });

  test('reads the marker from task-tool input and ignores another stage', () => {
    expect(
      resolveChatPipelineRouteIntent(
        [
          assistant([
            {
              id: 'tool-old',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'tool',
              tool: 'task',
              state: {
                status: 'completed',
                input: {
                  subagent_type: 'tagma-pipeline',
                  prompt: 'TAGMA_ROUTE_MODE: prior-stage create\nOld turn.',
                },
              },
            },
            {
              id: 'tool-current',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'tool',
              tool: 'task',
              state: {
                status: 'completed',
                input: {
                  subagent_type: 'tagma-pipeline',
                  prompt: 'TAGMA_ROUTE_MODE: stage-123 edit\nEdit the current pipeline.',
                },
              },
            },
          ]),
        ],
        'stage-123',
      ),
    ).toBe('edit');
  });

  test('fails closed on missing, malformed, or conflicting matching markers', () => {
    expect(resolveChatPipelineRouteIntent([], 'stage-123')).toBeNull();
    for (const prompt of [
      'TAGMA_ROUTE_MODE: stage-123 overwrite',
      'Explain first.\nTAGMA_ROUTE_MODE: stage-123 create',
      'TAGMA_ROUTE_MODE: stage-123 edit ',
      'TAGMA_ROUTE_MODE: stage-123\tedit',
    ]) {
      expect(
        resolveChatPipelineRouteIntent(
          [assistant([{ type: 'subtask', agent: 'tagma-pipeline', prompt }])],
          'stage-123',
        ),
      ).toBeNull();
    }
    for (const secondPrompt of [
      'TAGMA_ROUTE_MODE: stage-123 edit',
      'TAGMA_ROUTE_MODE: stage-123 overwrite',
    ]) {
      expect(
        resolveChatPipelineRouteIntent(
          [
            assistant([
              {
                type: 'subtask',
                agent: 'tagma-pipeline',
                prompt: 'TAGMA_ROUTE_MODE: stage-123 create',
              },
              { type: 'subtask', agent: 'tagma-pipeline', prompt: secondPrompt },
            ]),
          ],
          'stage-123',
        ),
      ).toBeNull();
    }
  });
});
