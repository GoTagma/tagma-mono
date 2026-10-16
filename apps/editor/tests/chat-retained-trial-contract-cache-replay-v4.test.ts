import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from '../server/chat-pipeline-trial-cache';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readAuthenticatedServerRecordSync } from '../server/server-record-auth.js';
import {
  hashChatPipelineTrialabilityReport,
  readChatYamlStageVerifiedRetainedTrialReceipt,
} from '../server/chat-yaml-staging.js';
import { readTrialTaskStreamEvidence } from '../server/chat-operations/trial-stream-evidence-store.js';
import type { ChatPipelineTrialRunResult } from '../server/chat-pipeline-trial-run.js';
import {
  authoredYaml,
  cleanupOwnedFixtureConstructionRoots,
  frozenIntent,
  realEngineFixture,
} from './chat-retained-trial-contract-cache-v4.fixture.js';
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
interface CacheRecord {
  version: number;
  inputHash: string;
  trialabilityReportHash: string;
  hostWitness: { digest: string; prerequisiteDigest: string };
  caseReuse: Array<{
    caseId: string;
    fingerprint: string;
    result: ChatPipelineTrialRunResult['cases'][number];
  }>;
  result: ChatPipelineTrialRunResult;
}
export const retainedContractCacheReplayEvidence: Record<string, unknown> = {};
function readOwnCaches(value: Awaited<ReturnType<typeof realEngineFixture>>) {
  const descriptor = value.stageDescriptor;
  if (!descriptor) throw new Error('The real owned repair must establish the stage descriptor.');
  const directory = join(descriptor.rootDir, '.trial-runs');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const record = readAuthenticatedServerRecordSync<CacheRecord>(path, {
        workspaceTagmaDir: join(value.workspaceRoot, '.tagma'),
        controlRoot: dirname(path),
        stageId: descriptor.id,
        kind: 'trial-cache',
      });
      expect(record.version).toBe(CHAT_PIPELINE_TRIAL_CACHE_VERSION);
      return { name, record };
    });
}
function authenticatedArchiveTuples(
  value: Awaited<ReturnType<typeof realEngineFixture>>,
  result: ChatPipelineTrialRunResult,
) {
  const descriptor = value.stageDescriptor;
  if (!descriptor) throw new Error('Missing owned stage descriptor.');
  const owner = {
    workspaceScopeId: 'scope-1',
    operationId: 'operation-1',
    operationGeneration: 1,
    stageId: descriptor.id,
  };
  return result.cases.flatMap((testCase) =>
    (testCase.taskStreamEvidence ?? []).map((evidence) => {
      expect(evidence.status).toBe('complete');
      expect(evidence.manifest).not.toBeNull();
      if (!evidence.manifest)
        throw new Error('Every actually run task must have its normal production archive.');
      const authenticated = readTrialTaskStreamEvidence(
        {
          workspaceTagmaDir: join(value.workspaceRoot, '.tagma'),
          controlRoot: descriptor.rootDir,
          stageId: descriptor.id,
          kind: 'stage-metadata',
        },
        owner,
        evidence.manifest,
      );
      expect(authenticated.manifest).toMatchObject({
        ...owner,
        trialId: evidence.trialId,
        caseId: evidence.caseId,
        runId: evidence.runId,
        runNumber: evidence.runNumber,
        taskId: evidence.taskId,
        status: 'complete',
      });
      expect(testCase.runIds).toContain(evidence.runId);
      return evidence.manifest;
    }),
  );
}
test('retained Host reruns an eligible independent cached branch and ordinary same-id replay preserves native run proofs', async () => {
  let positive: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
  let value: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
  let previousCaches: ReturnType<typeof readOwnCaches> = [];
  const facts = retainedContractCacheReplayEvidence;
  try {
    positive = await realEngineFixture('positive');
    expect((await positive.engine.dispatch(positive.dispatchInput())).kind).toBe(
      'commit_preparing',
    );
    const legal = positive.trials.find(({ result }) => result.ran && result.success)!;
    expect(legal.result).toMatchObject({
      success: true,
      plannedCaseCount: 2,
      caseResultCount: 2,
      notRunCaseCount: 0,
    });
    for (const testCase of legal.result.cases) {
      expect(testCase.success).toBe(true);
      expect(testCase.runIds).toHaveLength(2);
      expect(testCase.executionSource).toBe('current-trial');
    }
    expect(await positive.coordinator.resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
    ]);
    expect(readFileSync(join(positive.workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toBe(
      authoredYaml(true),
    );
    await positive.dispose();
    positive = undefined;
    value = await realEngineFixture('retained-repair', {
      afterOwnedRepair: async () => {
        if (!value) throw new Error('Fixture assignment must precede dispatch.');
        previousCaches = readOwnCaches(value);
        expect(previousCaches).toHaveLength(1);
        const record = previousCaches[0]!.record;
        expect(record.result.success).toBe(false);
        expect(record.caseReuse).toHaveLength(1);
        expect(record.caseReuse[0]).toMatchObject({
          caseId: 'independent',
          result: { success: true, executionSource: 'current-trial' },
        });
        expect(record.caseReuse[0]!.result.runIds).toHaveLength(2);
      },
    });
    const dispatch = await value.engine.dispatch(value.dispatchInput());
    facts.beforeExpectedPass = {
      dispatch: dispatch.kind,
      trials: value.trials.map(({ result }) => result),
      previousCaches,
    };
    expect(dispatch.kind).toBe('commit_preparing');
    expect(value.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'trial_plan',
      'trial_plan',
      'repair',
    ]);
    expect(value.store.getOperation('operation-1')).toMatchObject({
      repairAttempts: 1,
      repairMaxAttempts: 2,
    });
    expect(value.supportAfter).toBe(value.supportBefore);
    expect(readFileSync(value.targetPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8')).toBe(
      value.committedPlanBytes,
    );
    expect(JSON.parse(value.committedPlanBytes).yamlHash).toBe(sha1(value.originalYaml));
    expect(sha1(value.repairedYaml)).not.toBe(sha1(value.originalYaml));
    const actual = value.trials.filter(({ result }) => result.ran);
    expect(actual).toHaveLength(2);
    const failed = actual[0]!;
    const successful = actual[1]!;
    expect(failed.result).toMatchObject({
      success: false,
      repairAuthorization: 'pipeline-change-allowed',
    });
    expect(successful.result).toMatchObject({
      success: true,
      plannedCaseCount: 2,
      caseResultCount: 2,
      notRunCaseCount: 0,
    });
    expect(successful.result.tasks).toHaveLength(8);
    expect(
      successful.result.tasks.filter(
        (task) => task.caseId === 'independent' && task.taskId === 'main.observe',
      ),
    ).toEqual([
      expect.objectContaining({ status: 'skipped', exitCode: -1 }),
      expect.objectContaining({ status: 'skipped', exitCode: -1 }),
    ]);
    expect(successful.result.tasks.filter((task) => task.status === 'success')).toHaveLength(6);
    const oldRunIds = failed.result.cases.flatMap((testCase) => testCase.runIds);
    const freshRunIds = successful.result.cases.flatMap((testCase) => testCase.runIds);
    expect(new Set(oldRunIds).size).toBe(4);
    expect(new Set(freshRunIds).size).toBe(4);
    expect(freshRunIds.every((id) => !oldRunIds.includes(id))).toBe(true);
    for (const testCase of successful.result.cases) {
      expect(testCase.success).toBe(true);
      expect(testCase.executionSource).toBe('current-trial');
      expect(testCase.runIds).toHaveLength(2);
      expect(testCase.expectations.every((check) => check.passed)).toBe(true);
    }
    const afterCaches = readOwnCaches(value);
    expect(afterCaches).toHaveLength(2);
    const successfulCache = afterCaches.find(({ record }) => record.result.success)!;
    const prior = previousCaches[0]!.record;
    expect(successfulCache.record.trialabilityReportHash).toBe(prior.trialabilityReportHash);
    expect(hashChatPipelineTrialabilityReport(successful.result.trialabilityReport!)).toBe(
      prior.trialabilityReportHash,
    );
    expect(successfulCache.record.hostWitness.prerequisiteDigest).toBe(
      prior.hostWitness.prerequisiteDigest,
    );
    expect(
      successfulCache.record.caseReuse.find((item) => item.caseId === 'independent')!.fingerprint,
    ).toBe(prior.caseReuse[0]!.fingerprint);
    const oldArchives = authenticatedArchiveTuples(value, failed.result);
    const freshArchives = authenticatedArchiveTuples(value, successful.result);
    expect(oldArchives).toHaveLength(6);
    expect(freshArchives).toHaveLength(6);
    expect(freshArchives.every((ref) => !oldArchives.some((old) => old.hash === ref.hash))).toBe(
      true,
    );
    expect(
      readChatYamlStageVerifiedRetainedTrialReceipt(value.workspace, {
        stageId: value.stageDescriptor!.id,
        relativePath: 'alpha/alpha.yaml',
        intentText: frozenIntent,
      }),
    ).toMatchObject({
      trialId: successful.input.trialId,
      currentYamlHash: sha1(value.repairedYaml),
    });
    const captureCount = value.hostWitnessCaptures.length;
    const replay = await value.replayActualTrial(successful.input);
    expect(replay).toEqual(successful.result);
    expect(value.hostWitnessCaptures).toHaveLength(captureCount);
    expect(authenticatedArchiveTuples(value, replay)).toEqual(freshArchives);
    expect(readOwnCaches(value)).toEqual(afterCaches);
    // Ordinary new-id verification may reuse a real successful branch. Its archived tuple keeps the original trial/run owner.
    const ordinary = await value.replayActualTrial({
      ...successful.input,
      trialId: successful.input.trialId + '-ordinary',
      retainedRepair: undefined,
    });
    expect(ordinary.success).toBe(true);
    for (const testCase of ordinary.cases) {
      expect(testCase.executionSource).toBe('equivalent-closure-cache');
      const known = afterCaches
        .flatMap(({ record }) => record.caseReuse)
        .filter((item) => item.caseId === testCase.id);
      expect(
        known.some(
          (item) =>
            JSON.stringify({ ...item.result, executionSource: 'equivalent-closure-cache' }) ===
            JSON.stringify(testCase),
        ),
      ).toBe(true);
      expect(
        testCase.runIds.every((id) => oldRunIds.includes(id) || freshRunIds.includes(id)),
      ).toBe(true);
    }
    const ordinaryArchives = authenticatedArchiveTuples(value, ordinary);
    expect(
      ordinaryArchives.every((ref) =>
        [...oldArchives, ...freshArchives].some(
          (known) => known.hash === ref.hash && known.runId === ref.runId,
        ),
      ),
    ).toBe(true);
    expect(await value.coordinator.resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
    ]);
    expect(value.store.getResultProjection('operation-1')).toMatchObject({
      terminalOutcome: 'completed_published',
    });
    expect(readFileSync(join(value.workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toBe(
      authoredYaml(true),
    );
    expect(
      value.openCode.incomingRequests.filter(({ purpose }) => purpose === 'trial_plan'),
    ).toHaveLength(2);
    Object.assign(facts, {
      candidateGreen: true,
      priorEligibleIndependentCase: prior.caseReuse[0],
      previousCache: previousCaches[0],
      freshCache: successfulCache,
      oldRunIds,
      freshRunIds,
      oldArchives,
      freshArchives,
      responseReplay: { sameNativeResult: true, captureCountUnchanged: true, result: replay },
      ordinaryCaseReuse: ordinary,
      published: value.store.getResultProjection('operation-1'),
    });
  } catch (error) {
    facts.error = {
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    if (positive) await positive.dispose();
    if (value) await value.dispose();
    cleanupOwnedFixtureConstructionRoots();
  }
}, 120_000);
