import { describe, expect, test } from 'bun:test';
import plugin from './index';
import manifest from '../package.json' with { type: 'json' };

describe('middleware-lightrag plugin shape', () => {
  test('manifest declares middlewares/lightrag and matches plugin.name', () => {
    expect(manifest.tagmaPlugin.category).toBe('middlewares');
    expect(manifest.tagmaPlugin.type).toBe('lightrag');
    expect(plugin.name).toBe(manifest.tagmaPlugin.type);
  });

  test('exposes enhanceDoc or enhance function', () => {
    const anyPlugin = plugin as unknown as {
      enhanceDoc?: unknown;
      enhance?: unknown;
    };
    const hasEnhanceDoc = typeof anyPlugin.enhanceDoc === 'function';
    const hasEnhance = typeof anyPlugin.enhance === 'function';
    expect(hasEnhanceDoc || hasEnhance).toBe(true);
  });
});
