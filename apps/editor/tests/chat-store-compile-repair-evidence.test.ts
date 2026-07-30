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
