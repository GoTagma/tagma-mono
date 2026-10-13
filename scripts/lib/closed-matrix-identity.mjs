// Pure closed-matrix identity and closure predicates; callers supply frozen identity.
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (value, code) => {
  if (!value) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
};
export function validateClosedMatrixIdentity(matrix, closed, identity) {
  check(
    matrix?.runId === identity.runId &&
      matrix.sourceManifestSha256 === identity.sourceManifestSha256 &&
      matrix.actualCaseCount === closed.size &&
      Array.isArray(matrix.cases) &&
      matrix.cases.length === identity.caseIds.length &&
      equal(
        matrix.cases.map((row) => row.caseId),
        identity.caseIds,
      ),
    'closed_matrix_scope_or_inventory_mismatch',
  );
  const started = matrix.cases.filter((row) => Object.hasOwn(row, 'originalSendCount'));
  const unstarted = matrix.cases.filter((row) => !Object.hasOwn(row, 'originalSendCount'));
  check(
    started.length === closed.size &&
      equal(
        started.map((row) => row.caseId),
        identity.caseIds.slice(0, closed.size),
      ) &&
      started.every(
        (row) =>
          [0, 1].includes(row.originalSendCount) &&
          row.processKnownClosed === true &&
          row.paidScopeKnownSettled === true &&
          closed.has(row.caseId),
      ) &&
      unstarted.every(
        (row) =>
          row.status === 'NOT RUN' &&
          typeof row.reason === 'string' &&
          row.reason.length > 0 &&
          equal(Object.keys(row).sort(), ['caseId', 'reason', 'status']),
      ),
    'closed_matrix_started_closure_unknown',
  );
  return Object.freeze({
    actualStartedCount: started.length,
    actualSentCount: started.filter((row) => row.originalSendCount === 1).length,
    actualClosedNoSendCount: started.filter((row) => row.originalSendCount === 0).length,
    actualUnstartedCount: unstarted.length,
  });
}
