import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { main, updateWebChangelogSummary } from './update-web-changelog-summary.mjs';

const tempRoots = [];

function withTempWeb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tagma-web-summary-'));
  tempRoots.push(dir);
  const archiveDir = path.join(dir, 'src', 'content', 'archive');
  mkdirSync(archiveDir, { recursive: true });
  return { dir, archiveDir };
}

function writeArchive(archiveDir, version, content) {
  writeFileSync(path.join(archiveDir, `${version}.md`), content, 'utf-8');
}

function readArchive(archiveDir, version) {
  return readFileSync(path.join(archiveDir, `${version}.md`), 'utf-8');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('adds English and Chinese summaries to an existing web archive entry', () => {
  const { dir, archiveDir } = withTempWeb();
  writeArchive(
    archiveDir,
    '0.6.24',
    `---
version: "0.6.24"
date: "2026-05-22"
channel: "alpha"
---
Existing body stays.
`,
  );

  const archivePath = updateWebChangelogSummary({
    webDir: dir,
    version: 'desktop-v0.6.24',
    summary: 'Release "headline" with backslash \\ kept',
    summaryZh: '中文摘要',
  });

  assert.equal(archivePath, path.join(archiveDir, '0.6.24.md'));
  assert.equal(
    readArchive(archiveDir, '0.6.24'),
    `---
version: "0.6.24"
date: "2026-05-22"
channel: "alpha"
summary: "Release \\"headline\\" with backslash \\\\ kept"
summary_zh: "中文摘要"
---
Existing body stays.
`,
  );
});

test('updates existing summaries through the CLI and accepts English-only input', () => {
  const { dir, archiveDir } = withTempWeb();
  writeArchive(
    archiveDir,
    '0.6.25',
    `---
version: "0.6.25"
date: "2026-05-23"
channel: "stable"
summary: "Old summary"
summary_zh: "旧摘要"
---
`,
  );

  let stdout = '';
  let stderr = '';
  const exitCode = main(
    ['v0.6.25', '--summary', 'New summary only', '--web-dir', dir],
    {
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
    },
  );

  assert.equal(exitCode, 0);
  assert.match(stdout, /updated .*0\.6\.25\.md/);
  assert.equal(stderr, '');
  assert.equal(
    readArchive(archiveDir, '0.6.25'),
    `---
version: "0.6.25"
date: "2026-05-23"
channel: "stable"
summary: "New summary only"
summary_zh: "旧摘要"
---
`,
  );
});

test('fails when the target web archive entry does not exist', () => {
  const { dir } = withTempWeb();

  assert.throws(
    () =>
      updateWebChangelogSummary({
        webDir: dir,
        version: '0.6.99',
        summary: 'Missing release',
      }),
    /web changelog archive entry not found/,
  );
});
