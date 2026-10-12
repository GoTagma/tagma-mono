import { createHash } from 'node:crypto';
import {
  validateTrialPlannerNoProgressContext,
  type ChatOperationV2AuthoringInvocationRequest,
  type ChatOperationV2TrialPlannerNoProgress,
} from '../server/chat-operations/authoring.js';
import { describe, expect, test } from 'bun:test';
import {
  assertTrialPlanningAuthorityTransition,
  isTrialPlanRejectionContinuationEligible,
  mergeManagedAuthoringAuthorityUpdate,
  type ManagedChatOperationV2AuthoringAuthorityRecord as Authority,
  type ManagedChatOperationV2InvocationAuthority as Invocation,
} from '../server/chat-operations/authoring-runtime.js';
import {
  isBlockedCorePlanReviewCandidate,
  planBlockingDiagnostics,
} from '../server/chat-pipeline-trial-run.js';
import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan.js';
import type { ChatRepairEvidenceReference } from '../server/chat-operations/repair-evidence-store.js';

// Synthetic pure-guard fixtures, not authenticated stage/SDK evidence.
const hash = 'a'.repeat(64);
const settled = {
  kind: 'completed',
  disposition: 'no_change',
  text: null,
  executionMessageId: 'message-1',
  finishCode: 'stop',
  admittedAggregateSeq: 1,
  source: { aggregateSeq: 1, eventId: 'event-1' },
  usage: null,
} as const satisfies NonNullable<Invocation['completed']>;
function invocation(id: string, changes: Partial<Invocation> = {}): Invocation {
  return {
    invocationId: id,
    sessionId: 'session',
    inputId: `input-${id}`,
    purpose: 'trial_plan',
    conversationId: 'conversation',
    requestDigest: hash,
    executionMessageId: 'message-1',
    baselineSnapshotHash: hash,
    trialPlanRequestDigest: hash,
    executionSubmitted: true,
    completed: settled,
    ...changes,
  };
}
function authority(rows: readonly Invocation[] = []): Authority {
  return {
    workspaceScopeId: 'scope',
    stage: { operationId: 'operation', operationGeneration: 1, stageId: 'stage' },
    targetRelativePath: 'generic/generic.yaml',
    trialPlanningMaxAttempts: 2,
    invocations: Object.fromEntries(rows.map((row) => [row.invocationId, row])),
    relocation: null,
    conversationId: 'conversation',
  } as unknown as Authority;
}
const rejection = {
  submissionConsumed: false,
  toolAttemptCount: 0,
  validationRejectionCount: 0,
  successfulWriteCount: 0,
  hash,
  byteLength: 104,
};

describe('complete rejection with distinct planning and commit counters', () => {
  test('zero consumed commits can authorize one bounded planning correction', () => {
    expect(isTrialPlanRejectionContinuationEligible(rejection, 2)).toBe(true);
    expect(isTrialPlanRejectionContinuationEligible({ ...rejection, byteLength: 1051 }, 2)).toBe(
      true,
    );
    expect(
      isTrialPlanRejectionContinuationEligible(
        {
          ...rejection,
          submissionConsumed: true,
          toolAttemptCount: 1,
          validationRejectionCount: 1,
        },
        2,
      ),
    ).toBe(true);
  });
  test.each([
    { hash: 'invalid' },
    { byteLength: 0 },
    { successfulWriteCount: 1 },
    { toolAttemptCount: 1 },
    { validationRejectionCount: 1 },
    { submissionConsumed: true },
    { submissionConsumed: true, toolAttemptCount: 2, validationRejectionCount: 2 },
  ])('does not promote incomplete, written, inconsistent or exhausted evidence (%j)', (patch) => {
    expect(isTrialPlanRejectionContinuationEligible({ ...rejection, ...patch }, 2)).toBe(false);
  });
  test('missing/invalid frozen setting never defaults to two', () => {
    for (const max of [0, 4, Number.NaN])
      expect(isTrialPlanRejectionContinuationEligible(rejection, max)).toBe(false);
  });
});

