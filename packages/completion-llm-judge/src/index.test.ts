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

  test('rejects non-http judge endpoints before fetch', async () => {
    await expect(
      LlmJudgeCompletion.check(
        {
          rubric: 'must pass',
          endpoint: 'file:///tmp/judge.sock',
        },
        {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
        },
        {
          workDir: '/tmp',
          runtime: {} as never,
        },
      ),
    ).rejects.toThrow(/endpoint protocol must be http or https/);
  });
});
