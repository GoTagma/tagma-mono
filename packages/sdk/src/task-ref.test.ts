import { describe, expect, test } from 'bun:test';
import type { PipelineConfig, RawPipelineConfig } from './types';
import {
  TASK_ID_RE,
  isValidTaskId,
  qualifyTaskId,
  isQualifiedRef,
  buildTaskIndex,
  resolveTaskRef,
  AMBIGUOUS,
} from './task-ref';
import { buildDag, buildRawDag } from './dag';
import { validateRaw } from './validate-raw';

// ═══ Low-level helpers ═══

describe('isValidTaskId', () => {
  test('accepts letter-led ids with letters, digits, underscores, hyphens', () => {
    for (const id of ['a', 'A', '_', 'task_1', 'Task-2', '_private', 'a_b-c_1']) {
      expect(isValidTaskId(id)).toBe(true);
      expect(TASK_ID_RE.test(id)).toBe(true);
    }
  });

  test('rejects empty, digit-led, dot-bearing, and whitespace forms', () => {
    for (const id of ['', '1task', 'a.b', 'foo bar', '-leading', 'has/slash', 'dot.']) {
      expect(isValidTaskId(id)).toBe(false);
    }
  });

  test('rejects non-string values', () => {
    expect(isValidTaskId(null as unknown as string)).toBe(false);
    expect(isValidTaskId(undefined as unknown as string)).toBe(false);
    expect(isValidTaskId(42 as unknown as string)).toBe(false);
  });
});

describe('qualifyTaskId + isQualifiedRef', () => {
  test('qualifyTaskId joins with dot; isQualifiedRef detects dotted form', () => {
    expect(qualifyTaskId('alpha', 'review')).toBe('alpha.review');
    expect(isQualifiedRef('alpha.review')).toBe(true);
    expect(isQualifiedRef('review')).toBe(false);
  });
});

// ═══ Index build ═══

describe('buildTaskIndex', () => {
  test('collects all qualified ids and unique bare ids', () => {
    const cfg: RawPipelineConfig = {
      name: 'T',
      tracks: [
        { id: 'alpha', name: 'A', tasks: [{ id: 'plan', prompt: 'p' }] },
        { id: 'beta', name: 'B', tasks: [{ id: 'ship', prompt: 'p' }] },
      ],
    };
    const idx = buildTaskIndex(cfg);
    expect(idx.allQualified.has('alpha.plan')).toBe(true);
    expect(idx.allQualified.has('beta.ship')).toBe(true);
    expect(idx.bareToQualified.get('plan')).toBe('alpha.plan');
    expect(idx.bareToQualified.get('ship')).toBe('beta.ship');
  });

  test('marks bare ids shared across tracks as ambiguous', () => {
    const cfg: RawPipelineConfig = {
      name: 'T',
      tracks: [
        { id: 'alpha', name: 'A', tasks: [{ id: 'review', prompt: 'p' }] },
        { id: 'beta', name: 'B', tasks: [{ id: 'review', prompt: 'p' }] },
      ],
    };
    const idx = buildTaskIndex(cfg);
    expect(idx.bareToQualified.get('review')).toBe(AMBIGUOUS);
    expect(idx.allQualified.has('alpha.review')).toBe(true);
    expect(idx.allQualified.has('beta.review')).toBe(true);
  });

  test('tolerates tracks/tasks missing ids (editor in-progress state)', () => {
    const cfg = {
      name: 'T',
      tracks: [
        { id: '', name: 'half-typed', tasks: [{ id: 'x', prompt: 'p' }] },
        { id: 'ok', name: 'OK', tasks: [{ id: '', prompt: 'p' }, { id: 'y', prompt: 'p' }] },
      ],
    } as unknown as RawPipelineConfig;
    const idx = buildTaskIndex(cfg);
    expect(idx.allQualified.size).toBe(1);
    expect(idx.allQualified.has('ok.y')).toBe(true);
  });
});

// ═══ Ref resolution ═══

