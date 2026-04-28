import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { normalizeWorkspaceKey } from './workspace-key.js';

describe('normalizeWorkspaceKey', () => {
  test('returns an absolute path', () => {
    const out = normalizeWorkspaceKey('.');
    expect(isAbsolute(out)).toBe(true);
  });

  test('is idempotent', () => {
    const once = normalizeWorkspaceKey('.');
    const twice = normalizeWorkspaceKey(once);
    expect(twice).toBe(once);
  });

  if (process.platform === 'win32') {
    test('lowercases Windows paths for case-insensitive workspace keys', () => {
      expect(normalizeWorkspaceKey('C:\\Users\\Foo')).toBe('c:\\users\\foo');
      expect(normalizeWorkspaceKey('c:\\users\\foo')).toBe('c:\\users\\foo');
    });

    test('collapses upper/lower path variants to the same key', () => {
      expect(normalizeWorkspaceKey('C:\\Foo\\Bar')).toBe(normalizeWorkspaceKey('c:\\foo\\bar'));
    });
  }
});
