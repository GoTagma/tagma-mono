import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectChatStagedYamlTarget,
  detectSnapshotlessChatYamlTarget,
  maxTrialPlanPromptsForLogicalTurn,
  shouldAdoptFinalizedChatStateOnCurrentCanvas,
  shouldAutoRepairCompileResult,
  shouldAutoRepairTrialResult,
  shouldReverifyChatPipelineAfterRepair,
  shouldQueueTrialPlanPrompt,
  chatPipelineVerificationSucceeded,
  shouldTrialRunChatPipeline,
  type ChatPipelineRepairArtifactState,
  type ChatYamlSnapshot,
  type ChatYamlStageSnapshotEntry,
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
describe('detectSnapshotlessChatYamlTarget', () => {
  test('refreshes only the visible current YAML', () => {
    const sibling: WorkspaceYamlEntry = {
      ...before,
      name: 'sibling.yaml',
      path: 'C:/w/.tagma/sibling.yaml',
      pipelineName: 'Sibling',
    };

    expect(
      detectSnapshotlessChatYamlTarget({
        hidden: false,
        currentPath: 'c:\\w\\.tagma\\current.yaml',
        entries: [sibling, before],
      }),
    ).toEqual({
      kind: 'refresh-current',
      path: before.path,
      name: before.name,
      pipelineName: before.pipelineName,
    });
  });

  test('does not publish a result for a hidden external turn', () => {
    expect(
      detectSnapshotlessChatYamlTarget({
        hidden: true,
        currentPath: before.path,
        entries: [before],
      }),
    ).toBeNull();
  });

  test('does not infer a result without a current YAML', () => {
    expect(
      detectSnapshotlessChatYamlTarget({
        hidden: false,
        currentPath: null,
        entries: [before],
      }),
    ).toBeNull();
  });

  test('does not mistake a sibling file for the current YAML', () => {
    expect(
      detectSnapshotlessChatYamlTarget({
        hidden: false,
        currentPath: 'C:/w/.tagma/missing.yaml',
        entries: [before],
      }),
    ).toBeNull();
  });
});


describe('detectChatStagedYamlTarget', () => {
  const stagedBefore: ChatYamlStageSnapshotEntry = {
    name: 'current.yaml',
    stagedPath: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma/current/current.yaml',
    relativePath: 'current/current.yaml',
    sourcePath: 'C:/w/.tagma/current/current.yaml',
    pipelineName: 'Current',
    contentHash: 'base',
    layoutHash: 'layout-base',
    requirementsHash: null,
  };

  function stagedSnapshot(): ChatYamlSnapshot {
    return {
      workDir: 'C:/w',
      activePath: before.path,
      localEditRevision: 1,
      staging: {
        id: 'stage-id',
        agentTagmaDir: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma',
        activeRelativePath: stagedBefore.relativePath,
        activeStagedPath: stagedBefore.stagedPath,
        entries: [stagedBefore],
      },
    };
  }

  test('selects the changed active staged file without consulting live workspace revision', () => {
    const changed = { ...stagedBefore, contentHash: 'agent-result' };
    expect(detectChatStagedYamlTarget(stagedSnapshot(), [changed])).toEqual({
      kind: 'refresh-current',
      path: changed.stagedPath,
      name: changed.name,
      pipelineName: changed.pipelineName,
      relativePath: changed.relativePath,
      sourcePath: changed.sourcePath,
    });
  });

  test('classifies a new staged pipeline as created instead of a conflict copy', () => {
    const created: ChatYamlStageSnapshotEntry = {
      ...stagedBefore,
      name: 'created.yaml',
      stagedPath: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma/created/created.yaml',
      relativePath: 'created/created.yaml',
      sourcePath: null,
      pipelineName: 'Created',
      contentHash: 'created',
    };
    expect(detectChatStagedYamlTarget(stagedSnapshot(), [stagedBefore, created])).toEqual({
      kind: 'open-created',
      path: created.stagedPath,
      name: created.name,
      pipelineName: created.pipelineName,
      relativePath: created.relativePath,
      sourcePath: null,
    });
  });

  test('returns null when the isolated agent branch is unchanged', () => {
    expect(detectChatStagedYamlTarget(stagedSnapshot(), [stagedBefore])).toBeNull();
  });

  test('detects a requirements-only change on the isolated branch', () => {
    const changed = { ...stagedBefore, requirementsHash: 'requirements-changed' };
    expect(detectChatStagedYamlTarget(stagedSnapshot(), [changed])?.relativePath).toBe(
      stagedBefore.relativePath,
    );
  });
});

