import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  runPipelineLayoutSync,
  runPipelineLayoutSyncDetailed,
} from '../server/pipeline-layout-sync';
import * as layoutSync from '../server/pipeline-layout-sync';
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

test('layout failure keeps legacy null and exposes only the first failed Host phase', () => {
  const yamlPath = makePipeline(
    'pipeline:\n  name: Sample\n  tracks:\n    - id: main\n      tasks:\n        - id: task\n          command: echo ok\n',
  );
  mkdirSync(pipelineLayoutPath(yamlPath));
  const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    // A directory at the output coordinate deterministically prevents atomic replacement.
    expect(runPipelineLayoutSync(yamlPath)).toBeNull();
    expect(layoutSync).toHaveProperty('runPipelineLayoutSyncDetailed', expect.any(Function));
    const result = runPipelineLayoutSyncDetailed(yamlPath);
    expect(result).toMatchObject({
      kind: 'unavailable',
      observation: { phase: 'managed_layout_write', errorClass: 'Error' },
    });
    if (result.kind !== 'unavailable') throw new Error('Expected unavailable layout.');
    expect(JSON.stringify(result)).not.toContain(yamlPath);
    expect(Object.keys(result.observation!).sort()).toEqual(['errorClass', 'phase', 'systemCode']);
  } finally {
    warning.mockRestore();
  }
});

test('layout observations distinguish fatal read, parse, shape and dependency boundaries', () => {
  const yamlPath = makePipeline('invalid: [');
  const cases = [
    { content: 'invalid: [', phase: 'managed_layout_parse' },
    { content: 'pipeline: { tracks: {} }', phase: 'managed_layout_shape' },
    {
      content:
        'pipeline:\n  tracks:\n    - id: main\n      tasks:\n        - id: task\n          depends_on: [private-reference-sentinel]\n',
      phase: 'managed_layout_dependency',
    },
  ];
  for (const item of cases) {
    writeFileSync(yamlPath, item.content, 'utf8');
    const result = runPipelineLayoutSyncDetailed(yamlPath);
    expect(result).toMatchObject({ kind: 'unavailable', observation: { phase: item.phase } });
    expect(runPipelineLayoutSync(yamlPath)).toBeNull();
    expect(JSON.stringify(result)).not.toContain('private-reference-sentinel');
  }
  rmSync(yamlPath);
  expect(runPipelineLayoutSyncDetailed(yamlPath)).toMatchObject({
    kind: 'unavailable',
    observation: { phase: 'managed_layout_read', systemCode: 'ENOENT' },
  });
  expect(runPipelineLayoutSync(yamlPath)).toBeNull();
});

test('missing or malformed prior layout remains a successful synchronous fallback', () => {
  const yamlPath = makePipeline(
    'pipeline:\n  tracks:\n    - id: main\n      tasks:\n        - id: task\n          command: echo ok\n',
  );
  for (const prior of [null, '{invalid-json']) {
    rmSync(pipelineLayoutPath(yamlPath), { force: true });
    if (prior !== null) writeFileSync(pipelineLayoutPath(yamlPath), prior, 'utf8');
    const result = runPipelineLayoutSyncDetailed(yamlPath);
    expect(result).toEqual({
      kind: 'completed',
      layout: { positions: { 'main.task': { x: 20 } }, folders: [] },
    });
    expect(result).not.toBeInstanceOf(Promise);
  }
});

test('the detailed result does not turn an existing unexpected throw into null', () => {
  const yamlPath = makePipeline(
    'pipeline:\n  tracks:\n    - id: main\n      tasks:\n        - id: task\n          command: echo ok\n',
  );
  mkdirSync(pipelineLayoutPath(yamlPath));
  const original = new Error('Unexpected logger failure');
  const warning = spyOn(console, 'warn').mockImplementation(() => {
    throw original;
  });
  try {
    for (const synchronize of [runPipelineLayoutSync, runPipelineLayoutSyncDetailed]) {
      let caught: unknown;
      try {
        synchronize(yamlPath);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(original);
    }
  } finally {
    warning.mockRestore();
  }
});
