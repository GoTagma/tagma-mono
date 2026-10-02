import { afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompleteRepairOutput } from '../server/chat-operations/repair-output-reader';
import {
  trialTaskResults,
  type ChatPipelineTrialRunResult,
} from '../server/chat-pipeline-trial-run';
import {
  buildChatRepairErrorEvidence,
  hasUnexpectedExecutedTaskFailure,
  isChatRepairErrorEvidence,
  redactChatRepairErrorOutput,
} from '../server/chat-operations/repair-error-evidence';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('private model repair error evidence', () => {
  test('keeps concrete blocked input errors in private repair evidence', () => {
    const stderr =
      '[engine] task input binding resolution failed:\nbinding input "records": cannot coerce array to string';
    const result = trialTaskResults(
      {
        states: new Map([
          [
            'main.consume',
            {
              status: 'blocked',
              config: { command: 'consume' },
              trackConfig: {},
              result: { stdout: '', stderr, failureKind: 'input_error', exitCode: -1 },
            },
          ],
        ]),
      } as never,
      { name: 'Binding', tracks: [] },
      'positive',
      1,
      process.cwd(),
    );
    expect(result.repairErrorTasks).toHaveLength(1);
    expect(result.repairErrorTasks[0]).toMatchObject({
      status: 'blocked',
      repairScope: 'pipeline-artifact',
      stderr,
    });
  });
  test('recovers complete errors from the Host-owned persisted output instead of a runtime memory tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-repair-complete-output-'));
    roots.push(root);
    const logs = join(root, '.tagma', 'logs', 'run-owned');
    mkdirSync(logs, { recursive: true });
    const path = join(logs, 'work.failed.stderr');
    const stderr =
      'ACTUAL_ERROR_AT_START\n' + 'Diagnostic line\n'.repeat(4000) + 'ACTUAL_ERROR_AT_END';
    writeFileSync(path, stderr);
    const states = new Map([
      [
        'work.failed',
        {
          status: 'failed',
          config: { command: 'exit 1' },
          trackConfig: {},
          result: {
            stdout: '',
            stdoutBytes: 0,
            stderr: 'bounded runtime memory tail',
            stderrBytes: new TextEncoder().encode(stderr).length,
            exitCode: 1,
            failureKind: 'exit_nonzero',
          },
        },
      ],
    ]);
    const evidence = trialTaskResults(
      { states, logPath: join(logs, 'pipeline.log') } as never,
      { name: 'Capture', tracks: [] },
      'case-owned',
      1,
      root,
      new Map([['work.failed', { stderrPath: path }]]),
    );
    expect(evidence.repairErrorTasks[0].stderr).toBe(stderr);
    expect(evidence.repairErrorTasks[0].stderrTruncation.source).toBe('not-truncated');
    expect(evidence.tasks[0].stderr).toBe('bounded runtime memory tail');
  });

  test('refuses foreign log paths and hardlinked output files', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-repair-output-scope-'));
    roots.push(root);
    const logs = join(root, '.tagma', 'logs', 'run-owned');
    mkdirSync(logs, { recursive: true });
    const foreign = join(root, 'private.txt');
    writeFileSync(foreign, 'PRIVATE_DATA');
    expect(() => readCompleteRepairOutput(root, join(logs, 'pipeline.log'), foreign)).toThrow(
      'outside',
    );
    const alias = join(logs, 'stdout.txt');
    linkSync(foreign, alias);
    expect(() => readCompleteRepairOutput(root, join(logs, 'pipeline.log'), alias)).toThrow(
      'private regular',
    );
  });
  test('redacts credential syntax in mixed output while preserving diagnostic token-limit text', () => {
    const text =
      '{"api_key":"json-secret"} --token cli-secret\n' +
      'HTTP 403 at https://user:password@example.invalid/endpoint\n' +
      'The token limit was exceeded. LAST_CONTEXT';
    const redacted = redactChatRepairErrorOutput(text);
    expect(redacted).not.toContain('json-secret');
    expect(redacted).not.toContain('cli-secret');
    expect(redacted).not.toContain('user:password');
    expect(redacted).toContain('HTTP 403');
    expect(redacted).toContain('example.invalid/endpoint');
    expect(redacted).toContain('The token limit was exceeded. LAST_CONTEXT');
  });
  test.each(['failed', 'success'])(
    'captures error streams before display clipping and task selection (%s)',
    (status) => {
      const stderr =
        'FIRST_ERROR_DETAIL\n' +
        'Full captured diagnostic '.repeat(1000) +
        'MIDDLE_ERROR_DETAIL' +
        'Full captured diagnostic '.repeat(1000) +
        'FINAL_ERROR_DETAIL';
      const states = new Map(
        Array.from({ length: 120 }, (_, index) => [
          `work.task_${index}`,
          {
            status,
            config: { command: 'exit 1' },
            trackConfig: {},
            result: {
              stdout: '',
              stderr,
              exitCode: status === 'failed' ? 1 : 0,
              failureKind: status === 'failed' ? 'exit_nonzero' : null,
              stdoutBytes: 0,
              stderrBytes: new TextEncoder().encode(stderr).length,
            },
          },
        ]),
      );
      const result = trialTaskResults(
        { states } as never,
        { name: 'Capture', tracks: [] },
        'case-full',
        1,
        process.cwd(),
      );
      expect(result.repairErrorTasks).toHaveLength(120);
      expect(result.repairErrorTasks[119].stderr).toBe(stderr);
      expect(result.repairErrorTasks[119].stdoutTruncation.trialResult).toBe(false);
      expect(result.repairErrorTasks[119].stderrTruncation).toMatchObject({
        source: 'not-truncated',
        trialResult: false,
      });
      expect(result.tasks[0].stderr).not.toContain('MIDDLE_ERROR_DETAIL');
      expect(result.repairErrorTasks[119].status).toBe(status);
    },
  );

  test('retains long errors, stdout-only errors and credential-free structured context', () => {
    const longError = '详细错误 ☃ '.repeat(2000) + 'FINAL_CAUSE';
    const evidence = buildChatRepairErrorEvidence('trial-1', {
      kind: 'failed',
      ran: true,
      cases: [{ id: 'case-1', success: false, expectations: [] }],
      tasks: [
        {
          taskId: 'main.render',
          caseId: 'case-1',
          runNumber: 1,
          status: 'failed',
          repairScope: 'diagnostic-only',
          stdout: '',
          stderr: '[display clipped]',
        },
      ],
      repairErrorTasks: [
        {
          taskId: 'main.render',
          caseId: 'case-1',
          runNumber: 1,
          status: 'failed',
          repairScope: 'diagnostic-only',
          stdout: JSON.stringify({
            type: 'error',
            statusCode: 403,
            headers: {
              authorization: 'Bearer should-not-reach-model',
              'x-request-id': 'request-1',
            },
            metadata: { accessToken: 'private-value', provider: 'custom/provider' },
            responseBody: JSON.stringify({
              error: 'request refused',
              credential: 'nested-private-value',
            }),
          }),
          stderr: longError + '\nCUSTOM_TOKEN=secret-value',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult);
    const parsed = JSON.parse(evidence.text);
    expect(parsed.tasks[0].stderr).toContain(longError);
    expect(parsed.tasks[0].stderr).toContain('CUSTOM_TOKEN=[REDACTED]');
    expect(JSON.parse(parsed.tasks[0].stdout)).toMatchObject({
      type: 'error',
      statusCode: 403,
      headers: { 'x-request-id': 'request-1' },
      metadata: { provider: 'custom/provider' },
    });
    expect(evidence.text).not.toContain('[display clipped]');
    expect(evidence.text).not.toContain('should-not-reach-model');
    expect(evidence.text).not.toContain('private-value');
    expect(evidence.text).not.toContain('nested-private-value');
    expect(evidence.text).toContain('request refused');
    expect(evidence.text).not.toContain('secret-value');
    expect(isChatRepairErrorEvidence(evidence)).toBe(true);
    expect(isChatRepairErrorEvidence({ ...evidence, text: evidence.text + 'x' })).toBe(false);
  });

  test('shares repeated full streams losslessly while preserving independent errors and case identities', () => {
    const stdout = 'UPSTREAM_CONTEXT\n' + 'same successful output '.repeat(3000);
    const stderr = 'FIRST_CAUSE\n' + 'error details '.repeat(1000) + '\nLAST_CAUSE';
    const tasks = [1, 2, 3].flatMap((runNumber) => [
      {
        taskId: 'main.source',
        caseId: 'positive',
        runNumber,
        status: 'success',
        repairScope: null,
        stdout,
        stderr: '',
      },
      {
        taskId: 'main.consume',
        caseId: 'positive',
        runNumber,
        status: 'failed',
        repairScope: 'pipeline-artifact',
        stdout: '',
        stderr,
      },
    ]);
    const trial = {
      kind: 'failed',
      ran: true,
      repairErrorTasks: tasks,
      tasks: tasks.map((task) => ({
        ...task,
        stdout: '[display clipped]',
        stderr: '[display clipped]',
      })),
      cases: [
        {
          id: 'positive',
          success: false,
          expectations: [
            {
              type: 'file-equals',
              passed: false,
              detail: 'Expected a nonempty result; observed empty bytes.',
            },
          ],
        },
      ],
      repairPipelineDiagnostics: [
        { caseId: 'positive', taskId: 'main.consume', runNumber: 1, message: stderr },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const evidence = buildChatRepairErrorEvidence('trial-repeats', trial);
    const parsed = JSON.parse(evidence.text);
    const expand = (value: string | { textRef: string }) =>
      typeof value === 'string' ? value : parsed.sharedTexts[value.textRef];
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.tasks).toHaveLength(6);
    for (let index = 0; index < tasks.length; index++) {
      expect(expand(parsed.tasks[index].stdout)).toBe(tasks[index].stdout);
      expect(expand(parsed.tasks[index].stderr)).toBe(tasks[index].stderr);
      expect(parsed.tasks[index].runNumber).toBe(tasks[index].runNumber);
    }
    expect(expand(parsed.pipelineDiagnostics[0].message)).toBe(stderr);
    expect(parsed.cases[0].expectations[0].detail).toContain('observed empty bytes');
    expect(evidence.text.length).toBeLessThan(JSON.stringify(tasks).length / 2);
    expect(isChatRepairErrorEvidence(evidence)).toBe(true);
  });

  test('does not turn a passing expected rejection or a harness failure into artifact repair', () => {
    const task = {
      taskId: 'check.input',
      caseId: 'negative',
      runNumber: 1,
      status: 'failed',
      repairScope: null,
      stderr: 'Expected rejection',
      stdout: '',
    };
    const trial = {
      kind: 'failed',
      ran: true,
      tasks: [task],
      cases: [{ id: 'negative', success: true, expectations: [] }],
    } as unknown as ChatPipelineTrialRunResult;
    const evidence = JSON.parse(buildChatRepairErrorEvidence('trial-negative', trial).text);
    expect(evidence.tasks[0]).toMatchObject({
      expectedCaseOutcome: true,
      stderr: 'Expected rejection',
    });
    expect(hasUnexpectedExecutedTaskFailure(trial)).toBe(false);
    expect(
      hasUnexpectedExecutedTaskFailure({
        ...trial,
        kind: 'witness-failed',
        tasks: [{ ...trial.tasks[0], repairScope: 'diagnostic-only' }],
      }),
    ).toBe(false);
  });
});
