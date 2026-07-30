import { describe, expect, test } from 'bun:test';
import { buildConversationExport, conversationExportFilename } from '../src/utils/chat-export';
import type { OpencodeThreadEntry, Part } from '../src/api/opencode-chat';

const textPart = (id: string, text: string, synthetic = false): Part =>
  ({
    id,
    sessionID: 's1',
    messageID: `m-${id}`,
    type: 'text',
    text,
    ...(synthetic ? { synthetic } : {}),
  }) as Part;

const entry = (role: 'user' | 'assistant', id: string, parts: Part[]): OpencodeThreadEntry =>
  ({
    info: { id, sessionID: 's1', role },
    parts,
  }) as OpencodeThreadEntry;

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

  test('exports assistant messages that only have footer information', () => {
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

    expect(exported.content).toContain('Assistant:\nUsage: $0.012');
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
          version: 2,
          success: false,
          kind: 'witness-failed',
          ran: false,
          runId: null,
          summary: 'Witness failed with Authorization: Bearer trial-secret',
          durationMs: 25,
          totalTaskCount: 1,
          omittedTaskCount: 0,
          tasks: [],
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
              tasks: [],
              expectations: [
                {
                  type: 'case-execution',
                  passed: false,
                  detail: 'Not executed because secret=case-secret',
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
    expect(exported.content).toContain('### Trial Plan');
    expect(exported.content).toContain('`basic-run` — Basic run');
    expect(exported.content).toContain('### Trial Case Results');
    expect(exported.content).toContain('case-execution: failed');
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
          version: 6,
          success: true,
          kind: 'passed-with-warnings',
          ran: true,
          runId: 'run_warning',
          summary: 'Accepted risk concurrent-run-output-collision.',
          durationMs: 10,
          totalTaskCount: 1,
          omittedTaskCount: 0,
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
  });

  test('derives safe filenames for both export formats', () => {
    expect(conversationExportFilename('Feature / Q&A?', 'md')).toBe('tagma-chat-feature-q-a.md');
    expect(conversationExportFilename('', 'txt')).toBe('tagma-chat-conversation.txt');
  });
});