describe('shouldAutoRepairCompileResult', () => {
  test('allows bounded repair attempts for failed compile results', () => {
    expect(shouldAutoRepairCompileResult({ success: false }, 0, 2)).toBe(true);
    expect(shouldAutoRepairCompileResult({ success: false }, 2, 2)).toBe(false);
    expect(shouldAutoRepairCompileResult({ success: true }, 0, 2)).toBe(false);
  });

  test('does not spend agent repair attempts on host-only trial failures', () => {
    expect(shouldAutoRepairTrialResult({ success: false, kind: 'witness-failed' }, 0, 2)).toBe(
      false,
    );
    expect(shouldAutoRepairTrialResult({ success: false, kind: 'busy' }, 0, 2)).toBe(false);
    expect(shouldAutoRepairTrialResult({ success: false, kind: 'aborted' }, 0, 2)).toBe(false);
  });

  test('keeps bounded repair for pipeline-authored trial failures', () => {
    expect(
      shouldAutoRepairTrialResult(
        {
          success: false,
          kind: 'failed',
          repairAuthorization: 'pipeline-change-allowed',
        },
        0,
        2,
      ),
    ).toBe(true);
    expect(
      shouldAutoRepairTrialResult(
        {
          success: false,
          kind: 'plan-failed',
          repairAuthorization: 'pipeline-change-allowed',
        },
        1,
        2,
      ),
    ).toBe(true);
    expect(
      shouldAutoRepairTrialResult(
        {
          success: false,
          kind: 'failed',
          repairAuthorization: 'pipeline-change-allowed',
        },
        2,
        2,
      ),
    ).toBe(false);
    expect(shouldAutoRepairTrialResult({ success: true, kind: 'passed' }, 0, 2)).toBe(false);
  });

  test('does not let diagnostic-only or untyped trial failures authorize pipeline changes', () => {
    expect(
      shouldAutoRepairTrialResult(
        {
          success: false,
          kind: 'plan-failed',
          repairAuthorization: 'diagnostic-only',
        },
        0,
        2,
      ),
    ).toBe(false);
    expect(shouldAutoRepairTrialResult({ success: false, kind: 'plan-failed' }, 0, 2)).toBe(false);
    expect(shouldAutoRepairTrialResult({ success: false, kind: 'failed' }, 0, 2)).toBe(false);
  });
});

describe('Trial Plan prompt fuse', () => {
  test('budgets two prompts for the initial YAML revision and every allowed repair revision', () => {
    expect(
      maxTrialPlanPromptsForLogicalTurn({
        promptsPerRevision: 2,
        maxRepairAttempts: 0,
      }),
    ).toBe(2);
    expect(
      maxTrialPlanPromptsForLogicalTurn({ promptsPerRevision: 2, maxRepairAttempts: 25 }),
    ).toBe(52);
    expect(
      maxTrialPlanPromptsForLogicalTurn({ promptsPerRevision: 2, maxRepairAttempts: 50 }),
    ).toBe(102);
  });

  test('rejects a third prompt for the same YAML revision', () => {
    expect(
      shouldQueueTrialPlanPrompt({
        attemptsForRevision: 2,
        totalAttemptsForLogicalTurn: 2,
        promptsPerRevision: 2,
        maxRepairAttempts: 25,
        sessionCanContinue: true,
      }),
    ).toBe(false);
  });

  test('rejects prompts when the finished session cannot continue', () => {
    expect(
      shouldQueueTrialPlanPrompt({
        attemptsForRevision: 0,
        totalAttemptsForLogicalTurn: 0,
        promptsPerRevision: 2,
        maxRepairAttempts: 25,
        sessionCanContinue: false,
      }),
    ).toBe(false);
  });

  test('gives a new YAML revision two prompts after earlier revisions used their allowance', () => {
    const decision = (attemptsForRevision: number, totalAttemptsForLogicalTurn: number) =>
      shouldQueueTrialPlanPrompt({
        attemptsForRevision,
        totalAttemptsForLogicalTurn,
        promptsPerRevision: 2,
        maxRepairAttempts: 1,
        sessionCanContinue: true,
      });

    expect([decision(0, 2), decision(1, 3), decision(0, 4)]).toEqual([true, true, false]);
  });
});

