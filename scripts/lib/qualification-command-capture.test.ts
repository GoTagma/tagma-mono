import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const inheritedEnvironment = process.env; // No environment values are read or logged.
const probeCode =
  'console.log(JSON.stringify({execPath:process.execPath,nodeVersion:process.versions.node,bunVersion:process.versions.bun??null}))';
const nodeProbe = spawnSync(process.env.KNOWN_ISSUE_NODE_BIN ?? 'node', ['-e', probeCode], {
  env: inheritedEnvironment,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});
if (nodeProbe.error || nodeProbe.status !== 0 || nodeProbe.signal !== null)
  throw new Error('qualification_Node_environment_unavailable');
let runtime;
try {
  runtime = JSON.parse(nodeProbe.stdout);
} catch {
  throw new Error('qualification_Node_environment_invalid_response');
}
if (!runtime.nodeVersion || runtime.bunVersion !== null || !isAbsolute(runtime.execPath))
  throw new Error('qualification_Node_environment_not_actual_Node');
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'qualification-command-capture.fixture.mjs',
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('qualification capture uses explicit Node and blocks incomplete output', () => {
  const actual = spawnSync(runtime.execPath, [fixture], {
    env: inheritedEnvironment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (
    actual.error ||
    /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|SyntaxError:/.test(actual.stderr ?? '')
  ) {
    throw new Error('qualification_Node_fixture_environment_failure');
  }
  expect(actual.status).toBe(0);
  expect(actual.signal).toBeNull();
  const evidence = JSON.parse(actual.stdout);
  expect(evidence.runtime).toEqual(runtime);
  expect(evidence.schemaVersion).toBe(1);
  expect(evidence.executedCases).toBe(4);
  expect(evidence.passedCases).toBe(4);
  expect(evidence.failedCases).toBe(0);
  expect(evidence.skippedCases).toBe(0);
  expect(evidence.results.map((row) => row.id)).toEqual([
    'complete-large-stdout',
    'blocked-output-overflow',
    'blocked-nonzero-exit',
    'complete-large-stderr',
  ]);
  expect(evidence.results.every((row) => row.passed === true)).toBe(true);
  const bytes = 2 * 1024 * 1024 + 257,
    limit = 64 * 1024 * 1024;
  expect(evidence.payloadBytes).toBe(bytes);
  const [stdout, overflow, failed, stderr] = evidence.results;
  expect(stdout).toMatchObject({
    returnedOutput: true,
    maxBuffer: limit,
    exitCode: 0,
    exitSignal: null,
    errorCode: null,
    stdoutBytes: bytes,
    stderrBytes: 31,
    stdoutSha256: sha256(Buffer.alloc(bytes, 0x61)),
    stderrSha256: sha256(Buffer.alloc(31, 0x62)),
  });
  expect(overflow).toMatchObject({
    returnedOutput: false,
    maxBuffer: 1024 * 1024,
    errorCode: 'ENOBUFS',
  });
  expect(overflow.stdoutBytes).toBeGreaterThan(0);
  expect(overflow.stdoutBytes).toBeLessThan(bytes);
  expect(overflow.stdoutSha256).not.toBe(sha256(Buffer.alloc(bytes, 0x61)));
  expect(overflow.exitCode !== 0 || overflow.exitSignal !== null).toBe(true);
  expect(failed).toMatchObject({
    returnedOutput: false,
    exitCode: 7,
    exitSignal: null,
    errorCode: null,
    stdoutBytes: 257,
    stderrBytes: 19,
    stdoutSha256: sha256(Buffer.alloc(257, 0x61)),
    stderrSha256: sha256(Buffer.alloc(19, 0x62)),
  });
  expect(stderr).toMatchObject({
    returnedOutput: true,
    maxBuffer: limit,
    exitCode: 0,
    exitSignal: null,
    errorCode: null,
    stdoutBytes: 23,
    stderrBytes: bytes,
    stdoutSha256: sha256(Buffer.alloc(23, 0x61)),
    stderrSha256: sha256(Buffer.alloc(bytes, 0x62)),
  });
  console.log(JSON.stringify({ kind: 'qualification-capture-actual-Node-proof', ...evidence }));
});
