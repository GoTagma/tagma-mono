import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'bun:test';
import {
  createClarificationObserverLease,
  clarificationObservationSlot,
} from './clarification-observer-lease.mjs';
const sha = (x) => createHash('sha256').update(x).digest('hex');
const NOW = 1791820000000,
  configSha256 = sha('synthetic-config'),
  sourceSha256 = sha('synthetic-source');
function fixture() {
  let clock = NOW,
    available = false,
    replyKind = 'new_pipeline_goal';
  const writes = [],
    reads = [],
    reservations = new Set();
  const runId = 'synthetic-portable-observer';
  const question = 'Do you want an explanation, a one-off action, or a pipeline change?';
  const dto = {
    runId,
    caseId: 'ExampleOne',
    workspace: '/synthetic/fresh-workspace',
    configBinding: { sha256: configSha256 },
    sourceSHA256: sourceSha256,
    observedAt: NOW,
    operation: {
      operationId: 'op-synthetic',
      generation: 1,
      version: 3,
      phase: 'awaiting_input',
      waitReason: 'clarification',
      executionState: 'waiting_for_user',
    },
    pending: {
      clarificationId: 'clarification-synthetic',
      question,
      questionSHA256: sha(question),
      requestedAt: NOW,
      expiresAt: NOW + 60000,
    },
    normalDelegatedReceipts: [],
    resolvedAlreadyAuthorizedChoice: { replyKind, requestedFilename: null },
  };
  const lease = createClarificationObserverLease({
    runId,
    configSha256,
    sourceSha256,
    caseIds: ['ExampleOne'],
    now: () => clock,
  });
  const arm = () =>
    lease.arm({
      runId,
      configSha256,
      sourceSha256,
      exclusiveLeaseAcquired: true,
      actualRunRootAbsent: true,
      armedAt: clock,
    });
  const launch = () =>
    lease.observeLaunch({
      runId,
      configSha256,
      sourceManifestSha256: sourceSha256,
      startedAt: clock,
    });
  const handlers = {
    observeCase: async (id) => {
      reads.push({ id, at: clock });
      return available ? { ...dto, observedAt: clock } : null;
    },
    reserveSlot: async (r) => {
      assert.equal(reservations.has(r.slot), false);
      reservations.add(r.slot);
      return { created: true };
    },
    writeChoice: async (x) => {
      writes.push(x);
      return { metadataChoicePrepared: true, writerTypedPostCount: 0 };
    },
  };
  return {
    lease,
    dto,
    handlers,
    arm,
    launch,
    writes,
    reads,
    setTime: (x) => (clock = x),
    setAvailable: (x) => (available = x),
  };
}
test('Portable observer prearms and periodic saved reads include the first 60sec question', async () => {
  const f = fixture();
  f.arm();
  assert.equal((await f.lease.tick(f.handlers)).waitingForActualLaunch, true);
  f.setTime(NOW + 1);
  f.launch();
  for (let n = 1; n <= 4; n++) {
    f.setTime(NOW + 250 * n);
    if (n === 2) f.setAvailable(true);
    await f.lease.tick(f.handlers);
  }
  assert.equal(f.reads.length, 4);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].caseId, 'ExampleOne');
  assert.equal(f.lease.summary().originalSendAdded, 0);
  assert.equal(f.lease.summary().directTypedPOSTCount, 0);
});
test('Portable observer reserves once across text version change and unknown acknowledgement', async () => {
  const f = fixture();
  f.arm();
  f.launch();
  f.setAvailable(true);
  await f.lease.tick(f.handlers);
  f.dto.operation.version++;
  f.dto.pending.question += ' Please confirm.';
  f.dto.pending.questionSHA256 = sha(f.dto.pending.question);
  f.dto.normalDelegatedReceipts = [
    { reservationKey: clarificationObservationSlot(f.dto), status: 'UNKNOWN_HELD' },
  ];
  f.setTime(NOW + 1000);
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 1);
  assert.equal(f.lease.summary().slots[0].acknowledgement, 'UNKNOWN_HELD');
});
test('Portable observer true saved freshness and Host expiry block delayed metadata writes', async () => {
  const f = fixture();
  f.arm();
  f.launch();
  f.setAvailable(true);
  const old = { ...f.dto, observedAt: NOW };
  f.setTime(NOW + 3001);
  await f.lease.tick({ ...f.handlers, observeCase: async () => old });
  assert.equal(f.writes.length, 0);
  f.setTime(NOW + 60000);
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
});
test('Portable observer unknown business choice remains unguessed and writer failure stays once', async () => {
  const f = fixture();
  f.arm();
  f.launch();
  f.setAvailable(true);
  f.dto.resolvedAlreadyAuthorizedChoice = null;
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
  f.dto.resolvedAlreadyAuthorizedChoice = {
    replyKind: 'named_new_pipeline',
    requestedFilename: 'generic.yaml',
  };
  let calls = 0;
  await f.lease.tick({
    ...f.handlers,
    writeChoice: async () => {
      calls++;
      throw new Error('unknown response');
    },
  });
  await f.lease.tick(f.handlers);
  assert.equal(calls, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(
    f.lease.summary().slots[0].acknowledgement,
    'UNKNOWN_NOT_DERIVED_FROM_METADATA_WRITE',
  );
});
