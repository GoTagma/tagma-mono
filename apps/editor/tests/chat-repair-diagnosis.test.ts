import { afterEach, describe, expect, test } from 'bun:test';
import {
  trialCaseFileObservation,
  trialTaskExecutionContext,
  type ChatPipelineTrialRunResult,
} from '../server/chat-pipeline-trial-run';
import {
  advanceChatRepairDiagnosis,
  buildChatRepairDiagnosis,
} from '../server/chat-operations/repair-diagnosis';
import {
  isChatRepairDiagnosis,
  parseChatRepairDiagnosisJson,
  fitChatRepairDiagnosis,
} from '../shared/chat-repair-diagnosis';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function trial(failureKind = 'completion_failed'): ChatPipelineTrialRunResult {
  return {
    ran: true,
    kind: 'failed',
    repairAuthorization: 'pipeline-change-allowed',
    omittedTaskCount: 0,
    cases: [
      { id: 'normal', success: false, expectations: [] },
      { id: 'negative', success: true },
    ],
    tasks: [
      {
        caseId: 'normal',
        runNumber: 1,
        taskId: 'flow.build',
        status: 'failed',
        failureKind,
        exitCode: 0,
        repairScope: 'pipeline-artifact',
        executionContext: {
          effectiveCwd: '.',
          completion: {
            type: 'file_exists',
            resolvedPath: 'artifacts/result.json',
            regularFile: false,
          },
        },
      },
      {
        caseId: 'negative',
        taskId: 'flow.reject',
        status: 'failed',
        failureKind: 'exit_nonzero',
        exitCode: 1,
        repairScope: null,
      },
    ],
  } as unknown as ChatPipelineTrialRunResult;
}

