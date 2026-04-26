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
});
