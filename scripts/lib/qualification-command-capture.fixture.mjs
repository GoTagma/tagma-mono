import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runQualificationCommand } from './qualification-command-capture.mjs';

assert.ok(process.versions.node && !process.versions.bun, 'explicit actual Node runtime required');
const MiB = 1024 * 1024,
  payloadBytes = 2 * MiB + 257;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expected = (bytes, fill) => Buffer.alloc(bytes, fill);
const childEnvironment = process.env; // Stock session proxy/CA remain inherited; fixed child never reads or prints env.
const localChild = (stdoutBytes, stderrBytes, exitCode = 0) => [
  '-e',
  `process.stdout.write(Buffer.alloc(${stdoutBytes}, 0x61)); process.stderr.write(Buffer.alloc(${stderrBytes}, 0x62)); process.exitCode = ${exitCode};`,
];
const execute = (stdoutBytes, stderrBytes, exitCode = 0, options = {}) =>
  runQualificationCommand(process.execPath, localChild(stdoutBytes, stderrBytes, exitCode), {
    env: childEnvironment,
    ...options,
  });
const results = [];
let result;
assert.doesNotThrow(() => {
  result = execute(payloadBytes, 31);
}, 'complete local output above 1 MiB must be captured');
assert.equal(result.capture.exitCode, 0);
assert.equal(result.capture.exitSignal, null);
assert.equal(result.capture.errorCode, null);
assert.equal(result.stdout.length, payloadBytes);
assert.equal(result.capture.stdoutBytes, payloadBytes);
assert.equal(result.capture.stdoutSha256, sha256(expected(payloadBytes, 0x61)));
assert.deepEqual(result.stdout, expected(payloadBytes, 0x61));
assert.equal(result.capture.stderrSha256, sha256(expected(31, 0x62)));
results.push({
  id: 'complete-large-stdout',
  passed: true,
  returnedOutput: true,
  ...result.capture,
});
let valueReturned = false,
  overflow;
assert.throws(
  () => {
    execute(payloadBytes, 0, 0, { maxBuffer: MiB });
    valueReturned = true;
  },
  (error) => {
    assert.equal(error.code, 'QUALIFICATION_OUTPUT_OVERFLOW');
    assert.equal(error.capture.errorCode, 'ENOBUFS');
    assert.equal(error.capture.maxBuffer, MiB);
    assert.ok(error.capture.stdoutBytes > 0 && error.capture.stdoutBytes < payloadBytes);
    assert.notEqual(error.capture.stdoutSha256, sha256(expected(payloadBytes, 0x61)));
    assert.ok(error.capture.exitCode !== 0 || error.capture.exitSignal !== null);
    overflow = error.capture;
    return true;
  },
);
assert.equal(valueReturned, false);
results.push({
  id: 'blocked-output-overflow',
  passed: true,
  returnedOutput: valueReturned,
  ...overflow,
});
valueReturned = false;
let failed;
assert.throws(
  () => {
    execute(257, 19, 7);
    valueReturned = true;
  },
  (error) => {
    assert.equal(error.code, 'QUALIFICATION_COMMAND_FAILED');
    assert.equal(error.capture.exitCode, 7);
    assert.equal(error.capture.exitSignal, null);
    assert.equal(error.capture.errorCode, null);
    assert.equal(error.capture.stdoutBytes, 257);
    assert.equal(error.capture.stdoutSha256, sha256(expected(257, 0x61)));
    assert.equal(error.capture.stderrSha256, sha256(expected(19, 0x62)));
    failed = error.capture;
    return true;
  },
);
assert.equal(valueReturned, false);
results.push({
  id: 'blocked-nonzero-exit',
  passed: true,
  returnedOutput: valueReturned,
  ...failed,
});
result = execute(23, payloadBytes);
assert.equal(result.capture.stdoutSha256, sha256(expected(23, 0x61)));
assert.equal(result.capture.stderrBytes, payloadBytes);
assert.equal(result.capture.stderrSha256, sha256(expected(payloadBytes, 0x62)));
assert.deepEqual(result.stderr, expected(payloadBytes, 0x62));
results.push({
  id: 'complete-large-stderr',
  passed: true,
  returnedOutput: true,
  ...result.capture,
});
console.log(
  JSON.stringify({
    schemaVersion: 1,
    runtime: {
      execPath: process.execPath,
      nodeVersion: process.versions.node,
      bunVersion: process.versions.bun ?? null,
    },
    executedCases: results.length,
    passedCases: results.filter((row) => row.passed).length,
    failedCases: 0,
    skippedCases: 0,
    payloadBytes,
    results,
  }),
);
