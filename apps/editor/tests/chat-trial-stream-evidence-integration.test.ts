import { expect, test } from 'bun:test';
import type { EngineResult, PipelineConfig } from '@tagma/sdk';
import type { TaskState } from '@tagma/types';
import {
  archiveCompletedTrialTaskStreams,
  trialTaskResults,
} from '../server/chat-pipeline-trial-run';
import type {
  CompletedTrialTaskStreamSource,
  TrialTaskStreamEvidenceSink,
} from '../server/chat-operations/trial-stream-evidence-store';

function fixture(runId: string): { result: EngineResult; pipeline: PipelineConfig } {
  const config = { id: 'search', name: 'Search fixture', command: 'fixture-command' };
  const track = { id: 'verify', name: 'Verify fixture', tasks: [config] };
  const stdout = 'early-tool-evidence\n' + 'x'.repeat(20_000);
  const state: TaskState = {
    config,
    trackConfig: track,
    status: 'success',
    startedAt: '2026-10-11T00:00:00.000Z',
    finishedAt: '2026-10-11T00:00:01.000Z',
    result: {
      exitCode: 0,
      stdout,
      stderr: '',
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      stdoutStoredBytes: Buffer.byteLength(stdout),
      stderrStoredBytes: 0,
      durationMs: 1_000,
      sessionId: null,
      normalizedOutput: null,
      failureKind: null,
    },
  };
  return {
    result: {
      success: true,
      runId,
      logPath: `/fixture/.tagma/logs/${runId}/pipeline.log`,
      summary: { total: 1, success: 1, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
      states: new Map([['verify.search', state]]),
    },
    pipeline: { name: 'archive-fixture', tracks: [track] },
  };
}

test('successful task producer is archived independently of the unchanged UI tail', () => {
  const { result, pipeline } = fixture('run_fixture_one');
  const before = trialTaskResults(result, pipeline, 'case-one', 1, '/fixture');
  const observed: CompletedTrialTaskStreamSource[] = [];
  const sink: TrialTaskStreamEvidenceSink = (source) => {
    observed.push(source);
    return {
      trialId: source.trialId,
      caseId: source.caseId,
      runId: source.runId,
      runNumber: source.runNumber,
      taskId: source.taskId,
      status: 'unavailable',
      manifest: null,
      errorCodes: ['archive_sink_failure'],
    };
  };
  const archives = archiveCompletedTrialTaskStreams(
    result,
    { trialId: 'trial-fixture', caseId: 'case-one', runId: result.runId, runNumber: 1 },
    '/fixture',
    new Map(),
    sink,
  );
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    taskId: 'verify.search',
    taskStatus: 'success',
    stdout: { storedBytes: Buffer.byteLength(result.states.get('verify.search')!.result!.stdout) },
    stderr: { storedBytes: 0, captureReadError: false },
  });
  expect(archives).toHaveLength(1);
  expect(before.tasks[0].stdoutTruncation.returnedBytes).toBeLessThanOrEqual(8_192);
  expect(trialTaskResults(result, pipeline, 'case-one', 1, '/fixture')).toEqual(before);
  expect(result.success).toBe(true);
});

test('an archive sink failure stays UNKNOWN without changing task success or repair evidence', () => {
  const { result, pipeline } = fixture('run_fixture_error');
  const before = trialTaskResults(result, pipeline, 'case-one', 1, '/fixture');
  const archives = archiveCompletedTrialTaskStreams(
    result,
    { trialId: 'trial-fixture', caseId: 'case-one', runId: result.runId, runNumber: 1 },
    '/fixture',
    new Map(),
    () => {
      throw new Error('fixture archive write failure');
    },
  );
  expect(archives[0]).toMatchObject({
    status: 'unavailable',
    manifest: null,
    errorCodes: ['archive_sink_failure'],
  });
  expect(result.success).toBe(true);
  expect(result.states.get('verify.search')!.status).toBe('success');
  expect(trialTaskResults(result, pipeline, 'case-one', 1, '/fixture')).toEqual(before);
});

test('repeat runs preserve distinct actual identities and capture-error provenance', () => {
  const seen: CompletedTrialTaskStreamSource[] = [];
  const sink: TrialTaskStreamEvidenceSink = (source) => {
    seen.push(source);
    return {
      trialId: source.trialId,
      caseId: source.caseId,
      runId: source.runId,
      runNumber: source.runNumber,
      taskId: source.taskId,
      status: 'unavailable',
      manifest: null,
      errorCodes: ['archive_sink_failure'],
    };
  };
  for (const runNumber of [1, 2]) {
    const { result } = fixture(`run_fixture_${runNumber}`);
    if (runNumber === 2) {
      result.states.get('verify.search')!.result = {
        ...result.states.get('verify.search')!.result!,
        outputDiagnostics: [
          {
            stream: 'stdout',
            stage: 'read',
            message: 'fixture interrupted read',
            capturedBytes: 12,
            path: null,
          },
        ],
      };
    }
    archiveCompletedTrialTaskStreams(
      result,
      { trialId: 'trial-fixture', caseId: 'case-one', runId: result.runId, runNumber },
      '/fixture',
      new Map(),
      sink,
    );
  }
  expect(seen.map((item) => item.runId)).toEqual(['run_fixture_1', 'run_fixture_2']);
  expect(seen.map((item) => item.runNumber)).toEqual([1, 2]);
  expect(seen.map((item) => item.stdout.captureReadError)).toEqual([false, true]);
});

test('an engine run identity mismatch never reaches the archive sink', () => {
  const { result } = fixture('run_actual');
  let sinkCalls = 0;
  const archives = archiveCompletedTrialTaskStreams(
    result,
    { trialId: 'trial-fixture', caseId: 'case-one', runId: 'run_other', runNumber: 1 },
    '/fixture',
    new Map(),
    () => {
      sinkCalls += 1;
      throw new Error('must not archive a different run');
    },
  );
  expect(sinkCalls).toBe(0);
  expect(archives[0]).toMatchObject({
    status: 'unavailable',
    manifest: null,
    errorCodes: ['source_identity_mismatch'],
  });
  expect(result.success).toBe(true);
});

test('known capture diagnostics stay scoped to their own stream without changing results', () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const { result, pipeline } = fixture(`run_fixture_${stream}`);
    result.states.get('verify.search')!.result = {
      ...result.states.get('verify.search')!.result!,
      outputDiagnostics: [
        {
          stream,
          stage: 'read',
          message: 'fixture capture incomplete',
          capturedBytes: 0,
          path: null,
        },
      ],
    };
    const before = trialTaskResults(result, pipeline, 'case-one', 1, '/fixture');
    const sources: CompletedTrialTaskStreamSource[] = [];
    archiveCompletedTrialTaskStreams(
      result,
      { trialId: 'trial-fixture', caseId: 'case-one', runId: result.runId, runNumber: 1 },
      '/fixture',
      new Map(),
      (source) => {
        sources.push(source);
        return {
          trialId: source.trialId,
          caseId: source.caseId,
          runId: source.runId,
          runNumber: source.runNumber,
          taskId: source.taskId,
          status: 'unavailable',
          manifest: null,
          errorCodes: ['source_capture_read_error'],
        };
      },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].stdout.captureReadError).toBe(stream === 'stdout');
    expect(sources[0].stderr.captureReadError).toBe(stream === 'stderr');
    expect(result.success).toBe(true);
    expect(trialTaskResults(result, pipeline, 'case-one', 1, '/fixture')).toEqual(before);
  }
});
