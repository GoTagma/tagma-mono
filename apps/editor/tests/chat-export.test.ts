import { describe, expect, test } from 'bun:test';
import { buildConversationExport, conversationExportFilename } from '../src/utils/chat-export';
import type { OpencodeThreadEntry, Part } from '../src/api/opencode-chat';
import type { ChatYamlSessionResult } from '../src/store/chat-store';

const textPart = (id: string, text: string, synthetic = false): Part =>
  ({
    id,
    sessionID: 's1',
    messageID: `m-${id}`,
    type: 'text',
    text,
    ...(synthetic ? { synthetic } : {}),
  }) as Part;

const reasoningPart = (id: string, text: string): Part =>
  ({
    id,
    sessionID: 's1',
    messageID: `m-${id}`,
    type: 'reasoning',
    text,
  }) as Part;

const entry = (
  role: 'user' | 'assistant',
  id: string,
  parts: Part[],
  time?: { created: number; completed?: number },
  sessionID = 's1',
): OpencodeThreadEntry =>
  ({
    info: { id, sessionID, role, ...(time ? { time } : {}) },
    parts,
  }) as OpencodeThreadEntry;

const hostVerification = (sessionId = 's1', completedAt = 1_000): ChatYamlSessionResult => ({
  kind: 'open-created',
  path: 'D:/repo/.tagma/demo/demo.yaml',
  name: 'demo.yaml',
  pipelineName: 'Demo',
  sessionId,
  status: 'ready',
  compile: {
    success: true,
    summary: 'Valid pipeline configuration',
    validation: { errors: [], warnings: [] },
  },
  completedAt,
});

