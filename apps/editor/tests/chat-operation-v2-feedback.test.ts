import { describe, expect, test } from 'bun:test';
import { toHostOperationEventInput } from '../server/chat-operations/events';
import { isChatOperationFeedback } from '../shared/chat-operation-feedback';

const feedback = {
  schemaVersion: 1 as const,
  stage: 'trial' as const,
  details: 'Process startup failed for the copied working directory.',
  failedTaskIds: ['main.check'],
  omittedFailedTaskCount: 0,
};
const event = {
  schemaVersion: 1,
  eventId: 'event-feedback',
  type: 'trial_status_changed',
  timestamp: 1000,
  payload: {
    stageId: 'stage-one',
    trialId: 'trial-one',
    status: 'failed',
    planHash: null,
    caseCount: 1,
    passedCount: 0,
    failedCount: 1,
    warningCount: 0,
    errorCode: 'trial_failed',
  },
};

describe('Host verification feedback contract', () => {
  test('preserves bounded feedback in the durable Trial event', () => {
    expect(
      toHostOperationEventInput({ ...event, payload: { ...event.payload, feedback } }).payload
        ?.feedback,
    ).toEqual(feedback);
  });
  test('keeps older Trial events without feedback valid', () => {
    expect(toHostOperationEventInput(event).payload).not.toHaveProperty('feedback');
  });
  test('rejects credentials, private paths, duplicate IDs and unbounded text', () => {
    for (const invalid of [
      { ...feedback, details: 'Bearer private-provider-token' },
      { ...feedback, details: 'C:\\private\\workspace' },
      { ...feedback, details: 'x'.repeat(4097) },
      { ...feedback, failedTaskIds: ['main.check', 'main.check'] },
      { ...feedback, providerText: 'not permitted' },
    ]) {
      expect(isChatOperationFeedback(invalid)).toBe(false);
      expect(() =>
        toHostOperationEventInput({ ...event, payload: { ...event.payload, feedback: invalid } }),
      ).toThrow();
    }
    expect(isChatOperationFeedback(feedback)).toBe(true);
  });
});