describe('resolveTaskRef', () => {
  const cfg: RawPipelineConfig = {
    name: 'T',
    tracks: [
      {
        id: 'alpha',
        name: 'A',
        tasks: [
          { id: 'plan', prompt: 'p' },
          { id: 'review', prompt: 'p' },
        ],
      },
      {
        id: 'beta',
        name: 'B',
        tasks: [
          { id: 'review', prompt: 'p' },
          { id: 'ship', prompt: 'p' },
        ],
      },
    ],
  };
  const idx = buildTaskIndex(cfg);

  test('fully qualified ref resolves when it exists', () => {
    expect(resolveTaskRef('alpha.plan', 'beta', idx)).toEqual({
      kind: 'resolved',
      qid: 'alpha.plan',
    });
  });

  test('fully qualified ref that does not exist is not_found', () => {
    expect(resolveTaskRef('alpha.ghost', 'beta', idx)).toEqual({
      kind: 'not_found',
      ref: 'alpha.ghost',
    });
  });

  test('bare ref prefers same-track shorthand', () => {
    // "review" exists in both tracks — from beta's perspective, the same-
    // track shadow must win over the cross-track ambiguous pool.
    expect(resolveTaskRef('review', 'beta', idx)).toEqual({
      kind: 'resolved',
      qid: 'beta.review',
    });
    expect(resolveTaskRef('review', 'alpha', idx)).toEqual({
      kind: 'resolved',
      qid: 'alpha.review',
    });
  });

  test('bare ref not in current track is ambiguous when multiple tracks have it', () => {
    const twoForeign: RawPipelineConfig = {
      name: 'T',
      tracks: [
        { id: 'a', name: 'A', tasks: [{ id: 'review', prompt: 'p' }] },
        { id: 'b', name: 'B', tasks: [{ id: 'review', prompt: 'p' }] },
        { id: 'c', name: 'C', tasks: [{ id: 'other', prompt: 'p' }] },
      ],
    };
    const idx2 = buildTaskIndex(twoForeign);
    expect(resolveTaskRef('review', 'c', idx2)).toEqual({ kind: 'ambiguous', ref: 'review' });
  });

  test('bare ref unique in the pool resolves cross-track', () => {
    expect(resolveTaskRef('ship', 'alpha', idx)).toEqual({
      kind: 'resolved',
      qid: 'beta.ship',
    });
  });

  test('bare ref nobody has is not_found', () => {
    expect(resolveTaskRef('nowhere', 'alpha', idx)).toEqual({
      kind: 'not_found',
      ref: 'nowhere',
    });
  });
});

// ═══ Regression: bug #2 — same bare task id in multiple tracks ═══

describe('regression: continue_from across same-named tasks (bug #2)', () => {
  test('bare continue_from resolves via same-track shadow — qualified id handed downstream', () => {
    // Two tracks, each with a "review" task and a follower that continues
    // from it. The follower MUST bind to its own track's review via the
    // same-track shorthand, not to the other track's review.
    const resolved: PipelineConfig = {
      name: 'Same-Bare',
      tracks: [
        {
          id: 'alpha',
          name: 'Alpha',
          tasks: [
            { id: 'review', name: 'Review', prompt: 'do A' },
            {
              id: 'ship',
              name: 'Ship',
              prompt: 'ship A',
              depends_on: ['review'],
              continue_from: 'review',
            },
          ],
        },
        {
          id: 'beta',
          name: 'Beta',
          tasks: [
            { id: 'review', name: 'Review', prompt: 'do B' },
            {
              id: 'ship',
              name: 'Ship',
              prompt: 'ship B',
              depends_on: ['review'],
              continue_from: 'review',
            },
          ],
        },
      ],
    };
    const dag = buildDag(resolved);
    const alphaShip = dag.nodes.get('alpha.ship')!;
    const betaShip = dag.nodes.get('beta.ship')!;
    expect(alphaShip.resolvedContinueFrom).toBe('alpha.review');
    expect(betaShip.resolvedContinueFrom).toBe('beta.review');
    // And the dep edges get qualified too, preventing engine map-key misses.
    expect(alphaShip.dependsOn).toContain('alpha.review');
    expect(betaShip.dependsOn).toContain('beta.review');
  });

  test('bare continue_from pointing at a foreign ambiguous task throws', () => {
    const resolved: PipelineConfig = {
      name: 'Ambiguous',
      tracks: [
        {
          id: 'alpha',
          name: 'Alpha',
          tasks: [
            { id: 'review', name: 'Review', prompt: 'p' },
            // ship has no local "review" so bare "review" is ambiguous.
            { id: 'filler', name: 'Filler', prompt: 'p' },
          ],
        },
        {
          id: 'beta',
          name: 'Beta',
          tasks: [{ id: 'review', name: 'Review', prompt: 'p' }],
        },
        {
          id: 'gamma',
          name: 'Gamma',
          tasks: [
            {
              id: 'ship',
              name: 'Ship',
              prompt: 'ship',
              continue_from: 'review',
            },
          ],
        },
      ],
    };
    expect(() => buildDag(resolved)).toThrow(/ambiguous/i);
  });

  test('qualified continue_from always wins — no same-track-shadow risk', () => {
    const resolved: PipelineConfig = {
      name: 'Qualified',
      tracks: [
        {
          id: 'alpha',
          name: 'Alpha',
          tasks: [
            { id: 'plan', name: 'Plan', prompt: 'p' },
            {
              id: 'plan_v2',
              name: 'Plan v2',
              prompt: 'p2',
              continue_from: 'plan',
            },
          ],
        },
        {
          id: 'beta',
          name: 'Beta',
          tasks: [
            { id: 'plan', name: 'Plan B', prompt: 'p' },
            {
              id: 'cross',
              name: 'Cross',
              prompt: 'x',
              continue_from: 'alpha.plan',
            },
          ],
        },
      ],
    };
    const dag = buildDag(resolved);
    expect(dag.nodes.get('alpha.plan_v2')!.resolvedContinueFrom).toBe('alpha.plan');
    expect(dag.nodes.get('beta.cross')!.resolvedContinueFrom).toBe('alpha.plan');
  });
});

