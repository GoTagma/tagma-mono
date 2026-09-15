import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'tagma-stage-sidecar-')))
      throw new Error('Unexpected fixture root');
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-stage-sidecar-'));
  roots.push(root);
  const scripts = join(root, 'apps', 'electron', 'scripts');
  const source = join(root, 'apps', 'editor', 'desktop-dist');
  const destination = join(root, 'apps', 'editor', 'desktop-dist-x64');
  for (const dir of [scripts, source, destination]) mkdirSync(dir, { recursive: true });
  const script = join(scripts, 'stage-sidecar.mjs');
  copyFileSync(resolve(import.meta.dir, '../scripts/stage-sidecar.mjs'), script);
  return {
    source,
    destination,
    run: () => {
      const result = spawnSync(process.env.NODE ?? 'node', [script, 'x64'], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout;
    },
  };
}

function binary(dir: string, name: string, content: string, seconds: number) {
  const path = join(dir, name);
  writeFileSync(path, content);
  utimesSync(path, seconds, seconds);
}

test.each(['tagma-editor-server.exe', 'tagma-editor-server'])(
  'stages the newer %s when an old binary for another platform remains in both directories',
  (latest) => {
    const { source, destination, run } = fixture();
    const stale = latest.endsWith('.exe') ? 'tagma-editor-server' : 'tagma-editor-server.exe';
    binary(source, stale, 'old other platform', 10);
    binary(destination, stale, 'old other platform', 10);
    binary(source, latest, 'current final build', 30);
    binary(destination, latest, 'previous build', 20);
    expect(run()).toContain('copied');
    expect(readFileSync(join(destination, latest), 'utf8')).toBe('current final build');
    expect(run()).toContain('already current');
  },
);

test('preserves a newer independently built architecture sidecar', () => {
  const { source, destination, run } = fixture();
  binary(source, 'tagma-editor-server.exe', 'default build', 30);
  binary(destination, 'tagma-editor-server.exe', 'newer architecture build', 40);
  expect(run()).toContain('already current');
  expect(readFileSync(join(destination, 'tagma-editor-server.exe'), 'utf8')).toBe(
    'newer architecture build',
  );
});
