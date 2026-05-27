import { describe, expect, test } from 'bun:test';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { importRawYamlIntoWorkspace } from '../server/raw-import';
import type { WorkspaceState } from '../server/workspace-state';

function workspace(): WorkspaceState {
  const calls = { yaml: 0, layout: 0 };
  return {
    config: createEmptyPipeline('Old'),
    yamlPath: 'C:/w/.tagma/old.yaml',
    layout: { positions: { 'old.task': { x: 120 } } },
    watcher: { stopWatching: () => void calls.yaml++ },
    layoutWatcher: { stopWatching: () => void calls.layout++ },
    __calls: calls,
  } as unknown as WorkspaceState;
}

describe('raw YAML import state reset', () => {
  test('raw import becomes an unsaved pipeline and drops stale layout/watchers', () => {
    const ws = workspace();

    importRawYamlIntoWorkspace(
      ws,
      [
        'pipeline:',
        '  name: Imported',
        '  tracks:',
        '    - id: main',
        '      name: Main',
        '      tasks:',
        '        - id: start',
        '          command: echo ok',
        '',
      ].join('\n'),
    );

    expect(ws.config.name).toBe('Imported');
    expect(ws.yamlPath).toBeNull();
    expect(ws.layout).toEqual({ positions: {} });
    expect((ws as unknown as { __calls: { yaml: number; layout: number } }).__calls).toEqual({
      yaml: 1,
      layout: 1,
    });
  });
});
