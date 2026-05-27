import { describe, expect, test } from 'bun:test';
import {
  detectChatYamlTarget,
  shouldAutoRepairCompileResult,
  type ChatYamlSnapshot,
  type WorkspaceYamlEntry,
} from '../src/utils/chat-yaml-reconcile';

const before: WorkspaceYamlEntry = {
  name: 'current.yaml',
  path: 'C:/w/.tagma/current.yaml',
  pipelineName: 'Current',
  contentHash: 'old',
  layoutHash: 'layout-old',
  layoutMtimeMs: 1,
  layoutSize: 12,
  mtimeMs: 1,
  size: 10,
};

function snapshot(
  entries: WorkspaceYamlEntry[] = [before],
  activePath: string | null = before.path,
): ChatYamlSnapshot {
  return {
    workDir: 'C:/w',
    activePath,
    entries: entries.map((entry) => ({
      path: entry.path,
      contentHash: entry.contentHash,
      layoutHash: entry.layoutHash,
    })),
  };
}

describe('detectChatYamlTarget', () => {
  test('returns open-created for a new yaml path', () => {
    const created: WorkspaceYamlEntry = {
      name: 'new.yaml',
      path: 'C:/w/.tagma/new.yaml',
      pipelineName: 'New',
      contentHash: 'new-hash',
      layoutHash: 'new-layout-hash',
      layoutMtimeMs: 2,
      layoutSize: 30,
      mtimeMs: 2,
      size: 20,
    };

    expect(detectChatYamlTarget(snapshot(), [before, created], 'C:/w/.tagma/current.yaml')).toEqual(
      {
        kind: 'open-created',
        path: created.path,
        name: created.name,
        pipelineName: created.pipelineName,
      },
    );
  });

  test('returns refresh-current when the current yaml content hash changed', () => {
    const changed = { ...before, contentHash: 'changed', mtimeMs: 2 };

    expect(detectChatYamlTarget(snapshot(), [changed], before.path)).toEqual({
      kind: 'refresh-current',
      path: before.path,
      name: before.name,
      pipelineName: before.pipelineName,
    });
  });

  test('returns refresh-current when only the current layout content hash changed', () => {
    const changed = { ...before, layoutHash: 'layout-changed', layoutMtimeMs: 2 };

    expect(detectChatYamlTarget(snapshot(), [changed], before.path)).toEqual({
      kind: 'refresh-current',
      path: before.path,
      name: before.name,
      pipelineName: before.pipelineName,
    });
  });

  test('returns an existing non-current yaml when chat changed a sibling file', () => {
    const sibling: WorkspaceYamlEntry = {
      name: 'sibling.yaml',
      path: 'C:/w/.tagma/sibling.yaml',
      pipelineName: 'Sibling',
      contentHash: 'sibling-old',
      layoutHash: 'sibling-layout-old',
      layoutMtimeMs: 1,
      layoutSize: 12,
      mtimeMs: 1,
      size: 10,
    };
    const changedSibling = {
      ...sibling,
      contentHash: 'sibling-changed',
      mtimeMs: 2,
    };

    expect(
      detectChatYamlTarget(snapshot([before, sibling]), [before, changedSibling], before.path),
    ).toEqual({
      kind: 'refresh-current',
      path: sibling.path,
      name: sibling.name,
      pipelineName: sibling.pipelineName,
    });
  });

  test('returns null when yaml paths and hashes are unchanged', () => {
    expect(detectChatYamlTarget(snapshot(), [before], before.path)).toBeNull();
  });

  test('returns null when the user has switched away from the pipeline chat started on', () => {
    const other: WorkspaceYamlEntry = {
      name: 'other.yaml',
      path: 'C:/w/.tagma/other.yaml',
      pipelineName: 'Other',
      contentHash: 'other-hash',
      layoutHash: 'other-layout-hash',
      layoutMtimeMs: 1,
      layoutSize: 12,
      mtimeMs: 1,
      size: 10,
    };
    const created: WorkspaceYamlEntry = {
      name: 'new.yaml',
      path: 'C:/w/.tagma/new.yaml',
      pipelineName: 'New',
      contentHash: 'new-hash',
      layoutHash: 'new-layout-hash',
      layoutMtimeMs: 2,
      layoutSize: 30,
      mtimeMs: 2,
      size: 20,
    };
    const changedStartedPipeline = { ...before, contentHash: 'changed', mtimeMs: 2 };

    expect(
      detectChatYamlTarget(
        snapshot([before, other], before.path),
        [before, other, created],
        other.path,
      ),
    ).toBeNull();
    expect(
      detectChatYamlTarget(
        snapshot([before, other], before.path),
        [changedStartedPipeline, other],
        other.path,
      ),
    ).toBeNull();
  });

  test('preserves POSIX path case when checking whether the user switched pipelines', () => {
    const posixBefore: WorkspaceYamlEntry = {
      ...before,
      name: 'Build.yaml',
      path: '/ws/.tagma/Build/Build.yaml',
      pipelineName: 'Build',
    };
    const posixChanged = { ...posixBefore, contentHash: 'changed', mtimeMs: 2 };

    expect(
      detectChatYamlTarget(
        snapshot([posixBefore], posixBefore.path),
        [posixChanged],
        '/ws/.tagma/build/build.yaml',
      ),
    ).toBeNull();
  });
});

describe('shouldAutoRepairCompileResult', () => {
  test('allows bounded repair attempts for failed compile results', () => {
    expect(shouldAutoRepairCompileResult({ success: false }, 0, 2)).toBe(true);
    expect(shouldAutoRepairCompileResult({ success: false }, 2, 2)).toBe(false);
    expect(shouldAutoRepairCompileResult({ success: true }, 0, 2)).toBe(false);
  });
});
