import { describe, expect, test } from 'bun:test';

import {
  createChatVerificationOutcome,
  formatChatVerificationOutcomeForExport,
  parseChatVerificationOutcome,
  serializeChatVerificationOutcome,
} from '../shared/chat-verification-outcome.js';

describe('Chat verification outcome', () => {
  test('represents full success and partial Sandbox coverage without parsing diagnostic prose', () => {
    const passed = createChatVerificationOutcome({
      trialKind: 'passed',
      ran: true,
      plannedCaseCount: 2,
      caseResultCount: 2,
      passedCaseCount: 2,
      failedCaseCount: 0,
      notRunCaseCount: 0,
      taskStatusCounts: { success: 4 },
      liveSmokeStatus: 'passed',
      reasonCode: null,
      details: 'All verification evidence is available.',
    });
    const partial = createChatVerificationOutcome({
      trialKind: 'blocked',
      ran: true,
      plannedCaseCount: 2,
      caseResultCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      notRunCaseCount: 1,
      taskStatusCounts: { success: 2, skipped: 14 },
      liveSmokeStatus: 'skipped',
      reasonCode: 'trial_blocked',
      details: 'One case could not run safely.',
    });

    expect(passed).toMatchObject({
      sandbox: { status: 'passed', passedCaseCount: 2, plannedCaseCount: 2 },
      liveSmoke: { status: 'passed' },
    });
    expect(partial).toMatchObject({
      sandbox: { status: 'partial', passedCaseCount: 1, notRunCaseCount: 1 },
      liveSmoke: { status: 'skipped' },
      reasonCode: 'trial_blocked',
    });

    const reparsed = parseChatVerificationOutcome(serializeChatVerificationOutcome(partial));
    expect(reparsed).toEqual(partial);
    expect(formatChatVerificationOutcomeForExport(partial, 'published')).toContain(
      'Sandbox Trial: partial (1/2 cases passed; 1 not run)',
    );
  });

  test('distinguishes disabled Trial from failed Trial and Live Smoke failure', () => {
    const disabled = createChatVerificationOutcome({
      trialKind: 'blocked',
      ran: false,
      plannedCaseCount: 0,
      caseResultCount: 0,
      passedCaseCount: 0,
      failedCaseCount: 0,
      notRunCaseCount: 0,
      taskStatusCounts: {},
      liveSmokeStatus: 'not_enabled',
      reasonCode: 'trial_disabled',
      details: 'Sandbox Trial consent is not enabled.',
    });
    const failed = createChatVerificationOutcome({
      trialKind: 'failed',
      ran: true,
      plannedCaseCount: 1,
      caseResultCount: 1,
      passedCaseCount: 0,
      failedCaseCount: 1,
      notRunCaseCount: 0,
      taskStatusCounts: { failed: 1 },
      liveSmokeStatus: 'failed',
      reasonCode: 'trial_failed',
      details: 'The executed case failed.',
    });

    expect(disabled).toMatchObject({
      sandbox: { status: 'skipped' },
      liveSmoke: { status: 'not_enabled' },
    });
    expect(failed).toMatchObject({
      sandbox: { status: 'failed', failedCaseCount: 1 },
      liveSmoke: { status: 'failed' },
    });
  });

  test('round-trips long diagnostic content without expanding it into status inference', () => {
    const details = 'bounded diagnostic '.repeat(300);
    const outcome = createChatVerificationOutcome({
      trialKind: 'passed-with-warnings',
      ran: true,
      plannedCaseCount: 1,
      caseResultCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      notRunCaseCount: 0,
      taskStatusCounts: { success: 1 },
      liveSmokeStatus: 'not_enabled',
      reasonCode: 'trial_passed_with_warnings',
      details,
    });

    expect(parseChatVerificationOutcome(serializeChatVerificationOutcome(outcome))?.details).toBe(
      details,
    );
    expect(outcome.sandbox.status).toBe('passed');
  });

  test('rejects prose and unknown structured fields instead of guessing semantics', () => {
    expect(
      parseChatVerificationOutcome(
        'Sandbox Trial passed but Live Smoke was skipped because data was unavailable.',
      ),
    ).toBeNull();
    expect(
      parseChatVerificationOutcome({
        schemaVersion: 1,
        sandbox: {
          status: 'passed',
          plannedCaseCount: 1,
          resultCaseCount: 1,
          passedCaseCount: 1,
          failedCaseCount: 0,
          notRunCaseCount: 0,
          taskStatusCounts: { success: 1 },
        },
        liveSmoke: { status: 'not_enabled' },
        reasonCode: null,
        details: 'ok',
        inferredFromEnglish: true,
      }),
    ).toBeNull();
  });

  test('does not reinterpret a failed zero-case execution as passed', () => {
    const outcome = createChatVerificationOutcome({
      trialKind: 'failed',
      ran: true,
      plannedCaseCount: 0,
      caseResultCount: 0,
      passedCaseCount: 0,
      failedCaseCount: 0,
      notRunCaseCount: 0,
      taskStatusCounts: {},
      liveSmokeStatus: 'failed',
      reasonCode: 'trial_failed',
      details: 'The harness failed before a case result was available.',
    });

    expect(outcome.sandbox.status).toBe('failed');
  });
});
