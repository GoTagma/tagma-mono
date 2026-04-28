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
});
