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
