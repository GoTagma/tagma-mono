import { describe, expect, test } from 'bun:test';
import plugin from './index';
import manifest from '../package.json' with { type: 'json' };

describe('trigger-webhook plugin shape', () => {
  test('manifest declares triggers/webhook and matches plugin.name', () => {
    expect(manifest.tagmaPlugin.category).toBe('triggers');
    expect(manifest.tagmaPlugin.type).toBe('webhook');
    expect(plugin.name).toBe(manifest.tagmaPlugin.type);
  });

  test('exposes watch function', () => {
    expect(typeof plugin.watch).toBe('function');
  });
});