describe('monotonic invocation reservations shared by all authority writers', () => {
  test('settled exact-ID replay preserves one slot; third fresh ID exceeds the total', () => {
    const one = authority([invocation('first')]);
    expect(() => assertTrialPlanningAuthorityTransition(one, one)).not.toThrow();
    const two = authority([
      invocation('first'),
      invocation('second', { trialPlanFeedbackKey: hash }),
    ]);
    expect(() => assertTrialPlanningAuthorityTransition(one, two)).not.toThrow();
    const three = authority([...Object.values(two.invocations), invocation('third')]);
    expect(() => assertTrialPlanningAuthorityTransition(two, three)).toThrow();
  });
  test('stale whole-map updates cannot erase a reserved slot', () => {
    const one = authority([invocation('first')]);
    expect(() => assertTrialPlanningAuthorityTransition(one, authority())).toThrow();
  });
  test('owner generation and frozen maximum never change', () => {
    const one = authority([invocation('first')]);
    expect(() =>
      assertTrialPlanningAuthorityTransition(one, {
        ...one,
        stage: { ...one.stage, operationGeneration: 2 },
      }),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(one, { ...one, trialPlanningMaxAttempts: 3 }),
    ).toThrow();
  });
  test.each([
    'requestDigest',
    'sessionId',
    'inputId',
    'executionMessageId',
    'trialPlanRequestDigest',
  ] as const)('exact-ID immutable %s conflicts do not grant replay authority', (key) => {
    const old = invocation('first');
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([{ ...old, [key]: 'different' }]),
      ),
    ).toThrow();
  });
  test('once-set settlement snapshot and affected-case fence cannot change or disappear', () => {
    const affected: NonNullable<Invocation['planReviewAffectedCases']> = [
      { caseId: 'generic-case', originalCaseHash: hash, failedExpectationTypes: ['task-status'] },
    ];
    const old = invocation('first', {
      completedSnapshotHash: hash,
      planReviewAffectedCases: affected,
    });
    for (const completedSnapshotHash of [undefined, 'b'.repeat(64)])
      expect(() =>
        assertTrialPlanningAuthorityTransition(
          authority([old]),
          authority([{ ...old, completedSnapshotHash }]),
        ),
      ).toThrow();
    for (const planReviewAffectedCases of [undefined, []])
      expect(() =>
        assertTrialPlanningAuthorityTransition(
          authority([old]),
          authority([{ ...old, planReviewAffectedCases }]),
        ),
      ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([{ ...old, planReviewAffectedCases: structuredClone(affected) }]),
      ),
    ).not.toThrow();
  });
  test('undefined fences may receive their first legitimate settlement value', () => {
    const old = invocation('first', { completed: null });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([
          {
            ...old,
            completed: settled,
            completedSnapshotHash: hash,
            planReviewAffectedCases: [
              {
                caseId: 'generic-case',
                originalCaseHash: hash,
                failedExpectationTypes: ['task-status'],
              },
            ],
          },
        ]),
      ),
    ).not.toThrow();
  });
  test('submitted and completed state never roll back', () => {
    const old = invocation('first');
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([{ ...old, executionSubmitted: false }]),
      ),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([{ ...old, completed: null }]),
      ),
    ).toThrow();
  });
  test('one full-error/source invocation feedback key cannot occupy another slot twice', () => {
    const old = invocation('first', { trialPlanFeedbackKey: hash });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, invocation('second', { trialPlanFeedbackKey: hash })]),
      ),
    ).toThrow();
  });
  test('unfinished planner admits only its exact submitted bounded continuation', () => {
    const old = invocation('first', { completed: null });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, invocation('parallel', { completed: null })]),
      ),
    ).toThrow();
    const continuation = invocation('continuation', {
      completed: null,
      executionSubmitted: false,
      trialPlanContinuationOf: old.invocationId,
    });
    expect(() =>
      assertTrialPlanningAuthorityTransition(authority([old]), authority([old, continuation])),
    ).not.toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, { ...continuation, trialPlanContinuationOf: 'other' }]),
      ),
    ).toThrow();
  });
  test('definitive failure permits only its exact explicit Retry predecessor', () => {
    const failure: NonNullable<Invocation['trialPlanDefinitiveProviderFailure']> = {
      kind: 'failed_terminal' as const,
      phase: 'execution' as const,
      code: 'provider_billing_required',
      requestDigest: hash,
      trialPlanRequestDigest: hash,
      trialPlanRequest: {
        reason: 'missing',
        relativePlanPath: 'generic/generic.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'Original finite request',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'original-attempt',
      },
    };
    const old = invocation('failed', {
      completed: null,
      trialPlanDefinitiveProviderFailure: failure,
    });
    const retry = invocation('retry', {
      completed: null,
      executionSubmitted: false,
      trialPlanProviderRetryOf: old.invocationId,
      trialPlanProviderRetryProofHash: hash,
    });
    expect(() =>
      assertTrialPlanningAuthorityTransition(authority([old]), authority([old, retry])),
    ).not.toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, { ...retry, trialPlanProviderRetryOf: undefined }]),
      ),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, { ...retry, trialPlanProviderRetryOf: 'other' }]),
      ),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([old, { ...retry, trialPlanProviderRetryProofHash: undefined }]),
      ),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old]),
        authority([{ ...old, trialPlanDefinitiveProviderFailure: undefined }]),
      ),
    ).toThrow();
    const unknown = invocation('unknown', { completed: null });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        authority([old, unknown]),
        authority([old, unknown, retry]),
      ),
    ).toThrow();
  });
  test('legacy missing max preserves existing result but cannot reserve another ID', () => {
    const old = { ...authority([invocation('first')]), trialPlanningMaxAttempts: undefined };
    expect(() => assertTrialPlanningAuthorityTransition(old, old)).not.toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(old, {
        ...old,
        invocations: { ...old.invocations, second: invocation('second') },
      }),
    ).toThrow();
  });
});

