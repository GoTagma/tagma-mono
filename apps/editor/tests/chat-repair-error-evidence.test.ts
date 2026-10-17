import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, PluginRegistry, bunRuntime, type PipelineConfig } from '@tagma/sdk';
import type { CompletionPlugin, TaskResult } from '@tagma/types';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION as TRIAL_CACHE_VERSION } from '../server/chat-pipeline-trial-cache';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission';
import { buildManagedChatOperationV2ExecutionPrompt } from '../server/chat-operations/authoring-runtime';
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

test('private repair redaction preserves nonsecret nested JSON bytes while still removing credentials', () => {
  const artifact = '{\r\n  "observation": "Café-日本 🧭",\r\n  "amount": 13\r\n}\r\n';
  const request = JSON.stringify({
    artifacts: [
      {
        path: 'work/result.json',
        content: artifact,
        sha256: createHash('sha256').update(artifact).digest('hex'),
        bytes: Buffer.byteLength(artifact),
      },
    ],
  });
  const envelope = JSON.stringify({
    kind: 'independent-semantic-review',
    request,
    response: '{ "verdict": "fail" }',
  });
  expect(redactChatRepairErrorOutput(artifact)).toBe(artifact);
  expect(redactChatRepairErrorOutput(envelope)).toBe(envelope);
  const jsonl = '  { "type": "start", "index": 1 }\n' + envelope + '\n';
  expect(redactChatRepairErrorOutput(jsonl)).toBe(jsonl);
  const protectedText = JSON.stringify({
    request: JSON.stringify({
      headers: { authorization: 'Bearer private-review-token' },
      artifact,
    }),
    apiKey: 'private-api-key',
  });
  const redacted = redactChatRepairErrorOutput(protectedText);
  expect(redacted).not.toContain('private-review-token');
  expect(redacted).not.toContain('private-api-key');
  expect(JSON.parse(JSON.parse(redacted).request).artifact).toBe(artifact);
  expect(redactChatRepairErrorOutput(redacted)).toBe(redacted);
});

test('private repair byte preservation never revives credentials hidden by duplicate JSON keys', () => {
  const documents = [
    '{ "apiKey": "duplicate-hidden-key", "apiKey": "[REDACTED]" }',
    '{ "api\\u004bey": "escaped-hidden-key", "apiKey": "[REDACTED]" }',
    '{ "message": "\\u0042earer duplicate-hidden-token", "message": "safe" }',
    '{ "message": "https://user:duplicate-hidden-password@example.invalid/", "message": "safe" }',
    JSON.stringify({ request: '{ "apiKey": "nested-hidden-key", "apiKey": "[REDACTED]" }' }),
  ];
  for (const document of documents) {
    const result = redactChatRepairErrorOutput(document);
    expect(result).not.toContain('hidden-');
    expect(redactChatRepairErrorOutput(result)).toBe(result);
    const lines = redactChatRepairErrorOutput('{ "event": "start" }\n' + document + '\n');
    expect(lines).not.toContain('hidden-');
  }
});

