import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Response } from 'express';
import { parseYaml } from '@tagma/sdk/yaml';

import {
  __chatYamlStagingTestHooks,
  createChatYamlStage,
  discardChatYamlStage,
  discardChatYamlStageWithDisposition,
  finalizeChatYamlStage,
  listChatYamlStage,
  readFinalizedChatYamlStageResult,
  samePipelineRelativePath,
} from '../server/chat-yaml-staging';
import { getFileVersion, hasFileChanged } from '../server/optimistic-lock';
import { writeEditorSettings } from '../server/plugins/loader';
import {
  pipelineCompileLogPath,
  pipelineLayoutPath,
  pipelineRequirementsPath,
  pipelineYamlPath,
} from '../server/pipeline-paths';
import { pipelineManifestPath } from '../server/pipeline-manifest';
import {
  parseRequirementsMd,
  runRequirementsSync,
  serializeRequirementsMd,
} from '../server/requirements-sync';
import { WorkspaceState } from '../server/workspace-state';

const roots: string[] = [];

function mockStateEventResponse(chunks: string[]): Response {
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => undefined,
  } as unknown as Response;
}

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

function setupWorkspace(baseYaml = yamlFor('Base Pipeline', 'base')): {
  root: string;
  ws: WorkspaceState;
  sourcePath: string;
  baseYaml: string;
} {
  const root = makeRoot();
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, baseYaml, 'utf-8');
  writeFileSync(pipelineLayoutPath(sourcePath), layoutFor(20), 'utf-8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({ opencodeChatTrialRunEnabled: false }, null, 2) + '\n',
    'utf-8',
  );

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
  delete __chatYamlStagingTestHooks.captureHostWitnessAsync;
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

  test('isolates agent writes and adopts them only when the source still matches base', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;

    expect(staged.stagedPath).not.toBe(sourcePath);
    expect(readFileSync(staged.stagedPath, 'utf-8')).toBe(baseYaml);

    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    const stateEvents: string[] = [];
    ws.stateEventClients.add({ res: mockStateEventResponse(stateEvents) });

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(agentYaml);
    expect(result.entry?.path).toBe(sourcePath);
    expect(stateEvents.join('')).toContain('"origin":"chat-yaml-finalize"');
    stopWorkspace(ws);
  });

  test('publishes an agent copy and persists the renderer branch when the user edited locally', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const localYaml = yamlFor('User Pipeline', 'user');
    const result = await finalizeChatYamlStage(ws, {
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

  test('adopts Chat semantic YAML while preserving manual positions and track heights', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    const localLayout = {
      positions: { 'main.task': { x: 60, y: 90 } },
      folders: [],
      trackHeights: { main: 260 },
    };
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(agentYaml);
    expect(result.entry?.path).toBe(sourcePath);
    const adopted = parseYaml(readFileSync(sourcePath, 'utf-8'));
    expect(
      adopted.tracks.map((track) => ({
        id: track.id,
        taskIds: track.tasks.map((task) => task.id),
      })),
    ).toEqual([{ id: 'main', taskIds: ['task'] }]);
    const persistedLayout = JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'));
    expect(persistedLayout.positions).toEqual(localLayout.positions);
    expect(persistedLayout.trackHeights).toEqual(localLayout.trackHeights);
    expect(ws.layout.positions).toEqual(localLayout.positions);
    expect(ws.layout.trackHeights).toEqual(localLayout.trackHeights);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('merges Chat placement after the manual layout was flushed to disk', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = baseYaml
      .replace('name: Base Pipeline', 'name: Agent Pipeline')
      .replace(
        '          prompt: base',
        ['          prompt: agent', '        - id: added', '          command: echo added'].join(
          '\n',
        ),
      );
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify(
        {
          positions: {
            'main.task': { x: 20 },
            'main.added': { x: 340, y: 30 },
          },
          folders: [],
          trackHeights: { main: 140 },
        },
        null,
        2,
      ),
      'utf-8',
    );
    const localLayout = {
      positions: { 'main.task': { x: 75, y: 95 } },
      folders: [],
      trackHeights: { main: 280 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(localLayout, null, 2), 'utf-8');
    ws.layout = localLayout;

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(agentYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      positions: {
        'main.added': { x: 340, y: 30 },
        'main.task': { x: 75, y: 95 },
      },
      trackHeights: { main: 280 },
    });
    expect(ws.layout.positions).toEqual({
      'main.added': { x: 340, y: 30 },
      'main.task': { x: 75, y: 95 },
    });
    expect(ws.layout.trackHeights).toEqual({ main: 280 });
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('rejects a captured local branch for a different source path', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
        localBranch: {
          sourcePath: pipelineYamlPath(ws.workDir, 'different'),
          yaml: baseYaml,
          layout: JSON.parse(layoutFor(75)),
        },
      }),
    ).rejects.toThrow('Local branch path does not match the staged source pipeline.');

    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('forks when Chat and the user move the same existing position differently', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    const stagedLayout = {
      positions: { 'main.task': { x: 120 } },
      folders: [],
      trackHeights: { main: 140 },
    };
    const localLayout = {
      positions: { 'main.task': { x: 75 } },
      folders: [],
      trackHeights: { main: 140 },
    };
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify(stagedLayout, null, 2),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      positions: localLayout.positions,
      trackHeights: localLayout.trackHeights,
    });
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'));
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    expect(JSON.parse(readFileSync(pipelineLayoutPath(result.entry!.path), 'utf-8'))).toEqual({
      folders: [],
      positions: stagedLayout.positions,
      trackHeights: stagedLayout.trackHeights,
    });
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('merges position fields independently when the base position was absent', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    writeFileSync(
      pipelineLayoutPath(sourcePath),
      JSON.stringify({ trackHeights: { main: 140 } }, null, 2),
      'utf-8',
    );
    ws.layout = { positions: {}, trackHeights: { main: 140 } };
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify(
        {
          positions: { 'main.task': { x: 20 } },
          trackHeights: { main: 140 },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: {
          positions: { 'main.task': { x: 20, y: 90 } },
          trackHeights: { main: 140 },
        },
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(ws.layout.positions).toEqual({ 'main.task': { x: 20, y: 90 } });
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('forks divergent concurrent folder edits and preserves both branches', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const baseLayout = {
      positions: { 'main.task': { x: 20 } },
      folders: [
        {
          id: 'group',
          name: 'Base Group',
          trackIds: ['main'],
          collapsed: false,
        },
      ],
      trackHeights: { main: 140 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(baseLayout, null, 2), 'utf-8');
    ws.layout = baseLayout;
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const stagedLayout = {
      ...baseLayout,
      folders: [{ ...baseLayout.folders[0], name: 'Chat Group' }],
    };
    const localLayout = {
      ...baseLayout,
      folders: [{ ...baseLayout.folders[0], name: 'Manual Group' }],
    };
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify(stagedLayout, null, 2),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8')).folders).toEqual(
      localLayout.folders,
    );
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'));
    expect(
      JSON.parse(readFileSync(pipelineLayoutPath(result.entry!.path), 'utf-8')).folders,
    ).toEqual(stagedLayout.folders);
    stopWorkspace(ws);
  });

  test('adopts a staged task rename and prunes the obsolete manual position', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const renamedAgentYaml = yamlFor('Renamed Agent Pipeline', 'agent').replace(
      '        - id: task',
      '        - id: renamed',
    );
    const localLayout = JSON.parse(layoutFor(65));
    writeFileSync(staged.stagedPath, renamedAgentYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(renamedAgentYaml);
    expect(result.entry?.path).toBe(sourcePath);
    expect(ws.layout.positions).toEqual({});
    expect(ws.layout.trackHeights).toEqual({ main: 140 });
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('prunes a deleted track height and folder membership while preserving surviving edits', async () => {
    const baseYaml = [
      'pipeline:',
      '  name: Base Pipeline',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: task',
      '          command: echo main',
      '    - id: removed',
      '      name: Removed',
      '      tasks:',
      '        - id: task',
      '          command: echo removed',
      '',
    ].join('\n');
    const { ws, sourcePath } = setupWorkspace(baseYaml);
    const baseLayout = {
      positions: {
        'main.task': { x: 20 },
        'removed.task': { x: 40 },
      },
      folders: [
        {
          id: 'group',
          name: 'Group',
          trackIds: ['main', 'removed'],
          collapsed: false,
        },
      ],
      trackHeights: { main: 140, removed: 220 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(baseLayout, null, 2), 'utf-8');
    ws.layout = baseLayout;
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    const localLayout = {
      ...baseLayout,
      positions: {
        ...baseLayout.positions,
        'main.task': { x: 75 },
      },
      trackHeights: { main: 140, removed: 300 },
    };

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(true);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      folders: [
        {
          id: 'group',
          name: 'Group',
          trackIds: ['main'],
          collapsed: false,
        },
      ],
      positions: { 'main.task': { x: 75 } },
      trackHeights: { main: 140 },
    });
    expect(ws.layout.positions).toEqual({ 'main.task': { x: 75 } });
    expect(ws.layout.trackHeights).toEqual({ main: 140 });
    expect(ws.layout.folders?.[0]?.trackIds).toEqual(['main']);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('prunes deleted topology from the persisted staged layout without local edits', async () => {
    const baseYaml = [
      'pipeline:',
      '  name: Base Pipeline',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: task',
      '          command: echo main',
      '    - id: removed',
      '      name: Removed',
      '      tasks:',
      '        - id: task',
      '          command: echo removed',
      '',
    ].join('\n');
    const { ws, sourcePath } = setupWorkspace(baseYaml);
    const baseLayout = {
      positions: {
        'main.task': { x: 20 },
        'removed.task': { x: 40 },
      },
      folders: [
        {
          id: 'group',
          name: 'Group',
          trackIds: ['main', 'removed'],
          collapsed: false,
        },
      ],
      trackHeights: { main: 140, removed: 220 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(baseLayout, null, 2), 'utf-8');
    ws.layout = baseLayout;
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(false);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      folders: [
        {
          id: 'group',
          name: 'Group',
          trackIds: ['main'],
          collapsed: false,
        },
      ],
      positions: { 'main.task': { x: 20 } },
      trackHeights: { main: 140 },
    });
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('treats a missing base layout file as unchanged when the renderer reports the default empty layout', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    rmSync(pipelineLayoutPath(sourcePath), { force: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: { positions: {}, folders: [], trackHeights: {} },
        changed: false,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).not.toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('treats an agent-created default empty layout as unchanged from a missing base layout', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    rmSync(pipelineLayoutPath(sourcePath), { force: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify({ positions: {}, folders: [], trackHeights: {} }, null, 2),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(pipelineLayoutPath(sourcePath))).toBe(false);
    stopWorkspace(ws);
  });

  test('does not materialize an agent default empty layout when adopting other staged changes', async () => {
    const { ws, sourcePath } = setupWorkspace();
    rmSync(pipelineLayoutPath(sourcePath), { force: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify({ positions: {}, folders: [], trackHeights: {} }, null, 2),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    expect(existsSync(pipelineLayoutPath(sourcePath))).toBe(false);
    stopWorkspace(ws);
  });

  test('does not materialize a semantic empty local layout when another conflict forks', async () => {
    const { ws, sourcePath } = setupWorkspace();
    rmSync(pipelineLayoutPath(sourcePath), { force: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    const localYaml = yamlFor('User Pipeline', 'user');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      forceForkReason: 'path-moved',
      localBranch: {
        sourcePath,
        yaml: localYaml,
        layout: { positions: {}, folders: [], trackHeights: {} },
      },
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('path-moved');
    expect(result.conflicts).toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(localYaml);
    expect(existsSync(pipelineLayoutPath(sourcePath))).toBe(false);
    stopWorkspace(ws);
  });

  test('auto-merges a non-empty local layout when the base layout file was missing', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    rmSync(pipelineLayoutPath(sourcePath), { force: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    const localLayout = {
      positions: { 'main.task': { x: 60 } },
      folders: [],
      trackHeights: {},
    };

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      positions: localLayout.positions,
    });
    stopWorkspace(ws);
  });

  test('treats omitted empty layout fields as equivalent when other layout state is non-empty', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const baseLayout = {
      positions: { 'main.task': { x: 20, y: 40 } },
      trackHeights: { main: 140 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(baseLayout, null, 2), 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: {
          positions: { 'main.task': { y: 40, x: 20 } },
          folders: [],
          trackHeights: { main: 140 },
        },
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.conflicts).not.toContain('local-branch-changed');
    expect(result.localBranchPersisted).toBe(false);
    stopWorkspace(ws);
  });

  test('treats reordered non-empty staged layout objects as the same semantic artifact', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const baseLayout = {
      positions: {
        'main.task': { x: 20, y: 40 },
        'main.other': { x: 80, y: 10 },
      },
      folders: [],
      trackHeights: { main: 140 },
    };
    writeFileSync(pipelineLayoutPath(sourcePath), JSON.stringify(baseLayout, null, 2), 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const reorderedLayout = {
      trackHeights: { main: 140 },
      positions: {
        'main.other': { y: 10, x: 80 },
        'main.task': { y: 40, x: 20 },
      },
      folders: [],
    };
    writeFileSync(
      pipelineLayoutPath(staged.stagedPath),
      JSON.stringify(reorderedLayout, null, 2),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    stopWorkspace(ws);
  });

  test('ignores stale client dirty hints and compares the local branch with base on the server', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
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

  test('does not claim or reconcile an escaped live write without a staged mutation', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const escapedChatYaml = yamlFor('Agent Pipeline', 'agent');
    const localLayout = JSON.parse(layoutFor(60));

    // Simulate a delegated chat task escaping the stage and writing the live
    // pipeline while the renderer independently moves a task on the canvas.
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(escapedChatYaml);
    const persistedLayout = JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'));
    expect(persistedLayout).toEqual(JSON.parse(layoutFor(20)));
    expect(ws.config.name).toBe('Base Pipeline');
    expect(ws.layout.positions['main.task']?.x).toBe(20);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not adopt an escaped live rename when the stage is unchanged', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const escapedChatYaml = yamlFor('Agent Pipeline', 'agent').replace(
      '        - id: task',
      '        - id: renamed',
    );
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.compile.success).toBe(true);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      positions: { 'main.task': { x: 20 } },
      folders: [],
      trackHeights: { main: 140 },
    });
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('reports active live-source drift even when the staged branch is unchanged', () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const before = listChatYamlStage(ws, stage.id).entries.find(
      (entry) => entry.sourcePath === sourcePath,
    )!;
    expect(before.sourceChangedOnDisk).toBe(false);

    writeFileSync(sourcePath, yamlFor('Escaped Pipeline', 'escaped'), 'utf-8');
    const after = listChatYamlStage(ws, stage.id).entries.find(
      (entry) => entry.sourcePath === sourcePath,
    )!;
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.sourceChangedOnDisk).toBe(true);
    stopWorkspace(ws);
  });

  test('reconciles active live drift while publishing a different created pipeline', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const relativePath = 'created/created.yaml';
    const stagedPath = join(stage.agentTagmaDir, 'created', 'created.yaml');
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, yamlFor('Created Pipeline', 'created'), 'utf-8');
    writeFileSync(pipelineLayoutPath(stagedPath), layoutFor(30), 'utf-8');

    const listedBeforeDrift = listChatYamlStage(ws, stage.id);
    expect(
      listedBeforeDrift.entries.find((entry) => entry.sourcePath === sourcePath)
        ?.sourceChangedOnDisk,
    ).toBe(false);
    const escapedChatYaml = yamlFor('Escaped Pipeline', 'escaped');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');
    const localLayout = JSON.parse(layoutFor(85));

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath,
      activeLocalBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('created');
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'created'));
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: created');
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual({
      positions: localLayout.positions,
      trackHeights: localLayout.trackHeights,
    });
    const escapedCopyPath = pipelineYamlPath(ws.workDir, 'pipeline-copy-1');
    expect(readFileSync(escapedCopyPath, 'utf-8')).toContain('prompt: escaped');
    expect(ws.config.name).toBe('Base Pipeline');
    expect(ws.layout.positions['main.task']?.x).toBe(85);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('rolls back active drift reconciliation and a different created target together', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const relativePath = 'created/created.yaml';
    const stagedPath = join(stage.agentTagmaDir, 'created', 'created.yaml');
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, yamlFor('Created Pipeline', 'created'), 'utf-8');
    const escapedChatYaml = yamlFor('Escaped Pipeline', 'escaped');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected combined finalize result failure');
    };

    const input = {
      stageId: stage.id,
      relativePath,
      activeLocalBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: JSON.parse(layoutFor(90)),
      },
    } as const;
    await expect(finalizeChatYamlStage(ws, input)).rejects.toThrow(
      'injected combined finalize result failure',
    );

    expect(readFileSync(sourcePath, 'utf-8')).toBe(escapedChatYaml);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'created'))).toBe(false);
    expect(ws.config.name).toBe('Escaped Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    expect(existsSync(join(stage.rootDir, 'finalized.json'))).toBe(false);

    delete __chatYamlStagingTestHooks.beforeFinalizeResultWrite;
    const result = await finalizeChatYamlStage(ws, input);
    expect(result.outcome).toBe('created');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(readFileSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'), 'utf-8')).toContain(
      'prompt: escaped',
    );
    expect(readFileSync(pipelineYamlPath(ws.workDir, 'created'), 'utf-8')).toContain(
      'prompt: created',
    );
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('keeps active state separate when a different existing pipeline is adopted', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const otherPath = pipelineYamlPath(ws.workDir, 'other');
    const otherBaseYaml = yamlFor('Other Base Pipeline', 'other-base');
    mkdirSync(dirname(otherPath), { recursive: true });
    writeFileSync(otherPath, otherBaseYaml, 'utf-8');
    writeFileSync(pipelineLayoutPath(otherPath), layoutFor(25), 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const otherStaged = stage.entries.find((entry) => entry.sourcePath === otherPath)!;
    writeFileSync(otherStaged.stagedPath, yamlFor('Other Agent Pipeline', 'other-agent'), 'utf-8');

    const escapedChatYaml = yamlFor('Escaped Pipeline', 'escaped');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');
    const localLayout = JSON.parse(layoutFor(88));
    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: otherStaged.relativePath,
      activeLocalBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('adopted');
    expect(result.entry?.path).toBe(otherPath);
    expect(result.state.yamlPath).toBe(sourcePath);
    expect(result.localBranchPersisted).toBe(true);
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(readFileSync(otherPath, 'utf-8')).toContain('prompt: other-agent');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(readFileSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'), 'utf-8')).toContain(
      'prompt: escaped',
    );
    expect(ws.config.name).toBe('Base Pipeline');
    expect(ws.layout.positions['main.task']?.x).toBe(88);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('does not quarantine live drift when the stage is unchanged', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(sourcePath, yamlFor('Escaped Pipeline', 'escaped'), 'utf-8');
    writeFileSync(pipelineLayoutPath(sourcePath), '{not-json', 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.compile.success).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: escaped');
    expect(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8')).toBe('{not-json');
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not reconcile an unreadable live layout when the stage is unchanged', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    writeFileSync(pipelineLayoutPath(sourcePath), '{broken-base-layout', 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(sourcePath, yamlFor('Escaped Pipeline', 'escaped'), 'utf-8');
    const localLayout = JSON.parse(layoutFor(92));

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: escaped');
    expect(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8')).toBe('{broken-base-layout');
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not convert an escaped live write into a staged result', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const sourceSupportPath = join(dirname(sourcePath), 'prompts', 'policy.md');
    mkdirSync(dirname(sourceSupportPath), { recursive: true });
    writeFileSync(sourceSupportPath, 'base policy\n', 'utf-8');
    runRequirementsSync(sourcePath);
    const baseRequirements = parseRequirementsMd(
      readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8'),
    );
    writeFileSync(
      pipelineRequirementsPath(sourcePath),
      serializeRequirementsMd({
        frontmatter: baseRequirements.frontmatter,
        body: '# Base requirements\n\nKeep the base branch guidance.\n',
      }),
      'utf-8',
    );
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const escapedChatYaml = yamlFor('Agent Pipeline', 'agent');
    const localYaml = yamlFor('User Pipeline', 'user');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');
    writeFileSync(sourceSupportPath, 'chat policy\n', 'utf-8');
    const chatRequirements = parseRequirementsMd(
      readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8'),
    );
    writeFileSync(
      pipelineRequirementsPath(sourcePath),
      serializeRequirementsMd({
        frontmatter: chatRequirements.frontmatter,
        body: '# Chat requirements\n\nKeep the escaped Chat guidance.\n',
      }),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: localYaml,
        layout: JSON.parse(layoutFor(60)),
      },
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(escapedChatYaml);
    expect(result.entry!.path).toBe(sourcePath);
    expect(readFileSync(sourceSupportPath, 'utf-8')).toBe('chat policy\n');
    expect(readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8')).toContain(
      'Keep the escaped Chat guidance.',
    );
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not adopt an escaped live rename with local layout bookkeeping', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const renamedChatYaml = yamlFor('Renamed Pipeline', 'agent').replace(
      '        - id: task',
      '        - id: renamed',
    );
    const localLayout = JSON.parse(layoutFor(75));
    writeFileSync(sourcePath, renamedChatYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      localBranch: {
        sourcePath,
        yaml: baseYaml,
        layout: localLayout,
      },
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.localBranchPersisted).toBe(false);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(renamedChatYaml);
    expect(result.entry?.path).toBe(sourcePath);
    expect(ws.layout.positions).toEqual({ 'main.task': { x: 20 } });
    expect(ws.layout.trackHeights).toEqual({ main: 140 });
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not quarantine an invalid escaped live write when the stage is unchanged', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const invalidEscapedYaml = [
      'pipeline:',
      '  name: Invalid Escaped Pipeline',
      '  tracks: invalid',
      '',
    ].join('\n');
    writeFileSync(sourcePath, invalidEscapedYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.compile.success).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(invalidEscapedYaml);
    expect(result.entry!.path).toBe(sourcePath);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('leaves escaped live state untouched when unchanged-result persistence fails', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const escapedChatYaml = yamlFor('Escaped Pipeline', 'escaped');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected escaped finalize result failure');
    };

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow('injected escaped finalize result failure');

    expect(readFileSync(sourcePath, 'utf-8')).toBe(escapedChatYaml);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    expect(existsSync(join(stage.rootDir, 'finalized.json'))).toBe(false);
    stopWorkspace(ws);
  });

  test('does not refresh the optimistic-lock baseline for invalid escaped drift', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const invalidEscapedYaml = [
      'pipeline:',
      '  name: Invalid Escaped Pipeline',
      '  tracks: invalid',
      '',
    ].join('\n');
    writeFileSync(sourcePath, invalidEscapedYaml, 'utf-8');
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected invalid escaped finalize result failure');
    };

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow('injected invalid escaped finalize result failure');

    expect(readFileSync(sourcePath, 'utf-8')).toBe(invalidEscapedYaml);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    expect(existsSync(join(stage.rootDir, 'finalized.json'))).toBe(false);
    stopWorkspace(ws);
  });

  test('does not refresh the optimistic-lock baseline for deleted escaped drift', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    rmSync(sourcePath, { force: true });
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected deleted source finalize result failure');
    };

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
        localBranch: {
          sourcePath,
          yaml: baseYaml,
          layout: JSON.parse(layoutFor(70)),
        },
      }),
    ).rejects.toThrow('injected deleted source finalize result failure');

    expect(existsSync(sourcePath)).toBe(false);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    expect(existsSync(join(stage.rootDir, 'finalized.json'))).toBe(false);
    stopWorkspace(ws);
  });

  test('does not restore a deleted live source when the stage is unchanged', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    rmSync(sourcePath, { force: true });

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.trialVerification).toBe('not-required');
    expect(result.compile.success).toBe(true);
    expect(existsSync(sourcePath)).toBe(false);
    expect(result.entry).toBeNull();
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('does not run Trial or fork an escaped live write when the stage is unchanged', async () => {
    const { ws, sourcePath } = setupWorkspace();
    writeEditorSettings(ws, { opencodeChatTrialRunEnabled: true });
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const escapedChatYaml = yamlFor('Unverified Escaped Pipeline', 'escaped');
    writeFileSync(sourcePath, escapedChatYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.trialVerification).toBe('not-required');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(escapedChatYaml);
    expect(result.entry!.path).toBe(sourcePath);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(ws.config.name).toBe('Base Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(true);
    stopWorkspace(ws);
  });

  test('never overwrites an external disk change and still publishes the agent result', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    const externalYaml = yamlFor('External Pipeline', 'external');
    writeFileSync(sourcePath, externalYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
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
    expect(result.localBranchPersisted).toBe(true);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: user');
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    const externalCopyPath = pipelineYamlPath(ws.workDir, 'pipeline-copy-2');
    expect(readFileSync(externalCopyPath, 'utf-8')).toContain('prompt: external');
    expect(ws.config.name).toBe('User Pipeline');
    expect(hasFileChanged(sourcePath, ws.yamlVersion)).toBe(false);
    stopWorkspace(ws);
  });

  test('uses captured base hashes even if the on-disk base snapshot is altered', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const agentYaml = yamlFor('Agent Pipeline', 'agent');
    const externalYaml = yamlFor('External Pipeline', 'external');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');
    writeFileSync(sourcePath, externalYaml, 'utf-8');

    const baseYamlPath = join(stage.baseWorkspaceDir, '.tagma', ...staged.relativePath.split('/'));
    writeFileSync(baseYamlPath, externalYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(externalYaml);
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: agent');
    stopWorkspace(ws);
  });

  test('publishes a newly-created staged pipeline without treating it as a conflict copy', async () => {
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

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath,
    });

    expect(result.outcome).toBe('created');
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'created'));
    expect(readFileSync(result.entry!.path, 'utf-8')).toContain('prompt: created');
    stopWorkspace(ws);
  });

  test('keeps a path-conflicted new pipeline out of the primary path and saves a numbered copy', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const relativePath = 'created/created.yaml';
    const stagedPath = join(stage.agentTagmaDir, 'created', 'created.yaml');
    const primaryPath = pipelineYamlPath(ws.workDir, 'created');
    const copyPath = pipelineYamlPath(ws.workDir, 'created-copy-1');
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, yamlFor('Created Pipeline', 'created'), 'utf-8');
    writeFileSync(pipelineLayoutPath(stagedPath), layoutFor(20), 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath,
      forceForkReason: 'path-moved',
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('path-moved');
    expect(result.entry?.path).toBe(copyPath);
    expect(existsSync(primaryPath)).toBe(false);
    expect(readFileSync(copyPath, 'utf-8')).toContain('name: Created Pipeline Copy 1');
    expect(readFileSync(copyPath, 'utf-8')).toContain('prompt: created');
    stopWorkspace(ws);
  });

  test('rejects renderer-authored Trial failure as a fork reason', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    try {
      await expect(
        finalizeChatYamlStage(ws, {
          stageId: stage.id,
          relativePath: staged.relativePath,
          forceForkReason: 'trial-run-failed',
        } as never),
      ).rejects.toThrow('Trial verification is decided by the server');
    } finally {
      discardChatYamlStage(ws, stage.id);
      stopWorkspace(ws);
    }
  });

  test('publishes staged support files to a numbered copy while keeping the trial plan transient', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const relativePath = 'created/created.yaml';
    const stagedPath = join(stage.agentTagmaDir, 'created', 'created.yaml');
    const stagedDir = dirname(stagedPath);
    mkdirSync(join(stagedDir, 'input'), { recursive: true });
    mkdirSync(join(stagedDir, 'prompts'), { recursive: true });
    mkdirSync(join(stagedDir, 'assets'), { recursive: true });
    writeFileSync(stagedPath, yamlFor('Created Pipeline', 'created'), 'utf-8');
    writeFileSync(pipelineLayoutPath(stagedPath), layoutFor(20), 'utf-8');
    writeFileSync(join(stagedDir, 'input', 'text-to-check.md'), 'pipeline input\n', 'utf-8');
    writeFileSync(join(stagedDir, 'prompts', '01-ingest.md'), 'ingest prompt\n', 'utf-8');
    writeFileSync(join(stagedDir, 'trusted_sources.yaml'), 'sources: []\n', 'utf-8');
    writeFileSync(join(stagedDir, 'assets', 'policy.bin'), Uint8Array.of(0, 255, 1));
    writeFileSync(
      stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
      JSON.stringify({ version: 1 }) + '\n',
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath,
      forceForkReason: 'path-moved',
    });

    expect(result.outcome).toBe('forked');
    const publishedDir = dirname(result.entry!.path);
    expect(readFileSync(join(publishedDir, 'input', 'text-to-check.md'), 'utf-8')).toBe(
      'pipeline input\n',
    );
    expect(readFileSync(join(publishedDir, 'prompts', '01-ingest.md'), 'utf-8')).toBe(
      'ingest prompt\n',
    );
    expect(readFileSync(join(publishedDir, 'trusted_sources.yaml'), 'utf-8')).toBe('sources: []\n');
    expect([...readFileSync(join(publishedDir, 'assets', 'policy.bin'))]).toEqual([0, 255, 1]);
    expect(existsSync(result.entry!.path.replace(/\.ya?ml$/i, '.trial-plan.json'))).toBe(false);
    stopWorkspace(ws);
  });

  test('stages and adopts support-only edits for an existing pipeline', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const sourceDir = dirname(sourcePath);
    mkdirSync(join(sourceDir, 'prompts'), { recursive: true });
    writeFileSync(join(sourceDir, 'prompts', 'policy.md'), 'base policy\n', 'utf-8');
    writeFileSync(join(sourceDir, 'prompts', 'obsolete.md'), 'obsolete\n', 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const stagedDir = dirname(staged.stagedPath);

    expect(readFileSync(join(stagedDir, 'prompts', 'policy.md'), 'utf-8')).toBe('base policy\n');
    writeFileSync(join(stagedDir, 'prompts', 'policy.md'), 'agent policy\n', 'utf-8');
    rmSync(join(stagedDir, 'prompts', 'obsolete.md'));
    writeFileSync(join(stagedDir, 'prompts', 'added.md'), 'added\n', 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(readFileSync(join(sourceDir, 'prompts', 'policy.md'), 'utf-8')).toBe('agent policy\n');
    expect(existsSync(join(sourceDir, 'prompts', 'obsolete.md'))).toBe(false);
    expect(readFileSync(join(sourceDir, 'prompts', 'added.md'), 'utf-8')).toBe('added\n');
    stopWorkspace(ws);
  });

  test('forks support-only edits when the live support tree changed externally', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const sourcePrompt = join(dirname(sourcePath), 'prompts', 'policy.md');
    mkdirSync(dirname(sourcePrompt), { recursive: true });
    writeFileSync(sourcePrompt, 'base policy\n', 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(
      join(dirname(staged.stagedPath), 'prompts', 'policy.md'),
      'agent policy\n',
      'utf-8',
    );
    writeFileSync(sourcePrompt, 'external policy\n', 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('forked');
    expect(result.conflicts).toContain('source-changed-on-disk');
    expect(readFileSync(sourcePrompt, 'utf-8')).toBe('external policy\n');
    expect(readFileSync(join(dirname(result.entry!.path), 'prompts', 'policy.md'), 'utf-8')).toBe(
      'agent policy\n',
    );
    stopWorkspace(ws);
  });

  test('returns unchanged and removes the writable stage when the agent did not edit YAML or layout', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('unchanged');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(stage.agentWorkspaceDir)).toBe(false);
    stopWorkspace(ws);
  });

  test('does not create a conflict copy when an existing staged pipeline is unchanged', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const copyPath = pipelineYamlPath(ws.workDir, 'pipeline-copy-1');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      forceForkReason: 'path-moved',
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(result.entry?.path).toBe(sourcePath);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(copyPath)).toBe(false);
    stopWorkspace(ws);
  });

  test('does not publish live drift when the agent made no staged mutation', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const externallyChanged = yamlFor('External Pipeline', 'external');
    writeFileSync(sourcePath, externallyChanged, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      forceForkReason: 'path-moved',
      localBranch: {
        sourcePath,
        yaml: yamlFor('Different Canvas Pipeline', 'canvas'),
        layout: JSON.parse(layoutFor(90)),
        changed: true,
      },
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.conflicts).toEqual([]);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(externallyChanged);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('rebases a pipeline-local cwd when a conflicted staged edit is saved as a numbered copy', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace(
      yamlFor('Untitled Pipeline', 'placeholder'),
    );
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const stagedInputPath = join(dirname(staged.stagedPath), 'input').replace(/\\/g, '/');
    const sharedInputPath = join(ws.workDir, 'shared-input').replace(/\\/g, '/');
    const agentYaml = [
      'pipeline:',
      '  name: Fact Checker',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      cwd: .tagma/pipeline',
      '      middlewares:',
      '        - type: static_context',
      '          file: rubric.md',
      '      tasks:',
      '        - id: task',
      '          name: Task',
      '          prompt: check facts',
      '          trigger:',
      '            type: directory',
      `            path: '${stagedInputPath}'`,
      '          completion:',
      '            type: file_exists',
      '            path: report.md',
      '        - id: nested',
      '          name: Nested',
      '          prompt: check nested facts',
      '          cwd: .tagma/pipeline/nested',
      '        - id: shared',
      '          name: Shared',
      '          prompt: check shared facts',
      '          cwd: .tagma/shared',
      '          trigger:',
      '            type: directory',
      `            path: '${sharedInputPath}'`,
      '',
    ].join('\n');
    writeFileSync(staged.stagedPath, agentYaml, 'utf-8');

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      forceForkReason: 'path-moved',
    });

    expect(result.outcome).toBe('forked');
    expect(result.entry?.path).toBe(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'));
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(result.state.config.name).toBe('Untitled Pipeline');
    const copied = parseYaml(readFileSync(result.entry!.path, 'utf-8'));
    expect(copied.tracks[0]?.cwd).toBe('.tagma/pipeline-copy-1');
    const copiedTrack = copied.tracks[0]!;
    expect(copiedTrack.middlewares?.[0]?.file).toBe('rubric.md');
    expect(copiedTrack.tasks[0]?.trigger?.path).toBe(join(dirname(result.entry!.path), 'input'));
    expect(copiedTrack.tasks[0]?.completion?.path).toBe('report.md');
    expect(copiedTrack.tasks[1]?.cwd).toBe('.tagma/pipeline-copy-1/nested');
    expect(copiedTrack.tasks[2]?.cwd).toBe('.tagma/shared');
    expect(copiedTrack.tasks[2]?.trigger?.path).toBe(sharedInputPath);
    stopWorkspace(ws);
  });

  test('does not treat watcher initialization as an agent edit to an existing pipeline', async () => {
    const invalidYaml = yamlFor('Invalid Pipeline', '');
    const { ws, sourcePath } = setupWorkspace(invalidYaml);
    runRequirementsSync(sourcePath);
    const liveRequirements = readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8');
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const baselineHashes = {
      contentHash: staged.contentHash,
      layoutHash: staged.layoutHash,
      requirementsHash: staged.requirementsHash,
    };

    // The watcher debounces for 150ms. With zero agent writes, waiting beyond
    // that boundary must not compile the pre-copied pipeline or refresh the
    // generatedAt timestamp in its requirements document.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const listed = listChatYamlStage(ws, stage.id);
    const unchanged = listed.entries.find((entry) => entry.relativePath === staged.relativePath)!;
    const observedHashes = {
      contentHash: unchanged.contentHash,
      layoutHash: unchanged.layoutHash,
      requirementsHash: unchanged.requirementsHash,
    };
    const stagedRequirements = readFileSync(
      pipelineRequirementsPath(unchanged.stagedPath),
      'utf-8',
    );

    // allowInvalid matches the chat reconciliation path for preserving a
    // compile-failing agent branch. The untouched invalid source must still be
    // recognized as unchanged, never published as a visible numbered copy.
    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      allowInvalid: true,
    });

    expect({
      ...observedHashes,
      outcome: result.outcome,
      conflicts: result.conflicts,
      copyExists: existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1')),
    }).toEqual({
      ...baselineHashes,
      outcome: 'unchanged',
      conflicts: [],
      copyExists: false,
    });
    expect(stagedRequirements).toBe(liveRequirements);
    expect(readFileSync(sourcePath, 'utf-8')).toBe(invalidYaml);
    stopWorkspace(ws);
  });

  test('publishes a requirements-only agent edit through the same CAS boundary', async () => {
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
    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(result.outcome).toBe('adopted');
    expect(readFileSync(pipelineRequirementsPath(sourcePath), 'utf-8')).toContain(
      'Keep this guidance.',
    );
    stopWorkspace(ws);
  });

  test('rejects a repaired YAML while its agent-owned requirements still describe removed dependencies', async () => {
    const baseYaml = [
      'pipeline:',
      '  name: TEMP Report',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: write',
      '          name: Write report',
      '          command: |',
      '            $target = Join-Path $env:TEMP "casual-demo-report.txt"',
      '            if (Test-Path $target) { Remove-Item $target }',
      "            Set-Content -Path $target -Value 'hello'",
      '',
    ].join('\n');
    const repairedYaml = [
      'pipeline:',
      '  name: Relative Report',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: write',
      '          name: Write report',
      '          command: |',
      "            Set-Content -Path 'casual-demo-report.txt' -Value 'hello'",
      '',
    ].join('\n');
    const { ws, sourcePath } = setupWorkspace(baseYaml);
    runRequirementsSync(sourcePath);
    const liveRequirementsPath = pipelineRequirementsPath(sourcePath);
    const generated = parseRequirementsMd(readFileSync(liveRequirementsPath, 'utf-8'));
    writeFileSync(
      liveRequirementsPath,
      serializeRequirementsMd({
        frontmatter: generated.frontmatter,
        body: [
          '# TEMP report requirements',
          '',
          'The pipeline uses `Join-Path` and `Test-Path` with `$env:TEMP`.',
          '',
        ].join('\n'),
      }),
      'utf-8',
    );

    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, repairedYaml, 'utf-8');
    runRequirementsSync(staged.stagedPath);

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow(
      'requirements still reference removed pipeline dependencies: environment variable TEMP, PowerShell cmdlet Join-Path, PowerShell cmdlet Test-Path',
    );
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);

    const stagedRequirementsPath = pipelineRequirementsPath(staged.stagedPath);
    const stagedRequirements = parseRequirementsMd(readFileSync(stagedRequirementsPath, 'utf-8'));
    writeFileSync(
      stagedRequirementsPath,
      serializeRequirementsMd({
        frontmatter: stagedRequirements.frontmatter,
        body: '# Relative report requirements\n\nWrites only inside the run workspace.\n',
      }),
      'utf-8',
    );

    const result = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    expect(result.outcome).toBe('adopted');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(repairedYaml);
    stopWorkspace(ws);
  });

  test('finalize is idempotent after the writable stage has been cleaned', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');

    const first = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    const second = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(second).toEqual(first);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    ws.stateRevision++;
    const recovered = readFinalizedChatYamlStageResult(ws, stage.id);
    expect(recovered).not.toBeNull();
    expect(recovered?.outcome).toBe(first.outcome);
    expect(recovered?.entry?.path).toBe(first.entry?.path);
    expect(recovered?.revision).toBe(ws.stateRevision);
    expect(recovered?.state.revision).toBe(ws.stateRevision);
    expect(discardChatYamlStageWithDisposition(ws, stage.id)).toBe('finalized');
    expect(discardChatYamlStage(ws, stage.id)).toBe(false);
    stopWorkspace(ws);
  });

  test('publishes multiple staged pipelines incrementally and keeps each target idempotent', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const first = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    const secondPath = join(stage.agentTagmaDir, 'second-pipeline', 'second-pipeline.yaml');
    mkdirSync(dirname(secondPath), { recursive: true });
    writeFileSync(first.stagedPath, yamlFor('First Pipeline', 'first'), 'utf-8');
    writeFileSync(secondPath, yamlFor('Second Pipeline', 'second'), 'utf-8');

    const firstResult = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: first.relativePath,
      retainStage: true,
    });
    const firstRetry = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: first.relativePath,
      retainStage: true,
    });

    expect(firstRetry).toEqual(firstResult);
    expect(firstResult.outcome).toBe('adopted');
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: first');
    expect(listChatYamlStage(ws, stage.id).entries).toHaveLength(2);

    const secondResult = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: 'second-pipeline/second-pipeline.yaml',
    });
    const secondLivePath = pipelineYamlPath(ws.workDir, 'second-pipeline');
    expect(secondResult.outcome).toBe('created');
    expect(secondResult.entry?.path).toBe(secondLivePath);
    expect(readFileSync(secondLivePath, 'utf-8')).toContain('prompt: second');
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: first');
    expect(existsSync(pipelineYamlPath(ws.workDir, 'second-pipeline-copy-1'))).toBe(false);

    const secondRetry = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: 'second-pipeline/second-pipeline.yaml',
    });
    expect(secondRetry).toEqual(secondResult);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'second-pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('rejects a tampered per-target finalize record without republishing', async () => {
    const { ws, sourcePath } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Authenticated Pipeline', 'authenticated'), 'utf-8');
    const first = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
      retainStage: true,
    });
    expect(first.outcome).toBe('adopted');

    const resultDir = join(stage.rootDir, 'finalized-results');
    const [resultFile] = readdirSync(resultDir);
    expect(resultFile).toEndWith('.json');
    const resultPath = join(resultDir, resultFile!);
    const tampered = JSON.parse(readFileSync(resultPath, 'utf-8')) as Record<string, unknown>;
    tampered.relativePath = 'other/other.yaml';
    writeFileSync(resultPath, JSON.stringify(tampered, null, 2) + '\n', 'utf-8');

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
        retainStage: true,
      }),
    ).rejects.toThrow('authentication failed');
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: authenticated');
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('discard removes an abandoned stage without touching source files', () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });

    expect(discardChatYamlStageWithDisposition(ws, stage.id)).toBe('discarded');
    expect(existsSync(stage.rootDir)).toBe(false);
    expect(discardChatYamlStageWithDisposition(ws, stage.id)).toBe('missing');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    stopWorkspace(ws);
  });

  test('rejects traversal targets without touching live files', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: '../pipeline/pipeline.yaml',
      }),
    ).rejects.toThrow('stay inside the chat stage');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('validates every staged artifact before replacing the live branch', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), '{not-json', 'utf-8');

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow();
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('rolls back the live pipeline when a finalize write fails partway through', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), layoutFor(90), 'utf-8');
    __chatYamlStagingTestHooks.afterDestinationYamlWrite = (destinationPath) => {
      if (destinationPath === sourcePath) throw new Error('injected finalize failure');
    };

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow('injected finalize failure');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(JSON.parse(readFileSync(pipelineLayoutPath(sourcePath), 'utf-8'))).toEqual(
      JSON.parse(layoutFor(20)),
    );
    expect(discardChatYamlStage(ws, stage.id)).toBe(true);
    stopWorkspace(ws);
  });

  test('rolls back publication when the finalize result record cannot be written', async () => {
    const { ws, sourcePath, baseYaml } = setupWorkspace();
    const sourcePrompt = join(dirname(sourcePath), 'prompts', 'policy.md');
    mkdirSync(dirname(sourcePrompt), { recursive: true });
    writeFileSync(sourcePrompt, 'base policy\n', 'utf-8');
    const initialLayout = structuredClone(ws.layout);
    const initialYamlVersion = ws.yamlVersion;
    const initialRevision = ws.stateRevision;
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const staged = stage.entries.find((entry) => entry.sourcePath === sourcePath)!;
    writeFileSync(staged.stagedPath, yamlFor('Agent Pipeline', 'agent'), 'utf-8');
    writeFileSync(pipelineLayoutPath(staged.stagedPath), layoutFor(90), 'utf-8');
    writeFileSync(
      join(dirname(staged.stagedPath), 'prompts', 'policy.md'),
      'agent policy\n',
      'utf-8',
    );
    __chatYamlStagingTestHooks.beforeFinalizeResultWrite = () => {
      throw new Error('injected finalize result write failure');
    };

    await expect(
      finalizeChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: staged.relativePath,
      }),
    ).rejects.toThrow('injected finalize result write failure');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(readFileSync(sourcePrompt, 'utf-8')).toBe('base policy\n');
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
    const firstRetry = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });
    const stableRetry = await finalizeChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: staged.relativePath,
    });

    expect(firstRetry.outcome).toBe('adopted');
    expect(firstRetry.entry?.path).toBe(sourcePath);
    expect(stableRetry).toEqual(firstRetry);
    expect(readFileSync(sourcePrompt, 'utf-8')).toBe('agent policy\n');
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-1'))).toBe(false);
    stopWorkspace(ws);
  });

  test('reuses the first copy number after a fork result record rolls back', async () => {
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
      forceForkReason: 'path-moved',
    } as const;
    await expect(finalizeChatYamlStage(ws, input)).rejects.toThrow(
      'injected fork result write failure',
    );
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(existsSync(copyPath)).toBe(false);

    delete __chatYamlStagingTestHooks.beforeFinalizeResultWrite;
    const firstRetry = await finalizeChatYamlStage(ws, input);
    const stableRetry = await finalizeChatYamlStage(ws, input);

    expect(firstRetry.outcome).toBe('forked');
    expect(firstRetry.entry?.path).toBe(copyPath);
    expect(readFileSync(copyPath, 'utf-8')).toContain('prompt: agent');
    expect(readFileSync(sourcePath, 'utf-8')).toBe(baseYaml);
    expect(stableRetry).toEqual(firstRetry);
    expect(existsSync(pipelineYamlPath(ws.workDir, 'pipeline-copy-2'))).toBe(false);
    stopWorkspace(ws);
  });
});
