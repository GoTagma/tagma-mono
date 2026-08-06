import { expect, test } from 'bun:test';
import { buildChatYamlRepairPrompt } from '../src/store/chat-store';

const TARGET = {
  kind: 'refresh-current' as const,
  path: 'C:/repo/.tagma/build/build.yaml',
  name: 'build.yaml',
  pipelineName: 'Build',
};

test('compile repair prompt bounds and redacts compile evidence', () => {
  const secret = 'sk-live-secret-1234567890abcdefghijklmnop';
  const sessionToken = 'sess_live_super_secret_token_value';
  const bearer = 'Bearer ghp_compile_secret_token_value';
  const credential = 'password=compile-secret-password';
  const jsonSecret = '{"password":"hunter2","apiKey":"plain-secret"}';
  const providerAssignmentSecret = 'openai_api_key=sk-provider-assignment-secret-1234567890';
  const providerQuotedJsonSecret =
    '{"openai_api_key":"sk-provider-json-secret-1234567890","anthropic_api_key":"sk-provider-anthropic-secret-1234567890"}';
  const providerQuotedObjectSecret =
    "{ 'azure_openai_api_key': 'sk-provider-azure-secret-1234567890' }";
  const largeMessage = [
    'apiToken=' + secret,
    'session=' + sessionToken,
    'authorization=' + bearer,
    credential,
    jsonSecret,
    providerAssignmentSecret,
    providerQuotedJsonSecret,
    providerQuotedObjectSecret,
    'compile-diagnostic-'.repeat(120),
  ].join('\n');
  const prompt = buildChatYamlRepairPrompt(
    TARGET,
    {
      kind: 'compile',
      result: {
        timestamp: '2026-07-27T00:00:00.000Z',
        sourceName: 'build.yaml',
        success: false,
        parseOk: false,
        validation: {
          errors: Array.from({ length: 8 }, (_, index) => ({
            path: '/tasks/' + index + '/command',
            message: largeMessage + '\nline=' + index,
          })),
          warnings: Array.from({ length: 4 }, (_, index) => ({
            path: '/tasks/' + index + '/env',
            message: largeMessage + '\nwarning=' + index,
          })),
        },
        summary: largeMessage.repeat(80),
      },
    },
    1,
    3,
  );

  const evidence = prompt.split('<compile-result>')[1]!.split('</compile-result>')[0]!.trim();
  expect(new TextEncoder().encode(evidence).length).toBeLessThanOrEqual(64 * 1024);
  expect(evidence).toContain('evidenceTruncated');
  expect(evidence).toContain('[redacted');
  expect(evidence).not.toContain(secret);
  expect(evidence).not.toContain(sessionToken);
  expect(evidence).not.toContain(bearer);
  expect(evidence).not.toContain(credential);
  expect(evidence).not.toContain('hunter2');
  expect(evidence).not.toContain('plain-secret');
  expect(evidence).not.toContain('sk-provider-assignment-secret-1234567890');
  expect(evidence).not.toContain('sk-provider-json-secret-1234567890');
  expect(evidence).not.toContain('sk-provider-anthropic-secret-1234567890');
  expect(evidence).not.toContain('sk-provider-azure-secret-1234567890');
  expect(evidence).toContain('\\"password\\":\\"[redacted secret]\\"');
  expect(evidence).toContain('\\"apiKey\\":\\"[redacted secret]\\"');
  expect(evidence).toContain('\\"openai_api_key\\":\\"[redacted secret]\\"');
  expect(evidence).toContain('\\"anthropic_api_key\\":\\"[redacted secret]\\"');
  expect(evidence).toContain("{ 'azure_openai_api_key': '[redacted secret]' }");
});

test('compile repair prompt keeps multibyte fallback evidence byte-bounded', () => {
  const multibyte = '\u5bc6'.repeat(120_000);
  const prompt = buildChatYamlRepairPrompt(
    TARGET,
    {
      kind: 'compile',
      result: {
        timestamp: '2026-07-27T00:00:00.000Z',
        sourceName: multibyte,
        success: false,
        parseOk: false,
        validation: {
          errors: Array.from({ length: 400 }, (_, index) => ({
            path: '/tasks/' + index + '/command',
            message: multibyte,
          })),
          warnings: Array.from({ length: 200 }, (_, index) => ({
            path: '/tasks/' + index + '/env',
            message: multibyte,
          })),
        },
        summary: multibyte,
      },
    },
    1,
    3,
  );

  const evidence = prompt.split('<compile-result>')[1]!.split('</compile-result>')[0]!.trim();
  expect(new TextEncoder().encode(evidence).length).toBeLessThanOrEqual(64 * 1024);
  expect(evidence).toContain('evidenceTruncated');
});

test('trial repair prompt treats diagnostic-only evidence as non-authorizing context', () => {
  const prompt = buildChatYamlRepairPrompt(
    TARGET,
    {
      kind: 'trial-run',
      result: {
        version: 5,
        success: false,
        kind: 'plan-failed',
        repairAuthorization: 'pipeline-change-allowed',
        ran: false,
        runId: null,
        summary: 'One repairable finding and one harness limitation.',
        durationMs: 1,
        totalTaskCount: 0,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
      },
    },
    1,
    2,
  );

  expect(prompt).toContain('Items marked diagnostic-only are context, not mutation authority');
  expect(prompt).toContain('must never be repaired by weakening or redirecting the pipeline');
  expect(prompt).toContain('update the sibling .requirements.md in the same continuation');
});

