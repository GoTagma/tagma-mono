import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  detectChatStagedYamlTarget,
  detectChatStagedYamlTargets,
  detectSnapshotlessChatYamlTarget,
  maxTrialPlanPromptsForLogicalTurn,
  shouldAutoRepairCompileResult,
  shouldAutoRepairTrialResult,
  shouldReverifyChatPipelineAfterRepair,
  shouldQueueTrialPlanPrompt,
  chatPipelineVerificationFailureDiagnostic,
  chatPipelineVerificationSucceeded,
  applicableFinalizedChatTrialResult,
  chatYamlFinalizeForceForkReason,
  chatYamlTargetTrialId,
  shouldTrialRunChatPipeline,
  shouldPreserveCanvasForChatPipelineEvent,
  type ChatPipelineRepairArtifactState,
  type ChatYamlSnapshot,
  type ChatYamlStageSnapshotEntry,
  type WorkspaceYamlEntry,
} from '../src/utils/chat-yaml-reconcile';

describe('chatYamlTargetTrialId', () => {
  test('keeps long punctuation-distinct targets unique within the server id bound', () => {
    const sharedPrefix = 'nested/' + 'same-segment-'.repeat(20);
    const first = chatYamlTargetTrialId('finished_turn', sharedPrefix + 'alpha.yaml');
    const second = chatYamlTargetTrialId('finished_turn', sharedPrefix + 'beta.yaml');

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,160}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,160}$/);
  });
});

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
      yamlEditLockId: 'yaml-lock-stage-id',
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

  test('does not reconcile an unchanged active stage when only the live source drifted', () => {
    const liveDrift = { ...stagedBefore, sourceChangedOnDisk: true };

    expect(detectChatStagedYamlTarget(stagedSnapshot(), [liveDrift])).toBeNull();
  });

  test('does not attach unrelated active live-source drift to a created target', () => {
    const liveDrift = { ...stagedBefore, sourceChangedOnDisk: true };
    const created: ChatYamlStageSnapshotEntry = {
      ...stagedBefore,
      name: 'created.yaml',
      stagedPath: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma/created/created.yaml',
      relativePath: 'created/created.yaml',
      sourcePath: null,
      pipelineName: 'Created',
      contentHash: 'created',
      sourceChangedOnDisk: false,
    };

    expect(detectChatStagedYamlTarget(stagedSnapshot(), [liveDrift, created])).toEqual({
      kind: 'open-created',
      path: created.stagedPath,
      name: created.name,
      pipelineName: created.pipelineName,
      relativePath: created.relativePath,
      sourcePath: null,
    });
  });

  test('returns every created and changed pipeline in one logical turn', () => {
    const changed = { ...stagedBefore, contentHash: 'agent-result' };
    const createdOne: ChatYamlStageSnapshotEntry = {
      ...stagedBefore,
      name: 'alpha.yaml',
      stagedPath: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma/alpha/alpha.yaml',
      relativePath: 'alpha/alpha.yaml',
      sourcePath: null,
      pipelineName: 'Alpha',
      contentHash: 'alpha',
    };
    const createdTwo: ChatYamlStageSnapshotEntry = {
      ...createdOne,
      name: 'beta.yaml',
      stagedPath: 'C:/w/.tagma/.chat-staging/turn/agent-workspace/.tagma/beta/beta.yaml',
      relativePath: 'beta\\beta.yaml',
      pipelineName: 'Beta',
      contentHash: 'beta',
    };

    expect(
      detectChatStagedYamlTargets(stagedSnapshot(), [createdTwo, changed, createdOne]).map(
        (target) => target.relativePath.replace(/\\/g, '/'),
      ),
    ).toEqual(['current/current.yaml', 'alpha/alpha.yaml', 'beta/beta.yaml']);
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
    expect(
      shouldAutoRepairCompileResult({ success: false }, 0, 2, {
        reconcileLiveSourceDrift: true,
      }),
    ).toBe(false);
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
    expect(
      shouldTrialRunChatPipeline({
        compileSuccess: true,
        trialRunEnabled: true,
        reconcileLiveSourceDrift: true,
      }),
    ).toBe(false);
  });

  test('keeps Trial evidence only when finalize accepted it for the resulting branch', () => {
    const passedTrial = { success: true, kind: 'executed' };
    const failedTrial = { success: false, kind: 'failed' };
    const blockedTrial = { success: false, kind: 'prerequisite-unavailable' };

    expect(applicableFinalizedChatTrialResult('verified', passedTrial)).toBe(passedTrial);
    expect(applicableFinalizedChatTrialResult('prerequisite-unavailable', blockedTrial)).toBe(
      blockedTrial,
    );
    expect(applicableFinalizedChatTrialResult('not-verified', passedTrial)).toBeNull();
    expect(applicableFinalizedChatTrialResult('not-verified', failedTrial)).toBe(failedTrial);
    expect(applicableFinalizedChatTrialResult('not-required', passedTrial)).toBeNull();
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

  test('builds a bounded diagnostic for a terminal trial-plan failure only', () => {
    expect(
      chatPipelineVerificationFailureDiagnostic({
        compile: { success: true, summary: 'Compilation passed.' },
        trialRunEnabled: true,
        trialRun: {
          success: false,
          kind: 'plan-failed',
          summary: 'Trial plan tool attempt budget exhausted for this staged YAML revision.',
        },
      }),
    ).toEqual({
      compileSuccess: true,
      compileSummary: 'Compilation passed.',
      trialRunEnabled: true,
      trialRunSuccess: false,
      trialRunKind: 'plan-failed',
      trialRunSummary: 'Trial plan tool attempt budget exhausted for this staged YAML revision.',
    });
    expect(
      chatPipelineVerificationFailureDiagnostic({
        compile: { success: true, summary: 'Compilation passed.' },
        trialRunEnabled: true,
        trialRun: { success: true, kind: 'executed', summary: 'Trial passed.' },
      }),
    ).toBeNull();
  });
});

