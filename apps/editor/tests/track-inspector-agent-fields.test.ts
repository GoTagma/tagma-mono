import { describe, expect, test } from 'bun:test';
import type { RawTrackConfig } from '../src/api/client';
import { shouldShowTrackAgentFields } from '../src/utils/track-inspector';

function makeTrack(
  tasks: Array<{ id: string; prompt?: string; command?: string }>,
): RawTrackConfig {
  return {
    id: 't',
    name: 'T',
    tasks: tasks as RawTrackConfig['tasks'],
  } as RawTrackConfig;
}

describe('shouldShowTrackAgentFields', () => {
  test('debug view: shows agent fields regardless of task kinds', () => {
    expect(shouldShowTrackAgentFields('debug', makeTrack([]))).toBe(true);
    expect(shouldShowTrackAgentFields('debug', makeTrack([{ id: 'a', command: 'ls' }]))).toBe(true);
    expect(shouldShowTrackAgentFields('debug', makeTrack([{ id: 'a', prompt: 'hi' }]))).toBe(true);
  });

  test('production view + empty track: hides agent fields', () => {
    expect(shouldShowTrackAgentFields('production', makeTrack([]))).toBe(false);
  });

  test('production view + only command tasks: hides agent fields', () => {
    expect(
      shouldShowTrackAgentFields(
        'production',
        makeTrack([
          { id: 'a', command: 'ls' },
          { id: 'b', command: 'pwd' },
        ]),
      ),
    ).toBe(false);
  });

  test('production view + at least one prompt task: shows agent fields', () => {
    expect(
      shouldShowTrackAgentFields(
        'production',
        makeTrack([
          { id: 'a', command: 'ls' },
          { id: 'b', prompt: 'summarize' },
        ]),
      ),
    ).toBe(true);
  });

  test('production view + all prompt tasks: shows agent fields', () => {
    expect(
      shouldShowTrackAgentFields('production', makeTrack([{ id: 'a', prompt: 'do thing' }])),
    ).toBe(true);
  });
});