function evidenceReference(
  trialId: string,
  byteLength: number,
  evidenceHash: string = hash,
): ChatRepairEvidenceReference {
  return {
    schemaVersion: 1,
    kind: 'repair-evidence-blob',
    workspaceScopeId: 'scope',
    operationId: 'operation',
    operationGeneration: 1,
    stageId: 'stage',
    trialId,
    hash: evidenceHash,
    byteLength,
  };
}

describe('finite before-record merge preserves unrelated legitimate writes', () => {
  test('stale relocation update keeps a newly reserved planner and newer error reference', () => {
    const before = authority([invocation('first')]);
    const evidence = evidenceReference('trial-new', 1355);
    const current = {
      ...authority([invocation('first'), invocation('second')]),
      repairErrorEvidence: evidence,
    } as unknown as Authority;
    const next = { ...before, relocation: { phase: 'restored' } } as unknown as Authority;
    const merged = mergeManagedAuthoringAuthorityUpdate(current, before, next);
    expect(merged.invocations).toEqual(current.invocations);
    expect(merged.repairErrorEvidence).toEqual(evidence);
    expect(merged.relocation).toEqual(next.relocation);
    expect(() => assertTrialPlanningAuthorityTransition(current, merged)).not.toThrow();
  });
  test('settlement update preserves concurrent relocation and complete evidence', () => {
    const pending = invocation('first', { completed: null });
    const before = authority([pending]);
    const current = {
      ...before,
      relocation: { phase: 'restored' },
      repairErrorEvidence: evidenceReference('trial-new', 1213),
    } as unknown as Authority;
    const next = authority([invocation('first')]);
    const merged = mergeManagedAuthoringAuthorityUpdate(current, before, next);
    expect(merged.relocation).toEqual(current.relocation);
    expect(merged.repairErrorEvidence).toEqual(current.repairErrorEvidence);
    expect(merged.invocations.first?.completed).toEqual(settled);
  });
  test('two pending same-ID writers cannot both claim planner admission', () => {
    const pending = invocation('first', { completed: null, executionSubmitted: false });
    const before = authority([pending]);
    const claimed = authority([{ ...pending, trialPlanAdmissionClaimed: true }]);
    expect(mergeManagedAuthoringAuthorityUpdate(before, before, claimed)).toEqual(claimed);
    expect(() => mergeManagedAuthoringAuthorityUpdate(claimed, before, claimed)).toThrow();
    expect(() => assertTrialPlanningAuthorityTransition(claimed, before)).toThrow();
  });
  test('conflicting same-field evidence update fails instead of overwriting', () => {
    const before = authority();
    const current = {
      ...before,
      repairErrorEvidence: evidenceReference('one', 1355),
    } as unknown as Authority;
    const next = {
      ...before,
      repairErrorEvidence: evidenceReference('two', 1213, 'b'.repeat(64)),
    } as unknown as Authority;
    expect(() => mergeManagedAuthoringAuthorityUpdate(current, before, next)).toThrow();
  });
});

