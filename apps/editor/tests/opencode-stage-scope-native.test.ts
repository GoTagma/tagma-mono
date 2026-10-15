import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { tryAutoApproveChatOperationV2StagedPermission } from '../server/chat-operations/authoring-runtime';
import { stagePinnedOpencodePluginRuntime } from './helpers/opencode-native-plugin-fixture';

// Actual pinned native tools with a synthetic local model. No vendor credentials or acceptance claims.
if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('native author removes fresh staged files and empty directories through scoped edit grants', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tagma-native-stage-scope-')));
    const cleanup: Array<() => unknown | Promise<unknown>> = [
      () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ];
    try {
      const source = join(root, '.tagma');
      seedOpencodeArtifacts(source);
      const stage = join(source, '.chat-staging', 'scope-fixture');
      const cwd = join(stage, 'agent-workspace', '.tagma');
      mkdirSync(join(cwd, 'extra', 'nested'), { recursive: true });
      const target = join(cwd, 'target.yaml');
      writeFileSync(target, 'original target bytes\n');
      const paths = ['extra/nested/stray.txt', 'extra/nested', 'extra'];
      writeFileSync(join(cwd, paths[0]!), 'unintended new support file');
      mkdirSync(join(cwd, '.opencode', 'agents'), { recursive: true });
      expect(
        readFileSync(join(source, '.opencode', 'agents', 'tagma-pipeline.md'), 'utf8').length,
      ).toBeLessThan(22_000);
      cpSync(
        join(source, '.opencode', 'agents', 'tagma-pipeline.md'),
        join(cwd, '.opencode', 'agents', 'tagma-pipeline.md'),
      );
      const runtime = resolveOpencodeRuntimePaths(source);
      // Observe native-platform failures around the unchanged generated handler.
      // No permission, deletion or binding rule is changed by this test wrapper.
      const removalPath = join(runtime.managedToolsDir, 'tagma_stage_remove.ts');
      const removalSource = readFileSync(removalPath, 'utf8');
      expect(removalSource).toContain('export default tool({');
      writeFileSync(
        removalPath,
        removalSource.replace('export default tool({', 'const observedTool = tool({') +
          `
export default { ...observedTool, async execute(args, context) {
  try { return await observedTool.execute(args, context); }
  catch (error) {
    const root = realpathSync(context.directory);
    let facts = {};
    try {
      const metadataPath = join(dirname(dirname(root)), 'stage.json');
      const stat = lstatSync(metadataPath);
      const binding = JSON.parse(readFileSync(metadataPath, 'utf8')).sessionRelocation;
      facts = { metadataRegular:stat.isFile(), metadataSymlink:stat.isSymbolicLink(), metadataLinkCount:stat.nlink, sessionMatches:binding?.sessionId===context.sessionID, rootMatches:realpathSync(binding.targetDirectory)===root };
    } catch {}
    throw new Error('Synthetic scope observation: '+JSON.stringify({ message:error instanceof Error?error.message:'unknown', nativeBunVersion:Bun.version, agent:context.agent, privateRoot:basename(root)==='.tagma'&&basename(dirname(root))==='agent-workspace', ...facts }));
  }
}};
`,
      );
      const metadata = JSON.parse(
        readFileSync(resolve(import.meta.dirname, '../../electron/package.json'), 'utf8'),
      ) as { tagma: { bundledOpencodeVersion: string } };
      const version = metadata.tagma.bundledOpencodeVersion;
      const bundled =
        process.env.TAGMA_OPENCODE_BUNDLED_DIR ??
        resolve(
          import.meta.dirname,
          '../../electron/build/opencode',
          `${process.platform}-${process.arch}`,
        );
      expect(readFileSync(join(bundled, 'version.txt'), 'utf8').trim()).toBe(version);
      for (const directory of [runtime.configDir, join(cwd, '.opencode')])
        stagePinnedOpencodePluginRuntime(directory, version);
      let turns = 0;
      const toolNames = new Set<string>();
      const toolResponses = new Set<string>();
      const model = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as {
            tools?: Array<{ function: { name: string } }>;
            messages?: Array<{ role?: string; content?: unknown }>;
          };
          for (const message of body.messages ?? [])
            if (message.role === 'tool')
              toolResponses.add(JSON.stringify(message.content).slice(0, 1500));
          const names = body.tools?.map((item) => item.function.name) ?? [];
          names.forEach((name) => toolNames.add(name));
          const bounded = names.includes('tagma_stage_remove');
          const index = turns++;
          const call = bounded ? index < paths.length : index === 0;
          const delta = call
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `scope_${index}`,
                    type: 'function',
                    function: {
                      name: bounded ? 'tagma_stage_remove' : 'write',
                      arguments: JSON.stringify(
                        bounded
                          ? { path: paths[index] }
                          : { filePath: join(cwd, paths[0]!), content: '' },
                      ),
                    },
                  },
                ],
              }
            : { role: 'assistant', content: 'DONE' };
          const chunks =
            [delta, {}]
              .map(
                (value, i) =>
                  'data: ' +
                  JSON.stringify({
                    id: 'scope-protocol',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'glm-scope-fixture',
                    choices: [
                      {
                        index: 0,
                        delta: value,
                        finish_reason: i === 1 ? (call ? 'tool_calls' : 'stop') : null,
                      },
                    ],
                    ...(i === 1
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
          enabled_providers: ['scope'],
          provider: {
            scope: {
              npm: '@ai-sdk/openai-compatible',
              options: {
                baseURL: `http://127.0.0.1:${model.port}/v1`,
                apiKey: 'synthetic-local-only',
              },
              models: {
                'glm-scope-fixture': {
                  name: 'Local scope fixture',
                  limit: { context: 65536, output: 2048 },
                  tool_call: true,
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
        OPENCODE_CONFIG_DIR: runtime.configDir,
        OPENCODE_SERVER_PASSWORD: '',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      });
      const child = Bun.spawn(
        [
          join(bundled, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
          'serve',
          '--hostname',
          '127.0.0.1',
          '--port',
          '0',
        ],
        { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      );
      let log = '';
      async function drain(stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            log += new TextDecoder().decode(chunk.value);
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
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        base = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
        if (base) break;
        if (child.exitCode !== null)
          throw new Error('Native scope process exited before readiness.');
        await Bun.sleep(250);
      }
      if (!base) throw new Error('Native scope process not ready.');
      async function req(path: string, body?: unknown): Promise<unknown> {
        const response = await fetch(base + path, {
          signal: AbortSignal.timeout(300000),
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`Native scope HTTP ${response.status}`);
        return response.json();
      }
      const catalog = (await req(
        '/experimental/tool?provider=scope&model=glm-scope-fixture',
      )) as Array<{ id: string }>;
      expect(catalog.some((entry) => entry.id === 'apply_patch')).toBe(false);
      const session = (await req('/session', { title: 'Synthetic scoped cleanup' })) as {
        id: string;
      };
      writeFileSync(
        join(stage, 'stage.json'),
        JSON.stringify({
          id: 'scope-fixture',
          lifecycleOwner: 'chat-operation-v2',
          sessionRelocation: {
            version: 1,
            relocationId: 'local-fixture',
            stageId: 'scope-fixture',
            sessionId: session.id,
            sourceDirectory: source,
            targetDirectory: cwd,
            phase: 'staged',
            updatedAt: Date.now(),
          },
        }),
      );
      let settled = false;
      const grants: string[] = [];
      const message = req(`/session/${session.id}/message`, {
        agent: 'tagma-pipeline',
        model: { providerID: 'scope', modelID: 'glm-scope-fixture' },
        parts: [
          {
            type: 'text',
            text: 'Synthetic scope fixture: remove the unintended fresh support tree, preserve target.yaml, then stop.',
          },
        ],
      }).finally(() => {
        settled = true;
      });
      const seen = new Set<string>();
      try {
        while (!settled) {
          const permissions = (await req('/permission')) as Array<{
            id: string;
            sessionID: string;
            permission: string;
            patterns: string[];
            metadata?: Record<string, unknown>;
          }>;
          for (const permission of permissions) {
            if (permission.sessionID !== session.id || seen.has(permission.id)) continue;
            seen.add(permission.id);
            const approved = await tryAutoApproveChatOperationV2StagedPermission({
              workDir: cwd,
              agentRoot: cwd,
              permission: permission.permission,
              patterns: permission.patterns,
              metadata: permission.metadata,
              replyOnce: async () => {
                await req(`/permission/${permission.id}/reply`, { reply: 'once' });
                grants.push(permission.permission);
              },
            });
            if (!approved) {
              await req(`/permission/${permission.id}/reply`, { reply: 'reject' });
              throw new Error('Unexpected permission outside staged scope.');
            }
          }
          await Bun.sleep(20);
        }
        await message;
      } finally {
        if (!settled) {
          await req(`/session/${session.id}/abort`, {}).catch(() => {});
          await message.catch(() => {});
        }
      }
      expect(toolNames.has('bash')).toBe(false);
      const remainingPaths = paths.filter((path) => existsSync(join(cwd, path)));
      if (remainingPaths.length)
        throw new Error(
          'Synthetic native scope failure: ' +
            JSON.stringify({
              removalOffered: toolNames.has('tagma_stage_remove'),
              remainingPaths,
              grants,
              toolResponses: [...toolResponses].slice(-4),
            }),
        );
      for (const path of paths) expect(existsSync(join(cwd, path))).toBe(false);
      expect(grants.length).toBe(3);
      expect(grants.every((grant) => grant === 'edit')).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('original target bytes\n');
    } finally {
      for (const dispose of cleanup.reverse()) await dispose();
    }
  }, 360000);
}
