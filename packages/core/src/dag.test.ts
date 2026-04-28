import { describe, expect, test } from 'bun:test';
import { buildRawDag } from './dag';
import type { RawPipelineConfig } from './types';

describe('buildRawDag', () => {
  test('duplicate raw task ids do not overwrite the first node dependencies', () => {
    const first = { id: 'dup', command: 'echo first' };
    const duplicate = { id: 'dup', command: 'echo duplicate', depends_on: ['root'] };
    const config: RawPipelineConfig = {
      name: 'raw-duplicate',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'root', command: 'echo root' }, first, duplicate],
        },
      ],
    };

    const dag = buildRawDag(config);
    const node = dag.nodes.get('t.dup');

    expect(node?.rawTask).toBe(first);
    expect(node?.dependsOn).toEqual([]);
    expect(dag.edges).not.toContainEqual({ from: 't.root', to: 't.dup' });
  });

  test('malformed raw ids and dependency refs are ignored instead of crashing', () => {
    const config = {
      name: 'malformed-raw',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            { id: 'root', command: 'echo root' },
            { id: 5, command: 'echo bad' },
            { id: 'child', command: 'echo child', depends_on: ['root', 7], continue_from: 8 },
          ],
        },
        { id: 9, name: 'Bad', tasks: [{ id: 'ignored', command: 'echo ignored' }] },
      ],
    } as unknown as RawPipelineConfig;

    const dag = buildRawDag(config);

    expect([...dag.nodes.keys()].sort()).toEqual(['t.child', 't.root']);
    expect(dag.nodes.get('t.child')?.dependsOn).toEqual(['t.root']);
    expect(dag.edges).toEqual([{ from: 't.root', to: 't.child' }]);
  });
});
