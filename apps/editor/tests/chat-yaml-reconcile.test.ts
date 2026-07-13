import { describe, expect, test } from 'bun:test';
import {
  detectChatYamlTarget,
  shouldAdoptChatYamlTargetOnCurrentCanvas,
  shouldForkChatYamlResult,
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
    revision: 1,
    activeYaml: activePath ? 'pipeline:\n  name: Current\n' : null,
    activeLayout: activePath ? { positions: {}, folders: [], trackHeights: {} } : null,
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

  test('still detects chat output when the user has switched away from the started pipeline', () => {
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
    ).toEqual({
      kind: 'open-created',
      path: created.path,
      name: created.name,
      pipelineName: created.pipelineName,
    });
    expect(
      detectChatYamlTarget(
        snapshot([before, other], before.path),
        [changedStartedPipeline, other],
        other.path,
      ),
    ).toEqual({
      kind: 'refresh-current',
      path: before.path,
      name: before.name,
      pipelineName: before.pipelineName,
    });
  });

  test('does not mistake the current editor pipeline for a chat-created pipeline', () => {
    const userCreated: WorkspaceYamlEntry = {
      name: 'mine.yaml',
      path: 'C:/w/.tagma/mine.yaml',
      pipelineName: 'Mine',
      contentHash: 'mine-hash',
      layoutHash: 'mine-layout-hash',
      layoutMtimeMs: 2,
      layoutSize: 30,
      mtimeMs: 2,
      size: 20,
    };

    expect(detectChatYamlTarget(snapshot(), [before, userCreated], userCreated.path)).toBeNull();
  });

  test('matches changed Windows paths across slash and case differences', () => {
    const windowsBefore: WorkspaceYamlEntry = {
      ...before,
      name: 'Current.yaml',
      path: 'C:\\W\\.tagma\\Current\\Current.yaml',
      pipelineName: 'Current',
    };
    const windowsChanged: WorkspaceYamlEntry = {
      ...windowsBefore,
      path: 'c:/w/.tagma/current/current.yaml',
      contentHash: 'changed',
      mtimeMs: 2,
    };

    expect(
      detectChatYamlTarget(
        snapshot([windowsBefore], windowsBefore.path),
        [windowsChanged],
        'c:/w/.tagma/current/current.yaml',
      ),
    ).toEqual({
      kind: 'refresh-current',
      path: windowsChanged.path,
      name: windowsChanged.name,
      pipelineName: windowsChanged.pipelineName,
    });
  });
  test('preserves POSIX path case when excluding the current editor pipeline from created files', () => {
    const posixCreated: WorkspaceYamlEntry = {
      ...before,
      name: 'Build.yaml',
      path: '/ws/.tagma/Build/Build.yaml',
      pipelineName: 'Build',
      contentHash: 'created',
      mtimeMs: 2,
    };

    expect(
      detectChatYamlTarget(snapshot([], null), [posixCreated], '/ws/.tagma/build/build.yaml'),
    ).toEqual({
      kind: 'open-created',
      path: posixCreated.path,
      name: posixCreated.name,
      pipelineName: posixCreated.pipelineName,
    });
  });
});

describe('shouldAutoRepairCompileResult', () => {
  test('allows bounded repair attempts for failed compile results', () => {
    expect(shouldAutoRepairCompileResult({ success: false }, 0, 2)).toBe(true);
    expect(shouldAutoRepairCompileResult({ success: false }, 2, 2)).toBe(false);
    expect(shouldAutoRepairCompileResult({ success: true }, 0, 2)).toBe(false);
  });
});

describe('shouldForkChatYamlResult', () => {
  test('forks a changed current pipeline when the user edited it during the turn', () => {
    expect(
      shouldForkChatYamlResult({
        snapshot: { ...snapshot(), localEditRevision: 7 },
        target: {
          kind: 'refresh-current',
          path: before.path,
          name: before.name,
          pipelineName: before.pipelineName,
        },
        currentPath: before.path,
        currentRevision: 1,
        currentLocalEditRevision: 8,
        hasLocalChanges: true,
      }),
    ).toBe(true);
  });

  test('does not fork merely because the agent wrote repeatedly during the turn', () => {
    expect(
      shouldForkChatYamlResult({
        snapshot: { ...snapshot(), localEditRevision: 7 },
        target: {
          kind: 'refresh-current',
          path: before.path,
          name: before.name,
          pipelineName: before.pipelineName,
        },
        currentPath: before.path,
        currentRevision: 1,
        currentLocalEditRevision: 7,
        hasLocalChanges: false,
      }),
    ).toBe(false);
  });

  test('never forks a newly-created pipeline just because the current canvas is dirty', () => {
    expect(
      shouldForkChatYamlResult({
        snapshot: { ...snapshot(), localEditRevision: 7 },
        target: {
          kind: 'open-created',
          path: 'C:/w/.tagma/new/new.yaml',
          name: 'new.yaml',
          pipelineName: 'New',
        },
        currentPath: before.path,
        currentRevision: 2,
        currentLocalEditRevision: 8,
        hasLocalChanges: true,
      }),
    ).toBe(false);
  });
});

describe('shouldAdoptChatYamlTargetOnCurrentCanvas', () => {
  const changedTarget = {
    kind: 'refresh-current' as const,
    path: before.path,
    name: before.name,
    pipelineName: before.pipelineName,
  };

  test('adopts only an unchanged result that targets the open canvas', () => {
    expect(
      shouldAdoptChatYamlTargetOnCurrentCanvas({
        target: changedTarget,
        currentPath: 'c:/w/.tagma/current.yaml',
        forked: false,
      }),
    ).toBe(true);
    expect(
      shouldAdoptChatYamlTargetOnCurrentCanvas({
        target: changedTarget,
        currentPath: 'C:/w/.tagma/other.yaml',
        forked: false,
      }),
    ).toBe(false);
    expect(
      shouldAdoptChatYamlTargetOnCurrentCanvas({
        target: changedTarget,
        currentPath: before.path,
        forked: true,
      }),
    ).toBe(false);
  });
});
