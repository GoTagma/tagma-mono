import { describe, expect, test } from 'bun:test';
import { normalizePortableCwd, portableWorkspaceRelativePath } from '../src/utils/portable-cwd';

describe('portable cwd normalization', () => {
  test('keeps relative cwd values unchanged', () => {
    expect(normalizePortableCwd('src/tools', 'D:/repo')).toBe('src/tools');
    expect(normalizePortableCwd('./src', 'D:/repo')).toBe('./src');
  });

  test('converts absolute workspace paths to slash-separated relative cwd values', () => {
    expect(normalizePortableCwd('D:\\repo\\src\\tools', 'D:\\repo')).toBe('src/tools');
    expect(normalizePortableCwd('/home/me/repo/src/tools', '/home/me/repo')).toBe('src/tools');
  });

  test('represents the workspace root as dot', () => {
    expect(portableWorkspaceRelativePath('D:\\repo', 'D:\\repo')).toBe('.');
    expect(portableWorkspaceRelativePath('/home/me/repo', '/home/me/repo/')).toBe('.');
  });

  test('leaves absolute paths outside the workspace untouched', () => {
    expect(normalizePortableCwd('D:\\other\\src', 'D:\\repo')).toBe('D:\\other\\src');
    expect(normalizePortableCwd('/tmp/src', '/home/me/repo')).toBe('/tmp/src');
  });
});
