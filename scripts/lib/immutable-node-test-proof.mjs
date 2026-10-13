import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  const e = new Error(code);
  e.code = code;
  throw e;
};
const check = (v, c) => {
  if (!v) fail(c);
};
async function parents(path) {
  for (let at = dirname(path); ; at = dirname(at)) {
    const st = await lstat(at);
    check(
      st.isDirectory() && !st.isSymbolicLink() && (await realpath(at)) === at,
      'proof_parent_not_regular_canonical',
    );
    if (dirname(at) === at) break;
  }
}
function absolute(path) {
  check(
    typeof path === 'string' && isAbsolute(path) && resolve(path) === path,
    'proof_path_not_canonical_absolute',
  );
}
async function boundSource(path) {
  absolute(path);
  await parents(path);
  const before = await lstat(path);
  check(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= 16 * 1024 * 1024,
    'proof_source_not_regular_bounded',
  );
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    check(
      opened.ino === before.ino && opened.dev === before.dev,
      'proof_source_changed_before_open',
    );
    const b = await fd.readFile(),
      after = await fd.stat();
    check(
      b.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      'proof_source_changed_during_read',
    );
    return { path, sha256: hash(b), bytes: b.length, mode: before.mode & 0o777 };
  } finally {
    await fd.close();
  }
}
async function jsonNew(path, value) {
  const b = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(path, b, { flag: 'wx', mode: 0o600 });
  return { path, sha256: hash(b), bytes: b.length, mode: 384 };
}
export function buildNodeTestInvocation({ nodeExecutable, testFiles, cwd }) {
  absolute(nodeExecutable);
  absolute(cwd);
  check(
    Array.isArray(testFiles) &&
      testFiles.length > 0 &&
      new Set(testFiles).size === testFiles.length &&
      testFiles.every((x) => typeof x === 'string' && /\.test\.(?:mjs|js|ts)$/.test(x)),
    'proof_nonempty_unique_testfiles_required',
  );
  testFiles.forEach(absolute);
  return Object.freeze({
    executable: nodeExecutable,
    args: Object.freeze(['--test', '--test-isolation=none', '--test-reporter=tap', ...testFiles]),
    cwd,
    reporter: 'tap',
  });
}
export function parseNamedNodeTAP(text, expectedNames) {
  check(
    typeof text === 'string' &&
      Array.isArray(expectedNames) &&
      expectedNames.length > 0 &&
      expectedNames.every((x) => typeof x === 'string' && x.length > 0) &&
      new Set(expectedNames).size === expectedNames.length,
    'proof_expected_names_required',
  );
  const actual = [...text.matchAll(/^# Subtest: (.+)$/gm)].map((x) => x[1]);
  const summary = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const found = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    check(found.length === 1, 'proof_TAP_summary_unknown');
    summary[key] = Number(found[0][1]);
  }
  const ok = [...text.matchAll(/^ok \d+ - /gm)].length;
  check(
    actual.length === expectedNames.length &&
      new Set(actual).size === actual.length &&
      same(actual, expectedNames) &&
      summary.tests === actual.length &&
      summary.pass === actual.length &&
      summary.fail === 0 &&
      summary.cancelled === 0 &&
      summary.skipped === 0 &&
      summary.todo === 0 &&
      ok === actual.length &&
      !/^not ok /m.test(text),
    'proof_named_execution_not_nonempty_green',
  );
  return {
    actualFullNames: actual,
    counts: {
      tests: summary.tests,
      pass: summary.pass,
      fail: summary.fail,
      cancelled: summary.cancelled,
      skipped: summary.skipped,
      todo: summary.todo,
    },
  };
}
export function validateProofInvocation(proof, invocation) {
  check(
    same(proof.actualInvocation, invocation) &&
      same(proof.intentInvocation, invocation) &&
      same(proof.constructedInvocation, invocation) &&
      proof.actualReporter === 'tap',
    'proof_invocation_provenance_mismatch',
  );
  return true;
}

/** Construct execution and proof from one internal invocation. Each capture owns
 * a new directory; an existing directory blocks before any child is spawned. */
export async function captureImmutableNodeTestProof(options) {
  const allowed = [
    'directory',
    'nodeExecutable',
    'testFiles',
    'sourceFiles',
    'cwd',
    'expectedNames',
    'expectedInvocation',
  ];
  check(
    options && Object.keys(options).every((k) => allowed.includes(k)),
    'proof_unsupported_manual_proof_fields',
  );
  const { directory, nodeExecutable, testFiles, cwd, expectedNames, expectedInvocation } = options;
  absolute(directory);
  await parents(directory);
  const invocation = buildNodeTestInvocation({ nodeExecutable, testFiles, cwd });
  if (expectedInvocation !== undefined)
    check(same(expectedInvocation, invocation), 'proof_declared_invocation_mismatch_before_spawn');
  check(
    Array.isArray(expectedNames) &&
      expectedNames.length > 0 &&
      new Set(expectedNames).size === expectedNames.length,
    'proof_expected_names_required',
  );
  const exe = await lstat(nodeExecutable);
  check(
    exe.isFile() && !exe.isSymbolicLink() && (await realpath(nodeExecutable)) === nodeExecutable,
    'proof_node_executable_not_regular',
  );
  const sources = [...new Set([...testFiles, ...(options.sourceFiles ?? [])])];
  const bindings = [];
  for (const path of sources) bindings.push(await boundSource(path));
  // No recursive mkdir or retry. This is the ownership and immutability gate.
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST') fail('proof_capture_directory_already_exists_before_spawn');
    throw e;
  }
  const before = await lstat(directory);
  check(
    before.isDirectory() && !before.isSymbolicLink() && (await realpath(directory)) === directory,
    'proof_capture_directory_not_regular',
  );
  const startedAtUTC = new Date().toISOString();
  const intent = await jsonNew(join(directory, 'intent.json'), {
    schemaVersion: 1,
    kind: 'immutable-node-test-execution-intent',
    startedAtUTC,
    invocation,
    sourceBindings: bindings,
    overwriteAllowed: false,
  });
  const stdoutPath = join(directory, 'stdout.tap'),
    stderrPath = join(directory, 'stderr.log');
  const stdout = await open(
      stdoutPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    ),
    stderr = await open(
      stderrPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  const streams = {
    stdout: { bytes: 0, eof: false, closed: false, faults: [] },
    stderr: { bytes: 0, eof: false, closed: false, faults: [] },
  };
  let child,
    pid = null,
    spawnError = null,
    exitCode = null,
    exitSignal = null,
    naturalClose = false;
  const pump = async (name, stream, file) => {
    try {
      for await (const chunk of stream) {
        streams[name].bytes += chunk.length;
        await file.writeFile(chunk);
      }
      streams[name].eof = true;
    } catch (e) {
      streams[name].faults.push(e.code ?? 'UNKNOWN');
      stream.resume();
    } finally {
      try {
        await file.close();
        streams[name].closed = true;
      } catch (e) {
        streams[name].faults.push(e.code ?? 'proof_capture_close_unknown');
      }
    }
  };
  try {
    child = spawn(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pid = child.pid ?? null;
    const outPump = pump('stdout', child.stdout, stdout),
      errPump = pump('stderr', child.stderr, stderr);
    await new Promise((resolve) => {
      child.once('error', (e) => {
        spawnError = e.code ?? 'UNKNOWN';
      });
      child.once('close', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        naturalClose = true;
        resolve();
      });
    });
    await Promise.all([outPump, errPump]);
  } catch (e) {
    spawnError = e.code ?? 'UNKNOWN';
    if (!streams.stdout.closed) await stdout.close();
    if (!streams.stderr.closed) await stderr.close();
  }
  const completedAtUTC = new Date().toISOString(),
    stdoutRef = await boundSource(stdoutPath),
    stderrRef = await boundSource(stderrPath);
  const captureComplete =
    ['stdout', 'stderr'].every(
      (k) => streams[k].eof && streams[k].closed && streams[k].faults.length === 0,
    ) &&
    stdoutRef.bytes === streams.stdout.bytes &&
    stderrRef.bytes === streams.stderr.bytes;
  let classified = 'BLOCKED',
    reason = 'proof_spawn_exit_or_capture_unknown',
    parsed = null;
  if (!spawnError && naturalClose && exitCode === 0 && exitSignal === null && captureComplete) {
    try {
      const fd = await open(stdoutPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        parsed = parseNamedNodeTAP((await fd.readFile()).toString('utf8'), expectedNames);
      } finally {
        await fd.close();
      }
      for (const ref of bindings)
        check(same(await boundSource(ref.path), ref), 'proof_source_changed_across_execution');
      classified = 'GREEN';
      reason = 'verified_current_nonempty_named_execution';
    } catch (e) {
      reason = e.code ?? 'proof_unknown_parse_failure';
    }
  }
  const result = {
    schemaVersion: 1,
    kind: 'immutable-node-test-proof',
    classification: classified,
    reason,
    startedAtUTC,
    completedAtUTC,
    actualInvocation: invocation,
    intentInvocation: invocation,
    constructedInvocation: invocation,
    actualReporter: 'tap',
    intent,
    sourceBindings: bindings,
    stdout: stdoutRef,
    stderr: stderrRef,
    pid,
    spawnError,
    exitCode,
    exitSignal,
    naturalCloseObserved: naturalClose,
    captureComplete,
    streams,
    ...(parsed ?? {}),
    oldMissingEvidence: 'UNKNOWN_NOT_RECONSTRUCTED',
    globalUnregisteredScopes: 'UNKNOWN',
  };
  validateProofInvocation(result, invocation);
  const resultBinding = await jsonNew(join(directory, 'result.json'), result);
  return Object.freeze({ result, resultBinding });
}
