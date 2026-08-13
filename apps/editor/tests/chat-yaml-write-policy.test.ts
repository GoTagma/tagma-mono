import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createChatYamlStage, discardChatYamlStage } from '../server/chat-yaml-staging';
import { authorizeChatYamlStagePaths } from '../server/chat-yaml-write-policy';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];

function setupStage(): { root: string; ws: WorkspaceState; stageId: string; agentRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-write-policy-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'sample');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(
    sourcePath,
    'pipeline:\n  name: Sample\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: task\n          prompt: hello\n',
    'utf8',
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  return { root, ws, stageId: stage.id, agentRoot: stage.agentTagmaDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('staged child write policy', () => {
  test('allows normalized Windows aliases inside the authenticated agent root', () => {
    const { ws, stageId, agentRoot } = setupStage();
    try {
      const aliasRoot = process.platform === 'win32' ? agentRoot.toUpperCase() : agentRoot;
      const alias = `${aliasRoot.split('\\').join('/')}/sample/sample.yaml`;
      expect(
        authorizeChatYamlStagePaths(ws, { stageId, permission: 'edit', patterns: [alias] }),
      ).toEqual({ allowed: true, reason: null });
    } finally {
      discardChatYamlStage(ws, stageId);
    }
  });

  test('rejects live .tagma and traversal targets outside the agent root', () => {
    const { root, ws, stageId, agentRoot } = setupStage();
    try {
      const livePath = pipelineYamlPath(root, 'sample');
      expect(
        authorizeChatYamlStagePaths(ws, {
          stageId,
          permission: 'external_directory',
          patterns: [livePath],
        }),
      ).toEqual({ allowed: false, reason: expect.stringContaining('outside this turn') });
      expect(
        authorizeChatYamlStagePaths(ws, {
          stageId,
          permission: 'edit',
          patterns: ['sample/sample.yaml'],
        }),
      ).toEqual({ allowed: false, reason: expect.stringContaining('absolute path') });
      expect(
        authorizeChatYamlStagePaths(ws, {
          stageId,
          permission: 'edit',
          patterns: [join(agentRoot, '..', '..', '..', 'sample', 'sample.yaml')],
        }),
      ).toEqual({ allowed: false, reason: expect.stringContaining('outside this turn') });
    } finally {
      discardChatYamlStage(ws, stageId);
    }
  });

  test('rejects symlink/junction escapes and uninspectable shell writes', () => {
    const { root, ws, stageId, agentRoot } = setupStage();
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const link = join(agentRoot, 'linked-outside');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(
        authorizeChatYamlStagePaths(ws, {
          stageId,
          permission: 'edit',
          patterns: [join(link, 'escaped.yaml')],
        }),
      ).toEqual({ allowed: false, reason: expect.stringContaining('symbolic link') });
      expect(
        authorizeChatYamlStagePaths(ws, {
          stageId,
          permission: 'bash',
          patterns: ['Set-Content anything.yaml'],
        }),
      ).toEqual({ allowed: false, reason: expect.stringContaining('cannot be safely scoped') });
    } finally {
      discardChatYamlStage(ws, stageId);
    }
  });
});
