import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { OpenCodeAdapterSdkClient } from '../server/chat-operations/opencode-adapter';
import { createOpenCodeTrialSemanticReviewRuntime } from '../server/opencode-trial-semantic-review';
import { evaluateTrialSemanticReview } from '../server/chat-trial-semantic-review';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { stagePinnedOpencodePluginFixture } from './helpers/opencode-native-plugin-fixture';

// Actual pinned native process and SDK, synthetic loopback provider only; no live acceptance claim.
if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('native content reviewer has no tools or inherited history and preserves the frozen variant', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tagma-native-content-review-')));
    const cleanup: Array<() => unknown | Promise<unknown>> = [
      () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ];
    try {
      const source = join(root, '.tagma');
      mkdirSync(join(source, 'flow'), { recursive: true });
      seedOpencodeArtifacts(source);
      const version = (
        JSON.parse(
          readFileSync(resolve(import.meta.dirname, '../../electron/package.json'), 'utf8'),
        ) as { tagma: { bundledOpencodeVersion: string } }
      ).tagma.bundledOpencodeVersion;
      stagePinnedOpencodePluginFixture(source, version);
      const requests: Array<{
        model?: string;
        tools?: unknown[];
        messages?: Array<{ role?: string; content?: unknown }>;
        thinking?: unknown;
        reasoning_effort?: unknown;
      }> = [];
      const provider = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as (typeof requests)[number];
          requests.push(body);
          const marker = JSON.stringify(body.messages).includes('Provisional observation ONE')
            ? 'ONE'
            : 'TWO';
          const text = JSON.stringify({
            version: 1,
            reviews: [
              {
                taskId: 'flow.inspect',
                path: 'flow/report.md',
                verdict: 'pass',
                reason: 'The actual supplied report is the requested provisional explanation.',
                evidence: [{ path: 'flow/report.md', quote: `Provisional observation ${marker}` }],
              },
            ],
          });
          return new Response(
            [
              'data: ' +
                JSON.stringify({
                  id: 'synthetic-review',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'deepseek-v4-pro',
                  choices: [
                    { index: 0, delta: { role: 'assistant', content: text }, finish_reason: null },
                  ],
                }),
              'data: ' +
                JSON.stringify({
                  id: 'synthetic-review',
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'deepseek-v4-pro',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
                }),
              'data: [DONE]',
              '',
            ].join('\n\n'),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      cleanup.push(() => provider.stop(true));
      writeFileSync(
        join(source, 'opencode.json'),
        JSON.stringify({
          enabled_providers: ['review-fixture'],
          provider: {
            'review-fixture': {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                apiKey: 'synthetic-local-only',
              },
              models: {
                'deepseek-v4-pro': {
                  name: 'Local independent review fixture',
                  limit: { context: 131072, output: 4096 },
                  reasoning: true,
                  tool_call: true,
                  variants: { off: { thinking: { type: 'disabled' }, reasoningEffort: 'none' } },
                },
              },
            },
          },
        }),
      );
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
      ])
        if (process.env[key]) env[key] = process.env[key]!;
      Object.assign(env, {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_STATE_HOME: join(root, 'state'),
        OPENCODE_CONFIG_DIR: resolveOpencodeRuntimePaths(source).configDir,
        OPENCODE_SERVER_PASSWORD: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      });
      const bundled =
        process.env.TAGMA_OPENCODE_BUNDLED_DIR ??
        resolve(
          import.meta.dirname,
          '../../electron/build/opencode',
          `${process.platform}-${process.arch}`,
        );
      expect(readFileSync(join(bundled, 'version.txt'), 'utf8').trim()).toBe(version);
      const child = Bun.spawn(
        [
          join(bundled, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
        ],
        { cwd: source, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      let log = '';
      const drain = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const value = await reader.read();
            if (value.done) break;
            log += new TextDecoder().decode(value.value);
          }
        } finally {
          reader.releaseLock();
        }
      };
      const readers = [drain(child.stdout), drain(child.stderr)];
      cleanup.push(async () => {
        child.kill();
        await Promise.race([child.exited, Bun.sleep(3000)]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await Promise.race([Promise.allSettled(readers), Bun.sleep(2000)]);
      });
      let base = '';
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        base = log.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0] ?? '';
        if (base) break;
        if (child.exitCode !== null)
          throw new Error('Synthetic native reviewer process exited before readiness.');
        await Bun.sleep(250);
      }
      if (!base) throw new Error('Synthetic native reviewer process did not become ready.');
      const httpPhases: Array<{
        path: string;
        method: string;
        elapsedMs: number | null;
        status: number | null;
        errorName?: string;
      }> = [];
      const nativeFetch = createStreamingLoopbackFetch(base);
      const tracedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), base);
        const phase = {
          path: url.pathname.replace(/ses_[A-Za-z0-9_-]+/gu, ':session'),
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          elapsedMs: null as number | null,
          status: null as number | null,
          errorName: undefined as string | undefined,
        };
        const started = Date.now();
        if (httpPhases.length < 64) httpPhases.push(phase);
        try {
          const response = await nativeFetch(input, init);
          phase.status = response.status;
          return response;
        } catch (error) {
          phase.errorName = error instanceof Error ? error.name : 'UnknownError';
          throw error;
        } finally {
          phase.elapsedMs = Date.now() - started;
        }
      }) as typeof fetch;
      tracedFetch.preconnect = nativeFetch.preconnect.bind(nativeFetch);
      // A serve banner precedes lazy native workspace/plugin initialization. Prove
      // actual metadata readiness before starting the unchanged90s evaluator clock.
      // These GETs never create a session or make a provider call.
      const readinessDeadline = deadline;
      try {
        for (const endpoint of [
          '/global/health',
          '/session?limit=1&directory=' + encodeURIComponent(source),
          '/experimental/tool/ids?directory=' + encodeURIComponent(source),
        ]) {
          const response = await tracedFetch(base + endpoint, {
            signal: AbortSignal.timeout(Math.max(1, readinessDeadline - Date.now())),
          });
          expect(response.status).toBe(200);
          const payload: unknown = await response.json();
          if (endpoint.startsWith('/experimental/tool/ids'))
            expect(payload).toContain('tagma_trial_plan');
        }
        expect(requests).toHaveLength(0);
      } catch (error) {
        console.error(JSON.stringify({ nativeReadinessPhases: httpPhases }));
        throw error;
      }
      const runtime = createOpenCodeTrialSemanticReviewRuntime({
        sourceDirectory: source,
        model: { providerID: 'review-fixture', modelID: 'deepseek-v4-pro', variant: 'off' },
        resolveClient: async () =>
          createOpencodeClient({
            baseUrl: base,
            directory: source,
            throwOnError: false,
            fetch: tracedFetch,
          }) as unknown as OpenCodeAdapterSdkClient,
      });
      const intent = 'Produce a provisional explanation from the supplied observation.';
      const yaml = 'pipeline:\n  name: Synthetic review transport\n';
      const sessions: string[] = [];
      for (const [index, marker] of ['ONE', 'TWO'].entries()) {
        writeFileSync(
          join(source, 'flow', 'report.md'),
          `Provisional observation ${marker}; the measurement remains uncertain.`,
        );
        const result = await evaluateTrialSemanticReview({
          identity: {
            stageId: 'native_fixture',
            trialId: 'native_review',
            yamlHash: createHash('sha1').update(yaml).digest('hex'),
            planHash: 'a'.repeat(64),
            intentDigest: createHash('sha256').update(intent).digest('hex'),
            caseId: 'normal',
            runId: `native_run_${index}`,
            runNumber: index + 1,
          },
          intentText: intent,
          yamlText: yaml,
          targets: [{ taskId: 'flow.inspect', path: 'flow/report.md' }],
          referencePaths: [],
          runSucceeded: true,
          taskStatuses: { 'flow.inspect': 'success' },
          workDir: root,
          relativeYamlPath: 'flow/flow.yaml',
          runtime,
          signal: AbortSignal.timeout(120000),
          secretValues: [],
        });
        if (!result.success) {
          console.error(JSON.stringify({ nativeHttpPhases: httpPhases }));
          console.error(
            JSON.stringify(
              requests.map((body) => ({
                model: body.model,
                toolCount: body.tools?.length ?? 0,
                one: JSON.stringify(body.messages).includes('Provisional observation ONE'),
                two: JSON.stringify(body.messages).includes('Provisional observation TWO'),
                roles: body.messages?.map((message) => message.role),
              })),
            ),
          );
        }
        expect(result.detail).toBe('Independent model content review passed.');
        expect(result.success).toBe(true);
        sessions.push(result.receipt!.reviewerSessionId!);
      }
      expect(new Set(sessions).size).toBe(2);
      expect(requests).toHaveLength(2);
      for (const body of requests) {
        expect(body.tools?.length ?? 0).toBe(0);
        expect(body.model).toBe('deepseek-v4-pro');
        expect(body.thinking).toEqual({ type: 'disabled' });
        expect(body.reasoning_effort).toBe('none');
      }
      expect(JSON.stringify(requests[1]!.messages)).not.toContain('Provisional observation ONE');
      expect(JSON.stringify(requests[1]!.messages)).toContain('Provisional observation TWO');
    } finally {
      for (const action of cleanup.reverse()) await action();
    }
  }, 360000);
}
