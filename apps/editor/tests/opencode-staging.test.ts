import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateOpencodeBinary,
  rollbackOpencodeActivation,
  type OpencodeStagingResult,
} from '../server/release/opencode-staging';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('OpenCode activation changes binary, version, and database schema metadata atomically', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-staging-'));
  tempRoots.push(userDir);
  const binDir = join(userDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const executable = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binaryPath = join(binDir, executable);
  const stagingBinaryPath = `${binaryPath}.staging`;
  writeFileSync(binaryPath, 'old-binary');
  writeFileSync(stagingBinaryPath, 'new-binary');
  writeFileSync(join(userDir, 'version.txt'), '1.17.8\n');
  writeFileSync(join(userDir, 'database-schema-version.txt'), '1\n');

  const staged: OpencodeStagingResult = {
    version: '1.18.0',
    dbSchemaVersion: 2,
    userDir,
    binaryPath,
    stagingBinaryPath,
    sha256: 'a'.repeat(64),
  };
  const activation = activateOpencodeBinary(staged, { keepPrevious: true });

  expect(readFileSync(binaryPath, 'utf-8')).toBe('new-binary');
  expect(readFileSync(join(userDir, 'version.txt'), 'utf-8')).toBe('1.18.0\n');
  expect(readFileSync(join(userDir, 'database-schema-version.txt'), 'utf-8')).toBe('2\n');

  rollbackOpencodeActivation(activation);
  expect(readFileSync(binaryPath, 'utf-8')).toBe('old-binary');
  expect(readFileSync(join(userDir, 'version.txt'), 'utf-8')).toBe('1.17.8\n');
  expect(readFileSync(join(userDir, 'database-schema-version.txt'), 'utf-8')).toBe('1\n');
});
