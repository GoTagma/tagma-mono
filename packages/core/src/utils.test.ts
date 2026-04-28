import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetShellCache, parseDuration, shellArgs, validatePath } from './utils';

test('parseDuration rejects timer values above the runtime-safe setTimeout limit', () => {
  expect(() => parseDuration('25d')).toThrow(/exceeds maximum supported timer value/);
  expect(() => parseDuration('999999999999999999999999d')).toThrow(
    /exceeds maximum supported timer value/,
  );
});

test('PIPELINE_SHELL override is evaluated per call instead of cached', () => {
  const previousShell = process.env.PIPELINE_SHELL;
  try {
    _resetShellCache();
    process.env.PIPELINE_SHELL = 'cmd';
    expect(shellArgs('echo hi').slice(0, 2)).toEqual(['cmd', '/c']);

    process.env.PIPELINE_SHELL = 'powershell';
    expect(shellArgs('echo hi').slice(0, 2)).toEqual(['powershell', '-Command']);
  } finally {
    if (previousShell === undefined) {
      delete process.env.PIPELINE_SHELL;
    } else {
      process.env.PIPELINE_SHELL = previousShell;
    }
    _resetShellCache();
  }
});

test('validatePath rejects a future file under a symlinked parent outside the project root', () => {
  const root = join(
    tmpdir(),
    `tagma-core-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const outside = join(
    tmpdir(),
    `tagma-core-outside-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return;
    }

    expect(() => validatePath('link/future.txt', root)).toThrow(/escapes project root/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