describe('chatYamlFinalizeForceForkReason', () => {
  test('lets live-only drift reach server reconciliation even after the renderer switched paths', () => {
    expect(
      chatYamlFinalizeForceForkReason({
        reconcileLiveSourceDrift: true,
        compileSuccess: true,
        pathMoved: true,
      }),
    ).toBeUndefined();
  });

  test('keeps compile and path conflicts for staged agent edits', () => {
    expect(
      chatYamlFinalizeForceForkReason({
        reconcileLiveSourceDrift: false,
        compileSuccess: false,
        pathMoved: false,
      }),
    ).toBe('compile-failed');
    expect(
      chatYamlFinalizeForceForkReason({
        reconcileLiveSourceDrift: false,
        compileSuccess: true,
        pathMoved: true,
      }),
    ).toBe('path-moved');
  });
});

describe('shouldPreserveCanvasForChatPipelineEvent', () => {
  test('preserves the canvas throughout an active reconcile and for delayed final-result events', () => {
    expect(
      shouldPreserveCanvasForChatPipelineEvent({
        eventPath: 'c:\\w\\.tagma\\result\\result.yaml',
        workspaceKey: 'C:/W',
        activeLifecycleWorkspaceKey: 'c:\\w',
        activeTargetPaths: ['C:/W/.tagma/result/result.yaml'],
        acceptedCanvasMtimeMs: 900,
        resultTargets: [],
      }),
    ).toBe(true);
    expect(
      shouldPreserveCanvasForChatPipelineEvent({
        eventPath: 'C:/W/.tagma/result/result.yaml',
        workspaceKey: 'c:\\w',
        activeLifecycleWorkspaceKey: null,
        activeTargetPaths: [],
        acceptedCanvasPath: 'C:/W/.tagma/other/other.yaml',
        acceptedCanvasMtimeMs: 10_000,
        resultTargets: [
          {
            finalYamlMtimeMs: 1_000,
            workspaceKey: 'C:/W',
            path: 'c:\\w\\.tagma\\result\\result.yaml',
          },
        ],
      }),
    ).toBe(true);
    expect(
      shouldPreserveCanvasForChatPipelineEvent({
        eventPath: 'C:/W/.tagma/result/result.yaml',
        workspaceKey: 'C:/W',
        activeLifecycleWorkspaceKey: null,
        activeTargetPaths: [],
        acceptedCanvasPath: 'c:\\w\\.tagma\\result\\result.yaml',
        acceptedCanvasMtimeMs: 10_000,
        resultTargets: [
          {
            workspaceKey: 'C:/W',
            path: 'C:/W/.tagma/result/result.yaml',
          },
        ],
      }),
    ).toBe(true);
  });

  test('does not relabel an unrelated external event as a finalized chat result', () => {
    expect(
      shouldPreserveCanvasForChatPipelineEvent({
        eventPath: 'C:/W/.tagma/other/other.yaml',
        workspaceKey: 'C:/W',
        activeLifecycleWorkspaceKey: 'C:/W',
        activeTargetPaths: ['C:/W/.tagma/result/result.yaml'],
        acceptedCanvasMtimeMs: 900,
        resultTargets: [
          {
            workspaceKey: 'C:/W',
            path: 'C:/W/.tagma/result/result.yaml',
          },
        ],
      }),
    ).toBe(false);
    expect(
      shouldPreserveCanvasForChatPipelineEvent({
        eventPath: 'C:/W/.tagma/result/result.yaml',
        workspaceKey: 'C:/W',
        activeLifecycleWorkspaceKey: null,
        activeTargetPaths: [],
        acceptedCanvasPath: 'C:/W/.tagma/result/result.yaml',
        acceptedCanvasMtimeMs: 1_100,
        resultTargets: [
          {
            finalYamlMtimeMs: 1_000,
            workspaceKey: 'C:/W',
            path: 'C:/W/.tagma/result/result.yaml',
          },
        ],
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
    expect(appSource).toContain('const target = detectSnapshotlessChatYamlTarget({');
    expect(appSource).toContain('currentPath: currentYamlForChat,');
    expect(appSource).toContain('entries,');
  });

  test('reuses prior compile and trial evidence after a report-only repair', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).toMatch(
      /let compile =\s*repairMadeNoProgress && pendingRepair\s*\? pendingRepair\.compile\s*:\s*await underChatLock/,
    );
    expect(appSource).toContain('!skipUnchangedTrialRepair &&');
  });

  test('keeps finalized chat state off the canvas until the user explicitly opens it', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).not.toContain(`adoptDiskState(finalized.state, 'chat')`);
    expect(appSource).not.toContain('shouldAdoptFinalizedChatStateOnCurrentCanvas');
  });

  test('protects finalized chat results from delayed SSE adoption and snapshotless reload', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource.match(/shouldPreserveCanvasForChatPipelineEvent\(\{/g)?.length).toBe(3);
    expect(appSource.match(/acceptedCanvasPath:/g)?.length).toBe(3);
    expect(appSource.match(/finalYamlMtimeMs: result\.finalYamlMtimeMs/g)?.length).toBe(3);
    expect(appSource.match(/finalYamlMtimeMs: finalEntry\.mtimeMs/g)?.length).toBe(2);
    expect(appSource).toContain("event.origin === 'chat-yaml-finalize'");
    expect(appSource).not.toContain("pipelineState.adoptDiskState(newState, 'chat')");
    expect(appSource).not.toContain("pipelineState.autoSyncAllBindings('chat'");
  });

  test('does not auto-sync a finalized result before the user opens it', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).not.toContain('shouldAutoSyncFinalizedChatBindings');
  });

  test('discards live-only drift and finalizes only actual staged mutations', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).toContain(
      'const stagedTargets = detectChatStagedYamlTargets(snapshot, stage.entries).filter(',
    );
    expect(appSource).toContain('const reconcileLiveSourceDriftOnly = false;');
    expect(appSource).toContain('allowInvalid: !compile.success,');
    expect(appSource).toContain('const applicableTrialRun = applicableFinalizedChatTrialResult(');
    expect(appSource).not.toContain('...(trialRun ? { trial: trialRun } : {})');
  });

  test('keeps canvas navigation independent and drains every staged target', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');

    expect(appSource).toContain('pathMoved: false,');
    expect(appSource).not.toContain('const targetsDifferentPipeline =');
    expect(appSource).not.toContain('activeLocalBranch,');
    expect(appSource).toContain('retainStage: retainStageForMoreTargets,');
    expect(appSource).toContain('.markFinishedTurnYamlTargetCompleted(');
  });
});
