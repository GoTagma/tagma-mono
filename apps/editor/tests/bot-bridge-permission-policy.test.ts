import { describe, expect, test } from 'bun:test';
import { classifyTool, renderPermissionPrompt } from '../server/chat-bridge/permission-policy';

describe('permission-policy classifyTool', () => {
  test('read-class tools auto-approve', () => {
    for (const t of [
      'read',
      'Read',
      'file_read',
      'fs.read',
      'glob',
      'grep',
      'list',
      'list_files',
      'view',
      'search',
      'find',
      'todo_read',
      'fetch_metadata',
    ]) {
      expect(classifyTool(t)).toBe('auto-allow');
    }
  });

  test('write / exec / network tools need approval', () => {
    for (const t of [
      'bash',
      'shell',
      'exec',
      'write',
      'file_write',
      'edit',
      'multiedit',
      'patch',
      'delete',
      'rm',
      'mv',
      'rename',
      'create',
      'todo_write',
      'webfetch',
      'web_fetch',
      'curl',
      'git_commit',
      'push',
    ]) {
      expect(classifyTool(t)).toBe('needs-approval');
    }
  });

  test('write hint wins when both read and write substrings are present', () => {
    // "edit" is a write hint; even though it contains no read hint, a name
    // like "read_and_write" must land on the safe side.
    expect(classifyTool('read_and_write')).toBe('needs-approval');
    expect(classifyTool('write_after_read')).toBe('needs-approval');
  });

  test('unknown / empty tools default to needs-approval (default-deny)', () => {
    expect(classifyTool('frobnicate')).toBe('needs-approval');
    expect(classifyTool('')).toBe('needs-approval');
    expect(classifyTool(null)).toBe('needs-approval');
    expect(classifyTool(undefined)).toBe('needs-approval');
  });

  test('renderPermissionPrompt includes the tool name and truncates long titles', () => {
    const short = renderPermissionPrompt('bash', 'rm -rf build');
    expect(short).toContain('bash');
    expect(short).toContain('rm -rf build');
    const long = renderPermissionPrompt('bash', 'x'.repeat(500));
    expect(long.length).toBeLessThan(300);
    expect(long).toContain('…');
  });
});
