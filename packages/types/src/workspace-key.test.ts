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
    test('normalizes only the Windows root casing', () => {
      expect(normalizeWorkspaceKey('C:\\Users\\Foo')).toBe('c:\\Users\\Foo');
      expect(normalizeWorkspaceKey('c:\\Users\\Foo')).toBe('c:\\Users\\Foo');
    });
  }
});
