// Teeth + false-positive tests for the five new verification gates'
// detection cores. Auto-run by the `scripts` gate
// (node --test "scripts/**/*.test.mjs").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectExportTargets } from './exports-targets.mjs';
import { findCycles } from './graph-cycles.mjs';
import { isBuiltin, pkgNameOf, specifiersOf } from './import-spec.mjs';
import { focusHit, secretHit } from './static-scan.mjs';

test('focus: catches focus/skip/debugger, ignores clean code', () => {
  assert.ok(focusHit('  it.only("x", () => {})'), '.only');
  assert.ok(focusHit('describe.only("s", () => {})'));
  assert.ok(focusHit('fit("x", () => {})'), 'fit');
  assert.ok(focusHit('xdescribe("s", () => {})'), 'xdescribe');
  assert.ok(focusHit('    debugger;'), 'debugger');
  assert.equal(focusHit('it("does a thing", () => {})'), null);
  assert.equal(focusHit('const onlyThing = 1; // not a test'), null);
  assert.equal(focusHit('myObject.debugger = true;'), null);
});

test('imports: extractor handles real forms, no scan-to-next-from bug', () => {
  const src = [
    "import a from 'pkg-a';",
    "import { b } from '@scope/pkg-b';",
    "import type { C } from 'pkg-c/sub';",
    "export { d } from 'pkg-d';",
    "export * from 'pkg-e';",
    "const x = await import('pkg-f');",
    "const y = require('pkg-g');",
    "import './local-style.css';",
    'export const notImport = 1;',
    'function f() { return frommage; }',
    "const s = 'the value comes from somewhere';",
  ].join('\n');
  const specs = specifiersOf(src);
  for (const want of [
    'pkg-a',
    '@scope/pkg-b',
    'pkg-c/sub',
    'pkg-d',
    'pkg-e',
    'pkg-f',
    'pkg-g',
    './local-style.css',
  ]) {
    assert.ok(specs.has(want), `missing ${want}`);
  }
  // The bug class: `export const notImport` must NOT capture a later
  // string containing the word "from".
  assert.ok(!specs.has('somewhere'));
  assert.ok(![...specs].some((s) => s.includes('\n')), 'no multi-line capture');
});

test('imports: pkgNameOf + isBuiltin classification', () => {
  assert.equal(pkgNameOf('@tagma/core/sub/deep'), '@tagma/core');
  assert.equal(pkgNameOf('lodash/fp'), 'lodash');
  assert.equal(pkgNameOf('react'), 'react');
  assert.equal(isBuiltin('node:fs'), true);
  assert.equal(isBuiltin('path'), true, 'bare builtin');
  assert.equal(isBuiltin('readline'), true);
  assert.equal(isBuiltin('bun:test'), true);
  assert.equal(isBuiltin('express'), false);
});

test('cycles: detects a cycle, clears a DAG', () => {
  const dag = new Map([
    ['a', ['b', 'c']],
    ['b', ['c']],
    ['c', []],
  ]);
  assert.deepEqual(findCycles(dag), []);
  const cyclic = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', ['a']],
  ]);
  const found = findCycles(cyclic);
  assert.equal(found.length, 1);
  assert.match(found[0], /a -> b -> c -> a/);
  // self-loop
  assert.equal(findCycles(new Map([['x', ['x']]])).length, 1);
});

test('publish: collectExportTargets flattens nested conditions', () => {
  const exp = {
    '.': { import: './dist/index.js', require: './dist/index.cjs', types: './dist/index.d.ts' },
    './plugin': { import: './dist/plugin.js' },
    './style.css': './dist/style.css',
  };
  const targets = collectExportTargets(exp).sort();
  assert.deepEqual(targets, [
    './dist/index.cjs',
    './dist/index.d.ts',
    './dist/index.js',
    './dist/plugin.js',
    './dist/style.css',
  ]);
  assert.deepEqual(collectExportTargets(undefined), []);
  assert.deepEqual(collectExportTargets('./dist/index.js'), ['./dist/index.js']);
});

test('secrets: catches real signatures, ignores placeholders', () => {
  assert.ok(secretHit('-----BEGIN ' + 'RSA PRIVATE KEY-----', false), 'pem');
  assert.ok(secretHit('aws_key = "' + 'AKIA' + '1234567890ABCDEF"', false), 'akia');
  assert.ok(secretHit('token=ghp_' + 'a'.repeat(36), false), 'ghp');
  assert.ok(secretHit('const apiKey = "9f8e7d6c5b4a39281706abcd"', true), 'generic');
  // false-positive guards
  assert.equal(secretHit('const apiKey = process.env.API_KEY', true), null);
  assert.equal(secretHit('password: "your-password-here"', true), null);
  assert.equal(secretHit('token = "xxxxxxxxxxxxxxxxxx"', true), null);
  assert.equal(secretHit('const apiKey = "example-key-do-not-use"', true), null);
  // generic heuristic must stay OFF for fixtures/markdown callers
  assert.equal(secretHit('const apiKey = "9f8e7d6c5b4a39281706abcd"', false), null);
  assert.equal(secretHit('just a normal line of code', true), null);
});
