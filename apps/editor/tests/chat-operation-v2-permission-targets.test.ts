import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { isChatPermissionTargetSummary } from '../shared/chat-permission-targets';
import { describeChatPermissionTargets } from '../server/chat-operations/permission-targets';

test('permission target evidence describes reads and multi-file edits without exposing absolute roots', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'tagma-permission-targets-'));
  const agentRoot = join(workDir, '.tagma', '.chat-staging', 'stage', 'agent-workspace', '.tagma');
  mkdirSync(agentRoot, { recursive: true });
  try {
    const file = join(agentRoot, '分析', 'pipeline.yaml');
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'read',
        patterns: [relative(workDir, file)],
      }),
    ).toEqual({ targets: ['分析/pipeline.yaml'], omitted: 0 });
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'edit',
        patterns: ['display-only'],
        metadata: { files: [{ filePath: file, movePath: join(agentRoot, 'new', 'new.yaml') }] },
      }),
    ).toEqual({ targets: ['分析/pipeline.yaml', 'new/new.yaml'], omitted: 0 });
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'read',
        patterns: [join(workDir, 'outside.txt')],
      }),
    ).toBeUndefined();
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'read',
        patterns: ['../outside.txt'],
      }),
    ).toBeUndefined();
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'write',
        patterns: [file],
        metadata: { filepath: 'relative-is-not-execution-metadata' },
      }),
    ).toBeUndefined();
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'bash',
        patterns: ['echo private'],
      }),
    ).toBeUndefined();
    expect(
      describeChatPermissionTargets({
        workDir,
        agentRoot,
        permission: 'read',
        patterns: Array.from({ length: 12 }, (_, i) => join(agentRoot, 'files', `${i}.txt`)),
      }),
    ).toMatchObject({ targets: expect.any(Array), omitted: 4 });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('display summaries reject credentials, absolute coordinates, traversal and excess entries', () => {
  for (const target of [
    'C:/private/file',
    '/home/private/file',
    '../escape',
    'folder/../escape',
    'token=secret-value',
    'https://example.test',
    'line\nbreak',
  ]) {
    expect(isChatPermissionTargetSummary({ targets: [target], omitted: 0 })).toBe(false);
  }
  expect(isChatPermissionTargetSummary({ targets: Array(9).fill('file.yaml'), omitted: 0 })).toBe(
    false,
  );
  expect(isChatPermissionTargetSummary({ targets: ['file.yaml'], omitted: -1 })).toBe(false);
  expect(isChatPermissionTargetSummary({ targets: ['file.yaml'], omitted: 2 })).toBe(true);
  expect(isChatPermissionTargetSummary({ targets: Array(1), omitted: 0 })).toBe(false);
  expect(isChatPermissionTargetSummary({ targets: ['safe/\u202Etxt.exe'], omitted: 0 })).toBe(
    false,
  );
});
