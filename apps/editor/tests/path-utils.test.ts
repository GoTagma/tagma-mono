import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync, readContainedTextFileSync } from '../server/path-utils';

describe('path-utils', () => {
  test('atomicWriteFileSync retries transient Windows replacement failures without exposing partial bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-path-utils-'));
    try {
      const target = join(dir, 'requirements.md');
      writeFileSync(target, 'previous', 'utf-8');
      const delays: number[] = [];
      let attempts = 0;

      atomicWriteFileSync(target, 'replacement', {
        renameSync: (source, destination) => {
          attempts += 1;
          if (attempts < 3) {
            throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
          }
          renameSync(source, destination);
        },
        sleepSync: (milliseconds) => delays.push(milliseconds),
      });

      expect(attempts).toBe(3);
      expect(delays).toEqual([5, 10]);
      expect(readFileSync(target, 'utf-8')).toBe('replacement');
      expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
