import { describe, expect, test } from 'bun:test';
import plugin from './index';
import manifest from '../package.json' with { type: 'json' };

describe('completion-llm-judge plugin shape', () => {
  test('manifest declares completions/llm_judge and matches plugin.name', () => {
    expect(manifest.tagmaPlugin.category).toBe('completions');
    expect(manifest.tagmaPlugin.type).toBe('llm_judge');
    expect(plugin.name).toBe(manifest.tagmaPlugin.type);
  });

  test('exposes check function', () => {
    expect(typeof plugin.check).toBe('function');
  });
});
