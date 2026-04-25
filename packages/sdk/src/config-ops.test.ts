import { describe, expect, test } from 'bun:test';
import { transferTask } from './config-ops';
import type { RawPipelineConfig } from './types';

describe('transferTask', () => {
  test('does not remove the source task when the target track is missing', () => {
    const config: RawPipelineConfig = {
      name: 'Transfer',
      tracks: [
        {
          id: 'a',
          name: 'A',
          tasks: [{ id: 'move_me', command: 'echo a' }],
        },
      ],
    };

    const next = transferTask(config, 'a', 'move_me', 'missing');

    expect(next).toEqual(config);
  });

  test('qualifies moved task same-track dependencies so they keep pointing at the old track', () => {
    const config: RawPipelineConfig = {
      name: 'Transfer',
      tracks: [
        {
          id: 'a',
          name: 'A',
          tasks: [
            { id: 'build', command: 'echo old' },
            { id: 'move_me', command: 'echo move', depends_on: ['build'] },
          ],
        },
        {
          id: 'b',
          name: 'B',
          tasks: [{ id: 'build', command: 'echo new' }],
        },
      ],
    };

    const next = transferTask(config, 'a', 'move_me', 'b');
    const moved = next.tracks[1].tasks.find((task) => task.id === 'move_me');

    expect(moved?.depends_on).toEqual(['a.build']);
  });

  test('does not overwrite an existing task in the target track with the same id', () => {
    const config: RawPipelineConfig = {
      name: 'Transfer',
      tracks: [
        {
          id: 'a',
          name: 'A',
          tasks: [{ id: 'same', command: 'echo source' }],
        },
        {
          id: 'b',
          name: 'B',
          tasks: [{ id: 'same', command: 'echo target' }],
        },
      ],
    };

    const next = transferTask(config, 'a', 'same', 'b');

    expect(next).toEqual(config);
  });
});
