import { describe, expect, test } from 'bun:test';
import plugin, { LightRAGMiddleware } from './index';
import manifest from '../package.json' with { type: 'json' };

describe('middleware-lightrag plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('middlewares');
    expect(manifest.tagmaPlugin.type).toBe('lightrag');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.middlewares?.[manifest.tagmaPlugin.type]).toBe(LightRAGMiddleware);
  });

  test('enhanceDoc is a function', () => {
    expect(typeof plugin.capabilities!.middlewares!.lightrag.enhanceDoc).toBe('function');
  });

  test('manifest accepts compatible @tagma/types minor releases', () => {
    expect(manifest.peerDependencies?.['@tagma/types']).toBe('>=0.4.18 <0.5.0');
  });

  test('required retrieval fails when LightRAG returns empty context', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ response: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      await expect(
        LightRAGMiddleware.enhanceDoc(
          { contexts: [], task: 'explain tagma' },
          { endpoint: 'http://localhost:9621', required: true },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).rejects.toThrow(/query returned empty context/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('on_error skip leaves the prompt unchanged after retrieval failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    try {
      const doc = { contexts: [], task: 'explain tagma' };
      await expect(
        LightRAGMiddleware.enhanceDoc(
          doc,
          { endpoint: 'http://localhost:9621', on_error: 'skip' },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).resolves.toBe(doc);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects api_key_env over non-loopback http endpoints', async () => {
    const envName = `TAGMA_TEST_LIGHTRAG_KEY_${Date.now()}`;
    process.env[envName] = 'secret-value';
    try {
      await expect(
        LightRAGMiddleware.enhanceDoc(
          { contexts: [], task: 'explain tagma' },
          { endpoint: 'http://example.com:9621', api_key_env: envName },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).rejects.toThrow(/requires https for non-loopback endpoint/);
    } finally {
      delete process.env[envName];
    }
  });

  test('fails when api_key_env is configured but the env var is missing', async () => {
    const envName = `TAGMA_TEST_LIGHTRAG_MISSING_${Date.now()}`;
    const originalFetch = globalThis.fetch;
    delete process.env[envName];
    globalThis.fetch = (async () => {
      throw new Error('fetch should not run without the configured API key');
    }) as typeof fetch;

    try {
      await expect(
        LightRAGMiddleware.enhanceDoc(
          { contexts: [], task: 'explain tagma' },
          { endpoint: 'https://example.com:9621', api_key_env: envName, on_error: 'skip' },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).rejects.toThrow(new RegExp(envName));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('timeout 0 disables the LightRAG request timer', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 10);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
      });
      return new Response(JSON.stringify({ response: 'retrieved context' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await expect(
        LightRAGMiddleware.enhanceDoc(
          { contexts: [], task: 'explain tagma' },
          { endpoint: 'http://localhost:9621', required: true, timeout: 0 },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).resolves.toEqual({
        contexts: [{ label: 'Knowledge Graph Context', content: 'retrieved context' }],
        task: 'explain tagma',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects malformed timeout before querying LightRAG', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch should not run with malformed timeout');
    }) as typeof fetch;

    try {
      await expect(
        LightRAGMiddleware.enhanceDoc(
          { contexts: [], task: 'explain tagma' },
          { endpoint: 'http://localhost:9621', on_error: 'fail', timeout: 'soon' },
          { task: {} as never, track: {} as never, workDir: process.cwd() },
        ),
      ).rejects.toThrow(/Invalid duration format/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('links LightRAG fetch cancellation to the middleware signal', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    let rejectFetch: ((err: Error) => void) | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
        requestSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      });
    }) as typeof fetch;

    try {
      const pending = LightRAGMiddleware.enhanceDoc(
        { contexts: [], task: 'explain tagma' },
        { endpoint: 'http://localhost:9621', on_error: 'fail', timeout: '10m' },
        {
          task: {} as never,
          track: {} as never,
          workDir: process.cwd(),
          signal: controller.signal,
        },
      );
      await Promise.resolve();
      controller.abort('stop');

      expect(requestSignal?.aborted).toBe(true);
      rejectFetch?.(new Error('manual fetch stop'));
      await expect(pending).rejects.toThrow(/retrieval failed|abort/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
