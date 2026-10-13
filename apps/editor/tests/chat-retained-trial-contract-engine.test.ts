import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authoredYaml,
  cleanupOwnedFixtureConstructionRoots,
  realEngineFixture,
} from './chat-retained-trial-contract.fixture.js';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

export const retainedContractFeatureEvidence: Record<string, unknown> = {};

// Source/candidate use the same existing exported runtime/Trial interfaces; no missing module can be RED.
test('fresh Host repeats publish retained full core after owned shell YAML repair without a third planner', async () => {
  let positive: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
  let value: Awaited<ReturnType<typeof realEngineFixture>> | undefined;
  const facts = retainedContractFeatureEvidence;
  Object.assign(facts, {
    schemaVersion: 1,
    scope: 'owned synthetic real Engine/Trial/coordinator; no models',
    yamlCommandShape: 'shell-string',
    candidateGreen: false,
  });
  try {
    positive = await realEngineFixture('positive');
    const controlDispatch = await positive.engine.dispatch(positive.dispatchInput());
    expect(controlDispatch.kind).toBe('commit_preparing');
    expect(positive.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'trial_plan',
      'trial_plan',
    ]);
    const control = positive.trials.filter(({ result }) => result.ran);
    expect(control).toHaveLength(1);
    expect(control[0]!.result).toMatchObject({
      success: true,
      kind: 'passed-with-warnings',
      plannedCaseCount: 1,
    });
    expect(control[0]!.result.cases[0]).toMatchObject({
      id: 'normal',
      executionSource: 'current-trial',
      success: true,
    });
    expect(control[0]!.result.cases[0]!.runIds).toHaveLength(2);
    expect(await positive.coordinator.resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
    ]);
    expect(readFileSync(join(positive.workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toBe(
      authoredYaml(true),
    );
    expect(positive.store.getResultProjection('operation-1')).toMatchObject({
      terminalOutcome: 'completed_published',
    });
    facts.positive = {
      dispatch: controlDispatch.kind,
      trial: control[0]!.result,
      hostWitnesses: positive.hostWitnessCaptures,
      projection: positive.store.getResultProjection('operation-1'),
      yamlSha256: sha256(authoredYaml(true)),
      planSha256: sha256(positive.committedPlanBytes),
    };
    const positiveContract = JSON.parse(positive.committedPlanBytes);
    delete positiveContract.yamlHash;
    await positive.dispose();
    positive = undefined;
    value = await realEngineFixture('retained-repair');
    const dispatch = await value.engine.dispatch(value.dispatchInput());
    facts.featureBeforeExpectation = {
      dispatch: dispatch.kind,
      purposes: value.openCode.incomingRequests.map(({ purpose }) => purpose),
      verifications: value.verifications.map(({ result }) => result),
      trials: value.trials.map(({ result }) => result),
      hostWitnesses: value.hostWitnessCaptures,
      operation: value.store.getOperation('operation-1'),
    };
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
    expect(value.repairedYaml).toBe(authoredYaml(true));
    expect(value.supportAfter).toBe(value.supportBefore);
    expect(readFileSync(value.targetPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8')).toBe(
      value.committedPlanBytes,
    );
    const retainedContract = JSON.parse(value.committedPlanBytes);
    expect(retainedContract.yamlHash).toBe(sha1(value.originalYaml));
    expect(retainedContract.yamlHash).not.toBe(sha1(value.repairedYaml));
    delete retainedContract.yamlHash;
    expect(retainedContract).toEqual(positiveContract);
    const failed = value.trials.find(({ result }) => result.ran && !result.success);
    expect(failed).toBeDefined();
    expect(failed!.result).toMatchObject({
      ran: true,
      success: false,
      kind: 'failed',
      repairAuthorization: 'pipeline-change-allowed',
    });
    expect(failed!.result.cases[0]!.runIds).toHaveLength(2);
    // Current production RED is exactly here, after genuine publication control and owned repair proof.
    expect(dispatch.kind).toBe('commit_preparing');
    const rerun = value.trials.filter(({ result }) => result.ran && result.success);
    expect(rerun).toHaveLength(1);
    const current = rerun[0]!.result;
    expect(current).toMatchObject({
      ran: true,
      success: true,
      plannedCaseCount: 1,
      caseResultCount: 1,
      notRunCaseCount: 0,
    });
    expect(current.cases[0]).toMatchObject({
      id: 'normal',
      executionSource: 'current-trial',
      success: true,
    });
    expect(current.cases[0]!.runIds).toHaveLength(2);
    expect(
      current.cases[0]!.runIds.every((id) => !failed!.result.cases[0]!.runIds.includes(id)),
    ).toBe(true);
    expect(current.tasks).toHaveLength(2);
    for (const task of current.tasks)
      expect(task).toMatchObject({ taskId: 'main.observe', status: 'success', exitCode: 0 });
    expect(current.cases[0]!.expectations.every((check) => check.passed)).toBe(true);
    const passed = value.verifications.at(-1)!.result;
    expect(passed).toMatchObject({ kind: 'passed', caseCount: 1, passedCount: 1, failedCount: 0 });
    if (passed.kind !== 'passed') throw new Error('Real current verification must be passed.');
    expect(passed.stagedSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(passed.artifactSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(passed.artifactCount).toBeGreaterThan(0);
    // Both witnesses come from the real capture function/worker, without replacing their results.
    expect(value.hostWitnessCaptures.length).toBeGreaterThanOrEqual(4);
    const pair = value.hostWitnessCaptures.slice(-2);
    for (const witness of pair) {
      expect(witness.witnessed).toBe(true);
      expect(witness.currentYamlSha1).toBe(sha1(value.repairedYaml));
      expect(witness.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(witness.prerequisiteDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(pair[0]!.prerequisiteDigest).toBe(pair[1]!.prerequisiteDigest);
    expect(await value.coordinator.resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
    ]);
    expect(readFileSync(join(value.workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toBe(
      authoredYaml(true),
    );
    expect(value.store.getResultProjection('operation-1')).toMatchObject({
      terminalOutcome: 'completed_published',
    });
    expect(
      value.openCode.incomingRequests.filter(({ purpose }) => purpose === 'trial_plan'),
    ).toHaveLength(2);
    facts.feature = {
      dispatch: dispatch.kind,
      currentTrial: current,
      verification: passed,
      hostWitnesses: value.hostWitnessCaptures,
      projection: value.store.getResultProjection('operation-1'),
      freshAllOriginalRepeats: true,
      published: true,
    };
    facts.candidateGreen = true;
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
