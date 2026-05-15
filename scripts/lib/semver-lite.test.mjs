// Unit tests for the dependency-gate semver evaluator.
// Run with: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, parseVersion, satisfies } from './semver-lite.mjs';

test('parseVersion handles plain, v-prefixed, and prerelease', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
  assert.deepEqual(parseVersion('v0.4.38'), { major: 0, minor: 4, patch: 38, prerelease: '' });
  assert.equal(parseVersion('1.2.3-beta.1').prerelease, 'beta.1');
  assert.equal(parseVersion('not-a-version'), null);
});

test('compareVersions orders by major/minor/patch and prerelease', () => {
  assert.ok(compareVersions(parseVersion('1.0.0'), parseVersion('1.0.1')) < 0);
  assert.ok(compareVersions(parseVersion('2.0.0'), parseVersion('1.9.9')) > 0);
  assert.equal(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
  // prerelease sorts below its release
  assert.ok(compareVersions(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0')) < 0);
});

// The exact constraint the published @tagma/* plugins ship today.
// If @tagma/types is bumped to 0.5.0 without widening these ranges,
// the gate MUST fail -- these assertions are that guarantee.
test('plugin peerDependency range ">=0.4.18 <0.5.0"', () => {
  assert.equal(satisfies('0.4.38', '>=0.4.18 <0.5.0'), true);
  assert.equal(satisfies('0.4.18', '>=0.4.18 <0.5.0'), true, 'inclusive floor');
  assert.equal(satisfies('0.4.17', '>=0.4.18 <0.5.0'), false, 'below floor');
  assert.equal(satisfies('0.5.0', '>=0.4.18 <0.5.0'), false, 'exclusive ceiling');
  assert.equal(satisfies('1.0.0', '>=0.4.18 <0.5.0'), false);
});

test('caret ranges including 0.x special-casing', () => {
  assert.equal(satisfies('0.4.38', '^0.4.18'), true);
  assert.equal(satisfies('0.5.0', '^0.4.18'), false, '0.x caret pins minor');
  assert.equal(satisfies('0.4.17', '^0.4.18'), false);
  assert.equal(satisfies('1.9.9', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('1.2.2', '^1.2.3'), false);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false, '0.0.x caret pins patch');
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.9', '^0.0'), true, '^0.0 pins minor');
  assert.equal(satisfies('0.1.0', '^0.0'), false);
  assert.equal(satisfies('0.9.9', '^0'), true, '^0 pins major');
  assert.equal(satisfies('1.0.0', '^0'), false);
});

test('tilde ranges (full and partial)', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('1.9.9', '~1'), true);
  assert.equal(satisfies('2.0.0', '~1'), false);
  assert.equal(satisfies('0.4.38', '~0.4.0'), true);
  assert.equal(satisfies('0.5.1', '~0.4.0'), false);
});

test('x-ranges, partials, wildcards, and OR clauses', () => {
  assert.equal(satisfies('3.2.1', '1.x || 3.x'), true);
  assert.equal(satisfies('1.5.0', '1.x || 3.x'), true);
  assert.equal(satisfies('2.0.0', '1.x || 3.x'), false);
  assert.equal(satisfies('1.2.9', '1.2.x'), true);
  assert.equal(satisfies('1.3.0', '1.2.x'), false);
  assert.equal(satisfies('1.99.99', '1'), true);
  assert.equal(satisfies('5.0.0', '1'), false);
  assert.equal(satisfies('9.9.9', '*'), true);
  assert.equal(satisfies('1.0.0', 'x'), true);
  assert.equal(satisfies('1.0.0', ''), true);
});

test('exact versions and invalid input', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true);
  assert.equal(satisfies('1.2.4', '1.2.3'), false);
  assert.equal(satisfies('1.2.3', '=1.2.3'), true);
  assert.equal(satisfies('garbage', '>=1.0.0'), false);
});