test('oversized trial repair fallback preserves every finding repair scope', () => {
  const prompt = buildChatYamlRepairPrompt(
    TARGET,
    {
      kind: 'trial-run',
      result: {
        version: 6,
        success: false,
        kind: 'plan-failed',
        repairAuthorization: 'pipeline-change-allowed',
        ran: false,
        runId: null,
        summary: 'Mixed repair and diagnostic evidence.',
        durationMs: 1,
        totalTaskCount: 6,
        omittedTaskCount: 0,
        tasks: Array.from({ length: 6 }, (_, index) => ({
          caseId: null,
          runNumber: 1,
          taskId: `${'large-task-id-'.repeat(1_000)}${index}`,
          status: 'failed',
          exitCode: 1,
          failureKind: 'exit_code',
          stdout: '',
          stderr: 'failed',
        })),
        plan: {
          summary: 'Mixed evidence.',
          goals: [],
          coverage: [],
          findings: [
            {
              severity: 'blocking',
              repairScope: 'pipeline-artifact',
              summary: 'Pipeline defect',
              evidence: 'The staged command is invalid.',
            },
            {
              severity: 'blocking',
              repairScope: 'diagnostic-only',
              summary: 'Harness limitation',
              evidence: 'The harness cannot observe the external system.',
            },
          ],
          cases: [],
        },
        cases: [],
      },
    },
    1,
    2,
  );

  const evidence = prompt.split('<trial-run-result>')[1]!.split('</trial-run-result>')[0]!.trim();
  const parsed = JSON.parse(evidence) as {
    evidenceTruncation?: { layer?: string; reason?: string; limitBytes?: number };
    planFindings?: Array<{ repairScope?: string }>;
  };
  expect(parsed.evidenceTruncation).toEqual({
    layer: 'repair-prompt',
    reason: 'total-byte-limit',
    limitBytes: 64 * 1024,
  });
  expect(parsed.planFindings?.map((finding) => finding.repairScope)).toEqual([
    'pipeline-artifact',
    'diagnostic-only',
  ]);
});

test('trial repair evidence prioritizes actionable stderr and keeps failed-case task context', () => {
  const skippedTasks = Array.from({ length: 10 }, (_, index) => ({
    caseId: null,
    runNumber: 1,
    taskId: `main.skipped_${index}`,
    status: 'skipped',
    exitCode: null,
    failureKind: null,
    stdout: '',
    stderr: '',
  }));
  const failedTask = {
    caseId: null,
    runNumber: 1,
    taskId: 'main.actual_failure',
    status: 'failed',
    exitCode: 17,
    failureKind: 'exit_nonzero',
    stdout: '',
    stderr: `the actionable failure from the real task ${'detail '.repeat(400)}`,
  };
  const failedCaseTask = {
    caseId: 'semantic-json',
    runNumber: 1,
    taskId: 'main.emit_json',
    status: 'success',
    exitCode: 0,
    failureKind: null,
    stdout: 'wrote result.json',
    stderr: '',
  };
  const prompt = buildChatYamlRepairPrompt(
    TARGET,
    {
      kind: 'trial-run',
      result: {
        version: 8,
        success: false,
        kind: 'failed',
        repairAuthorization: 'pipeline-change-allowed',
        ran: true,
        runId: 'run_evidence_priority',
        summary: 'A real task and one semantic case failed.',
        durationMs: 10,
        totalTaskCount: 12,
        omittedTaskCount: 0,
        tasks: [...skippedTasks, failedTask, failedCaseTask],
        cases: [
          {
            id: 'semantic-json',
            title: 'Semantic JSON output',
            objective: 'Keep generated JSON valid.',
            success: false,
            runIds: ['run_case'],
            tasks: [failedCaseTask],
            expectations: [
              {
                type: 'case-execution',
                passed: false,
                detail: 'result.json was invalid JSON',
              },
            ],
          },
        ],
      },
    },
    1,
    2,
  );

  const evidence = JSON.parse(
    prompt.split('<trial-run-result>')[1]!.split('</trial-run-result>')[0]!.trim(),
  ) as {
    omittedTaskCount: number;
    omittedTaskStatusCounts: Record<string, number>;
    evidenceBounds: {
      layer: string;
      selectedTaskLimit: number;
      taskStreamLimitChars: number;
    };
    tasks: Array<{
      taskId: string;
      stderr: string;
      stderrRepairEvidenceTruncated?: boolean;
      stderrRepairEvidenceTruncation?: {
        layer?: string;
        reason?: string;
        limitChars?: number;
        sourceChars?: number;
        returnedChars?: number;
      };
    }>;
    cases: Array<{ id: string; tasks?: Array<{ taskId: string }> }>;
  };
  const actionable = evidence.tasks.find((task) => task.taskId === 'main.actual_failure');
  expect(actionable).toMatchObject({
    taskId: 'main.actual_failure',
    stderrRepairEvidenceTruncated: true,
    stderrRepairEvidenceTruncation: {
      layer: 'repair-prompt',
      reason: 'character-limit',
      limitChars: 2_000,
      sourceChars: expect.any(Number),
      returnedChars: expect.any(Number),
    },
  });
  expect(actionable?.stderr).toContain('the actionable failure from the real task');
  expect(actionable?.stderr).toContain('truncation-layer: repair-prompt');
  expect(evidence.omittedTaskCount).toBe(4);
  expect(evidence.omittedTaskStatusCounts).toEqual({ skipped: 4 });
  expect(evidence.evidenceBounds).toMatchObject({
    layer: 'repair-prompt',
    selectedTaskLimit: 8,
    taskStreamLimitChars: 2_000,
  });
  expect(evidence.cases[0]).toMatchObject({
    id: 'semantic-json',
    tasks: [{ taskId: 'main.emit_json' }],
  });
});
