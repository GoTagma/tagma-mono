import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';
import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  readChatPipelineTrialPlanToolTelemetry,
} from '../server/chat-pipeline-trial-plan';
import { stagePinnedOpencodePluginRuntime } from './helpers/opencode-native-plugin-fixture';
import { TRIAL_EVIDENCE_KINDS } from '../server/chat-trial-resilience-rules';

type ModelRequest = {
  messages?: Array<{ role?: string }>;
  tools?: Array<{
    function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
  }>;
};
type CatalogEntry = { id: string; parameters: unknown };

// Synthetic localhost protocol coverage, never a provider/Chat acceptance run.
if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  for (const blockedArtifact of [false, true])
    test(
      blockedArtifact
        ? 'native Trial commits blocked artifact feedback without passing execution'
        : 'native Trial schema keeps typed hints and counted malformed commit transport',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'tagma-native-trial-contract-'));
        const cleanup: Array<() => unknown | Promise<unknown>> = [
          () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
        ];
        try {
          const stage = join(root, '.tagma', '.chat-staging', 'protocol');
          const cwd = join(stage, 'agent-workspace', '.tagma');
          const yamlPath = join(cwd, 'flow', 'flow.yaml');
          mkdirSync(dirname(yamlPath), { recursive: true });
          const yaml =
            'pipeline:\n  name: Protocol\n  tracks:\n    - id: main\n      tasks:\n        - id: run\n          command: echo unit\n';
          writeFileSync(yamlPath, yaml);
          const attempt = 'native-counted-malformed';
          writeFileSync(
            join(stage, 'stage.json'),
            JSON.stringify({
              trialPlanMaxAttempts: 2,
              trialPlanAttempt: {
                attemptId: attempt,
                relativePath: 'flow/flow.yaml',
                yamlHash: createHash('sha1').update(yaml).digest('hex'),
              },
            }),
          );
          const metadata = JSON.parse(
            readFileSync(resolve(import.meta.dirname, '../../electron/package.json'), 'utf8'),
          ) as {
            tagma?: { bundledOpencodeVersion?: string };
          };
          const version = metadata.tagma?.bundledOpencodeVersion;
          if (!version) throw new Error('Missing pinned OpenCode version.');
          const bundled =
            process.env.TAGMA_OPENCODE_BUNDLED_DIR ??
            resolve(
              import.meta.dirname,
              '../../electron/build/opencode',
              `${process.platform}-${process.arch}`,
            );
          expect(readFileSync(join(bundled, 'version.txt'), 'utf8').trim()).toBe(version);
          for (const directory of [join(root, 'config'), join(cwd, '.opencode')]) {
            stagePinnedOpencodePluginRuntime(directory, version);
          }
          const toolsDir = join(cwd, '.opencode', 'tools');
          mkdirSync(toolsDir, { recursive: true });
          writeFileSync(join(toolsDir, 'tagma_trial_plan.ts'), buildTagmaTrialPlanTool());
          const observedGoals: unknown[] = [];
          const invalid = blockedArtifact
            ? {
                operation: 'commit-plan',
                pipeline_path: yamlPath,
                attempt_id: attempt,
                summary: 'Synthetic blocked artifact feedback',
                goals: ['Expose the requested business result'],
                coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
                  dimension,
                  status: 'accepted-risk',
                  caseIds: [],
                  rationale: 'Focused pre-execution repair contract.',
                })),
                findings: [
                  {
                    severity: 'blocking',
                    repairScope: 'pipeline-artifact',
                    summary: 'Missing result artifact',
                    evidence:
                      'The authored command only echoes a marker instead of the requested result.',
                  },
                ],
                evidence_review: {
                  version: 1,
                  intentDigest: 'a'.repeat(64),
                  decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
                    type,
                    required: false,
                    taskIds: [],
                    rationale: 'Focused blocked-core fixture.',
                  })),
                  coreWitness: {
                    status: 'blocked',
                    taskIds: ['main.run'],
                    code: 'missing_observable_result',
                    rationale: 'A permitted artifact repair can expose the requested result.',
                  },
                },
                cases: [
                  {
                    id: 'normal',
                    title: 'Normal',
                    objective: 'Produce the requested result',
                    targetTaskIds: ['main.run'],
                    fixtures: [],
                    expectations: [{ type: 'task-status', taskId: 'main.run', status: 'success' }],
                  },
                ],
              }
            : {
                operation: 'commit-plan',
                pipeline_path: yamlPath,
                attempt_id: attempt,
                summary: 'Synthetic malformed business payload',
                goals: '["one"]',
                coverage: [],
                cases: [],
              };
          const model = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            async fetch(request) {
              const body = (await request.json()) as ModelRequest;
              observedGoals.push(
                body.tools?.find((tool) => tool.function?.name === 'tagma_trial_plan')?.function
                  ?.parameters?.properties?.goals,
              );
              const first = !body.messages?.some((message) => message.role === 'tool');
              const deltas = first
                ? [
                    {
                      role: 'assistant',
                      tool_calls: [invalid, invalid, { ...invalid, attempt_id: 17 }].map(
                        (args, index) => ({
                          index,
                          id: `call_${index}`,
                          type: 'function',
                          function: { name: 'tagma_trial_plan', arguments: JSON.stringify(args) },
                        }),
                      ),
                    },
                    {},
                  ]
                : [{ role: 'assistant', content: 'DONE' }, {}];
              const chunks =
                deltas
                  .map(
                    (delta, index) =>
                      'data: ' +
                      JSON.stringify({
                        id: 'unit-protocol',
                        object: 'chat.completion.chunk',
                        created: 1,
                        model: 'probe',
                        choices: [
                          {
                            index: 0,
                            delta,
                            finish_reason:
                              index === deltas.length - 1 ? (first ? 'tool_calls' : 'stop') : null,
                          },
                        ],
                        ...(index === deltas.length - 1
                          ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
                          : {}),
                      }) +
                      '\n\n',
                  )
                  .join('') + 'data: [DONE]\n\n';
              return new Response(chunks, { headers: { 'Content-Type': 'text/event-stream' } });
            },
          });
          cleanup.push(() => model.stop(true));
          writeFileSync(
            join(cwd, 'opencode.json'),
            JSON.stringify({
              enabled_providers: ['probe'],
              provider: {
                probe: {
                  npm: '@ai-sdk/openai-compatible',
                  options: {
                    baseURL: `http://127.0.0.1:${model.port}/v1`,
                    apiKey: 'unit-only-not-a-real-secret',
                  },
                  models: {
                    probe: {
                      name: 'Synthetic protocol only',
                      limit: { context: 65536, output: 2048 },
                      tool_call: true,
                    },
                  },
                },
              },
              agent: {
                'protocol-probe': {
                  mode: 'primary',
                  steps: 4,
                  permission: { '*': 'deny', tagma_trial_plan: 'allow' },
                },
              },
            }),
          );
          // Deliberately omit every provider credential and all global profile paths.
          const env: Record<string, string> = {};
          for (const key of [
            'PATH',
            'HTTP_PROXY',
            'HTTPS_PROXY',
            'http_proxy',
            'https_proxy',
            'SSL_CERT_FILE',
            'SSL_CERT_DIR',
            'NODE_EXTRA_CA_CERTS',
          ]) {
            if (process.env[key]) env[key] = process.env[key]!;
          }
          Object.assign(env, {
            XDG_CONFIG_HOME: join(root, 'xdg-config'),
            XDG_DATA_HOME: join(root, 'xdg-data'),
            XDG_CACHE_HOME: join(root, 'xdg-cache'),
            XDG_STATE_HOME: join(root, 'xdg-state'),
            OPENCODE_CONFIG_DIR: join(root, 'config'),
            OPENCODE_SERVER_PASSWORD: '',
            NO_PROXY: '127.0.0.1,localhost',
            no_proxy: '127.0.0.1,localhost',
          });
          const binary = join(
            bundled,
            'bin',
            process.platform === 'win32' ? 'opencode.exe' : 'opencode',
          );
          const child = Bun.spawn([binary, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
            cwd,
            env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          });
          let processLog = '';
          async function drain(stream: ReadableStream<Uint8Array>) {
            const reader = stream.getReader();
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                processLog += new TextDecoder().decode(chunk.value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          const readers = [drain(child.stdout), drain(child.stderr)];
          cleanup.push(async () => {
            child.kill();
            await Promise.race([child.exited, Bun.sleep(3000)]);
            if (child.exitCode === null) child.kill('SIGKILL');
            await Promise.race([Promise.allSettled(readers), Bun.sleep(2000)]);
          });
          let base = '';
          for (let attemptIndex = 0; attemptIndex < 600; attemptIndex++) {
            base = processLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
            if (base) break;
            if (child.exitCode !== null)
              throw new Error('Native protocol process exited before readiness.');
            await Bun.sleep(500);
          }
          if (!base) throw new Error('Native protocol process did not become ready.');
          async function req(path: string, body?: unknown): Promise<unknown> {
            const response = await fetch(base + path, {
              signal: AbortSignal.timeout(300000),
              headers: { 'Content-Type': 'application/json' },
              ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
            });
            if (!response.ok) throw new Error(`Native protocol HTTP ${response.status}.`);
            return response.json();
          }
          const catalog = (await req(
            '/experimental/tool?provider=probe&model=probe',
          )) as CatalogEntry[];
          expect(
            catalog.find((entry) => entry.id === 'tagma_trial_plan')?.parameters,
          ).toMatchObject({
            properties: {
              goals: {
                type: 'array',
                minItems: 1,
                maxItems: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.goals,
                items: { type: 'string' },
              },
            },
          });
          const session = (await req('/session', {
            title: 'Synthetic native protocol, not acceptance',
          })) as { id: string };
          await req(`/session/${session.id}/message`, {
            agent: 'protocol-probe',
            model: { providerID: 'probe', modelID: 'probe' },
            parts: [{ type: 'text', text: 'Run the protocol fixture once, then DONE.' }],
          });
          expect(observedGoals.length).toBeGreaterThanOrEqual(2);
          for (const schema of observedGoals) {
            expect(schema).toMatchObject({
              type: 'array',
              minItems: 1,
              maxItems: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.goals,
            });
            expect(schema).not.toHaveProperty('anyOf');
          }
          const telemetry = readChatPipelineTrialPlanToolTelemetry(yamlPath, 2);
          expect(telemetry).toMatchObject({
            toolAttemptCount: 1,
            validationRejectionCount: blockedArtifact ? 0 : 1,
            successfulWriteCount: blockedArtifact ? 1 : 0,
          });
          if (blockedArtifact) {
            const plan = JSON.parse(
              readFileSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8'),
            );
            expect(plan.evidenceReview.coreWitness.status).toBe('blocked');
            expect(plan.findings[0]).toMatchObject({
              severity: 'blocking',
              repairScope: 'pipeline-artifact',
            });
          } else expect(telemetry.rejections[0]?.message).toContain('received string');
        } finally {
          for (const dispose of cleanup.reverse()) await dispose();
        }
      },
      360000,
    );
}
