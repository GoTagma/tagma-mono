import { describe, expect, test } from 'bun:test';
import plugin, { LlmJudgeCompletion } from './index';
import manifest from '../package.json' with { type: 'json' };

describe('completion-llm-judge plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('completions');
    expect(manifest.tagmaPlugin.type).toBe('llm_judge');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.completions?.[manifest.tagmaPlugin.type]).toBe(LlmJudgeCompletion);
  });

  test('check is a function', () => {
    expect(typeof plugin.capabilities!.completions!.llm_judge.check).toBe('function');
  });
});
