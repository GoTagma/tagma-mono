import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createClarificationObserverLease } from './clarification-observer-lease.mjs';
import { createOptionalJSONPollReader } from './optional-json-poll-reader.mjs';

function fixture() {
  let clock = 10000;
  const files = new Map();
  const calls = [];
  const read = createOptionalJSONPollReader({
    readBytes: async (path, options) => {
      calls.push({ path, options });
      return files.has(path) ? Buffer.from(files.get(path)) : null;
    },
    now: () => clock,
  });
  return { read, files, calls, time: () => clock, setTime: (value) => (clock = value) };
}

test('optional JSON poll holds incomplete bytes then accepts the completed document', async () => {
  const f = fixture();
  assert.equal(await f.read('metadata'), null);
  f.files.set('metadata', '{"complete":true}');
  assert.deepEqual(await f.read('metadata'), { complete: true });
  f.files.set('metadata', '{"complete":');
  assert.equal(await f.read('metadata'), null);
  f.setTime(10250);
  f.files.set('metadata', '{"complete":true,"version":2}');
  assert.deepEqual(await f.read('metadata'), { complete: true, version: 2 });
  assert.ok(f.calls.every((call) => call.options.optional === true));
});

test('optional JSON poll rejects unchanged malformed JSON at the bounded deadline', async () => {
  const f = fixture();
  f.files.set('metadata', '{');
  assert.equal(await f.read('metadata'), null);
  f.setTime(10999);
  assert.equal(await f.read('metadata'), null);
  f.setTime(11000);
  await assert.rejects(f.read('metadata'), { code: 'operator_optional_json_malformed' });
});

test('optional JSON poll does not reset its deadline when malformed bytes change', async () => {
  const f = fixture();
  f.files.set('metadata', '{');
  assert.equal(await f.read('metadata'), null);
  f.setTime(10750);
  f.files.set('metadata', '{"complete":');
  assert.equal(await f.read('metadata'), null);
  f.setTime(11000);
  f.files.set('metadata', '{"complete":true,');
  await assert.rejects(f.read('metadata'), { code: 'operator_optional_json_unsettled' });
});

test('optional JSON poll does not reset its deadline when malformed metadata disappears', async () => {
  const f = fixture();
  f.files.set('metadata', '{');
  assert.equal(await f.read('metadata'), null);
  f.files.delete('metadata');
  f.setTime(10500);
  assert.equal(await f.read('metadata'), null);
  f.setTime(11000);
  await assert.rejects(f.read('metadata'), { code: 'operator_optional_json_unsettled' });
});

test('optional JSON poll clears a completed document interval before a later producer write', async () => {
  const f = fixture();
  f.files.set('metadata', '{');
  assert.equal(await f.read('metadata'), null);
  f.setTime(10750);
  f.files.set('metadata', '{"version":1}');
  assert.deepEqual(await f.read('metadata'), { version: 1 });
  f.setTime(15000);
  f.files.set('metadata', '{"version":');
  assert.equal(await f.read('metadata'), null);
  f.setTime(16000);
  await assert.rejects(f.read('metadata'), { code: 'operator_optional_json_malformed' });
});

test('optional JSON poll keeps independent deadlines for separate metadata coordinates', async () => {
  const f = fixture();
  f.files.set('first', '{');
  assert.equal(await f.read('first'), null);
  f.setTime(10750);
  f.files.set('second', '{');
  assert.equal(await f.read('second'), null);
  f.setTime(11000);
  await assert.rejects(f.read('first'), { code: 'operator_optional_json_malformed' });
  assert.equal(await f.read('second'), null);
  f.setTime(11750);
  await assert.rejects(f.read('second'), { code: 'operator_optional_json_malformed' });
});

test('optional JSON poll propagates exact reader failures without retrying a read or mutation', async () => {
  const original = Object.assign(new Error('private bounded read failed'), {
    code: 'synthetic_exact_read_guard',
  });
  let reads = 0;
  const read = createOptionalJSONPollReader({
    readBytes: async () => {
      reads++;
      throw original;
    },
  });
  await assert.rejects(read('metadata'), (error) => error === original);
  assert.equal(reads, 1);
});

test('optional JSON poll never holds non-syntax decoding exceptions', async () => {
  const original = new TypeError('synthetic decode failed');
  const read = createOptionalJSONPollReader({
    readBytes: async () => ({
      toString: () => {
        throw original;
      },
    }),
  });
  await assert.rejects(read('metadata'), (error) => error === original);
});

test('optional JSON poll rejects invalid grace and backward or invalid clocks', async () => {
  for (const graceMs of [0, -1, 1001, Infinity, 0.5])
    assert.throws(() => createOptionalJSONPollReader({ readBytes: async () => null, graceMs }), {
      code: 'operator_optional_json_poll_configuration_invalid',
    });
  assert.throws(() => createOptionalJSONPollReader(), {
    code: 'operator_optional_json_poll_configuration_invalid',
  });
  const f = fixture();
  f.files.set('metadata', '{');
  assert.equal(await f.read('metadata'), null);
  f.setTime(9999);
  await assert.rejects(f.read('metadata'), { code: 'operator_optional_json_poll_clock_invalid' });
  const invalid = createOptionalJSONPollReader({
    readBytes: async () => Buffer.from('{'),
    now: () => NaN,
  });
  await assert.rejects(invalid('metadata'), { code: 'operator_optional_json_poll_clock_invalid' });
});