describe('chat pipeline repair progress', () => {
  const artifacts: ChatPipelineRepairArtifactState = {
    contentHash: 'yaml-1',
    layoutHash: 'layout-1',
    requirementsHash: 'requirements-1',
    trialPlanHash: 'plan-1',
  };

  test('does not re-run verification when a hidden repair changed no pipeline artifacts', () => {
    expect(shouldReverifyChatPipelineAfterRepair(artifacts, { ...artifacts })).toBe(false);
  });

  test('re-runs verification after any supported repair artifact changes', () => {
    for (const changed of [
      { ...artifacts, contentHash: 'yaml-2' },
      { ...artifacts, layoutHash: 'layout-2' },
      { ...artifacts, requirementsHash: 'requirements-2' },
      { ...artifacts, trialPlanHash: 'plan-2' },
    ]) {
      expect(shouldReverifyChatPipelineAfterRepair(artifacts, changed)).toBe(true);
    }
  });

  test('runs initial verification when there is no pending repair checkpoint', () => {
    expect(shouldReverifyChatPipelineAfterRepair(null, artifacts)).toBe(true);
  });
});

describe('optional OpenCode Chat pipeline trial run', () => {
  test('runs only after compile success when the workspace setting is enabled', () => {
    expect(shouldTrialRunChatPipeline({ compileSuccess: true, trialRunEnabled: true })).toBe(true);
    expect(shouldTrialRunChatPipeline({ compileSuccess: false, trialRunEnabled: true })).toBe(
      false,
    );
    expect(shouldTrialRunChatPipeline({ compileSuccess: true, trialRunEnabled: false })).toBe(
      false,
    );
  });

  test('requires trial success when enabled and accepts compile success when disabled', () => {
    expect(
      chatPipelineVerificationSucceeded({
        compileSuccess: true,
        trialRunEnabled: true,
        trialRunSuccess: true,
      }),
    ).toBe(true);
    expect(
      chatPipelineVerificationSucceeded({
        compileSuccess: true,
        trialRunEnabled: true,
        trialRunSuccess: false,
      }),
    ).toBe(false);
    expect(
      chatPipelineVerificationSucceeded({
        compileSuccess: true,
        trialRunEnabled: false,
        trialRunSuccess: null,
      }),
    ).toBe(true);
    expect(
      chatPipelineVerificationSucceeded({
        compileSuccess: false,
        trialRunEnabled: false,
        trialRunSuccess: null,
      }),
    ).toBe(false);
  });
});

describe('shouldAdoptFinalizedChatStateOnCurrentCanvas', () => {
  test('adopts when the finalized state still targets the current canvas and no later local edit landed', () => {
    expect(
      shouldAdoptFinalizedChatStateOnCurrentCanvas({
        currentPath: 'c:/w/.tagma/current.yaml',
        finalizedStatePath: before.path,
        finalEntryPath: before.path,
        finalizedOutcome: 'adopted',
        localBranchPersisted: false,
        localEditRevisionBeforeFinalize: 11,
        currentLocalEditRevision: 11,
      }),
    ).toBe(true);
  });

  test('blocks adoption when a newer same-window local edit landed while finalize was in flight', () => {
    expect(
      shouldAdoptFinalizedChatStateOnCurrentCanvas({
        currentPath: before.path,
        finalizedStatePath: before.path,
        finalEntryPath: before.path,
        finalizedOutcome: 'adopted',
        localBranchPersisted: false,
        localEditRevisionBeforeFinalize: 11,
        currentLocalEditRevision: 12,
      }),
    ).toBe(false);
  });
});

describe('staged finalize adoption wiring', () => {
  test('has no renderer fallback to the obsolete chat result copy route', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const clientSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'api', 'client.ts'),
      'utf-8',
    );

    expect(appSource).not.toContain('copyChatResultPipeline');
    expect(clientSource).not.toContain('/workspace/chat-result-copy');
  });

  test('keeps snapshotless external turns on the current-YAML reconciliation path', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    expect(appSource).toContain('if (finishedTurn.hidden || !currentYamlForChat) return;');
  });

  test('reuses prior compile and trial evidence after a report-only repair', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).toMatch(
      /let compile =\s*repairMadeNoProgress && pendingRepair\s*\? pendingRepair\.compile\s*:\s*await underChatLock/,
    );
    expect(appSource).toContain('!skipUnchangedTrialRepair &&');
  });

  test('captures the pre-finalize local edit revision and gates adoptDiskState on the helper', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).toMatch(
      /const localEditRevisionBeforeFinalize = getLocalPipelineEditRevision\(\);[\s\S]*const finalizeOnce = \(\) =>/,
    );
    expect(appSource).toContain(
      'const finalStateBelongsOnCanvas = shouldAdoptFinalizedChatStateOnCurrentCanvas({',
    );
    expect(appSource).toContain('localEditRevisionBeforeFinalize,');
    expect(appSource).toContain('currentLocalEditRevision: getLocalPipelineEditRevision(),');
    expect(appSource).toMatch(
      /const finalStateBelongsOnCanvas = shouldAdoptFinalizedChatStateOnCurrentCanvas\([\s\S]*current\.adoptDiskState\(finalized\.state, 'chat'\);/,
    );
  });
});
