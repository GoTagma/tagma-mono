import { afterEach, describe, expect, test } from 'bun:test';
import { api } from '../src/api/client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('plugin API client', () => {
  test('installPlugin includes a marketplace version pin when provided', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          plugin: {
            name: '@scope/plugin-under-test',
            installed: true,
            loaded: true,
            version: '1.2.3',
            categories: ['drivers'],
          },
          registry: {
            drivers: [],
            triggers: [],
            completions: [],
            middlewares: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await api.installPlugin('@scope/plugin-under-test', '1.2.3');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/plugins/install');
    expect(requests[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      name: '@scope/plugin-under-test',
      version: '1.2.3',
    });
  });

  test('installPlugin omits version for local latest-resolution installs', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          plugin: {
            name: '@scope/plugin-under-test',
            installed: true,
            loaded: true,
            version: '1.2.3',
            categories: ['drivers'],
          },
          registry: {
            drivers: [],
            triggers: [],
            completions: [],
            middlewares: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await api.installPlugin('@scope/plugin-under-test');

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      name: '@scope/plugin-under-test',
    });
  });
});
