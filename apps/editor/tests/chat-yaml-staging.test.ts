import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseYaml } from '@tagma/sdk/yaml';

import {
  __chatYamlStagingTestHooks,
  createChatYamlStage,
  discardChatYamlStage,
  finalizeChatYamlStage,
  listChatYamlStage,
  samePipelineRelativePath,
} from '../server/chat-yaml-staging';
import { getFileVersion } from '../server/optimistic-lock';
import {
  pipelineCompileLogPath,
  pipelineLayoutPath,
  pipelineRequirementsPath,
  pipelineYamlPath,
} from '../server/pipeline-paths';
import { pipelineManifestPath } from '../server/pipeline-manifest';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-stage-'));
  roots.push(root);
  return root;
}

function yamlFor(name: string, prompt: string): string {
  return [
    'pipeline:',
    `  name: ${name}`,
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

function layoutFor(x: number): string {
  return JSON.stringify(
    {
      positions: { 'main.task': { x } },
      folders: [],
      trackHeights: { main: 140 },
    },
    null,
    2,
  );
}

function setupWorkspace(): {
  root: string;
  ws: WorkspaceState;
  sourcePath: string;
  baseYaml: string;
} {
  const root = makeRoot();
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const baseYaml = yamlFor('Base Pipeline', 'base');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, baseYaml, 'utf-8');
  writeFileSync(pipelineLayoutPath(sourcePath), layoutFor(20), 'utf-8');

  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(baseYaml);
  ws.layout = JSON.parse(layoutFor(20));
  ws.yamlVersion = getFileVersion(sourcePath);
  return { root, ws, sourcePath, baseYaml };
}

function stopWorkspace(ws: WorkspaceState): void {
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
}

afterEach(() => {
  delete __chatYamlStagingTestHooks.afterDestinationYamlWrite;
  delete __chatYamlStagingTestHooks.beforeFinalizeResultWrite;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat YAML staging', () => {
  test('keeps POSIX pipeline path identity case-sensitive', () => {
    expect(
      samePipelineRelativePath('pipeline/pipeline.yaml', 'Pipeline/Pipeline.yaml', 'linux'),
    ).toBe(false);
  });

  test('keeps Windows pipeline path identity case-insensitive', () => {
    expect(
      samePipelineRelativePath('pipeline/pipeline.yaml', 'Pipeline/Pipeline.yaml', 'win32'),
    ).toBe(true);
  });

  test('isolates agent writes and adopts them only when the source still matches base', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;

    expect(staged.stagedPath).not.toBe(sourcePath);
    expect(readFileSync(staged.stagedPath, 'utf-8')).toBe(baseYaml);

    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(agentYaml);
    expect(result.entry?.path).toBe(sourcePath);
    stopWorkspace(ws);
  });

  test('publishes an agent copy and persists the renderer branch when the user edited locally', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const localYaml = yamlFor('User Pipeline', 'user');
    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: localYaml,
        layout: JSON.parse(layoutFor(60)),
        changed: false,
      },
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(localYaml);
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'));
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('name: Agent Pipeline Copy 1');
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('ignores stale client dirty hints and compares the local branch with base on the server', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: JSON.parse(layoutFor(20)),
        changed: true,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).not.toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('never overwrites an external disk change and still publishes the agent result', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    const externalYaml = yamlFor('External Pipeline', 'external');
    writeFileSync(sourcePath, externalYaml, 'utf-8');

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: yamlFor('User Pipeline', 'user'),
        layout: JSON.parse(layoutFor(80)),
        changed: true,
      },
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(result.localBranchPersisted).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(externalYaml);
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('uses captured base hashes even if the on-disk base snapshot is altered', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    const externalYaml = yamlFor('External Pipeline', 'external');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    writeFileSync(sourcePath, externalYaml, 'utf-8');

    const baseYamlPath = join(stage.baseWorkspaceDir, '.tagma', ...staged.relativePath.split('/'));
    writeFileSync(baseYamlPath, externalYaml, 'utf-8');

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(externalYaml);
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('publishes a newly-created staged pipeline without treating it as a conflict copy', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const relativePath = 'created/created.yaml';
    const stagedPath = join(stage.agentTagmaDir, 'created', 'created.yaml');
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, yamlFor('Created Pipeline', 'created'), 'utf-8');
    writeFileSync(pipelineLayoutPath(stagedPath), layoutFor(20), 'utf-8');

    const listed = listChatYamlStage(ws, stage.id);
    const created = listed.entries.find((entry) => entry.relativePath === relativePath)!;
    expect(created.sourcePath).toBeNull();

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath,
    });

    expect(result.outcome).toBe('created');
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'created'));
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: created');
    stopWorkspace(ws);
  });

  test('returns unchanged and removes the writable stage when the agent did not edit YAML or layout', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;

    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(stage.agentWorkspaceDir)).toBe(false);
    stopWorkspace(ws);
  });

  test('publishes a requirements-only agent edit through the same CAS boundary', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(
      pipelineRequirementsPath(staged.stagedPath),
      '# Agent requirements\n\nKeep this guidance.\n',
      'utf-8',
    );

    const listed = listChatYamlStage(ws, stage.id);
    expect(
      listed.entries.find((entry) => entry.relativePath === staged.relativePath)?.requirementsHash,
    ).not.toBeNull();
    const result = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8')).toContain(
      'Keep this guidance.',
    );
    stopWorkspace(ws);
  });

  test('finalize is idempotent after the writable stage has been cleaned', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const first = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    const second = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(second).toEqual(first);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('discard removes an abandoned stage without touching source files', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });

    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    expect(existsSync(stage.rootDir)).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    stopWorkspace(ws);
  });

  test('rejects traversal targets without touching live files', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });

    expect(() =>
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: '../pipeline/pipeline.yaml',
      }),
    ).toThrow('stay inside the chat stage');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('validates every staged artifact before replacing the live branch', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), '{not-json', 'utf-8');

    expect(() =>
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).toThrow();
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('rolls back the live pipeline when a finalize write fails partway through', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), layoutFor(90), 'utf-8');
    __chatYamlStagingTestHooks.afterDestinationYamlWrite = (destinationPath) => {
      if (destinationPath === sourcePath) throw new Error('injected finalize failure');
    };

    expect(() =>
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).toThrow('injected finalize failure');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual(
      JSON.parse(layoutFor(20)),
    );
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('rolls back publication when the finalize result record cannot be written', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const initialLayout = structuredClone(ws.layout);
    const initialYamlVersion = ws.yamlVersion;
    const initialRevision = ws.stateRevision;
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), layoutFor(90), 'utf-8');
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected finalize result write failure');
    };

    expect(() =>
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).toThrow('injected finalize result write failure');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual(
      JSON.parse(layoutFor(20)),
    );
    expect(ws.config).toEqual(parseYaml(baseYaml));
    expect(ws.layout).toEqual(initialLayout);
    expect(ws.yamlVersion).toEqual(getFileVersion(sourcePath));
    expect(ws.yamlVersion).toMatchObject({
      size: initialYamlVersion?.size,
      hash: initialYamlVersion?.hash,
    });
    expect(ws.stateRevision).toBe(initialRevision);
    expect(existsSync(pipelineRequirementsPath(sourcePath))).toBe(false);
    expect(existsSync(pipelineManifestPath(sourcePath))).toBe(false);
    expect(existsSync(pipelineCompileLogPath(sourcePath))).toBe(false);
    expect(existsSync(join(stage.rootDir, 'finalized.json'))).toBe(false);

    delete __chatYamlStagingTestHooks.beforeFinalizeResultWrite;
    const firstRetry = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    const stableRetry = finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(firstRetry.outcome).toBe('adopted');
    expect(firstRetry.entry?.path).toBe(sourcePath);
    expect(stableRetry).toEqual(firstRetry);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('reuses the first copy number after a fork result record rolls back', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const copyPath = pipelineYamlPath(ws.workDir, 'pipeline-copy-1');
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected fork result write failure');
    };

    const input = {
      stageId: stage.id,
      relativePath: staged.relativePath,
      forceFork: true,
      forceForkReason: 'path-moved',
    } as const;
    expect(() => finalizeChatYamlStage(ws, input)).toThrow('injected fork result write failure');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(copyPath)).toBe(false);

    delete __chatYamlStagingTestHooks.beforeFinalizeResultWrite;
    const firstRetry = finalizeChatYamlStage(ws, input);
    const stableRetry = finalizeChatYamlStage(ws, input);

    expect(firstRetry.outcome).toBe('forked');
    expect(firstRetry.entry?.path).toBe(copyPath);
    expect(readFileSync(copyPath, 'utf-8')).toContain('prompt: agent');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(stableRetry).toEqual(firstRetry);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-2'))).toBe(false);
    stopWorkspace(ws);
  });
});
