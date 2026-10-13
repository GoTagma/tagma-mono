import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import {
  buildNodeTestInvocation,
  captureImmutableNodeTestProof,
  validateProofInvocation,
} from './immutable-node-test-proof.mjs';

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const q = (x: string) => JSON.stringify(x);
async function fixture(fn: (f: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'tagma-immutable-proof-'));
  try {
    const nodeExecutable = await realpath(Bun.which('node')!);
    const file = join(root, 'fixture.test.mjs');
    const dependency = join(root, 'support.mjs');
    await writeFile(dependency, 'export const value = 7;\n');
    const options = {
      directory: join(root, 'capture'),
      nodeExecutable,
      cwd: root,
      testFiles: [file],
      sourceFiles: [dependency],
      expectedNames: ['actual first', 'actual second'],
    };
    const normal = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './support.mjs';\ntest('actual first', () => assert.equal(value, 7));\ntest('actual second', () => assert.ok(true));\n`;
    await writeFile(file, normal);
    await fn({ root, file, dependency, options, normal });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Immutable proof captures real Node named execution and actual argv in new wx files', async () => {
  await fixture(async ({ root, file, options, dependency }) => {
    const actual = await captureImmutableNodeTestProof(options);
    assert.equal(actual.result.classification, 'GREEN');
    assert.deepEqual(actual.result.counts, {
      tests: 2,
      pass: 2,
      fail: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    });
    assert.deepEqual(actual.result.actualFullNames, options.expectedNames);
    assert.equal(actual.result.naturalCloseObserved, true);
    assert.equal(actual.result.captureComplete, true);
    assert.equal(actual.result.exitCode, 0);
    assert.equal(actual.result.exitSignal, null);
    const invocation = buildNodeTestInvocation(options);
    assert.equal(validateProofInvocation(actual.result, invocation), true);
    const intent = JSON.parse(await readFile(join(root, 'capture', 'intent.json'), 'utf8'));
    const result = JSON.parse(await readFile(actual.resultBinding.path, 'utf8'));
    assert.deepEqual(intent.invocation, invocation);
    assert.deepEqual(result.actualInvocation, invocation);
    assert.equal(result.actualReporter, 'tap');
    for (const name of ['stdout', 'stderr']) {
      const raw = await readFile(result[name].path);
      assert.equal(result[name].sha256, sha(raw));
      assert.equal(result[name].bytes, raw.length);
      assert.equal(result.streams[name].bytes, raw.length);
      assert.equal(result.streams[name].eof, true);
      assert.equal(result.streams[name].closed, true);
      assert.deepEqual(result.streams[name].faults, []);
    }
    assert.equal(
      result.sourceBindings.find((r: any) => r.path === dependency).sha256,
      sha(await readFile(dependency)),
    );
    assert.equal(result.oldMissingEvidence, 'UNKNOWN_NOT_RECONSTRUCTED');
    // A separate real child writes outside its pipe into its own capture file.
    // The producer must not equate drained pipe bytes with changed stored bytes.
    const corruptDirectory = `${options.directory}-changed-stream`;
    await writeFile(
      file,
      `import test from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('actual first', () => appendFileSync(${q(join(corruptDirectory, 'stdout.tap'))}, 'x'.repeat(10000)));\n`,
    );
    const corrupted = await captureImmutableNodeTestProof({
      ...options,
      directory: corruptDirectory,
      expectedNames: ['actual first'],
    });
    assert.equal(corrupted.result.exitCode, 0);
    assert.equal(corrupted.result.naturalCloseObserved, true);
    assert.equal(corrupted.result.streams.stdout.eof, true);
    assert.notEqual(corrupted.result.stdout.bytes, corrupted.result.streams.stdout.bytes);
    assert.equal(corrupted.result.captureComplete, false);
    assert.equal(corrupted.result.classification, 'BLOCKED');
  });
});

test('Immutable proof existing output preserves old bytes and blocks before real Node child', async () => {
  await fixture(async ({ root, file, options }) => {
    const marker = join(root, 'child-spawned');
    await writeFile(
      file,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${q(marker)}, 'bad');\n`,
    );
    await mkdir(options.directory);
    const old = Buffer.from('immutable prior test bytes\n');
    const oldLog = join(options.directory, 'stdout.tap');
    await writeFile(oldLog, old);
    await assert.rejects(captureImmutableNodeTestProof(options), {
      code: 'proof_capture_directory_already_exists_before_spawn',
    });
    assert.deepEqual(await readFile(oldLog), old);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await assert.rejects(readFile(join(options.directory, 'intent.json')), { code: 'ENOENT' });
  });
});

