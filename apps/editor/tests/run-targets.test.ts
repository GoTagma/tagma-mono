import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig } from '../src/api/client';
import { buildStartRunRequestBody } from '../src/api/client';
import { normalizeRunTargetTaskIds } from '../server/routes/run';

const config: RawPipelineConfig = {
  name: 'P',
  tracks: [
    {
      id: 'main',
      name: 'Main',
      tasks: [
        { id: 'prepare', name: 'Prepare', command: 'prepare' },
        { id: 'test', name: 'Test', command: 'test', depends_on: ['prepare'] },
      ],
    },
    {
      id: 'ship',
      name: 'Ship',
      tasks: [{ id: 'deploy', name: 'Deploy', command: 'deploy' }],
    },
  ],
};

describe('run target task ids', () => {
  test('client includes selected target task ids and config snapshot in the run start body', () => {
    expect(
      buildStartRunRequestBody({
        yamlPath: 'C:/repo/.tagma/p/chat-created.yaml',
        targetTaskIds: ['main.test', 'ship.deploy'],
        skipPreflight: true,
        configSnapshot: config,
      }),
    ).toEqual({
      yamlPath: 'C:/repo/.tagma/p/chat-created.yaml',
      targetTaskIds: ['main.test', 'ship.deploy'],
      skipPreflight: true,
      configSnapshot: config,
    });
  });

  test('client omits the request body when no run options are set', () => {
    expect(buildStartRunRequestBody()).toBeUndefined();
    expect(buildStartRunRequestBody({ targetTaskIds: [] })).toBeUndefined();
  });

  test('server accepts and dedupes valid qualified target task ids', () => {
    expect(normalizeRunTargetTaskIds(['main.test', 'ship.deploy', 'main.test'], config)).toEqual([
      'main.test',
      'ship.deploy',
    ]);
  });

  test('server rejects empty, malformed, or unknown target task ids', () => {
    expect(() => normalizeRunTargetTaskIds([], config)).toThrow(/at least one/);
    expect(() => normalizeRunTargetTaskIds(['test'], config)).toThrow(/qualified task id/);
    expect(() => normalizeRunTargetTaskIds(['main.missing'], config)).toThrow(/not found/);
  });
});
