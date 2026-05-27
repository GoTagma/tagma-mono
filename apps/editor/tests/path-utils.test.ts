import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync, readContainedTextFileSync } from '../server/path-utils';

describe('path-utils', () => {
  test('atomicWriteFileSync refuses to overwrite a symlink target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-path-utils-'));
    try {
      const outside = join(dir, 'outside.txt');
      const link = join(dir, 'linked.txt');
      writeFileSync(outside, 'outside', 'utf-8');
      try {
        symlinkSync(outside, link);
      } catch {
        return;
      }

      expect(() => atomicWriteFileSync(link, 'replacement')).toThrow(/symbolic link/i);
      expect(readFileSync(outside, 'utf-8')).toBe('outside');
      expect(existsSync(link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readContainedTextFileSync refuses symlinked files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-path-utils-'));
    try {
      const root = join(dir, 'root');
      mkdirSync(root);
      const safe = join(root, 'safe.txt');
      const outside = join(dir, 'outside.txt');
      const link = join(root, 'linked.txt');
      writeFileSync(safe, 'safe', 'utf-8');
      writeFileSync(outside, 'outside', 'utf-8');
      expect(readContainedTextFileSync(root, safe, 'safe file')).toBe('safe');
      try {
        symlinkSync(outside, link);
      } catch {
        return;
      }

      expect(() => readContainedTextFileSync(root, link, 'linked file')).toThrow(
        /symbolic link|outside/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
