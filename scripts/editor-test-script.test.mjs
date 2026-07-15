import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const editorPackage = JSON.parse(
  readFileSync(new URL('../apps/editor/package.json', import.meta.url), 'utf8'),
);
const runnerUrl = new URL('../apps/editor/scripts/test-serial.mjs', import.meta.url);

test('tagma-editor tests use a per-file process runner', () => {
  assert.equal(editorPackage.scripts?.test, 'bun scripts/test-serial.mjs');
  assert.equal(existsSync(runnerUrl), true);
});

test('editor serial runner discovers test files deterministically', async () => {
  const { buildBunTestArgs, discoverTestFiles } = await import(runnerUrl.href);
  const root = mkdtempSync(join(tmpdir(), 'tagma-editor-test-runner-'));
  const testsDir = join(root, 'tests');
  try {
    mkdirSync(join(testsDir, 'nested'), { recursive: true });
    writeFileSync(join(testsDir, 'z.ignore.ts'), '');
    writeFileSync(join(testsDir, 'a.test.ts'), '');
    writeFileSync(join(testsDir, 'nested', 'b.test.tsx'), '');

    assert.deepEqual(discoverTestFiles(testsDir, root), [
      'tests/a.test.ts',
      'tests/nested/b.test.tsx',
    ]);
    assert.deepEqual(buildBunTestArgs('tests/a.test.ts', ['--timeout', '10000']), [
      'test',
      'tests/a.test.ts',
      '--timeout',
      '10000',
    ]);
    assert.deepEqual(buildBunTestArgs('tests/workflow-integration.test.ts'), [
      'test',
      'tests/workflow-integration.test.ts',
      '--timeout',
      '30000',
    ]);
    assert.deepEqual(buildBunTestArgs('tests/workflow-integration.test.ts', ['--timeout=45000']), [
      'test',
      'tests/workflow-integration.test.ts',
      '--timeout=45000',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editor serial runner separates explicit file selectors from Bun arguments', async () => {
  const { parseRunnerArgs } = await import(runnerUrl.href);

  assert.deepEqual(
    parseRunnerArgs([
      '--file',
      'tests/workflow-integration.test.ts',
      '--timeout',
      '45000',
      '--file=tests/editor-staging.test.ts',
    ]),
    {
      fileSelectors: ['tests/workflow-integration.test.ts', 'tests/editor-staging.test.ts'],
      bunArgs: ['--timeout', '45000'],
    },
  );
});

test('editor serial runner rejects empty file selectors', async () => {
  const { parseRunnerArgs } = await import(runnerUrl.href);

  assert.throws(() => parseRunnerArgs(['--file']), /--file requires a test file/);
  assert.throws(() => parseRunnerArgs(['--file=']), /--file requires a test file/);
  assert.throws(
    () => parseRunnerArgs(['--file', '--timeout', '1000']),
    /--file requires a test file/,
  );
});

test('editor serial runner selects files deterministically across path separators', async () => {
  const { selectTestFiles } = await import(runnerUrl.href);
  const files = [
    'tests/a.test.ts',
    'tests/nested/b.test.tsx',
    'tests/workflow-integration.test.ts',
  ];

  assert.deepEqual(
    selectTestFiles(files, ['workflow-integration.test.ts', 'tests\\nested\\b.test.tsx']),
    ['tests/nested/b.test.tsx', 'tests/workflow-integration.test.ts'],
  );
  assert.deepEqual(selectTestFiles(files, []), files);
});

test('editor serial runner rejects every unmatched file selector', async () => {
  const { selectTestFiles } = await import(runnerUrl.href);

  assert.throws(
    () => selectTestFiles(['tests/a.test.ts'], ['tests/a.test.ts', 'tests/missing.test.ts']),
    /No editor test file matched --file: tests\/missing\.test\.ts/,
  );
});

test('editor serial runner rejects ambiguous file selectors', async () => {
  const { selectTestFiles } = await import(runnerUrl.href);
  const files = ['tests/first/shared.test.ts', 'tests/second/shared.test.ts'];

  assert.throws(
    () => selectTestFiles(files, ['shared.test.ts']),
    /Ambiguous editor test file selector --file: shared\.test\.ts/,
  );
  assert.deepEqual(selectTestFiles(files, ['tests/first/shared.test.ts']), [
    'tests/first/shared.test.ts',
  ]);
});

test('editor serial runner executes only explicitly selected files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-editor-test-runner-cli-'));
  const testsDir = join(root, 'tests');
  try {
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(
      join(testsDir, 'selected.test.ts'),
      `import { expect, test } from 'bun:test'; test('selected fixture', () => expect(true).toBe(true));`,
    );
    writeFileSync(
      join(testsDir, 'unselected.test.ts'),
      `import { expect, test } from 'bun:test'; test('unselected fixture', () => expect(true).toBe(false));`,
    );

    const result = spawnSync(
      'bun',
      [fileURLToPath(runnerUrl), '--file', 'tests/selected.test.ts', '--timeout', '1000'],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    const output = (result.stdout ?? '') + (result.stderr ?? '');

    assert.equal(result.status, 0, output);
    assert.match(output, /::group::tests\/selected\.test\.ts/);
    assert.doesNotMatch(output, /unselected\.test\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editor serial runner still aggregates failures for selected files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-editor-test-runner-failures-'));
  const testsDir = join(root, 'tests');
  try {
    mkdirSync(testsDir, { recursive: true });
    for (const file of ['first.test.ts', 'second.test.ts']) {
      writeFileSync(
        join(testsDir, file),
        `import { expect, test } from 'bun:test'; test('failure fixture', () => expect(true).toBe(false));`,
      );
    }

    const result = spawnSync(
      'bun',
      [fileURLToPath(runnerUrl), '--file', 'tests/first.test.ts', '--file=tests/second.test.ts'],
      { cwd: root, encoding: 'utf8', timeout: 10_000 },
    );
    const output = (result.stdout ?? '') + (result.stderr ?? '');

    assert.equal(result.status, 1, output);
    assert.match(output, /::group::tests\/first\.test\.ts/);
    assert.match(output, /::group::tests\/second\.test\.ts/);
    assert.match(output, /2 editor test file\(s\) failed\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
