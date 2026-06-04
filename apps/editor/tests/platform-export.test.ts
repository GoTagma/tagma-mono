import { describe, expect, test } from 'bun:test';

import {
  convertPipelineYamlForPlatform,
  createLoopbackFetch,
  extractPlatformYamlFromReply,
  normalizeTagmaPlatform,
  parsePlatformExportModelPick,
  platformExportFileName,
} from '../server/platform-export';

const validPipelineYaml = [
  'pipeline:',
  '  name: Demo',
  '  tracks:',
  '    - id: build',
  '      name: Build',
  '      tasks:',
  '        - id: say',
  '          name: Say',
  '          command: echo ok',
].join('\n');

describe('platform export helpers', () => {
  test('normalizes supported platform names only', () => {
    expect(normalizeTagmaPlatform('windows')).toBe('windows');
    expect(normalizeTagmaPlatform('linux')).toBe('linux');
    expect(normalizeTagmaPlatform('mac')).toBe('mac');
    expect(normalizeTagmaPlatform('darwin')).toBeNull();
  });

  test('adds target platform before YAML extension', () => {
    expect(platformExportFileName('pipeline.yaml', 'linux')).toBe('pipeline.linux.yaml');
    expect(platformExportFileName('pipeline.yml', 'mac')).toBe('pipeline.mac.yml');
    expect(platformExportFileName('pipeline', 'windows')).toBe('pipeline.windows.yaml');
  });

  test('extracts and canonicalizes fenced YAML from an OpenCode reply', () => {
    const yaml = extractPlatformYamlFromReply(
      [
        '```yaml',
        'pipeline:',
        '  name: Demo',
        '  tracks:',
        '    - id: build',
        '      name: Build',
        '      tasks:',
        '        - id: test',
        '          command: npm test',
        '```',
      ].join('\n'),
    );

    expect(yaml).toContain('pipeline:');
    expect(yaml).toContain('name: Demo');
    expect(yaml).toContain('command: npm test');
  });

  test('extracts YAML after brief prose', () => {
    const yaml = extractPlatformYamlFromReply(
      [
        'Here is the conversion:',
        '',
        'pipeline:',
        '  name: Demo',
        '  tracks:',
        '    - id: build',
        '      name: Build',
        '      tasks: []',
      ].join('\n'),
    );

    expect(yaml).toContain('pipeline:');
    expect(yaml).toContain('tasks: []');
  });

  test('throws when an OpenCode reply has no parseable YAML', () => {
    expect(() => extractPlatformYamlFromReply('I cannot convert this pipeline safely.')).toThrow(
      'OpenCode did not return a parseable Tagma YAML document.',
    );
  });

  test('parses only complete model picks', () => {
    expect(parsePlatformExportModelPick({ providerID: 'opencode', modelID: 'gpt-5.4' })).toEqual({
      providerID: 'opencode',
      modelID: 'gpt-5.4',
    });
    expect(parsePlatformExportModelPick({ providerID: 'opencode' })).toBeUndefined();
    expect(parsePlatformExportModelPick({ providerID: '', modelID: 'gpt-5.4' })).toBeUndefined();
    expect(parsePlatformExportModelPick(null)).toBeUndefined();
  });

  test('loopback fetch talks directly to local OpenCode-style servers', async () => {
    const prevProxy = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });

    try {
      const loopbackFetch = createLoopbackFetch(server.url.href);
      const res = await loopbackFetch(server.url.href);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      if (prevProxy === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = prevProxy;
      }
      server.stop(true);
    }
  });

  test('platform conversion creates the temporary session with v2 metadata', async () => {
    const sessionCreateBodies: unknown[] = [];
    const promptBodies: unknown[] = [];
    const deletedSessions: string[] = [];
    const model = { providerID: 'anthropic', modelID: 'claude' };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/config/providers' && req.method === 'GET') {
          return new Response(
            JSON.stringify({
              providers: [{ id: 'anthropic', models: { claude: {} } }],
              default: { anthropic: 'claude' },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.pathname === '/session' && req.method === 'POST') {
          sessionCreateBodies.push(await req.json());
          return new Response(JSON.stringify({ id: 'platform-session' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/session/platform-session/message' && req.method === 'POST') {
          promptBodies.push(await req.json());
          return new Response(
            JSON.stringify({ parts: [{ type: 'text', text: validPipelineYaml }] }),
            {
              headers: { 'content-type': 'application/json' },
            },
          );
        }
        if (url.pathname === '/session/platform-session' && req.method === 'DELETE') {
          deletedSessions.push('platform-session');
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(`unexpected ${req.method} ${url.pathname}`, { status: 404 });
      },
    });

    try {
      const converted = await convertPipelineYamlForPlatform({
        baseUrl: server.url.href,
        sourceYaml: validPipelineYaml,
        sourceName: 'pipeline.yaml',
        sourcePlatform: 'windows',
        targetPlatform: 'linux',
        model,
      });

      expect(converted).toContain('pipeline:');
      expect(sessionCreateBodies).toHaveLength(1);
      expect(sessionCreateBodies[0]).toMatchObject({
        metadata: {
          tagma: {
            source: 'platform-export',
            model,
            platformExport: {
              sourceName: 'pipeline.yaml',
              sourcePlatform: 'windows',
              targetPlatform: 'linux',
            },
          },
        },
      });
      expect(promptBodies).toHaveLength(1);
      expect(deletedSessions).toEqual(['platform-session']);
    } finally {
      server.stop(true);
    }
  });
});
