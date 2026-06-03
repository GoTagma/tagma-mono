import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchMarketplacePackage,
  marketplaceDownloadsCache,
  marketplaceManifestCache,
  marketplacePackageCache,
  marketplaceSearchCache,
  NPM_DOWNLOADS_URL,
} from '../server/plugins/marketplace';

const originalFetch = globalThis.fetch;

function clearMarketplaceCaches(): void {
  marketplaceDownloadsCache.clear();
  marketplaceManifestCache.clear();
  marketplacePackageCache.clear();
  marketplaceSearchCache.clear();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearMarketplaceCaches();
});

describe('plugin marketplace metadata', () => {
  test('filters packages whose latest dist-tag is not a strict installable semver', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: 'next' },
          versions: {
            next: {
              name: '@scope/plugin-under-test',
              version: 'next',
              tagmaPlugin: { category: 'drivers', type: 'test' },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(fetchMarketplacePackage('@scope/plugin-under-test')).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('filters packages whose latest manifest identity does not match the request', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.2.3' },
          versions: {
            '1.2.3': {
              name: '@scope/other-plugin',
              version: '1.2.3',
              tagmaPlugin: { category: 'drivers', type: 'test' },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(fetchMarketplacePackage('@scope/plugin-under-test')).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('filters packages whose latest manifest version does not match the latest key', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.2.3' },
          versions: {
            '1.2.3': {
              name: '@scope/plugin-under-test',
              version: '1.2.4',
              tagmaPlugin: { category: 'drivers', type: 'test' },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(fetchMarketplacePackage('@scope/plugin-under-test')).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('slash-escapes scoped package names when fetching weekly downloads', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith(NPM_DOWNLOADS_URL)) {
        return new Response(JSON.stringify({ downloads: 42 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: '1.2.3' },
          versions: {
            '1.2.3': {
              name: '@scope/plugin-under-test',
              version: '1.2.3',
              description: 'A plugin',
              keywords: ['tagma-plugin'],
              tagmaPlugin: { category: 'drivers', type: 'test' },
            },
          },
          time: { '1.2.3': '2026-06-03T00:00:00.000Z' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const detail = await fetchMarketplacePackage('@scope/plugin-under-test');

    expect(detail?.version).toBe('1.2.3');
    expect(detail?.weeklyDownloads).toBe(42);
    expect(requests).toContain(
      `${NPM_DOWNLOADS_URL}/${encodeURIComponent('@scope/plugin-under-test')}`,
    );
  });
});
