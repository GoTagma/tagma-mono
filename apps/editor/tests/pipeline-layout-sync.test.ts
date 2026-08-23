import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runPipelineLayoutSync } from '../server/pipeline-layout-sync';
import { pipelineLayoutPath } from '../server/pipeline-paths';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePipeline(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-layout-sync-'));
  roots.push(root);
  const yamlPath = join(root, '.tagma', 'sample', 'sample.yaml');
  mkdirSync(dirname(yamlPath), { recursive: true });
  writeFileSync(yamlPath, yaml, 'utf8');
  return yamlPath;
}

test('Host layout sync preserves surviving editor-owned fields and prunes stale topology', () => {
  const yamlPath = makePipeline(
    [
      'pipeline:',
      '  name: Sample',
      '  tracks:',
      '    - id: first',
      '      name: First',
      '      tasks:',
      '        - id: start',
      '          prompt: Start',
      '    - id: second',
      '      name: Second',
      '      tasks:',
      '        - id: finish',
      '          prompt: Finish',
      '          depends_on: [first.start]',
      '',
    ].join('\n'),
  );
  writeFileSync(
    pipelineLayoutPath(yamlPath),
    JSON.stringify({
      positions: {
        'first.start': { x: 999, y: 17 },
        'second.finish': { x: 1, y: 29 },
        'deleted.task': { x: 50, y: 40 },
      },
      folders: [
        {
          id: 'flow',
          name: 'Flow',
          trackIds: ['first', 'deleted', 'second'],
          collapsed: true,
        },
      ],
      trackHeights: { first: 150, second: 170, deleted: 190 },
    }),
    'utf8',
  );

  expect(runPipelineLayoutSync(yamlPath)).toEqual({
    positions: {
      'first.start': { x: 20, y: 17 },
      'second.finish': { x: 360, y: 29 },
    },
    folders: [
      {
        id: 'flow',
        name: 'Flow',
        trackIds: ['first', 'second'],
        collapsed: true,
      },
    ],
    trackHeights: { first: 150, second: 170 },
  });
});

test('Host layout sync leaves the prior layout untouched when dependencies are unresolved', () => {
  const yamlPath = makePipeline(
    [
      'pipeline:',
      '  name: Sample',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: task',
      '          prompt: Task',
      '          depends_on: [missing]',
      '',
    ].join('\n'),
  );
  const layoutPath = pipelineLayoutPath(yamlPath);
  const original = '{"positions":{"main.task":{"x":77}},"folders":[]}\n';
  writeFileSync(layoutPath, original, 'utf8');

  expect(runPipelineLayoutSync(yamlPath)).toBeNull();
  expect(readFileSync(layoutPath, 'utf8')).toBe(original);
});
