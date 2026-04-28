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
});
