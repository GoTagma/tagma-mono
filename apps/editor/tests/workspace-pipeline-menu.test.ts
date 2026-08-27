import { describe, expect, test } from 'bun:test';
import type { ChatYamlStageEntry, WorkspaceYamlEntry } from '../src/api/client';
import { buildWorkspacePipelineMenuItems } from '../src/utils/workspace-yaml-list';

const WORK_DIR = 'C:/repo';

type StagedTarget = ChatYamlStageEntry & { stageId: string };

function liveEntry(
  stem: string,
  pipelineName: string,
  overrides: Partial<WorkspaceYamlEntry> = {},
): WorkspaceYamlEntry {
  return {
    name: `${stem}.yaml`,
    path: `${WORK_DIR}/.tagma/${stem}/${stem}.yaml`,
    pipelineName,
    contentHash: `${stem}-live`,
    layoutHash: null,
    layoutMtimeMs: null,
    layoutSize: null,
    mtimeMs: 1,
    size: 1,
    ...overrides,
  };
}

function stagedTarget(
  stageId: string,
  stem: string,
  pipelineName: string,
  sourcePath: string | null = null,
): StagedTarget {
  const stagedPath =
    `${WORK_DIR}/.tagma/.chat-staging/${stageId}` + `/agent-workspace/.tagma/${stem}/${stem}.yaml`;
  return {
    ...liveEntry(stem, pipelineName, {
      path: stagedPath,
      contentHash: `${stem}-staged`,
      mtimeMs: 2,
    }),
    stageId,
    stagedPath,
    relativePath: `${stem}/${stem}.yaml`,
    sourcePath,
    requirementsHash: null,
  };
}

function menuText(item: { label: string; subLabel?: string }): string {
  return [item.label, item.subLabel].filter(Boolean).join(' ');
}

describe('workspace pipeline menu', () => {
  test('keeps live pipelines actionable and exposes only new staged targets as Temporary', () => {
    const build = liveEntry('build', 'Build');
    const draft = stagedTarget('stage-a', 'draft', 'Draft');
    const stagedEditOfBuild = stagedTarget('stage-a', 'build', 'Build draft', build.path);
    const opened: string[] = [];
    const deleted: string[] = [];

    const items = buildWorkspacePipelineMenuItems({
      workDir: WORK_DIR,
      liveEntries: [build],
      stagedTargets: [draft, stagedEditOfBuild],
      activeYamlName: build.name,
      yamlEditLocked: false,
      onOpen: (path) => opened.push(path),
      onDelete: (path) => deleted.push(path),
    });

    expect(items).toHaveLength(2);
    const liveItem = items.find((item) => menuText(item).includes('Build'));
    const temporaryItem = items.find((item) => menuText(item).includes('Draft'));

    expect(liveItem).toMatchObject({ disabled: false });
    expect(liveItem?.onDelete).toBeFunction();
    liveItem?.onAction();
    liveItem?.onDelete?.();
    expect(opened).toEqual([build.path]);
    expect(deleted).toEqual([build.path]);

    expect(temporaryItem).toMatchObject({ disabled: true });
    expect(menuText(temporaryItem!)).toContain('Temporary');
    expect(temporaryItem?.onDelete).toBeUndefined();
    expect(menuText(items[0]!)).not.toContain('Build draft');
  });

  test('prefers the live pipeline when a late staged listing reports the same target', () => {
    const liveDraft = liveEntry('draft', 'Published Draft');
    const lateTemporaryDraft = stagedTarget('stage-a', 'draft', 'Temporary Draft');

    const items = buildWorkspacePipelineMenuItems({
      workDir: WORK_DIR,
      liveEntries: [liveDraft],
      stagedTargets: [lateTemporaryDraft],
      activeYamlName: liveDraft.name,
      yamlEditLocked: false,
      onOpen: () => {},
      onDelete: () => {},
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ disabled: false });
    expect(menuText(items[0]!)).toContain('Published Draft');
    expect(menuText(items[0]!)).not.toContain('Temporary');
  });

  test('shows one Temporary item when multiple stages target the same new pipeline', () => {
    const items = buildWorkspacePipelineMenuItems({
      workDir: WORK_DIR,
      liveEntries: [],
      stagedTargets: [
        stagedTarget('stage-a', 'draft', 'First Draft'),
        stagedTarget('stage-b', 'draft', 'Second Draft'),
      ],
      activeYamlName: null,
      yamlEditLocked: false,
      onOpen: () => {},
      onDelete: () => {},
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ disabled: true });
    expect(menuText(items[0]!)).toContain('First Draft');
    expect(menuText(items[0]!)).toContain('Temporary');
  });
});
