// Prepared-only B12 regressions. Not executed; ready: false.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fileSystem from 'node:fs';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __serverRecordAuthTestHooks,
  MAX_SERVER_RECORD_BYTES,
  type ServerRecordContext,
} from '../server/server-record-auth';
import type { ChatRepairEvidenceOwner } from '../server/chat-operations/repair-evidence-store';
import { redactChatRepairErrorOutput } from '../server/chat-operations/repair-error-evidence';
import {
  createTrialTaskStreamEvidenceSink,
  MAX_TRIAL_STREAM_ARCHIVE_BYTES,
  readTrialTaskStreamEvidence,
  type CompletedTrialTaskStreamSource,
  type TrialTaskStreamArchiveReference,
} from '../server/chat-operations/trial-stream-evidence-store';

const roots: string[] = [];
const savedKeyPath = process.env.TAGMA_STAGE_RECORD_KEY_FILE;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

afterEach(() => {
  if (savedKeyPath === undefined) delete process.env.TAGMA_STAGE_RECORD_KEY_FILE;
  else process.env.TAGMA_STAGE_RECORD_KEY_FILE = savedKeyPath;
  __serverRecordAuthTestHooks.resetKeyCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(stdout: Buffer | string = 'complete task output', stderr: Buffer | string = '') {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-stream-'));
  roots.push(root);
  process.env.TAGMA_STAGE_RECORD_KEY_FILE = join(root, 'private-server-control', 'key');
  __serverRecordAuthTestHooks.resetKeyCache();
  const owner: ChatRepairEvidenceOwner = {
    workspaceScopeId: 'workspace-archive',
    operationId: 'operation-archive',
    operationGeneration: 2,
    stageId: 'stage-archive',
  };
  const context: ServerRecordContext = {
    workspaceTagmaDir: join(root, '.tagma'),
    controlRoot: join(root, '.tagma', '.chat-yaml-staging', owner.stageId),
    stageId: owner.stageId,
    kind: 'stage-metadata',
  };
  mkdirSync(context.controlRoot, { recursive: true });
  const caseRoot = join(context.controlRoot, '.trial-cases', 'case-a-random');
  const workDir = join(caseRoot, 'workspace');
  const runId = 'run_archive_a';
  const taskId = 'track.task';
  const logDir = join(workDir, '.tagma', 'logs', runId);
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = join(logDir, 'track_task.stdout');
  const stderrPath = join(logDir, 'track_task.stderr');
  writeFileSync(stdoutPath, stdout, { mode: 0o600 });
  writeFileSync(stderrPath, stderr, { mode: 0o600 });
  const source: CompletedTrialTaskStreamSource = {
    trialId: 'trial-archive',
    caseId: 'case-a',
    runId,
    runNumber: 1,
    taskId,
    taskStatus: 'success',
    workDir,
    logPath: join(logDir, 'pipeline.log'),
    stdout: {
      path: stdoutPath,
      producedBytes: Buffer.byteLength(stdout),
      storedBytes: Buffer.byteLength(stdout),
      captureReadError: false,
    },
    stderr: {
      path: stderrPath,
      producedBytes: Buffer.byteLength(stderr),
      storedBytes: Buffer.byteLength(stderr),
      captureReadError: false,
    },
  };
  const archiveRoot = join(context.controlRoot, '.trial-streams');
  const sink = createTrialTaskStreamEvidenceSink(context, owner);
  const manifestPath = () =>
    join(
      archiveRoot,
      readdirSync(archiveRoot).find((name) => name.endsWith('.json'))!,
    );
  return { root, owner, context, caseRoot, source, sink, archiveRoot, manifestPath };
}

function requireReference(
  ref: TrialTaskStreamArchiveReference | null,
): TrialTaskStreamArchiveReference {
  expect(ref).not.toBeNull();
  return ref!;
}

describe('Host-owned completed Trial task stream archives', () => {
  test('retains more than the display limit and a legitimate empty stderr after case cleanup', () => {
    const text = 'error detail\n'.repeat(1500);
    const f = fixture(text, '');
    const result = f.sink(f.source);
    expect(result.status).toBe('complete');
    expect(result.errorCodes).toEqual([]);
    expect(result.streams?.[0].byteLength).toBeGreaterThan(8192);
    expect(result.streams?.[1]).toMatchObject({
      hash: digest(''),
      byteLength: 0,
      state: 'complete',
    });
    rmSync(f.caseRoot, { recursive: true, force: true });
    const retained = readTrialTaskStreamEvidence(
      f.context,
      f.owner,
      requireReference(result.manifest),
    );
    expect(retained.stdout).toBe(text);
    expect(retained.stderr).toBe('');
  });

  test('keeps produced, captured and redacted byte counts and digests separate', () => {
    const sourceText = 'failure api_key=fixture-private-value\n';
    const f = fixture(sourceText);
    const source = {
      ...f.source,
      stdout: { ...f.source.stdout, producedBytes: f.source.stdout.storedBytes! + 31 },
    };
    const result = f.sink(source);
    const expected = redactChatRepairErrorOutput(sourceText);
    expect(expected).not.toBe(sourceText);
    expect(result.status).toBe('complete');
    expect(result.streams?.[0]).toMatchObject({
      producedBytes: Buffer.byteLength(sourceText) + 31,
      storedBytes: Buffer.byteLength(sourceText),
      capturedBytes: Buffer.byteLength(sourceText),
      sourceHash: digest(sourceText),
      hash: digest(expected),
      byteLength: Buffer.byteLength(expected),
    });
    expect(
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)).stdout,
    ).toBe(expected);
  });

  test('rejects owner/context mismatches before Trial and wrong owners on authenticated reads', () => {
    const f = fixture();
    expect(() =>
      createTrialTaskStreamEvidenceSink({ ...f.context, stageId: 'other-stage' }, f.owner),
    ).toThrow();
    expect(() =>
      createTrialTaskStreamEvidenceSink({ ...f.context, kind: 'trial-cache' }, f.owner),
    ).toThrow();
    const result = f.sink(f.source);
    expect(() =>
      readTrialTaskStreamEvidence(
        f.context,
        { ...f.owner, operationGeneration: 3 },
        requireReference(result.manifest),
      ),
    ).toThrow();
    expect(() =>
      readTrialTaskStreamEvidence(f.context, f.owner, {
        ...requireReference(result.manifest),
        runNumber: 2,
      }),
    ).toThrow();
  });

  test('detects manifest tampering and never accepts an unsigned changed status', () => {
    const f = fixture();
    const result = f.sink(f.source);
    const record = JSON.parse(readFileSync(f.manifestPath(), 'utf8'));
    record.taskStatus = 'failed';
    writeFileSync(f.manifestPath(), JSON.stringify(record), { mode: 0o600 });
    expect(() =>
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)),
    ).toThrow();
  });

  test('a legal owner with an unavailable archive directory gets an unavailable sink', () => {
    const f = fixture();
    rmSync(f.archiveRoot, { recursive: true, force: true });
    const blocker = 'fixture storage directory conflict';
    writeFileSync(f.archiveRoot, blocker, { mode: 0o600 });
    const sourceBefore = readFileSync(f.source.stdout.path!);
    // Even under a storage failure, an invalid owner/context is never admitted.
    expect(() =>
      createTrialTaskStreamEvidenceSink({ ...f.context, stageId: 'other-stage' }, f.owner),
    ).toThrow();
    const sink = createTrialTaskStreamEvidenceSink(f.context, f.owner);
    expect(sink(f.source)).toMatchObject({
      trialId: f.source.trialId,
      caseId: f.source.caseId,
      runId: f.source.runId,
      runNumber: f.source.runNumber,
      taskId: f.source.taskId,
      status: 'unavailable',
      manifest: null,
      errorCodes: ['archive_unavailable'],
    });
    expect(sink({ ...f.source, runNumber: 0 }).errorCodes).toEqual(['source_invalid']);
    expect(readFileSync(f.archiveRoot, 'utf8')).toBe(blocker);
    expect(readFileSync(f.source.stdout.path!).equals(sourceBefore)).toBe(true);
  });

  test('ENOSPC during legal archive setup returns unavailable and never retries publication', () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    rmSync(f.archiveRoot, { recursive: true, force: true });
    const sourceBefore = readFileSync(f.source.stdout.path!);
    const original = fileSystem.chmodSync;
    let failedSetups = 0;
    const setup = spyOn(fileSystem, 'chmodSync').mockImplementation((path, mode) => {
      if (path === f.archiveRoot) {
        failedSetups += 1;
        throw Object.assign(new Error('fixture archive storage full'), { code: 'ENOSPC' });
      }
      return original(path, mode);
    });
    try {
      const sink = createTrialTaskStreamEvidenceSink(f.context, f.owner);
      expect(sink(f.source)).toMatchObject({
        status: 'unavailable',
        manifest: null,
        errorCodes: ['archive_unavailable'],
      });
      expect(sink(f.source)).toMatchObject({ status: 'unavailable', manifest: null });
      expect(failedSetups).toBe(1);
      expect(readdirSync(f.archiveRoot)).toEqual([]);
      expect(readFileSync(f.source.stdout.path!).equals(sourceBefore)).toBe(true);
    } finally {
      setup.mockRestore();
    }
  });

  test('detects modified blob bytes and rejects non-private archive files', () => {
    const f = fixture('original task bytes');
    const result = f.sink(f.source);
    const blob = join(f.archiveRoot, `${result.streams![0]!.hash}.utf8`);
    writeFileSync(blob, 'modified task bytes', { mode: 0o600 });
    expect(() =>
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)),
    ).toThrow();
    writeFileSync(blob, 'original task bytes', { mode: 0o600 });
    if (process.platform !== 'win32') {
      chmodSync(blob, 0o644);
      expect(() =>
        readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)),
      ).toThrow();
    }
  });

  test('rejects a different run coordinate and symlink or hardlink source grafts', () => {
    const f = fixture();
    const wrongRun = f.sink({ ...f.source, runId: 'run_other' });
    expect(wrongRun.status).toBe('unavailable');
    expect(wrongRun.errorCodes).toContain('source_path_invalid');
    const stdoutPath = f.source.stdout.path!;
    const outside = join(f.root, 'outside-output');
    writeFileSync(outside, 'unrelated output');
    rmSync(stdoutPath);
    symlinkSync(outside, stdoutPath);
    const symlinkResult = f.sink(f.source);
    expect(symlinkResult.status).not.toBe('complete');
    expect(symlinkResult.errorCodes).toContain('source_read_failed');
    rmSync(stdoutPath);
    linkSync(outside, stdoutPath);
    const hardlinkResult = f.sink(f.source);
    expect(hardlinkResult.status).not.toBe('complete');
    expect(hardlinkResult.errorCodes).toContain('source_read_failed');
  });

  test('does not accept a non-private source stream as complete evidence', () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    chmodSync(f.source.stdout.path!, 0o644);
    const result = f.sink(f.source);
    expect(result.status).not.toBe('complete');
    expect(result.errorCodes).toContain('source_read_failed');
    expect(result.streams?.[0]).toMatchObject({ state: 'unavailable', hash: null });
  });

  test('preserves missing, unknown counts, count mismatches and capture errors as safe outcomes', () => {
    const f = fixture();
    const missing = f.sink({
      ...f.source,
      stdout: { ...f.source.stdout, path: null },
      stderr: { ...f.source.stderr, path: null },
    });
    expect(missing).toMatchObject({ status: 'unavailable', manifest: null });
    expect(missing.errorCodes).toContain('source_missing');
    const mismatch = f.sink({ ...f.source, stdout: { ...f.source.stdout, storedBytes: 1 } });
    expect(mismatch.status).toBe('partial');
    expect(mismatch.streams?.[0].state).toBe('unknown');
    expect(mismatch.errorCodes).toContain('source_count_mismatch');
    const differentTask = {
      ...f.source,
      trialId: 'trial-read-error',
      stdout: { ...f.source.stdout, producedBytes: null, captureReadError: true },
    };
    const captureError = f.sink(differentTask);
    expect(captureError.status).toBe('partial');
    expect(captureError.errorCodes).toContain('source_count_unknown');
    expect(captureError.errorCodes).toContain('source_capture_read_error');
  });

  test('reports the existing stream read bound and invalid UTF-8 without clipping or throwing', () => {
    const f = fixture(Buffer.alloc(MAX_SERVER_RECORD_BYTES + 1, 0x61));
    const overLimit = f.sink(f.source);
    expect(overLimit.status).not.toBe('complete');
    expect(overLimit.errorCodes).toContain('source_limit');
    expect(overLimit.streams?.[0].hash).toBeNull();
    writeFileSync(f.source.stdout.path!, Buffer.from([0xc0, 0xaf]), { mode: 0o600 });
    const invalid = f.sink({
      ...f.source,
      trialId: 'trial-invalid-utf8',
      stdout: { ...f.source.stdout, storedBytes: 2, producedBytes: 2 },
    });
    expect(invalid.status).not.toBe('complete');
    expect(invalid.errorCodes).toContain('source_invalid_utf8');
    expect(invalid.streams?.[0].hash).toBeNull();
  });

  test('retains independent repeated run identities and never replaces a sealed tuple', () => {
    const f = fixture('first run');
    const first = f.sink(f.source);
    const secondRun = 'run_archive_b';
    const secondLog = join(f.source.workDir, '.tagma', 'logs', secondRun);
    mkdirSync(secondLog, { recursive: true });
    writeFileSync(join(secondLog, 'track_task.stdout'), 'second run', { mode: 0o600 });
    writeFileSync(join(secondLog, 'track_task.stderr'), '', { mode: 0o600 });
    const second = f.sink({
      ...f.source,
      runId: secondRun,
      runNumber: 2,
      logPath: join(secondLog, 'pipeline.log'),
      stdout: {
        path: join(secondLog, 'track_task.stdout'),
        producedBytes: 10,
        storedBytes: 10,
        captureReadError: false,
      },
      stderr: { ...f.source.stderr, path: join(secondLog, 'track_task.stderr') },
    });
    expect(second.status).toBe('complete');
    const originalManifestBytes = readFileSync(f.manifestPath());
    const same = f.sink(f.source);
    expect(same.manifest).toEqual(first.manifest);
    expect(readFileSync(f.manifestPath()).equals(originalManifestBytes)).toBe(true);
    writeFileSync(f.source.stdout.path!, 'changed!!', { mode: 0o600 });
    const conflict = f.sink({
      ...f.source,
      stdout: { ...f.source.stdout, producedBytes: 9, storedBytes: 9 },
    });
    expect(conflict.status).toBe('unavailable');
    expect(conflict.errorCodes).toContain('archive_conflict');
    rmSync(f.caseRoot, { recursive: true, force: true });
    expect(
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(first.manifest)).stdout,
    ).toBe('first run');
    expect(
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(second.manifest)).stdout,
    ).toBe('second run');
    expect(readdirSync(f.archiveRoot).filter((name) => name.endsWith('.json'))).toHaveLength(2);
  });

  test('fails closed on stale publication claims and counts orphan bytes in archive quota', () => {
    const f = fixture();
    const result = f.sink(f.source);
    writeFileSync(`${f.manifestPath()}.claim`, '', { mode: 0o600 });
    const stale = f.sink(f.source);
    expect(stale.status).toBe('unavailable');
    expect(stale.errorCodes).toContain('archive_conflict');
    expect(
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)).stdout,
    ).toBe('complete task output');
    const pending = join(f.archiveRoot, '.pending-00000000-0000-0000-0000-000000000000');
    writeFileSync(pending, '', { mode: 0o600 });
    truncateSync(pending, MAX_TRIAL_STREAM_ARCHIVE_BYTES + 1);
    const quota = f.sink({
      ...f.source,
      trialId: 'trial-quota',
      stdout: { ...f.source.stdout, producedBytes: null },
    });
    expect(quota.status).toBe('unavailable');
    expect(quota.errorCodes).toContain('archive_limit');
    expect(existsSync(pending)).toBe(true);
    expect(
      readTrialTaskStreamEvidence(f.context, f.owner, requireReference(result.manifest)).stdout,
    ).toBe('complete task output');
  });
});