describe('structured Chat repair diagnosis', () => {
  test('contrasts completion coordinates with actual Host-asserted files without exposing case roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-repair-coordinates-'));
    roots.push(root);
    mkdirSync(join(root, '.tagma', 'sample', 'artifacts'), { recursive: true });
    writeFileSync(join(root, '.tagma', 'sample', 'artifacts', 'result.json'), '[]');
    const fileObservation = trialCaseFileObservation(root, 'sample/sample.yaml', {
      type: 'json-valid',
      path: 'sample/artifacts/result.json',
    })!;
    expect(fileObservation).toEqual({
      path: '.tagma/sample/artifacts/result.json',
      regularFile: true,
    });
    const value = trial();
    value.cases![0]!.expectations = [
      {
        type: 'json-valid',
        passed: true,
        detail: 'JSON is valid.',
        repairScope: 'pipeline-artifact',
        fileObservation,
      },
    ];
    const diagnosis = buildChatRepairDiagnosis(value, 0)!;
    expect(diagnosis.files).toEqual([fileObservation]);
    expect(diagnosis.tasks[0]!.completionPath).toBe('artifacts/result.json');
    expect(JSON.stringify(diagnosis)).not.toContain(root);
  });
  test('keeps workspace-relative effective cwd and completion coordinates separate', () => {
    const root = join(tmpdir(), 'coordinate-only');
    expect(
      trialTaskExecutionContext(
        { completion: { type: 'file_exists', path: 'artifacts/result.json' } },
        {},
        root,
      ),
    ).toMatchObject({ effectiveCwd: '.', completion: { resolvedPath: 'artifacts/result.json' } });
    expect(
      trialTaskExecutionContext(
        {
          cwd: '.tagma/sample',
          completion: { type: 'file_exists', path: 'artifacts/result.json' },
        },
        {},
        root,
      ),
    ).toMatchObject({
      effectiveCwd: '.tagma/sample',
      completion: { resolvedPath: '.tagma/sample/artifacts/result.json' },
    });
    expect(
      trialTaskExecutionContext(
        { cwd: '..', completion: { type: 'file_exists', path: 'private.txt' } },
        {},
        root,
      ),
    ).toEqual({
      effectiveCwd: null,
      completion: { type: 'file_exists', resolvedPath: null, regularFile: null },
    });
  });

  test.each(['completion_failed', 'output_error'])(
    'detects repeated observed failures after new repairs without depending on model prose (%s)',
    (kind) => {
      const first = buildChatRepairDiagnosis(trial(kind), 0)!;
      expect(isChatRepairDiagnosis(first)).toBe(true);
      expect(first.tasks.map((task) => task.taskId)).toEqual(['flow.build']);
      const second = advanceChatRepairDiagnosis(buildChatRepairDiagnosis(trial(kind), 1)!, first);
      const third = advanceChatRepairDiagnosis(buildChatRepairDiagnosis(trial(kind), 2)!, second);
      expect(second.consecutiveFailures).toBe(2);
      expect(third.consecutiveFailures).toBe(3);
    },
  );

  test('resets recurrence when actual failure or successful task evidence changes', () => {
    const first = buildChatRepairDiagnosis(trial(), 0)!;
    const changed = advanceChatRepairDiagnosis(
      buildChatRepairDiagnosis(trial('exit_nonzero'), 1)!,
      first,
    );
    expect(changed.consecutiveFailures).toBe(1);
    const progressed = trial();
    progressed.tasks!.push({
      ...progressed.tasks![0]!,
      taskId: 'flow.previous',
      status: 'success',
    });
    expect(
      advanceChatRepairDiagnosis(buildChatRepairDiagnosis(progressed, 1)!, first)
        .consecutiveFailures,
    ).toBe(1);
    const fileProgress = trial();
    fileProgress.cases![0]!.expectations = [
      {
        type: 'path-exists',
        passed: true,
        detail: 'exists',
        repairScope: 'pipeline-artifact',
        fileObservation: { path: 'result.json', regularFile: true },
      },
    ];
    expect(
      advanceChatRepairDiagnosis(buildChatRepairDiagnosis(fileProgress, 1)!, first)
        .consecutiveFailures,
    ).toBe(1);
  });

  test('does not label replay or incomplete evidence as another comparable failure', () => {
    const first = buildChatRepairDiagnosis(trial(), 0)!;
    expect(advanceChatRepairDiagnosis(first, first).consecutiveFailures).toBe(1);
    const omitted = { ...trial(), omittedTaskCount: 1 };
    const unknown = trial();
    delete unknown.tasks![0]!.executionContext;
    const notRun = { ...trial(), notRunCaseCount: 1 };
    const unobservedCompletion = trial();
    unobservedCompletion.tasks![0]!.executionContext = {
      effectiveCwd: '.',
      completion: { type: 'file_exists', resolvedPath: null, regularFile: null },
    };
    for (const value of [omitted, unknown, notRun, unobservedCompletion]) {
      const second = advanceChatRepairDiagnosis(buildChatRepairDiagnosis(value, 1)!, first);
      expect(second.complete).toBe(false);
      expect(second.consecutiveFailures).toBe(1);
    }
    expect(
      advanceChatRepairDiagnosis(buildChatRepairDiagnosis(trial(), 1)!, undefined)
        .consecutiveFailures,
    ).toBe(1);
  });

  test('rejects private, traversing, unbounded and unknown diagnosis fields', () => {
    const value = buildChatRepairDiagnosis(trial(), 0)!;
    for (const path of [
      'C:/private/file',
      '/tmp/private',
      '../outside',
      'https://host/file',
      'a'.repeat(513),
    ]) {
      expect(
        isChatRepairDiagnosis({ ...value, tasks: [{ ...value.tasks[0], effectiveCwd: path }] }),
      ).toBe(false);
    }
    expect(isChatRepairDiagnosis({ ...value, arbitrary: true })).toBe(false);
    expect(parseChatRepairDiagnosisJson(JSON.stringify(value))).toEqual(value);
    expect(parseChatRepairDiagnosisJson('{')).toBeNull();
    expect(parseChatRepairDiagnosisJson(JSON.stringify({ ...value, arbitrary: true }))).toBeNull();
    expect(isChatRepairDiagnosis({ ...value, tasks: [] })).toBe(false);
    const cyclic = { ...value, tasks: [] as unknown[] };
    cyclic.tasks.push(cyclic);
    expect(isChatRepairDiagnosis(cyclic)).toBe(false);
  });
  test('fits transport bytes without treating omitted coordinates as complete evidence', () => {
    const value = buildChatRepairDiagnosis(trial(), 0)!;
    const wide = {
      ...value,
      tasks: Array.from({ length: 8 }, (_, index) => ({
        ...value.tasks[0]!,
        taskId: `flow.task_${index}`,
        effectiveCwd: '测'.repeat(400),
        completionPath: '验'.repeat(400),
      })),
      files: [{ path: 'output/result.json', regularFile: false }],
    };
    const fitted = fitChatRepairDiagnosis(wide, 1200)!;
    expect(isChatRepairDiagnosis(fitted)).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(JSON.stringify(fitted))).byteLength,
    ).toBeLessThanOrEqual(1200);
    expect(fitted.complete).toBe(false);
    expect(fitted.omittedTaskCount).toBeGreaterThan(0);
    expect(fitted.omittedFileCount).toBe(1);
    expect(fitChatRepairDiagnosis(wide, 1)).toBeNull();
    expect(wide.tasks).toHaveLength(8);
  });
});
