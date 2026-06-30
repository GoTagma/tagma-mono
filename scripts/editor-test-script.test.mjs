import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
});
