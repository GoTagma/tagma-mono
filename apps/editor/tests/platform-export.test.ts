import { describe, expect, test } from 'bun:test';

import {
  createLoopbackFetch,
  extractPlatformYamlFromReply,
  normalizeTagmaPlatform,
  parsePlatformExportModelPick,
  platformExportFileName,
} from '../server/platform-export';

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
});
