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

  test('manifest accepts compatible @tagma/types minor releases', () => {
    expect(manifest.peerDependencies?.['@tagma/types']).toBe('>=0.4.18 <0.5.0');
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

  test('rejects api_key_env over non-loopback http endpoints', async () => {
    const envName = `TAGMA_TEST_JUDGE_KEY_${Date.now()}`;
    process.env[envName] = 'secret-value';
    try {
      await expect(
        LlmJudgeCompletion.check(
          {
            rubric: 'must pass',
            endpoint: 'http://example.com/v1/chat/completions',
            api_key_env: envName,
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
      ).rejects.toThrow(/requires https for non-loopback endpoint/);
    } finally {
      delete process.env[envName];
    }
  });

  test('rejects malformed timeout before calling the judge endpoint', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch should not run with malformed timeout');
    }) as typeof fetch;

    try {
      await expect(
        LlmJudgeCompletion.check(
          {
            rubric: 'must pass',
            endpoint: 'http://localhost:11434/v1/chat/completions',
            timeout: 'soon',
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
      ).rejects.toThrow(/Invalid duration format/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
