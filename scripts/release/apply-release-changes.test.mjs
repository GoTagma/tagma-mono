import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  applyReleaseChanges,
  formatReleaseChangesSummary,
  parseReleaseChanges,
} from './apply-release-changes.mjs';

const tempRoots = [];

function tempFile(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tagma-release-changes-'));
  tempRoots.push(dir);
  const file = path.join(dir, '0.6.28.md');
  writeFileSync(file, content, 'utf-8');
  return file;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('parses workflow JSON array input into release changes', () => {
  assert.deepEqual(
    parseReleaseChanges(
      JSON.stringify([
        'apps: fix editor workflow return path handling',
        'web: sync changelog summary automatically',
      ]),
    ),
    [
      'apps: fix editor workflow return path handling',
      'web: sync changelog summary automatically',
    ],
  );
});

test('parses newline input from the GitHub Actions UI', () => {
  assert.deepEqual(
    parseReleaseChanges('- First change\n2. Second change\nThird change'),
    ['First change', 'Second change', 'Third change'],
  );
});

test('formats changes as a real markdown bullet list', () => {
  assert.equal(
    formatReleaseChangesSummary(['First change', 'Second change']),
    '- First change\n- Second change',
  );
});

test('writes release changes into changelog frontmatter summary', () => {
  const file = tempFile(`---
version: "0.6.28"
date: "2026-05-26"
channel: "alpha"
---
`);

  const result = applyReleaseChanges({
    version: 'desktop-v0.6.28',
    changelogFile: file,
    changesInput: '["apps: fix editor workflow return path handling","web: publish summary"]',
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.changes, [
    'apps: fix editor workflow return path handling',
    'web: publish summary',
  ]);
  assert.equal(
    readFileSync(file, 'utf-8'),
    `---
version: "0.6.28"
date: "2026-05-26"
channel: "alpha"
summary: |-
  - apps: fix editor workflow return path handling
  - web: publish summary
---
`,
  );
});
