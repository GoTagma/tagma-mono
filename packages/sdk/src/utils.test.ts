import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePath } from './utils';

describe('validatePath', () => {
  test('rejects real parent traversal outside the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-validate-path-'));
    try {
      expect(() => validatePath('../outside', root)).toThrow(/escapes project root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allows project-local names that merely start with two dots', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-validate-path-'));
    try {
      const inside = join(root, '..inside');
      mkdirSync(inside);

      expect(validatePath('..inside', root)).toBe(inside);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
