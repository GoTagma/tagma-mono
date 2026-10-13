import { test, expect } from 'bun:test';
import { validateClosedMatrixIdentity } from './closed-matrix-identity.mjs';

const identity = {
  runId: 'closed-fixture-run',
  sourceManifestSha256: 'a'.repeat(64),
  caseIds: ['alpha', 'beta', 'gamma'],
};
const unstarted = (caseId: string) => ({ caseId, status: 'NOT RUN', reason: 'not_started' });
const closedRow = (caseId: string, originalSendCount: number, status = 'NOT RUN') => ({
  caseId,
  status,
  originalSendCount,
  paidScopeKnownSettled: true,
  processKnownClosed: true,
});
function matrix(started: ReturnType<typeof closedRow>[] = []) {
  return {
    runId: identity.runId,
    sourceManifestSha256: identity.sourceManifestSha256,
    actualCaseCount: started.length,
    cases: identity.caseIds.map(
      (caseId) => started.find((row) => row.caseId === caseId) ?? unstarted(caseId),
    ),
  };
}

test('closed matrix preserves closed zero Send slots and derives sent count from submission facts', () => {
  const sent = matrix([closedRow('alpha', 1, 'NOT_FULL_PASS')]);
  expect(validateClosedMatrixIdentity(sent, new Set(['alpha']), identity)).toEqual({
    actualStartedCount: 1,
    actualSentCount: 1,
    actualClosedNoSendCount: 0,
    actualUnstartedCount: 2,
  });
  const noSend = matrix([closedRow('alpha', 0)]);
  expect(() => validateClosedMatrixIdentity(noSend, new Set(['alpha']), identity)).not.toThrow();
  expect(validateClosedMatrixIdentity(noSend, new Set(['alpha']), identity)).toEqual({
    actualStartedCount: 1,
    actualSentCount: 0,
    actualClosedNoSendCount: 1,
    actualUnstartedCount: 2,
  });
  const mixed = matrix([closedRow('alpha', 0), closedRow('beta', 1)]);
  expect(validateClosedMatrixIdentity(mixed, new Set(['alpha', 'beta']), identity)).toEqual({
    actualStartedCount: 2,
    actualSentCount: 1,
    actualClosedNoSendCount: 1,
    actualUnstartedCount: 1,
  });
});

test('closed matrix separates unstarted slots and rejects unknown closure evidence', () => {
  expect(validateClosedMatrixIdentity(matrix(), new Set(), identity)).toEqual({
    actualStartedCount: 0,
    actualSentCount: 0,
    actualClosedNoSendCount: 0,
    actualUnstartedCount: 3,
  });
  for (const field of ['paidScopeKnownSettled', 'processKnownClosed']) {
    for (const value of [false, 'UNKNOWN', null, undefined]) {
      const changed = matrix([closedRow('alpha', 0)]);
      Object.assign(changed.cases[0], { [field]: value });
      expect(() => validateClosedMatrixIdentity(changed, new Set(['alpha']), identity)).toThrow(
        'closed_matrix_started_closure_unknown',
      );
    }
  }
  for (const value of [2, -1, '0', true, null]) {
    const changed = matrix([closedRow('alpha', 0)]);
    Object.assign(changed.cases[0], { originalSendCount: value });
    expect(() => validateClosedMatrixIdentity(changed, new Set(['alpha']), identity)).toThrow(
      'closed_matrix_started_closure_unknown',
    );
  }
  const extra = matrix();
  Object.assign(extra.cases[0], { paidScopeKnownSettled: true });
  expect(() => validateClosedMatrixIdentity(extra, new Set(), identity)).toThrow(
    'closed_matrix_started_closure_unknown',
  );
  const missingReason = matrix();
  Object.assign(missingReason.cases[0], { reason: '' });
  expect(() => validateClosedMatrixIdentity(missingReason, new Set(), identity)).toThrow(
    'closed_matrix_started_closure_unknown',
  );
});

test('closed matrix rejects mismatched source run inventory and nonserial closed identities', () => {
  const first = matrix([closedRow('alpha', 1, 'PASS')]);
  expect(validateClosedMatrixIdentity(first, new Set(['alpha']), identity).actualSentCount).toBe(1);
  for (const changed of [
    { ...first, runId: 'foreign-run' },
    { ...first, sourceManifestSha256: 'b'.repeat(64) },
    { ...first, actualCaseCount: 0 },
    { ...first, cases: [...first.cases].reverse() },
    { ...first, cases: first.cases.slice(0, 2) },
  ]) {
    expect(() => validateClosedMatrixIdentity(changed, new Set(['alpha']), identity)).toThrow(
      'closed_matrix_scope_or_inventory_mismatch',
    );
  }
  expect(() => validateClosedMatrixIdentity(first, new Set(['beta']), identity)).toThrow(
    'closed_matrix_started_closure_unknown',
  );
  const nonserial = matrix([closedRow('beta', 0)]);
  expect(() => validateClosedMatrixIdentity(nonserial, new Set(['beta']), identity)).toThrow(
    'closed_matrix_started_closure_unknown',
  );
  expect(() => validateClosedMatrixIdentity(first, new Set(['alpha', 'beta']), identity)).toThrow(
    'closed_matrix_scope_or_inventory_mismatch',
  );
});
