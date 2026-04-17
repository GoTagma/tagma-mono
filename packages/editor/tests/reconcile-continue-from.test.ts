import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig } from '@tagma/sdk';
import { reconcileContinueFrom } from '../server/state.js';

function pipeline(
  tracks: readonly {
    id: string;
    tasks: readonly {
      id: string;
      prompt?: string;
      command?: string;
      depends_on?: readonly string[];
      continue_from?: string;
    }[];
  }[],
): RawPipelineConfig {
  return {
    name: 'T',
    tracks: tracks.map((t) => ({
      id: t.id,
      name: t.id,
      tasks: t.tasks.map((k) => ({ name: k.id, ...k })),
    })),
  };
}

describe('reconcileContinueFrom', () => {
  test('preserves continue_from when depends_on uses bare ref and continue_from is qualified', () => {
    // Regression for bug #8: the previous pure-string comparison dropped
    // `continue_from: "alpha.upstream"` when depends_on was the bare form.
    // The two refs resolve to the same qid and must be treated as equal.
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'upstream', prompt: 'p' },
          {
            id: 'follower',
            prompt: 'p',
            depends_on: ['upstream'],
            continue_from: 'alpha.upstream',
          },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[1]?.continue_from).toBe('alpha.upstream');
  });

  test('preserves continue_from when depends_on is qualified and continue_from is bare', () => {
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'upstream', prompt: 'p' },
          {
            id: 'follower',
            prompt: 'p',
            depends_on: ['alpha.upstream'],
            continue_from: 'upstream',
          },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[1]?.continue_from).toBe('upstream');
  });

  test('still drops continue_from that points at a non-upstream task', () => {
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'a', prompt: 'p' },
          { id: 'b', prompt: 'p' },
          {
            id: 'c',
            prompt: 'p',
            depends_on: ['a'],
            // `b` is not in depends_on → dangling
            continue_from: 'b',
          },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[2]?.continue_from).toBeUndefined();
  });

  test('drops continue_from on command-only tasks', () => {
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'a', prompt: 'p' },
          {
            id: 'c',
            command: 'echo hi',
            depends_on: ['a'],
            // command tasks cannot continue_from anything
            continue_from: 'a',
          },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[1]?.continue_from).toBeUndefined();
  });

  test('auto-fills continue_from when there is exactly one upstream prompt dep', () => {
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'a', prompt: 'p' },
          { id: 'c', prompt: 'p', depends_on: ['a'] },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[1]?.continue_from).toBe('a');
  });

  test('does NOT auto-fill when multiple prompt deps exist', () => {
    const cfg = pipeline([
      {
        id: 'alpha',
        tasks: [
          { id: 'a', prompt: 'p' },
          { id: 'b', prompt: 'p' },
          { id: 'c', prompt: 'p', depends_on: ['a', 'b'] },
        ],
      },
    ]);
    const out = reconcileContinueFrom(cfg);
    expect(out.tracks[0].tasks[2]?.continue_from).toBeUndefined();
  });
});
