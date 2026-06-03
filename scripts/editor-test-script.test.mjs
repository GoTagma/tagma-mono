import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editorPackage = JSON.parse(
  readFileSync(new URL('../apps/editor/package.json', import.meta.url), 'utf8'),
);

test('tagma-editor tests run serially to avoid shared mock races', () => {
  assert.equal(editorPackage.scripts?.test, 'bun test --max-concurrency 1');
});