describe('chat conversation export', () => {
  test('builds markdown from visible user and assistant text', () => {
    const exported = buildConversationExport({
      format: 'md',
      title: 'Pipeline help',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'u1', [
          textPart(
            'u1p1',
            [
              '<editor-context>',
              '  <workspace>D:/repo</workspace>',
              '</editor-context>',
              '',
              '<ask-ai-context>',
              '<attachment>hidden run log</attachment>',
              '</ask-ai-context>',
              '',
              'Please explain **this** pipeline.',
            ].join('\n'),
          ),
        ]),
        entry('assistant', 'a1', [textPart('a1p1', 'Done.\n\n- It runs the build.')]),
      ],
    });

    expect(exported.extension).toBe('md');
    expect(exported.mimeType).toBe('text/markdown;charset=utf-8');
    expect(exported.content).toContain('# Pipeline help');
    expect(exported.content).toContain('Exported: 2026-05-20T12:00:00.000Z');
    expect(exported.content).toContain('## User\n\nPlease explain **this** pipeline.');
    expect(exported.content).toContain('## Assistant\n\nDone.\n\n- It runs the build.');
    expect(exported.content).not.toContain('<editor-context>');
    expect(exported.content).not.toContain('<ask-ai-context>');
    expect(exported.content).not.toContain('hidden run log');
  });

  test('builds txt and skips internal, context-only, and synthetic messages', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: '',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'internal', [
          textPart('internal-p1', '<tagma-internal>repair</tagma-internal>'),
        ]),
        entry('user', 'context-only', [
          textPart(
            'context-p1',
            [
              '<editor-context>',
              '  <workspace>D:/repo</workspace>',
              '</editor-context>',
              '',
              '<ask-ai-context>',
              '<attachment>hidden</attachment>',
              '</ask-ai-context>',
            ].join('\n'),
          ),
        ]),
        entry('assistant', 'synthetic', [textPart('synthetic-p1', 'hidden synthetic text', true)]),
        entry('assistant', 'visible', [textPart('visible-p1', 'Visible answer')]),
      ],
    });

    expect(exported.extension).toBe('txt');
    expect(exported.mimeType).toBe('text/plain;charset=utf-8');
    expect(exported.content).toBe(
      [
        'Chat Export',
        'Exported: 2026-05-20T12:00:00.000Z',
        '',
        'Assistant:',
        'Visible answer',
        '',
      ].join('\n'),
    );
    expect(exported.content).not.toContain('repair');
    expect(exported.content).not.toContain('hidden synthetic text');
  });

  test('omits reasoning, routing-only assistants, and internal continuation turns', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Private internals',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'visible-user', [textPart('visible-user-text', 'Build the pipeline.')]),
        {
          info: {
            id: 'router',
            sessionID: 's1',
            role: 'assistant',
            finish: 'tool-calls',
            cost: 0.0042,
            tokens: {
              input: 1200,
              output: 50,
              reasoning: 40,
              cache: { read: 300, write: 0 },
            },
          },
          parts: [
            reasoningPart('router-reasoning', 'Internal routing decision and tool contract.'),
          ],
        } as unknown as OpencodeThreadEntry,
        entry('assistant', 'visible-answer', [
          textPart('visible-answer-text', 'Pipeline drafted.'),
        ]),
        entry('user', 'internal-repair', [
          textPart(
            'internal-repair-text',
            '<tagma-internal>Automatic repair with private diagnostics.</tagma-internal>',
          ),
        ]),
        entry('assistant', 'internal-result', [
          reasoningPart('internal-result-reasoning', 'Private repair reasoning.'),
          textPart('internal-result-text', 'Internal repair result should stay hidden.'),
        ]),
        entry('user', 'visible-follow-up', [
          textPart('visible-follow-up-text', 'Show the result.'),
        ]),
        entry('assistant', 'visible-final', [
          textPart('visible-final-text', 'Final visible result.'),
        ]),
      ],
    });

    expect(exported.content).toContain('Build the pipeline.');
    expect(exported.content).toContain('Pipeline drafted.');
    expect(exported.content).toContain('Show the result.');
    expect(exported.content).toContain('Final visible result.');
    expect(exported.content).not.toContain('Reasoning:');
    expect(exported.content).not.toContain('Internal routing decision');
    expect(exported.content).not.toContain('Internal repair');
    expect(exported.content).not.toContain('Private repair reasoning');
    expect(exported.content).not.toContain('1.5k input tokens');
  });

  test('exports assistant errors but skips usage-only phantom messages', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Debug run',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        {
          info: {
            id: 'cost-only',
            sessionID: 's1',
            role: 'assistant',
            cost: 0.012,
          },
          parts: [],
        } as unknown as OpencodeThreadEntry,
        {
          info: {
            id: 'error-only',
            sessionID: 's1',
            role: 'assistant',
            error: { name: 'ProviderAuthError', data: { message: 'missing key' } },
          },
          parts: [],
        } as unknown as OpencodeThreadEntry,
      ],
    });

    expect(exported.content).not.toContain('Usage: $0.012');
    expect(exported.content).toContain('Assistant:\nError: ProviderAuthError: missing key');
  });

  test('exports assistant footer metadata alongside visible text', () => {
    const exported = buildConversationExport({
      format: 'md',
      title: 'Usage',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        {
          info: {
            id: 'with-usage',
            sessionID: 's1',
            role: 'assistant',
            cost: 0.0042,
            finish: 'length',
            tokens: {
              input: 1200,
              output: 50,
              reasoning: 0,
              cache: { read: 300, write: 0 },
            },
          },
          parts: [textPart('answer', 'Partial answer')],
        } as unknown as OpencodeThreadEntry,
      ],
    });

    expect(exported.content).toContain('## Assistant\n\nPartial answer\n\n_');
    expect(exported.content).toContain('50 output tokens');
    expect(exported.content).toContain('1.5k input tokens');
    expect(exported.content).toContain('$0.0042');
    expect(exported.content).toContain('Finish: length');
  });

  test('appends redacted trial plan, case results, and final host verification', () => {
    const exported = buildConversationExport({
      format: 'md',
      title: 'Verified pipeline',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [entry('assistant', 'a1', [textPart('a1p1', 'Pipeline drafted.')])],
      pipelineVerification: {
        kind: 'open-created',
        path: 'D:/repo/.tagma/demo.yaml',
        name: 'demo.yaml',
        pipelineName: 'Demo',
        sessionId: 's1',
        status: 'failed',
        compile: {
          success: true,
          summary: 'Compiled with token=ghp_compile_secret',
          validation: { errors: [], warnings: [] },
        },
        trial: {
          version: 13,
          success: false,
          kind: 'witness-failed',
          ran: false,
          runId: null,
          summary:
            'Witness failed with Authorization: Bearer trial-secret ' +
            'diagnostic detail '.repeat(300),
          durationMs: 25,
          totalTaskCount: 12,
          omittedTaskCount: 10,
          taskStatusCounts: { failed: 1, success: 1, skipped: 10 },
          omittedTaskStatusCounts: { skipped: 10 },
          repairAuthorization: 'diagnostic-only',
          trialMode: 'sandbox',
          verificationMode: 'sandbox-cases-only',
          trialabilityReport: {
            protocolVersion: 1,
            mode: 'sandbox',
            runnable: false,
            enforcement: {
              sandboxCases: {
                workspace: 'temporary-copy',
                stdin: 'closed',
                tty: 'none',
                secrets: 'synthetic',
                filesystem: 'host-unrestricted-outside-copy',
                network: 'host-unrestricted',
                process: 'host-unrestricted',
              },
              liveSmokeBaseline: null,
            },
            items: Array.from({ length: 35 }, (_, index) => ({
              component: 'driver' as const,
              taskId: `main.task-${index}`,
              type: `driver-${index}`,
              provider: `provider-${index}`,
              declaration: null,
              disposition: 'unsupported-in-unattended-trial' as const,
            })),
            blockers: Array.from(
              { length: 18 },
              (_, index) => `Blocker ${index} token=private-blocker-${index}`,
            ),
            warnings: Array.from(
              { length: 18 },
              (_, index) => `Warning ${index} token=private-warning-${index}`,
            ),
          },
          manualExecutionGrants: [{ taskId: 'main.manual-check', approvalCount: 2 }],
          plannedCaseCount: 2,
          caseResultCount: 1,
          notRunCaseCount: 1,
          tasks: [
            {
              caseId: null,
              runNumber: 1,
              taskId: 'baseline.failed',
              status: 'failed',
              exitCode: 17,
              failureKind: 'exit_nonzero',
              stdout: '',
              stderr: 'actionable failure token=baseline-task-secret',
              stderrAuxiliaryDiagnosticsOmittedLines: 1,
              repairScope: 'pipeline-artifact',
              stdoutTruncation: {
                source: 'not-truncated',
                trialResult: false,
                producedBytes: 0,
                sourceReturnedBytes: 0,
                returnedBytes: 0,
              },
              stderrTruncation: {
                source: 'truncated',
                trialResult: false,
                producedBytes: 9_000,
                sourceReturnedBytes: 4_000,
                returnedBytes: 4_000,
              },
            },
            {
              caseId: 'basic-run',
              runNumber: 1,
              taskId: 'case.success',
              status: 'success',
              exitCode: 0,
              failureKind: null,
              stdout: 'case output',
              stderr: '',
              repairScope: null,
            },
          ],
          plan: {
            summary: 'Exercise the pipeline using api_key=plan-secret',
            goals: ['Verify basic output password=hunter2'],
            coverage: [
              {
                dimension: 'multiple-inputs',
                status: 'covered',
                caseIds: ['basic-run', 'token=coverage-case-secret'],
                rationale: 'Covered by credential=coverage-secret',
              },
            ],
            findings: [
              {
                severity: 'blocking',
                repairScope: 'diagnostic-only',
                summary: 'Host witness unavailable',
                evidence: 'session_id=sess_evidence_secret',
              },
            ],
            cases: [
              {
                id: 'basic-run',
                title: 'Basic run',
                objective: 'Create greeting.txt',
                runs: 1,
                targetTaskIds: ['write-output', 'secret=task-id-secret'],
              },
            ],
          },
          cases: [
            {
              id: 'basic-run',
              title: 'Basic run',
              objective: 'Create greeting.txt',
              success: false,
              runIds: [],
              totalTaskCount: 11,
              omittedTaskCount: 10,
              taskStatusCounts: { success: 1, skipped: 10 },
              omittedTaskStatusCounts: { skipped: 10 },
              tasks: [
                {
                  caseId: 'basic-run',
                  runNumber: 1,
                  taskId: 'case.success',
                  status: 'success',
                  exitCode: 0,
                  failureKind: null,
                  stdout: 'case output',
                  stderr: '',
                  repairScope: null,
                },
              ],
              expectations: [
                {
                  type: 'case-execution',
                  passed: false,
                  detail: 'Not executed because secret=case-secret',
                  repairScope: 'diagnostic-only',
                  paths: ['generated/changed.txt'],
                  omittedPathEventCount: 2,
                  workspaceMutation: {
                    layer: 'trial-workspace-mutation-monitor',
                    attribution: 'writer-unknown',
                    observedDuringCaseId: 'basic-run',
                    observedPathEventCount: 5,
                    returnedPathEventCount: 3,
                    returnedPathCount: 1,
                    omittedPathEventCount: 2,
                    paths: ['generated/changed.txt'],
                  },
                },
                {
                  type: 'file-contains',
                  passed: false,
                  detail: 'Output exceeded the assertion reader.',
                  repairScope: 'diagnostic-only',
                  truncation: {
                    layer: 'trial-assertion-reader',
                    reason: 'byte-limit',
                    limitBytes: 2_097_152,
                    sourceBytes: 2_097_153,
                    returnedBytes: 0,
                  },
                },
              ],
            },
          ],
        },
        repairAttempts: 1,
        planningTelemetry: {
          promptCount: 2,
          toolAttemptCount: 2,
          validationRejectionCount: 1,
          repeatedValidationRejectionCount: 0,
          elapsedMs: 4_200,
          inputTokens: 1_200,
          outputTokens: 80,
          reasoningTokens: 20,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          cost: 0.01,
        },
        reconcile: {
          outcome: 'forked',
          conflicts: ['trial-run-failed'],
          localBranchPersisted: true,
          resultPath: 'D:/repo/.tagma/demo.yaml',
          compileSuccess: true,
          trialRunSuccess: false,
        },
        completedAt: Date.parse('2026-05-20T12:00:01.000Z'),
      },
    });

    expect(exported.content).toContain('## Pipeline Verification');
    expect(exported.content).toContain('Host result: forked');
    expect(exported.content).toContain('Pipeline repair cycles: 1');
    expect(exported.content).toContain('Trial planning prompts: 2');
    expect(exported.content).toContain('Trial plan tool attempts: 2');
    expect(exported.content).toContain('Planning validation rejections: 1');
    expect(exported.content).toContain('Planning token usage: 1.5k input, 100 output');
    expect(exported.content).toContain('Trial cases: 2 planned; 1 returned; 1 not run');
    expect(exported.content).toContain('Trial task status totals: failed=1, skipped=10, success=1');
    expect(exported.content).toContain('Trial task status omitted: skipped=10');
    expect(exported.content).toContain('Trial repair authorization: diagnostic-only');
    expect(exported.content).toContain('Trial mode: sandbox');
    expect(exported.content).toContain('Trial verification mode: sandbox-cases-only');
    expect(exported.content).toContain('Trialability preflight: blocked; protocol v1');
    expect(exported.content).toContain(
      'Trialability Sandbox-case containment (application-level; no OS sandbox): workspace=temporary-copy; stdin=closed; TTY=none; secrets=synthetic; filesystem=host-unrestricted-outside-copy; network=host-unrestricted; process=host-unrestricted',
    );
    expect(exported.content).toContain('Trialability Live Smoke baseline: not enabled');
    expect(exported.content).toContain('Trialability surfaces: 35 total; 32 returned; 3 omitted');
    expect(exported.content).toContain('Trialability blockers: 18 total; 16 returned; 2 omitted');
    expect(exported.content).toContain('Trialability warnings: 18 total; 16 returned; 2 omitted');
    expect(exported.content).toContain('Trialability blocker: Blocker 0 token=[REDACTED]');
    expect(exported.content).not.toContain('private-blocker-17');
    expect(exported.content).not.toContain('private-warning-17');
    expect(exported.content).toContain(
      'Trial manual execution grant: main.manual-check (2 approvals)',
    );
    expect(exported.content).toContain('...[chat-export truncated ');
    expect(exported.content).not.toContain('...[truncated]');
    expect(exported.content).toContain('Baseline Task Evidence');
    expect(exported.content).toContain(
      'baseline.failed run 1: failed; exit 17; failure exit_nonzero',
    );
    expect(exported.content).toContain('stderr: actionable failure token=[REDACTED]');
    expect(exported.content).toContain(
      'stderr auxiliary diagnostics omitted: 1 recoverable OpenCode title-model line(s)',
    );
    expect(exported.content).toContain(
      'stderr evidence: source/runtime=truncated; trial-result=not-truncated; produced=9000 bytes; source-returned=4000 bytes; final-returned=4000 bytes',
    );
    expect(exported.content).toContain('### Trial Plan');
    expect(exported.content).toContain('repair scope: diagnostic-only');
    expect(exported.content).toContain('`basic-run` — Basic run');
    expect(exported.content).toContain('### Trial Case Results');
    expect(exported.content).toContain('case-execution: failed');
    expect(exported.content).toContain(
      'Changed paths: generated/changed.txt; omitted path events: 2',
    );
    expect(exported.content).toContain(
      'Workspace mutation observation: layer=trial-workspace-mutation-monitor; attribution=writer-unknown; case=basic-run; observed events=5; returned events=3; returned paths=1; omitted events=2',
    );
    expect(exported.content).toContain(
      'Evidence truncation: layer=trial-assertion-reader; reason=byte-limit; limit=2097152 bytes; source=2097153 bytes; returned=0 bytes',
    );
    expect(exported.content).toContain('[REDACTED]');
    expect(exported.content).not.toContain('ghp_compile_secret');
    expect(exported.content).not.toContain('trial-secret');
    expect(exported.content).not.toContain('plan-secret');
    expect(exported.content).not.toContain('hunter2');
    expect(exported.content).not.toContain('coverage-secret');
    expect(exported.content).not.toContain('coverage-case-secret');
    expect(exported.content).not.toContain('sess_evidence_secret');
    expect(exported.content).not.toContain('case-secret');
    expect(exported.content).not.toContain('task-id-secret');
  });

  test('labels a successful trial with accepted risk as passed with warnings', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Warning-aware verification',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [],
      pipelineVerification: {
        kind: 'refresh-current',
        path: 'D:/repo/.tagma/demo/demo.yaml',
        name: 'demo.yaml',
        pipelineName: 'Demo',
        sessionId: 's1',
        status: 'ready',
        compile: {
          success: true,
          summary: 'Compile passed.',
          validation: { errors: [], warnings: [] },
        },
        trial: {
          version: 13,
          success: true,
          kind: 'passed-with-warnings',
          ran: true,
          runId: 'run_warning',
          summary: 'Accepted risk concurrent-run-output-collision.',
          durationMs: 10,
          totalTaskCount: 1,
          omittedTaskCount: 0,
          trialMode: 'sandbox-with-live-smoke',
          verificationMode: 'sandbox-cases-with-live-smoke',
          trialabilityReport: {
            protocolVersion: 1,
            mode: 'sandbox-with-live-smoke',
            runnable: true,
            enforcement: {
              sandboxCases: {
                workspace: 'temporary-copy',
                stdin: 'closed',
                tty: 'none',
                secrets: 'synthetic',
                filesystem: 'host-unrestricted-outside-copy',
                network: 'host-unrestricted',
                process: 'host-unrestricted',
              },
              liveSmokeBaseline: {
                workspace: 'real-workspace',
                stdin: 'closed',
                tty: 'none',
                secrets: 'real',
                filesystem: 'host-unrestricted',
                network: 'host-unrestricted',
                process: 'host-unrestricted',
              },
            },
            items: [],
            blockers: [],
            warnings: [],
          },
          tasks: [],
          cases: [],
        },
        repairAttempts: 0,
        reconcile: {
          outcome: 'adopted',
          conflicts: [],
          localBranchPersisted: false,
          resultPath: 'D:/repo/.tagma/demo/demo.yaml',
          compileSuccess: true,
          trialRunSuccess: true,
        },
        completedAt: 1_000,
      },
    });

    expect(exported.content).toContain('Trial: passed with warnings (passed-with-warnings; ran)');
    expect(exported.content).not.toContain('Trial: passed (passed-with-warnings; ran)');
    expect(exported.content).toContain(
      'Trialability Live Smoke baseline authority (real workspace; real secrets; normal host authority; no OS sandbox): workspace=real-workspace; stdin=closed; TTY=none; secrets=real; filesystem=host-unrestricted; network=host-unrestricted; process=host-unrestricted',
    );
  });

  test('exports authoritative host verification with actionable planning rejection evidence', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Failed plan',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'u1', [textPart('u1p1', 'Build the pipeline.')], { created: 700 }),
        entry(
          'assistant',
          'a1',
          [
            textPart(
              'a1p1',
              'authoring complete; host verification pending\n\nDo you want the host to verify?',
            ),
          ],
          { created: 800, completed: 900 },
        ),
        entry('user', 'u2', [textPart('u2p1', 'What happened after verification?')], {
          created: 1_100,
        }),
        entry(
          'assistant',
          'a2',
          [textPart('a2p1', 'This later answer must remain in the export.')],
          { created: 1_200, completed: 1_300 },
        ),
      ],
      pipelineVerification: {
        kind: 'open-created',
        path: 'D:/repo/.tagma/demo/demo.yaml',
        name: 'demo.yaml',
        pipelineName: 'Demo',
        sessionId: 's1',
        status: 'failed',
        compile: {
          success: true,
          summary: 'Valid pipeline configuration',
          validation: { errors: [], warnings: [] },
        },
        trial: {
          version: 10,
          success: false,
          kind: 'plan-failed',
          ran: false,
          runId: null,
          summary: 'Trial plan tool attempt budget exhausted.',
          durationMs: 1_000,
          totalTaskCount: 0,
          omittedTaskCount: 0,
          tasks: [],
          cases: [],
          repairAuthorization: 'diagnostic-only',
          planTelemetry: {
            version: 2,
            yamlHash: 'a'.repeat(40),
            relativeYamlPath: 'demo/demo.yaml',
            attemptIds: ['host-attempt-1', 'host-attempt-2', 'host-attempt-3'],
            toolAttemptCount: 3,
            validationRejectionCount: 3,
            repeatedValidationRejectionCount: 0,
            successfulWriteCount: 0,
            firstAttemptAt: 1,
            lastAttemptAt: 1,
            elapsedMs: 1_000,
            rejections: [
              {
                fingerprint: 'b'.repeat(64),
                count: 1,
                message: 'coverage[0].status must be a non-empty string.',
              },
              {
                fingerprint: 'c'.repeat(64),
                count: 2,
                message: `Authorization: Bearer super-secret-token ${'x'.repeat(5_000)}`,
              },
            ],
          },
        },
        planningTelemetry: {
          promptCount: 1,
          toolAttemptCount: 3,
          validationRejectionCount: 3,
          repeatedValidationRejectionCount: 0,
          elapsedMs: 1_000,
          inputTokens: 100,
          outputTokens: 10,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
        completedAt: 1_000,
      },
    });

    expect(exported.content).toContain(
      'Host-owned final verification replaces the provisional assistant result for this pipeline turn.',
    );
    expect(exported.content).not.toContain('authoring complete; host verification pending');
    expect(exported.content).not.toContain('Do you want the host to verify?');
    expect(exported.content).toContain('What happened after verification?');
    expect(exported.content).toContain('This later answer must remain in the export.');
    expect(exported.content.indexOf('Pipeline Verification:')).toBeLessThan(
      exported.content.indexOf('What happened after verification?'),
    );
    expect(exported.content).toContain(
      'Planning rejection (1x): coverage[0].status must be a non-empty string.',
    );
    expect(exported.content).toContain('Planning rejection (2x): Authorization: Bearer [REDACTED]');
    expect(exported.content).toContain('[chat-export truncated');
    expect(exported.content).not.toContain('super-secret-token');
  });

  test('appends host verification when visible assistants belong to another session', () => {
    const provisionalText = 'A result from a different session must remain visible.';
    const foreignPart = {
      ...textPart('foreign-assistant-text', provisionalText),
      sessionID: 'other-session',
    } as Part;
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Session-bound verification',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry(
          'assistant',
          'foreign-assistant',
          [foreignPart],
          { created: 800, completed: 900 },
          'other-session',
        ),
      ],
      pipelineVerification: hostVerification('verification-session'),
    });

    expect(exported.content).toContain(provisionalText);
    expect(exported.content).not.toContain(
      'Host-owned final verification replaces the provisional assistant result',
    );
    expect(exported.content.indexOf(provisionalText)).toBeLessThan(
      exported.content.indexOf('Pipeline Verification:'),
    );
  });

  test('appends host verification when the same-session assistant has no timestamp', () => {
    const provisionalText = 'An undated provisional result must remain visible.';
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Timestamp-bound verification',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('assistant', 'undated-assistant', [textPart('undated-text', provisionalText)]),
      ],
      pipelineVerification: hostVerification(),
    });

    expect(exported.content).toContain(provisionalText);
    expect(exported.content).not.toContain(
      'Host-owned final verification replaces the provisional assistant result',
    );
    expect(exported.content.indexOf(provisionalText)).toBeLessThan(
      exported.content.indexOf('Pipeline Verification:'),
    );
  });

  test('appends host verification when an undated visible user follows the candidate assistant', () => {
    const provisionalText = 'The earlier assistant result must not be deleted.';
    const interveningUserText = 'This undated user turn starts a new exchange.';
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Turn-bound verification',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('assistant', 'dated-assistant', [textPart('dated-text', provisionalText)], {
          created: 800,
          completed: 900,
        }),
        entry('user', 'undated-user', [textPart('undated-user-text', interveningUserText)]),
      ],
      pipelineVerification: hostVerification(),
    });

    expect(exported.content).toContain(provisionalText);
    expect(exported.content).toContain(interveningUserText);
    expect(exported.content).not.toContain(
      'Host-owned final verification replaces the provisional assistant result',
    );
    expect(exported.content.indexOf(provisionalText)).toBeLessThan(
      exported.content.indexOf(interveningUserText),
    );
    expect(exported.content.indexOf(interveningUserText)).toBeLessThan(
      exported.content.indexOf('Pipeline Verification:'),
    );
  });

  test('redacts diagnostic credential forms from planning rejection evidence', () => {
    const githubPat = 'github_pat_1234567890abcdefghijklmnopqrstuvwxyz';
    const awsAccessKey = ['AK', 'IA1234567890ABCDEF'].join('');
    const basicCredential = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
    const clientSecret = 'client_secret=export-secret-value';
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Redacted planning diagnostics',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [],
      pipelineVerification: {
        ...hostVerification(),
        status: 'failed',
        trial: {
          version: 10,
          success: false,
          kind: 'plan-failed',
          ran: false,
          runId: null,
          summary: 'Trial plan validation failed.',
          durationMs: 10,
          totalTaskCount: 0,
          omittedTaskCount: 0,
          tasks: [],
          cases: [],
          planTelemetry: {
            version: 2,
            yamlHash: 'a'.repeat(40),
            relativeYamlPath: 'demo/demo.yaml',
            attemptIds: ['host-attempt-1'],
            toolAttemptCount: 1,
            validationRejectionCount: 1,
            repeatedValidationRejectionCount: 0,
            successfulWriteCount: 0,
            firstAttemptAt: 1,
            lastAttemptAt: 1,
            elapsedMs: 10,
            rejections: [
              {
                fingerprint: 'b'.repeat(64),
                count: 1,
                message: [githubPat, awsAccessKey, basicCredential, clientSecret].join(' '),
              },
            ],
          },
        },
      },
    });

    expect(exported.content).toContain('[REDACTED]');
    expect(exported.content).not.toContain(githubPat);
    expect(exported.content).not.toContain(awsAccessKey);
    expect(exported.content).not.toContain(basicCredential);
    expect(exported.content).not.toContain(clientSecret);
  });

  test('exports unavailable prerequisites as blocked rather than failed', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Prerequisite-aware verification',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [],
      pipelineVerification: {
        kind: 'refresh-current',
        path: 'D:/repo/.tagma/facts/facts.yaml',
        name: 'facts.yaml',
        pipelineName: 'Fact Checker',
        sessionId: 's1',
        status: 'blocked',
        compile: {
          success: true,
          summary: 'Compile passed.',
          validation: { errors: [], warnings: [] },
        },
        trial: {
          version: 8,
          success: false,
          kind: 'blocked',
          ran: false,
          runId: null,
          summary: 'Trial run requirements are unavailable: environment=FACT_API_KEY.',
          durationMs: 10,
          totalTaskCount: 0,
          omittedTaskCount: 0,
          tasks: [],
          cases: [],
          repairAuthorization: 'diagnostic-only',
          prerequisiteState: {
            state: 'blocked',
            blockers: [{ kind: 'environment', name: 'FACT_API_KEY' }],
          },
        },
        repairAttempts: 0,
        reconcile: {
          outcome: 'adopted',
          conflicts: [],
          localBranchPersisted: false,
          resultPath: 'D:/repo/.tagma/facts/facts.yaml',
          compileSuccess: true,
          trialRunSuccess: false,
          trialVerification: 'prerequisite-unavailable',
        },
        completedAt: 1_000,
      },
    });

    expect(exported.content).toContain('Final status: blocked');
    expect(exported.content).toContain('Trial: blocked by prerequisites (blocked; not run)');
    expect(exported.content).toContain('Trial verified: blocked by prerequisites');
    expect(exported.content).not.toContain('Trial: failed (blocked; not run)');
    expect(exported.content).not.toContain('Trial verified: failed');
  });

  test('derives safe filenames for both export formats', () => {
    expect(conversationExportFilename('Feature / Q&A?', 'md')).toBe('tagma-chat-feature-q-a.md');
    expect(conversationExportFilename('', 'txt')).toBe('tagma-chat-conversation.txt');
  });
});