test('Immutable proof copied argv or reporter mismatch blocks before child and output', async () => {
  await fixture(async ({ root, file, options }) => {
    const marker = join(root, 'child-spawned');
    await writeFile(
      file,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${q(marker)}, 'bad');\n`,
    );
    const invocation = buildNodeTestInvocation(options);
    for (const expectedInvocation of [
      {
        ...invocation,
        args: invocation.args.map((x: string) => (x === file ? join(root, 'old.test.mjs') : x)),
      },
      { ...invocation, reporter: 'spec' },
      {
        ...invocation,
        args: invocation.args.map((x: string) =>
          x === '--test-reporter=tap' ? '--test-reporter=spec' : x,
        ),
      },
    ]) {
      await assert.rejects(captureImmutableNodeTestProof({ ...options, expectedInvocation }), {
        code: 'proof_declared_invocation_mismatch_before_spawn',
      });
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(readFile(join(options.directory, 'intent.json')), { code: 'ENOENT' });
    }
  });
});

test('Immutable proof real Node skip and todo cannot establish selected GREEN', async () => {
  await fixture(async ({ file, options }) => {
    for (const kind of ['skip', 'todo']) {
      await writeFile(
        file,
        `import test from 'node:test';\ntest.${kind}('actual first', () => {});\n`,
      );
      const { result } = await captureImmutableNodeTestProof({
        ...options,
        directory: `${options.directory}-${kind}`,
        expectedNames: ['actual first'],
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.captureComplete, true);
      assert.equal(result.classification, 'BLOCKED');
      assert.equal(result.reason, 'proof_named_execution_not_nonempty_green');
    }
  });
});

test('Immutable proof zero execution and wrong expected names cannot establish GREEN', async () => {
  await fixture(async ({ file, normal, options }) => {
    await writeFile(file, 'export const noTests = true;\n');
    const zero = await captureImmutableNodeTestProof(options);
    assert.equal(zero.result.exitCode, 0);
    assert.equal(zero.result.classification, 'BLOCKED');
    await writeFile(file, normal);
    const wrong = await captureImmutableNodeTestProof({
      ...options,
      directory: `${options.directory}-wrong`,
      expectedNames: ['old first', 'old second'],
    });
    assert.equal(wrong.result.exitCode, 0);
    assert.equal(wrong.result.classification, 'BLOCKED');
    assert.equal(wrong.result.reason, 'proof_named_execution_not_nonempty_green');
  });
});

test('Immutable proof real assertion failure remains captured BLOCKED', async () => {
  await fixture(async ({ file, options }) => {
    await writeFile(
      file,
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('actual first', () => assert.equal(1, 2));\n`,
    );
    const { result } = await captureImmutableNodeTestProof({
      ...options,
      expectedNames: ['actual first'],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.naturalCloseObserved, true);
    assert.equal(result.captureComplete, true);
    assert.equal(result.classification, 'BLOCKED');
    assert.match(await readFile(result.stdout.path, 'utf8'), /not ok 1 - actual first/);
    assert.equal(result.oldMissingEvidence, 'UNKNOWN_NOT_RECONSTRUCTED');
  });
});

test('Immutable proof source bytes changed by actual Node child block source-bound GREEN', async () => {
  await fixture(async ({ file, dependency, options }) => {
    await writeFile(
      file,
      `import test from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('actual first', () => writeFileSync(${q(dependency)}, 'export const value = 8;\\n'));\n`,
    );
    const { result } = await captureImmutableNodeTestProof({
      ...options,
      expectedNames: ['actual first'],
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.captureComplete, true);
    assert.equal(result.classification, 'BLOCKED');
    assert.equal(result.reason, 'proof_source_changed_across_execution');
    assert.notEqual(
      result.sourceBindings.find((r: any) => r.path === dependency).sha256,
      sha(await readFile(dependency)),
    );
  });
});

test('Immutable proof rejects symlink source and manual provenance before execution', async () => {
  await fixture(async ({ root, file, options }) => {
    const linked = join(root, 'linked.test.mjs');
    await symlink(file, linked);
    await assert.rejects(captureImmutableNodeTestProof({ ...options, testFiles: [linked] }), {
      code: 'proof_source_not_regular_bounded',
    });
    await assert.rejects(captureImmutableNodeTestProof({ ...options, actualInvocation: {} }), {
      code: 'proof_unsupported_manual_proof_fields',
    });
    await assert.rejects(readFile(join(options.directory, 'intent.json')), { code: 'ENOENT' });
  });
});

test('Immutable proof validator rejects tampered actual argv intent or reporter', async () => {
  await fixture(async ({ options }) => {
    const { result } = await captureImmutableNodeTestProof(options);
    const invocation = buildNodeTestInvocation(options);
    for (const altered of [
      { ...result, actualInvocation: { ...invocation, args: [...invocation.args, '--unknown'] } },
      { ...result, intentInvocation: { ...invocation, reporter: 'spec' } },
      { ...result, actualReporter: 'spec' },
    ])
      assert.throws(() => validateProofInvocation(altered, invocation), {
        code: 'proof_invocation_provenance_mismatch',
      });
    assert.equal(validateProofInvocation(result, invocation), true);
  });
});