function streamEvidence(result: Partial<TaskResult>, persisted?: string) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-repair-stream-'));
  roots.push(root);
  const logs = join(root, '.tagma', 'logs', 'run-owned');
  mkdirSync(logs, { recursive: true });
  const path = join(logs, 'work.failed.stderr');
  if (persisted !== undefined) writeFileSync(path, persisted);
  const evidence = trialTaskResults(
    {
      states: new Map([
        [
          'work.failed',
          {
            status: 'failed',
            config: { command: 'exit 1' },
            trackConfig: {},
            result: { stdout: '', stderr: '', exitCode: 1, failureKind: 'exit_nonzero', ...result },
          },
        ],
      ]),
      logPath: join(logs, 'pipeline.log'),
    } as never,
    { name: 'Capture', tracks: [] },
    'positive',
    1,
    root,
    persisted === undefined ? new Map() : new Map([['work.failed', { stderrPath: path }]]),
  );
  return evidence.repairErrorTasks[0];
}

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
            stderrStoredBytes: new TextEncoder().encode(stderr).length,
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

  test('restores stored child errors and appends full completion feedback once into the repair prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-repair-full-completion-'));
    roots.push(root);
    const child = 'CHILD_FIRST\n' + 'child context ☃ '.repeat(1000) + '\nCHILD_LAST';
    const feedback =
      ' FIRST_COMPLETION\n' + 'completion context ☃ '.repeat(2000) + '\nLAST_COMPLETION ';
    const registry = new PluginRegistry();
    registry.registerPlugin('completions', 'judge', {
      name: 'judge',
      async check() {
        return { passed: false, feedback };
      },
    } as CompletionPlugin);
    const config: PipelineConfig = {
      name: 'Capture',
      tracks: [
        {
          id: 'work',
          name: 'Work',
          tasks: [
            {
              id: 'failed',
              name: 'Failed',
              command: {
                argv: [
                  'node',
                  '-e',
                  `const fs = require("node:fs"); fs.writeSync(1, "business output"); fs.writeSync(2, ${JSON.stringify(child)});`,
                ],
              },
              completion: { type: 'judge' },
            },
          ],
        },
      ],
    };
    const baseRuntime = bunRuntime();
    const runtime = {
      ...baseRuntime,
      runCommand(
        command: Parameters<typeof baseRuntime.runCommand>[0],
        cwd: string,
        options: Parameters<typeof baseRuntime.runCommand>[2],
      ) {
        return baseRuntime.runCommand(command, cwd, { ...options, maxStderrTailBytes: 128 });
      },
    };
    const execution = await createTagma({ registry, runtime, builtins: false }).run(config, {
      cwd: root,
      skipPluginLoading: true,
    });
    const result = execution.states.get('work.failed')!.result!;
    expect(execution.success).toBe(false);
    expect(result.failureKind).toBe('completion_failed');
    expect(result.stderr).not.toContain('FIRST_COMPLETION');
    expect(readFileSync(result.stderrPath!, 'utf8')).toBe(child);
    const trial = trialTaskResults(
      execution,
      config,
      'positive',
      1,
      root,
      new Map([['work.failed', { stdoutPath: result.stdoutPath, stderrPath: result.stderrPath }]]),
    );
    const repaired = trial.repairErrorTasks[0];
    expect(repaired.stderr).toBe(child + '\n[completion] ' + feedback);
    expect(repaired.stdout).toBe('business output');
    expect(repaired.modelEvidenceReadErrors).toBeUndefined();
    expect(repaired.stderrTruncation.source).toBe('not-truncated');
    expect(trial.tasks[0].stderr).not.toContain('FIRST_COMPLETION');
    const evidence = buildChatRepairErrorEvidence('trial-1', {
      kind: 'failed',
      ran: true,
      cases: [{ id: 'positive', success: false, expectations: [] }],
      ...trial,
    } as unknown as ChatPipelineTrialRunResult);
    expect(JSON.parse(evidence.text).tasks[0].stderr).toBe(repaired.stderr);
    const canonicalRequestBytes = new TextEncoder().encode(
      JSON.stringify({
        purpose: 'repair',
        repairAttempt: 1,
        repairEvidence: {
          feedback: {
            schemaVersion: 1,
            stage: 'trial',
            details: 'Completion check failed.',
            failedTaskIds: ['work.failed'],
            omittedFailedTaskCount: 0,
          },
          diagnosticCodes: ['task_failed'],
          errorEvidenceHash: evidence.hash,
          errors: evidence.text,
        },
      }),
    );
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'repair-1',
      sessionId: 'session-1',
      executionMessageId: 'input-1',
      purpose: 'repair',
      intent: 'create',
      stageDirectory: root,
      targetRelativePath: 'capture/capture.yaml',
      trialPlanRequest: null,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: { schemaVersion: 1, text: 'Build the pipeline.', attachments: [] },
        provider: 'test',
        model: 'offline-fixture',
        variant: null,
        agentPolicyHash: '1'.repeat(64),
        settingsHash: '2'.repeat(64),
        capabilityHash: '3'.repeat(64),
        featureHash: '4'.repeat(64),
        rendererInstanceId: 'renderer-1',
        conversationId: 'conversation-1',
        inventoryRevision: 1,
        inventoryDigest: '5'.repeat(64),
        readSnapshotHash: null,
        purpose: 'authoring',
        admittedAt: 1,
      }),
      clarificationThread: null,
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
      canonicalRequestBytes,
    });
    expect(prompt.text).toContain('CHILD_FIRST');
    expect(prompt.text).toContain('CHILD_LAST');
    expect(prompt.text).toContain('FIRST_COMPLETION');
    expect(prompt.text).toContain('LAST_COMPLETION');
    const encodedErrors = prompt.text.match(
      /<repair-error-evidence>([\s\S]*?)<\/repair-error-evidence>/u,
    )![1];
    const decodedErrors = encodedErrors
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&');
    expect(decodedErrors).toBe(evidence.text);
    expect(readFileSync(result.stderrPath!, 'utf8')).toBe(child);
  });

  test.each(['[runner] parse failed', '[driver] rejected output', '[engine] invalid binding'])(
    'preserves typed diagnostics after restoring a child stream (%s)',
    (note) => {
      const child = 'CHILD_START\n' + 'detail '.repeat(2000) + '\nCHILD_END';
      const suffix = '\n' + note;
      const task = streamEvidence(
        {
          stderr: 'tail' + suffix,
          stderrBytes: Buffer.byteLength(child),
          stderrStoredBytes: Buffer.byteLength(child),
          stderrDiagnostics: {
            suffix,
            completeSuffix: suffix,
            sourceBytes: Buffer.byteLength(child),
          },
        },
        child,
      );
      expect(task.stderr).toBe(child + suffix);
      expect(task.modelEvidenceReadErrors).toBeUndefined();
      expect(task.stderrTruncation.source).toBe('not-truncated');
    },
  );

  test.each(['short-file', 'missing-file'])('rejects known missing captured bytes (%s)', (mode) => {
    const task = streamEvidence(
      { stderr: 'tail', stderrBytes: 1000, stderrStoredBytes: 1000 },
      mode === 'short-file' ? 'short stored output' : undefined,
    );
    expect(task.modelEvidenceReadErrors?.[0].stream).toBe('stderr');
    expect(task.stderrTruncation.source).toBe('truncated');
  });

  test('keeps redaction byte shrinkage valid and legacy raw byte gaps unknown', () => {
    const redacted = streamEvidence({ stderr: 'x', stderrBytes: 6, stderrStoredBytes: 1 });
    expect(redacted.stderr).toBe('x');
    expect(redacted.modelEvidenceReadErrors).toBeUndefined();
    expect(redacted.stderrTruncation.source).toBe('not-truncated');
    const legacy = streamEvidence({ stderr: 'x', stderrBytes: 6 });
    expect(legacy.modelEvidenceReadErrors).toBeUndefined();
    expect(legacy.stderrTruncation.source).toBe('unknown');
    const restoredLegacy = streamEvidence(
      { stderr: 'tail', stderrBytes: 1000 },
      'complete legacy capture',
    );
    expect(restoredLegacy.stderr).toBe('complete legacy capture');
    expect(restoredLegacy.modelEvidenceReadErrors).toBeUndefined();
    expect(restoredLegacy.stderrTruncation.source).toBe('unknown');
    const empty = streamEvidence({ stderr: '', stderrBytes: 0, stderrStoredBytes: 0 });
    expect(empty.stderrTruncation.source).toBe('not-truncated');
    expect(empty.modelEvidenceReadErrors).toBeUndefined();
  });

  test('does not infer diagnostics from child text and rejects a mismatched typed suffix', () => {
    const literal = 'child says [completion] with no engine annotation';
    expect(
      streamEvidence({ stderr: literal, stderrBytes: Buffer.byteLength(literal) }).stderr,
    ).toBe(literal);
    const mismatch = streamEvidence({
      stderr: 'child only',
      stderrStoredBytes: 10,
      stderrDiagnostics: {
        suffix: '\n[completion] expected',
        completeSuffix: '\n[completion] full',
      },
    });
    expect(mismatch.stderr).not.toContain('[completion] full');
    expect(mismatch.modelEvidenceReadErrors?.[0].message).toContain('suffix does not match');
    const marker = streamEvidence({
      stderr: '[100 bytes truncated from head; not persisted]\nTAIL',
    });
    expect(marker.stderrTruncation.source).toBe('truncated');
    expect(marker.modelEvidenceReadErrors).toHaveLength(1);
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

test('complete native planner rejection survives private redaction, resealing and actual planner input', () => {
  const required = [
    'timeout-recovery',
    'failure-recovery',
    'empty-result',
    'unlocated-source',
    'source-preservation',
  ];
  const text = JSON.stringify({
    message: 'Native rejection with all issues.',
    missingEvidence: required,
    issues: required.map((type, index) => ({
      type,
      caseId: null,
      code: 'typed-evidence-missing',
      field: 'cases.evidence',
      message:
        '完整诊断🧭'.repeat(200) + ` issue=${index} --token native-private-secret FINAL_${index}`,
      repairScope: 'diagnostic-only',
    })),
  });
  const nativeHash = createHash('sha256').update(text, 'utf8').digest('hex');
  const hostMessage = 'Host full inspection 🧭 '.repeat(200) + 'HOST_FINAL_DETAIL';
  const planRequest = {
    reason: 'invalid' as const,
    relativePlanPath: 'flow/flow.trial-plan.json',
    pipelineHash: 'a'.repeat(40),
    message: hostMessage,
    maxAttempts: 2,
    requiredCoverage: ['multiple-inputs' as const],
    attemptId: 'fresh-host-attempt',
  };
  for (const kind of ['plan-required', 'plan-failed'] as const) {
    const evidence = buildChatRepairErrorEvidence('trial-native', {
      version: TRIAL_CACHE_VERSION,
      success: false,
      runId: null,
      durationMs: 0,
      totalTaskCount: 0,
      omittedTaskCount: 0,
      kind,
      ran: false,
      tasks: [],
      cases: [],
      summary: '[compact display summary]',
      ...(kind === 'plan-required' ? { planRequest } : { repairPlanRequest: planRequest }),
      repairPlanRejectionEvidence: {
        version: 1,
        stageId: 'stage-native',
        yamlHash: 'a'.repeat(40),
        relativeYamlPath: 'flow/flow.yaml',
        attemptId: 'rejected-host-attempt',
        submissionConsumed: true,
        toolAttemptCount: 1,
        validationRejectionCount: 1,
        successfulWriteCount: 0,
        recordedAt: 1,
        text,
        hash: nativeHash,
        byteLength: Buffer.byteLength(text, 'utf8'),
      },
    } as ChatPipelineTrialRunResult);
    expect(isChatRepairErrorEvidence(evidence)).toBe(true);
    expect(evidence.hash).toBe(createHash('sha256').update(evidence.text, 'utf8').digest('hex'));
    expect(evidence.text).not.toContain('native-private-secret');
    const document = JSON.parse(evidence.text);
    const native = document.planRejectionEvidence;
    expect(native.nativeHash).toBe(nativeHash);
    expect(native.nativeByteLength).toBe(Buffer.byteLength(text, 'utf8'));
    expect(native.byteLength).toBe(Buffer.byteLength(native.text, 'utf8'));
    expect(native.hash).toBe(createHash('sha256').update(native.text, 'utf8').digest('hex'));
    expect(native.hash).not.toBe(nativeHash);
    const complete = JSON.parse(native.text);
    expect(complete.missingEvidence).toEqual(required);
    expect(complete.issues).toHaveLength(5);
    expect(complete.issues.map((issue: { type: string }) => issue.type)).toEqual(required);
    expect(complete.issues.at(-1).message).toContain('FINAL_4');
    expect(complete.issues.at(-1).message).toContain('[REDACTED]');
    expect(document.planRequest.message).toBe(hostMessage);
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'native-planner',
      sessionId: 'native-session',
      executionMessageId: 'native-input',
      purpose: 'trial_plan',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'flow/flow.yaml',
      trialPlanRequest: planRequest,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: { schemaVersion: 1, text: 'Build the pipeline.', attachments: [] },
        provider: 'test',
        model: 'offline-fixture',
        variant: null,
        agentPolicyHash: '1'.repeat(64),
        settingsHash: '2'.repeat(64),
        capabilityHash: '3'.repeat(64),
        featureHash: '4'.repeat(64),
        rendererInstanceId: 'renderer-native',
        conversationId: 'conversation-native',
        inventoryRevision: 1,
        inventoryDigest: '5'.repeat(64),
        readSnapshotHash: null,
        purpose: 'authoring',
        admittedAt: 1,
      }),
      clarificationThread: null,
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({
          purpose: 'trial_plan',
          verificationErrorEvidence: { hash: evidence.hash, errors: evidence.text },
        }),
      ),
    });
    const encoded = prompt.text.match(
      /<trial-error-evidence>([\s\S]*?)<\/trial-error-evidence>/u,
    )![1]!;
    const decoded = encoded
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&');
    expect(decoded).toBe(evidence.text);
    expect(prompt.text).not.toContain('native-private-secret');
  }
  const missing = buildChatRepairErrorEvidence('trial-missing-native', {
    version: TRIAL_CACHE_VERSION,
    success: false,
    runId: null,
    durationMs: 0,
    totalTaskCount: 0,
    omittedTaskCount: 0,
    kind: 'plan-required',
    ran: false,
    tasks: [],
    cases: [],
    summary: '[compact only]',
  } as ChatPipelineTrialRunResult);
  expect(JSON.parse(missing.text).planRejectionEvidence).toBeUndefined();
});
