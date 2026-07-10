import { describe, expect, test } from 'bun:test';
import { removeTask, removeTrack, transferTask } from './config-ops';
import type { RawPipelineConfig } from '@tagma/types';

function bindingsWithProto<T extends Record<string, unknown>>(entries: T): T {
  Object.defineProperty(entries, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { value: 'keep-me', type: 'string' },
    writable: true,
  });
  return entries;
}

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
            { id: 'build', command: 'echo old', outputs: { city: { type: 'string' } } },
            {
              id: 'move_me',
              command: 'echo {{inputs.city}} {{inputs.raw}}',
              depends_on: ['build'],
              inputs: {
                city: { from: 'build.outputs.city', type: 'string', required: true },
                raw: { from: 'build.stdout' },
                matched: { from: 'outputs.city' },
              },
            },
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
    expect(moved?.inputs?.city?.from).toBe('a.build.outputs.city');
    expect(moved?.inputs?.raw?.from).toBe('a.build.stdout');
    expect(moved?.inputs?.matched?.from).toBe('outputs.city');
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

  test('qualifies downstream input bindings that reference the moved task', () => {
    const config: RawPipelineConfig = {
      name: 'Transfer',
      tracks: [
        {
          id: 'a',
          name: 'A',
          tasks: [
            { id: 'move_me', command: 'echo move', outputs: { result: { type: 'string' } } },
            {
              id: 'consumer',
              command: 'echo {{inputs.result}} {{inputs.code}}',
              depends_on: ['move_me'],
              inputs: bindingsWithProto({
                result: { from: 'move_me.outputs.result', type: 'string' },
                code: { from: 'move_me.exitCode', type: 'number' },
              }),
            },
          ],
        },
        { id: 'b', name: 'B', tasks: [] },
      ],
    };

    const next = transferTask(config, 'a', 'move_me', 'b');
    const consumer = next.tracks[0].tasks.find((task) => task.id === 'consumer');

    expect(consumer?.depends_on).toEqual(['b.move_me']);
    expect(consumer?.inputs?.result?.from).toBe('b.move_me.outputs.result');
    expect(consumer?.inputs?.code?.from).toBe('b.move_me.exitCode');
    expect(Object.prototype.hasOwnProperty.call(consumer?.inputs, '__proto__')).toBe(true);
    expect(consumer?.inputs?.['__proto__']).toEqual({ value: 'keep-me', type: 'string' });
  });
});

describe('removeTrack', () => {
  test('cleanRefs removes references to tasks deleted with the track', () => {
    const config: RawPipelineConfig = {
      name: 'Remove Track',
      tracks: [
        {
          id: 'old',
          name: 'Old',
          tasks: [
            { id: 'produce', command: 'echo city', outputs: { city: { type: 'string' } } },
            { id: 'review', prompt: 'review' },
          ],
        },
        {
          id: 'main',
          name: 'Main',
          tasks: [
            { id: 'produce', command: 'echo local' },
            {
              id: 'consume',
              command: 'echo {{inputs.city}} {{inputs.raw}} {{inputs.local}}',
              depends_on: ['old.produce', 'review', 'produce'],
              continue_from: 'old.review',
              inputs: {
                city: { from: 'old.produce.outputs.city', type: 'string', required: true },
                raw: { from: 'review.stdout' },
                local: { from: 'produce.stdout' },
                matched: { from: 'outputs.city' },
              },
            },
          ],
        },
      ],
    };

    const next = removeTrack(config, 'old', true);
    const consume = next.tracks[0].tasks.find((task) => task.id === 'consume');

    expect(next.tracks.map((track) => track.id)).toEqual(['main']);
    expect(consume?.depends_on).toEqual(['produce']);
    expect(consume?.continue_from).toBeUndefined();
    expect(consume?.inputs?.city).toEqual({ type: 'string', required: true });
    expect(consume?.inputs?.raw).toEqual({});
    expect(consume?.inputs?.local?.from).toBe('produce.stdout');
    expect(consume?.inputs?.matched?.from).toBe('outputs.city');
  });
});

describe('removeTask', () => {
  test('cleanRefs removes stale input binding sources for the deleted task', () => {
    const config: RawPipelineConfig = {
      name: 'Remove',
      tracks: [
        {
          id: 'a',
          name: 'A',
          tasks: [
            { id: 'produce', command: 'echo produce', outputs: { city: { type: 'string' } } },
            {
              id: 'consume',
              command: 'echo {{inputs.city}} {{inputs.raw}}',
              depends_on: ['produce'],
              inputs: bindingsWithProto({
                city: {
                  from: 'produce.outputs.city',
                  type: 'string',
                  required: true,
                  description: 'City name',
                },
                raw: { from: 'produce.stdout' },
                matched: { from: 'outputs.city' },
              }),
            },
          ],
        },
      ],
    };

    const next = removeTask(config, 'a', 'produce', true);
    const consume = next.tracks[0].tasks.find((task) => task.id === 'consume');

    expect(consume?.depends_on).toBeUndefined();
    expect(consume?.inputs?.city).toEqual({
      type: 'string',
      required: true,
      description: 'City name',
    });
    expect(consume?.inputs?.raw).toEqual({});
    expect(consume?.inputs?.matched?.from).toBe('outputs.city');
    expect(Object.prototype.hasOwnProperty.call(consume?.inputs, '__proto__')).toBe(true);
    expect(consume?.inputs?.['__proto__']).toEqual({ value: 'keep-me', type: 'string' });
  });
});