test('optional JSON poll returns ordinary complete JSON values without fabricating objects', async () => {
  const f = fixture();
  for (const value of [null, false, 0, '', [], { complete: false }]) {
    f.files.set('metadata', JSON.stringify(value));
    assert.deepEqual(await f.read('metadata'), value);
  }
});

const digest = (value) => createHash('sha256').update(value).digest('hex');
function observerFixture() {
  const f = fixture();
  const question = 'Do you want an explanation, a one-off action, or a pipeline change?';
  const dto = {
    runId: 'synthetic-poll-reader-observer',
    caseId: 'ExampleOne',
    workspace: '/synthetic/fresh-workspace',
    configBinding: { sha256: digest('synthetic-config') },
    sourceSHA256: digest('synthetic-source'),
    observedAt: 10000,
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
      questionSHA256: digest(question),
      requestedAt: 10000,
      expiresAt: 70000,
    },
    normalDelegatedReceipts: [],
    resolvedAlreadyAuthorizedChoice: { replyKind: 'new_pipeline_goal', requestedFilename: null },
  };
  const lease = createClarificationObserverLease({
    runId: dto.runId,
    configSha256: dto.configBinding.sha256,
    sourceSha256: dto.sourceSHA256,
    caseIds: [dto.caseId],
    now: f.time,
  });
  const writes = [],
    reservations = new Set(),
    alerts = [];
  lease.arm({
    runId: dto.runId,
    configSha256: dto.configBinding.sha256,
    sourceSha256: dto.sourceSHA256,
    exclusiveLeaseAcquired: true,
    actualRunRootAbsent: true,
    armedAt: f.time(),
  });
  lease.observeLaunch({
    runId: dto.runId,
    configSha256: dto.configBinding.sha256,
    sourceManifestSha256: dto.sourceSHA256,
    startedAt: f.time(),
  });
  const handlers = {
    observeCase: () => f.read('observation'),
    reserveSlot: async (reservation) => {
      assert.equal(reservations.has(reservation.slot), false);
      reservations.add(reservation.slot);
      return { created: true };
    },
    writeChoice: async (selection) => {
      writes.push(selection);
      return { metadataChoicePrepared: true, writerTypedPostCount: 0 };
    },
    onUnknown: async (event) => alerts.push(event),
  };
  return { ...f, dto, lease, writes, reservations, alerts, handlers };
}

test('optional JSON poll and real observer lease tolerate a partial observation and never repost', async () => {
  const f = observerFixture();
  f.files.set('observation', '{"runId":');
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
  f.setTime(10250);
  f.files.set('observation', JSON.stringify({ ...f.dto, observedAt: 10250 }));
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 1);
  f.files.set('observation', '{');
  f.setTime(10500);
  await f.lease.tick(f.handlers);
  f.setTime(10750);
  f.files.set('observation', JSON.stringify({ ...f.dto, observedAt: 10750 }));
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 1);
  assert.equal(f.reservations.size, 1);
  assert.equal(f.lease.summary().directTypedPOSTCount, 0);
  assert.equal(f.lease.summary().originalSendAdded, 0);
  assert.equal(f.lease.summary().manualRetryAdded, 0);
});

test('optional JSON poll and real observer reject stable malformed evidence without authority', async () => {
  const f = observerFixture();
  f.files.set('observation', '{');
  await f.lease.tick(f.handlers);
  f.setTime(11000);
  await assert.rejects(f.lease.tick(f.handlers), { code: 'operator_optional_json_malformed' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.reservations.size, 0);
  assert.equal(f.lease.summary().directTypedPOSTCount, 0);
});

test('optional JSON poll and real observer keep unknown semantic choices held through expiry', async () => {
  const f = observerFixture();
  f.files.set('observation', '{');
  await f.lease.tick(f.handlers);
  f.setTime(10250);
  const question = 'Which private account and region should this workflow use?';
  const unknown = {
    ...f.dto,
    observedAt: 10250,
    pending: { ...f.dto.pending, question, questionSHA256: digest(question) },
    resolvedAlreadyAuthorizedChoice: null,
  };
  f.files.set('observation', JSON.stringify(unknown));
  await f.lease.tick(f.handlers);
  assert.equal(f.alerts[0].kind, 'observer_unknown_semantic_choice_held');
  f.setTime(70000);
  f.files.set('observation', JSON.stringify({ ...unknown, observedAt: 70000 }));
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reservations.size, 0);
  assert.equal(f.alerts.at(-1).kind, 'observer_stale_or_closed_question_held');
});

test('optional JSON poll and real observer preserve saved freshness and Host question expiry', async () => {
  const f = observerFixture();
  f.files.set('observation', '{');
  await f.lease.tick(f.handlers);
  f.setTime(10250);
  f.files.set('observation', JSON.stringify({ ...f.dto, observedAt: 0 }));
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
  f.setTime(70000);
  f.files.set('observation', JSON.stringify({ ...f.dto, observedAt: 70000 }));
  await f.lease.tick(f.handlers);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reservations.size, 0);
});
