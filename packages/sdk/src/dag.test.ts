import { describe, expect, test } from 'bun:test';
import { buildDag } from './dag';
import type { PipelineConfig, TaskConfig, TrackConfig, Permissions } from './types';

const PERMS: Permissions = { read: true, write: false, execute: false };

function task(id: string, depends_on?: string[]): TaskConfig {
  return { id, name: id, prompt: 'x', permissions: PERMS, depends_on };
}

function track(id: string, tasks: TaskConfig[]): TrackConfig {
  return { id, name: id, driver: 'opencode', permissions: PERMS, tasks };
}

function pipeline(tasks: TaskConfig[]): PipelineConfig {
  return { name: 'test', tracks: [track('t', tasks)] };
}

function qid(id: string): string {
  return `t.${id}`;
}

describe('buildDag', () => {
  test('empty pipeline yields empty sorted array', () => {
    const dag = buildDag({ name: 'empty', tracks: [track('t', [])] });
    expect(dag.sorted).toEqual([]);
    expect(dag.nodes.size).toBe(0);
  });

  test('single node returns that node', () => {
    const dag = buildDag(pipeline([task('only')]));
    expect(dag.sorted).toEqual([qid('only')]);
    expect(dag.nodes.size).toBe(1);
  });

  test('linear chain A -> B -> C produces correct order', () => {
    const dag = buildDag(pipeline([task('a'), task('b', ['a']), task('c', ['b'])]));
    expect(dag.sorted).toEqual([qid('a'), qid('b'), qid('c')]);
  });

  test('diamond A -> B,C; B,C -> D: A first, D last, B/C in between', () => {
    const dag = buildDag(
      pipeline([task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])]),
    );
    expect(dag.sorted[0]).toBe(qid('a'));
    expect(dag.sorted[dag.sorted.length - 1]).toBe(qid('d'));
    const mid = dag.sorted.slice(1, -1).sort();
    expect(mid).toEqual([qid('b'), qid('c')]);
  });

  test('cycle detection throws', () => {
    expect(() => buildDag(pipeline([task('a', ['b']), task('b', ['a'])]))).toThrow(
      /[Cc]ircular|cycle/,
    );
  });
});