describe('blocked core allows bounded plan correction without artifact promotion', () => {
  function plan(
    status: string = 'blocked',
    scope: string = 'diagnostic-only',
    severity: string = 'blocking',
  ) {
    return {
      evidenceReview: { coreWitness: { status } },
      findings: [
        {
          summary: 'Generic blocked witness',
          evidence: 'No exact witness',
          repairScope: scope,
          severity,
        },
      ],
    } as unknown as ChatPipelineTrialPlan;
  }
  test('a committed blocked plan can request its remaining plan-only correction', () => {
    const value = plan();
    expect(isBlockedCorePlanReviewCandidate(value, planBlockingDiagnostics(value), 1, 2)).toBe(
      true,
    );
  });
  test('exhausted, artifact, nonblocking and covered plans never use this exception', () => {
    for (const value of [
      plan('covered'),
      plan('blocked', 'pipeline-artifact'),
      plan('blocked', 'diagnostic-only', 'warning'),
    ])
      expect(isBlockedCorePlanReviewCandidate(value, planBlockingDiagnostics(value), 1, 2)).toBe(
        false,
      );
    const blocked = plan();
    expect(isBlockedCorePlanReviewCandidate(blocked, planBlockingDiagnostics(blocked), 2, 2)).toBe(
      false,
    );
    expect(isBlockedCorePlanReviewCandidate(blocked, planBlockingDiagnostics(blocked), 0, 4)).toBe(
      false,
    );
  });
});

describe('finite consumed-predecessor graph at an already frozen maximum of three', () => {
  const capThree = (rows: readonly Invocation[]) => ({
    ...authority(rows),
    trialPlanningMaxAttempts: 3,
  });
  const failure: NonNullable<Invocation['trialPlanDefinitiveProviderFailure']> = {
    kind: 'failed_terminal' as const,
    phase: 'execution' as const,
    code: 'provider_billing_required',
    requestDigest: hash,
    trialPlanRequestDigest: hash,
    trialPlanRequest: {
      reason: 'missing',
      relativePlanPath: 'generic/generic.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'Original finite request',
      maxAttempts: 3,
      requiredCoverage: ['multiple-inputs'],
      attemptId: 'original-attempt',
    },
  };
  const failed = () =>
    invocation('failed', { completed: null, trialPlanDefinitiveProviderFailure: failure });
  const retry = (parent: Invocation, changes: Partial<Invocation> = {}) =>
    invocation('retry', {
      trialPlanProviderRetryOf: parent.invocationId,
      trialPlanProviderRetryProofHash: hash,
      ...changes,
    });

  test('authenticated consumed failure remains counted while its settled successor permits slot three', () => {
    const old = failed();
    const child = retry(old);
    const previous = capThree([old, child]);
    const third = invocation('third', { trialPlanFeedbackKey: 'b'.repeat(64) });
    expect(() =>
      assertTrialPlanningAuthorityTransition(previous, capThree([old, child, third])),
    ).not.toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([old, child, third]),
        capThree([old, child, third, invocation('fourth')]),
      ),
    ).toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(previous, capThree([child, third])),
    ).toThrow();
  });

  test('truncated exact Retry permits only its own third-slot continuation', () => {
    const old = failed();
    const child = retry(old, { completed: null });
    const continuation = invocation('third', {
      completed: null,
      executionSubmitted: false,
      trialPlanContinuationOf: child.invocationId,
    });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([old, child]),
        capThree([old, child, continuation]),
      ),
    ).not.toThrow();
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([old, child]),
        capThree([old, child, { ...continuation, trialPlanContinuationOf: old.invocationId }]),
      ),
    ).toThrow();
  });

  test('completed exact continuation consumes its truncated ancestor, never an unknown child', () => {
    const parent = invocation('truncated', { completed: null });
    const child = invocation('continued', { trialPlanContinuationOf: parent.invocationId });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([parent, child]),
        capThree([parent, child, invocation('third')]),
      ),
    ).not.toThrow();
    const unknown = { ...child, completed: null, executionSubmitted: false };
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([parent, unknown]),
        capThree([parent, unknown, invocation('third')]),
      ),
    ).toThrow();
  });

  test.each([
    'no-carrier',
    'wrong-session',
    'wrong-request',
    'no-proof',
    'wrong-parent',
    'mixed-edge',
  ] as const)('does not consume a failed ancestor through %s', (fault) => {
    const original = failed();
    const old =
      fault === 'no-carrier'
        ? { ...original, trialPlanDefinitiveProviderFailure: undefined }
        : original;
    const child = retry(old, {
      ...(fault === 'wrong-session' ? { sessionId: 'other' } : {}),
      ...(fault === 'wrong-request' ? { trialPlanRequestDigest: 'b'.repeat(64) } : {}),
      ...(fault === 'no-proof' ? { trialPlanProviderRetryProofHash: undefined } : {}),
      ...(fault === 'wrong-parent' ? { trialPlanProviderRetryOf: 'missing' } : {}),
      ...(fault === 'mixed-edge' ? { trialPlanContinuationOf: old.invocationId } : {}),
    });
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        capThree([old, child]),
        capThree([old, child, invocation('third')]),
      ),
    ).toThrow();
  });

  test('one definitive failure cannot be consumed by a second Retry or hide another active/unknown reservation', () => {
    const old = failed();
    const child = retry(old);
    const previous = capThree([old, child]);
    expect(() =>
      assertTrialPlanningAuthorityTransition(
        previous,
        capThree([
          old,
          child,
          invocation('duplicate-retry', {
            trialPlanProviderRetryOf: old.invocationId,
            trialPlanProviderRetryProofHash: hash,
          }),
        ]),
      ),
    ).toThrow();
    for (const executionSubmitted of [false, true]) {
      const pending = retry(old, { completed: null, executionSubmitted });
      expect(() =>
        assertTrialPlanningAuthorityTransition(
          capThree([old, pending]),
          capThree([old, pending, invocation('fresh')]),
        ),
      ).toThrow();
    }
  });
});

