import assert from 'node:assert/strict';
import test from 'node:test';

import { validateOpencodeVersionContract } from './opencode-version-contract.mjs';

const editorPath = 'apps/editor/package.json';
const electronPath = 'apps/electron/package.json';

function editorManifest(version = '1.18.18') {
  return { dependencies: { '@opencode-ai/sdk': version } };
}

function electronManifest(version = '1.18.18') {
  return { tagma: { bundledOpencodeVersion: version } };
}

test('accepts matching exact OpenCode SDK and bundled CLI versions', () => {
  assert.equal(
    validateOpencodeVersionContract({
      editorManifest: editorManifest(),
      electronManifest: electronManifest(),
      editorManifestPath: editorPath,
      electronManifestPath: electronPath,
    }),
    '1.18.18',
  );
});

test('accepts an exact prerelease version', () => {
  assert.equal(
    validateOpencodeVersionContract({
      editorManifest: editorManifest('2.0.0-rc.1+build.7'),
      electronManifest: electronManifest('2.0.0-rc.1+build.7'),
      editorManifestPath: editorPath,
      electronManifestPath: electronPath,
    }),
    '2.0.0-rc.1+build.7',
  );
});

test('rejects a ranged SDK dependency', () => {
  assert.throws(
    () =>
      validateOpencodeVersionContract({
        editorManifest: editorManifest('^1.18.18'),
        electronManifest: electronManifest(),
        editorManifestPath: editorPath,
        electronManifestPath: electronPath,
      }),
    /apps\/editor\/package\.json.*@opencode-ai\/sdk.*exact semantic version.*\^1\.18\.18/i,
  );
});

test('rejects malformed bundled CLI versions', () => {
  assert.throws(
    () =>
      validateOpencodeVersionContract({
        editorManifest: editorManifest(),
        electronManifest: electronManifest('1.18'),
        editorManifestPath: editorPath,
        electronManifestPath: electronPath,
      }),
    /apps\/electron\/package\.json.*tagma\.bundledOpencodeVersion.*exact semantic version.*1\.18/i,
  );
});

test('rejects missing pins with the owning manifest path', () => {
  assert.throws(
    () =>
      validateOpencodeVersionContract({
        editorManifest: {},
        electronManifest: electronManifest(),
        editorManifestPath: editorPath,
        electronManifestPath: electronPath,
      }),
    /apps\/editor\/package\.json.*@opencode-ai\/sdk.*missing/i,
  );
  assert.throws(
    () =>
      validateOpencodeVersionContract({
        editorManifest: editorManifest(),
        electronManifest: {},
        editorManifestPath: editorPath,
        electronManifestPath: electronPath,
      }),
    /apps\/electron\/package\.json.*tagma\.bundledOpencodeVersion.*missing/i,
  );
});

test('rejects SDK and bundled CLI version drift with both values and paths', () => {
  assert.throws(
    () =>
      validateOpencodeVersionContract({
        editorManifest: editorManifest('1.18.18'),
        electronManifest: electronManifest('1.17.8'),
        editorManifestPath: editorPath,
        electronManifestPath: electronPath,
      }),
    (error) => {
      assert.match(error.message, /OpenCode SDK\/CLI version mismatch/);
      assert.match(error.message, /apps\/editor\/package\.json/);
      assert.match(error.message, /@opencode-ai\/sdk="1\.18\.18"/);
      assert.match(error.message, /apps\/electron\/package\.json/);
      assert.match(error.message, /tagma\.bundledOpencodeVersion="1\.17\.8"/);
      return true;
    },
  );
});
