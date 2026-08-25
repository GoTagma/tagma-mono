import { describe, expect, test } from 'bun:test';
import type {
  ChatYamlStageEntry,
  ChatYamlStageFinalizeResult,
  WorkspaceYamlEntry,
} from '../src/api/client';
import {
  buildWorkspacePipelineMenuItems,
  failedChatDraftPaths,
  reconcileFinalizedWorkspacePipelines,
} from '../src/utils/workspace-yaml-list';

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

function finalizedLiveEntry(
  stem: string,
  pipelineName: string,
  contentHash: string,
): ChatYamlStageEntry {
  const entry = liveEntry(stem, pipelineName, { contentHash, mtimeMs: 3 });
  return {
    ...entry,
    stagedPath: entry.path,
    relativePath: `${stem}/${stem}.yaml`,
    sourcePath: entry.path,
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

  test('moves preserved failed Chat drafts behind ordinary pipelines and labels them', () => {
    const failed = liveEntry('fact-checker-copy-1', 'Fact Checker Copy 1');
    const active = liveEntry('active', 'Active Pipeline');
    const items = buildWorkspacePipelineMenuItems({
      workDir: WORK_DIR,
      liveEntries: [failed, active],
      stagedTargets: [],
      activeYamlName: active.name,
      failedDraftPaths: new Set([failed.path]),
      yamlEditLocked: false,
      onOpen: () => {},
      onDelete: () => {},
    });

    expect(menuText(items[0]!)).toContain('Active Pipeline');
    expect(menuText(items[1]!)).toContain('Fact Checker Copy 1');
    expect(menuText(items[1]!)).toContain('Failed Chat draft');
  });

  test('identifies only unchanged live forks whose latest durable Chat result is failed', () => {
    const failedCopy = liveEntry('fact-checker-copy-1', 'Fact Checker Copy 1', {
      contentHash: 'failed-copy-hash',
    });
    const repairedCopy = liveEntry('fact-checker-copy-2', 'Fact Checker Copy 2', {
      contentHash: 'repaired-copy-hash',
    });
    const editedCopy = liveEntry('fact-checker-copy-3', 'Fact Checker Copy 3', {
      contentHash: 'user-edited-hash',
    });
    const ordinaryFailure = liveEntry('ordinary', 'Ordinary', {
      contentHash: 'ordinary-failure-hash',
    });
    const result = (
      path: string,
      contentHash: string,
      status: 'ready' | 'failed',
      completedAt: number,
      outcome: 'adopted' | 'forked' = 'forked',
      workspaceKey = WORK_DIR,
      resultId?: string,
    ) =>
      ({
        path,
        workspaceKey,
        status,
        completedAt,
        finalYamlContentHash: contentHash,
        reconcile: { outcome },
        ...(resultId ? { resultId } : {}),
      }) as never;

    const paths = failedChatDraftPaths(
      [failedCopy, repairedCopy, editedCopy, ordinaryFailure],
      [
        result(
          failedCopy.path,
          failedCopy.contentHash,
          'failed',
          1,
          'forked',
          WORK_DIR,
          'result-b',
        ),
        result(
          failedCopy.path,
          failedCopy.contentHash,
          'ready',
          1,
          'adopted',
          WORK_DIR,
          'result-a',
        ),
        result(repairedCopy.path, 'older-failed-hash', 'failed', 1),
        result(repairedCopy.path, repairedCopy.contentHash, 'ready', 2, 'adopted'),
        result(editedCopy.path, 'pre-edit-hash', 'failed', 3),
        result(ordinaryFailure.path, ordinaryFailure.contentHash, 'failed', 4, 'adopted'),
        result(
          `${WORK_DIR}/.tagma/foreign/foreign.yaml`,
          'foreign-hash',
          'failed',
          5,
          'forked',
          'D:/other',
        ),
      ],
      WORK_DIR,
    );

    expect([...paths]).toEqual([failedCopy.path]);
  });

  test('matches legacy Windows result paths without crossing workspace-prefix boundaries', () => {
    const workDir = 'D:\\Repo';
    const failedCopy = {
      ...liveEntry('copy', 'Copy'),
      path: 'd:/REPO/.tagma/copy/copy.yaml',
      contentHash: 'copy-hash',
    };
    const outsideWorkspace = {
      ...liveEntry('outside', 'Outside'),
      path: 'D:/Repository/.tagma/outside/outside.yaml',
      contentHash: 'outside-hash',
    };
    const outsideTagmaRoot = {
      ...liveEntry('outside-root', 'Outside root'),
      path: 'D:/Repo/.tagma-other/outside-root/outside-root.yaml',
      contentHash: 'outside-root-hash',
    };

    const paths = failedChatDraftPaths(
      [failedCopy, outsideWorkspace, outsideTagmaRoot],
      [
        {
          path: 'D:\\repo\\.tagma\\copy\\copy.yaml',
          status: 'failed',
          completedAt: 1,
          finalYamlContentHash: 'copy-hash',
          reconcile: { outcome: 'forked' },
        },
        {
          path: outsideWorkspace.path,
          status: 'failed',
          completedAt: 2,
          finalYamlContentHash: 'outside-hash',
          reconcile: { outcome: 'forked' },
        },
        {
          path: outsideTagmaRoot.path,
          status: 'failed',
          completedAt: 3,
          finalYamlContentHash: 'outside-root-hash',
          reconcile: { outcome: 'forked' },
        },
      ] as never,
      workDir,
    );

    expect([...paths]).toEqual([failedCopy.path]);
  });

  test('upserts finalized live metadata and removes only the matching temporary identity', () => {
    const outcomes: ChatYamlStageFinalizeResult['outcome'][] = [
      'created',
      'forked',
      'unchanged',
      'adopted',
    ];

    for (const outcome of outcomes) {
      const target = stagedTarget('stage-a', 'draft', 'Draft');
      const sameRelativePathInAnotherStage = stagedTarget('stage-b', 'draft', 'Other Draft');
      const siblingInSameStage = stagedTarget('stage-a', 'notes', 'Notes');
      const finalStem = outcome === 'forked' ? 'draft-copy-1' : 'draft';
      const staleLiveMetadata = liveEntry(finalStem, 'Stale name', {
        contentHash: 'stale-hash',
      });
      const finalized = finalizedLiveEntry(finalStem, 'Final name', `final-${outcome}`);

      const next = reconcileFinalizedWorkspacePipelines(
        {
          liveEntries: [liveEntry('build', 'Build'), staleLiveMetadata],
          stagedTargets: [target, sameRelativePathInAnotherStage, siblingInSameStage],
        },
        {
          stageId: target.stageId,
          stagedRelativePath: target.relativePath,
          outcome,
          entry: finalized,
        },
      );

      expect(next.liveEntries).toHaveLength(2);
      expect(next.liveEntries.filter((entry) => entry.path === finalized.path)).toHaveLength(1);
      expect(next.liveEntries.find((entry) => entry.path === finalized.path)).toMatchObject({
        pipelineName: 'Final name',
        contentHash: `final-${outcome}`,
      });
      expect(next.stagedTargets.map((entry) => `${entry.stageId}:${entry.relativePath}`)).toEqual([
        `${sameRelativePathInAnotherStage.stageId}:${sameRelativePathInAnotherStage.relativePath}`,
        `${siblingInSameStage.stageId}:${siblingInSameStage.relativePath}`,
      ]);
    }
  });
});
