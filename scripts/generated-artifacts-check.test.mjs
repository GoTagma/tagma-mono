import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ESLint } from 'eslint';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('text hygiene excludes generated desktop packages while retaining application source checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-generated-gates-'));
  try {
    const generated = join(root, 'apps', 'electron', 'release', 'qa', 'resources');
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, 'bundle.js'), '<<<<<<< generated vendor text\n');
    const scratch = join(root, 'apps', 'editor', '.tmp', 'qa');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'repro.ts'), '<<<<<<< temporary investigation\n');
    const run = () =>
      spawnSync(process.execPath, [join(repo, 'scripts', 'text-hygiene-check.mjs')], {
        cwd: root,
        encoding: 'utf8',
      });
    const ignored = run();
    assert.equal(ignored.status, 0, ignored.stderr);
    const source = join(root, 'apps', 'electron', 'src');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'bad.ts'), '<<<<<<< real source conflict\n');
    const checked = run();
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /bad\.ts: conflict marker/);
  } finally {
    if (!root.startsWith(join(tmpdir(), 'tagma-generated-gates-')))
      throw new Error('Unexpected fixture');
    rmSync(root, { recursive: true, force: true });
  }
});

test('ESLint ignores packaged resources without ignoring Electron source or packaging scripts', async () => {
  const eslint = new ESLint({ cwd: repo });
  assert.equal(
    await eslint.isPathIgnored(join(repo, 'apps/electron/release/qa/resources/bundle.js')),
    true,
  );
  assert.equal(await eslint.isPathIgnored(join(repo, 'apps/editor/.tmp/qa/repro.ts')), true);
  assert.equal(
    await eslint.isPathIgnored(join(repo, 'apps/electron/src/chat-identities.ts')),
    false,
  );
  assert.equal(
    await eslint.isPathIgnored(join(repo, 'apps/electron/scripts/stage-sidecar.mjs')),
    false,
  );
});