const noProgressHash = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('no-progress metadata stays separate from rejection telemetry', () => {
  test('rejects invented zero counters, unknown fields and a different original request digest', () => {
    const sourcePlanRequest = {
      reason: 'missing' as const,
      relativePlanPath: 'alpha/alpha.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'A committed plan is required.',
      maxAttempts: 2,
      requiredCoverage: ['multiple-inputs'],
      attemptId: 'original-attempt',
    } satisfies NonNullable<ChatOperationV2AuthoringInvocationRequest['trialPlanRequest']>;
    const ordered = Object.fromEntries(
      Object.entries(sourcePlanRequest).sort(([left], [right]) => left.localeCompare(right)),
    );
    const observation = {
      kind: 'completed_planner_no_progress',
      workspaceScopeId: 'scope-1',
      operationId: 'operation-1',
      operationGeneration: 1,
      stageId: 'stage-1',
      invocationId: 'planner-1',
      sessionId: 'session-1',
      inputId: 'input-1',
      requestDigest: noProgressHash('request'),
      trialPlanRequestDigest: noProgressHash(JSON.stringify(ordered)),
      completedSnapshotHash: noProgressHash('snapshot'),
      errorEvidenceHash: noProgressHash('full error'),
      planArtifactStatus: 'absent',
    } satisfies ChatOperationV2TrialPlannerNoProgress;
    expect(validateTrialPlannerNoProgressContext({ observation, sourcePlanRequest })).toEqual({
      observation,
      sourcePlanRequest,
    });
    expect(() =>
      validateTrialPlannerNoProgressContext({
        observation: { ...observation, toolAttemptCount: 0 },
        sourcePlanRequest,
      }),
    ).toThrow();
    expect(() =>
      validateTrialPlannerNoProgressContext({
        observation: { ...observation, submissionConsumed: false },
        sourcePlanRequest,
      }),
    ).toThrow();
    expect(() =>
      validateTrialPlannerNoProgressContext({
        observation,
        sourcePlanRequest: { ...sourcePlanRequest, attemptId: 'other-attempt' },
      }),
    ).toThrow();
    expect(() =>
      validateTrialPlannerNoProgressContext({
        observation: { ...observation, requestDigest: 'bad' },
        sourcePlanRequest,
      }),
    ).toThrow();
    expect(() =>
      validateTrialPlannerNoProgressContext({ observation, sourcePlanRequest, newBudget: 3 }),
    ).toThrow();
  });
});
