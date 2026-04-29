import { describe, expect, test } from 'bun:test';
import { isCommandTaskConfig, isPromptTaskConfig } from './index';

describe('task kind helpers', () => {
  test('classifies command tasks by command field presence', () => {
    expect(isCommandTaskConfig({ command: 'bun test' })).toBe(true);
    expect(isCommandTaskConfig({ command: { shell: 'bun test' } })).toBe(true);
    expect(isCommandTaskConfig({ command: { argv: ['bun', 'test'] } })).toBe(true);
  });

  test('classifies prompts only when command is absent', () => {
    expect(isPromptTaskConfig({ prompt: 'Summarize this' })).toBe(true);
    expect(isPromptTaskConfig({ prompt: 'Summarize this', command: 'echo nope' })).toBe(false);
  });
});