// ═══ Regression: bug #10 — editor-generated ids always pass validate-raw ═══

describe('regression: TASK_ID_RE is the single source of truth (bug #10)', () => {
  test('validateRaw rejects exactly what isValidTaskId rejects', () => {
    // Any string the helper says is invalid must be flagged by validateRaw
    // as an "invalid characters" error — proving they read from the same
    // regex rather than two drifted copies.
    const invalids = ['1bad', 'has.dot', 'with space', '-leading', 'q?mark', ''];
    for (const badId of invalids) {
      const cfg: RawPipelineConfig = {
        name: 'T',
        tracks: [
          {
            id: 'ok',
            name: 'OK',
            tasks: [{ id: badId, prompt: 'p' }],
          },
        ],
      };
      const errs = validateRaw(cfg);
      expect(errs.length).toBeGreaterThan(0);
      expect(isValidTaskId(badId)).toBe(false);
    }
  });
});

// ═══ Regression: buildDag topo sort is deterministic (bug #13) ═══

describe('regression: buildDag topo sort is deterministic', () => {
  const base = (trackOrder: readonly string[]): PipelineConfig => ({
    name: 'Determinism',
    tracks: trackOrder.map((id) => ({
      id,
      name: id,
      tasks: [
        { id: 'a', name: 'A', prompt: 'p' },
        { id: 'b', name: 'B', prompt: 'p', depends_on: ['a'] },
      ],
    })),
  });

  test('parallel tasks with equal depth sort by qid, independent of YAML order', () => {
    const forward = buildDag(base(['alpha', 'beta', 'gamma']));
    const reversed = buildDag(base(['gamma', 'beta', 'alpha']));
    expect(forward.sorted).toEqual(reversed.sorted);
    // And the actual order is alphabetical by qid — every "a" before every "b".
    expect(forward.sorted).toEqual([
      'alpha.a',
      'beta.a',
      'gamma.a',
      'alpha.b',
      'beta.b',
      'gamma.b',
    ]);
  });

  test('diamond dependency still produces a unique sorted order', () => {
    // root -> left, right -> join
    const cfg: PipelineConfig = {
      name: 'Diamond',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            { id: 'root', name: 'r', prompt: 'p' },
            { id: 'left', name: 'l', prompt: 'p', depends_on: ['root'] },
            { id: 'right', name: 'r', prompt: 'p', depends_on: ['root'] },
            { id: 'join', name: 'j', prompt: 'p', depends_on: ['left', 'right'] },
          ],
        },
      ],
    };
    const first = buildDag(cfg).sorted;
    const second = buildDag(cfg).sorted;
    expect(first).toEqual(second);
    // root first, join last; left/right in alphabetical order between.
    expect(first[0]).toBe('t.root');
    expect(first[first.length - 1]).toBe('t.join');
    expect(first.indexOf('t.left')).toBeLessThan(first.indexOf('t.right'));
  });
});

// ═══ Regression: buildRawDag stays lenient (editor real-time view) ═══

describe('buildRawDag tolerates unresolved refs', () => {
  test('ambiguous bare continue_from is silently skipped (no edge, no throw)', () => {
    const cfg: RawPipelineConfig = {
      name: 'T',
      tracks: [
        { id: 'a', name: 'A', tasks: [{ id: 'review', prompt: 'p' }] },
        { id: 'b', name: 'B', tasks: [{ id: 'review', prompt: 'p' }] },
        {
          id: 'c',
          name: 'C',
          tasks: [{ id: 'use', prompt: 'p', continue_from: 'review' }],
        },
      ],
    };
    const raw = buildRawDag(cfg);
    expect(raw.nodes.size).toBe(3);
    // No edge for the ambiguous ref — the editor panel should prompt the
    // user to qualify it instead of silently linking to the wrong track.
    expect(raw.edges.find((e) => e.to === 'c.use')).toBeUndefined();
  });
});
