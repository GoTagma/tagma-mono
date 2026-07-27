import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseYaml } from '@tagma/sdk/yaml';

import {
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from '../server/server-record-auth';
import {
  createChatYamlStage,
  finalizeChatYamlStage,
  listChatYamlStage,
} from '../server/chat-yaml-staging';
import { stopChatCompileWatcher } from '../server/chat-compile-watcher';
import { getFileVersion } from '../server/optimistic-lock';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];

function makeRoot(prefix = 'tagma-server-record-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function recordContext(
  workspaceTagmaDir: string,
  stageId: string,
  controlRoot: string,
  kind = 'trial-cache',
): ServerRecordContext {
  return { workspaceTagmaDir, stageId, controlRoot, kind };
}

function yamlFor(prompt: string): string {
  return [
    'pipeline:',
    '  name: Authenticated stage',
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      tasks:',
    '        - id: task',
    '          name: Task',
    `          prompt: ${prompt}`,
    '',
  ].join('\n');
}

function setupWorkspace(): {
  root: string;
  ws: WorkspaceState;
  sourcePath: string;
} {
  const root = makeRoot('tagma-auth-stage-');
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = yamlFor('base');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml, 'utf-8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({ opencodeChatTrialRunEnabled: false }, null, 2) + '\n',
    'utf-8',
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  ws.yamlVersion = getFileVersion(sourcePath);
  return { root, ws, sourcePath };
}

function stopWorkspace(ws: WorkspaceState): void {
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('server-authenticated control records', () => {
  test('round-trips a signed record while preserving the existing top-level payload', () => {
    const root = makeRoot();
    const workspaceTagmaDir = join(root, '.tagma');
    const stageId = '11111111-1111-4111-8111-111111111111';
    const controlRoot = join(workspaceTagmaDir, '.chat-staging', stageId, '.trial-runs');
    const recordPath = join(controlRoot, 'result.json');
    const context = recordContext(workspaceTagmaDir, stageId, controlRoot);
    const payload = { version: 4, inputHash: 'input', result: { success: true } };

    writeAuthenticatedServerRecordSync(recordPath, context, payload);

    expect(readAuthenticatedServerRecordSync(recordPath, context)).toEqual(payload);
    const stored = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
    expect(stored.version).toBe(4);
    expect(stored.result).toEqual({ success: true });
    expect(stored.__tagmaServerAuth).toBeObject();
  });

  test('rejects a payload bit flip and an unsigned forged success', () => {
    const root = makeRoot();
    const workspaceTagmaDir = join(root, '.tagma');
    const stageId = '22222222-2222-4222-8222-222222222222';
    const controlRoot = join(workspaceTagmaDir, '.chat-staging', stageId, '.trial-runs');
    const signedPath = join(controlRoot, 'signed.json');
    const unsignedPath = join(controlRoot, 'unsigned.json');
    const context = recordContext(workspaceTagmaDir, stageId, controlRoot);

    writeAuthenticatedServerRecordSync(signedPath, context, {
      version: 4,
      result: { success: true },
    });
    const tampered = JSON.parse(readFileSync(signedPath, 'utf-8')) as {
      result: { success: boolean };
    };
    tampered.result.success = false;
    writeFileSync(signedPath, JSON.stringify(tampered), 'utf-8');
    writeFileSync(
      unsignedPath,
      JSON.stringify({ version: 4, result: { success: true } }),
      'utf-8',
    );

    expect(() => readAuthenticatedServerRecordSync(signedPath, context)).toThrow(
      /authentication/i,
    );
    expect(() => readAuthenticatedServerRecordSync(unsignedPath, context)).toThrow(
      /authentication/i,
    );
  });

  test('binds authentication to record kind, stage id, and canonical path', () => {
    const root = makeRoot();
    const workspaceTagmaDir = join(root, '.tagma');
    const stageOne = '33333333-3333-4333-8333-333333333333';
    const stageTwo = '44444444-4444-4444-8444-444444444444';
    const rootOne = join(workspaceTagmaDir, '.chat-staging', stageOne, '.trial-runs');
    const rootTwo = join(workspaceTagmaDir, '.chat-staging', stageTwo, '.trial-runs');
    const pathOne = join(rootOne, 'result.json');
    const pathTwo = join(rootTwo, 'result.json');
    const contextOne = recordContext(workspaceTagmaDir, stageOne, rootOne);

    writeAuthenticatedServerRecordSync(pathOne, contextOne, {
      version: 4,
      result: { success: true },
    });
    mkdirSync(rootTwo, { recursive: true });
    copyFileSync(pathOne, pathTwo);

    expect(() =>
      readAuthenticatedServerRecordSync(
        pathTwo,
        recordContext(workspaceTagmaDir, stageTwo, rootTwo),
      ),
    ).toThrow(/authentication/i);
    expect(() =>
      readAuthenticatedServerRecordSync(pathOne, {
        ...contextOne,
        kind: 'finalized',
      }),
    ).toThrow(/authentication/i);
  });

  test('rejects a symbolic-link control directory before writing outside the stage', () => {
    const root = makeRoot();
    const outside = makeRoot('tagma-server-record-outside-');
    const workspaceTagmaDir = join(root, '.tagma');
    const stageId = '55555555-5555-4555-8555-555555555555';
    const stageRoot = join(workspaceTagmaDir, '.chat-staging', stageId);
    const controlRoot = join(stageRoot, '.trial-runs');
    mkdirSync(stageRoot, { recursive: true });
    symlinkSync(outside, controlRoot, 'junction');

    expect(() =>
      writeAuthenticatedServerRecordSync(
        join(controlRoot, 'result.json'),
        recordContext(workspaceTagmaDir, stageId, controlRoot),
        { version: 4, result: { success: true } },
      ),
    ).toThrow(/symbolic link/i);
    expect(() => readFileSync(join(outside, 'result.json'), 'utf-8')).toThrow();
  });
});

describe('authenticated chat YAML stage records', () => {
  test('rejects tampered stage metadata', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const metadataPath = join(stage.rootDir, 'stage.json');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
      createdAt: number;
    };
    metadata.createdAt += 1;
    writeFileSync(metadataPath, JSON.stringify(metadata), 'utf-8');

    expect(() => listChatYamlStage(ws, stage.id)).toThrow(/authentication/i);
    stopChatCompileWatcher(stage.agentTagmaDir);
    stopWorkspace(ws);
  });

  test('rejects a tampered finalized result instead of trusting forged idempotency', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('agent'), 'utf-8');
    finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    const finalizedPath = join(stage.rootDir, 'finalized.json');
    const finalized = JSON.parse(readFileSync(finalizedPath, 'utf-8')) as {
      outcome: string;
    };
    finalized.outcome = 'created';
    writeFileSync(finalizedPath, JSON.stringify(finalized), 'utf-8');

    expect(() =>
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).toThrow(/authentication/i);
    stopWorkspace(ws);
  });
});
