import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from './index';
import type { CompletionPlugin, TagmaRuntime, TaskResult } from './types';

function commandResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: '41',
    stderr: 'child warning',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 2,
    stderrBytes: 1_300,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand() {
      return commandResult();
    },
    async runSpawn() {
      throw new Error('runSpawn should not be called');
    },
    async ensureDir() {
      /* no-op */
    },
    async fileExists() {
      return false;
    },
    async *watch() {
      /* no-op */
    },
    logStore: {
      openRunLog({ runId }) {
        return {
          path: `mem://${runId}/pipeline.log`,
          dir: `mem://${runId}`,
          append() {
            /* memory sink */
          },
          close() {
            /* memory sink */
          },
        };
      },
      taskOutputPath({ runId, taskId, stream }) {
        return `mem://${runId}/${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
      async prune() {
        /* no-op */
      },
    },
    now: () => new Date('2026-07-17T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

describe('completion feedback', () => {
  test('classifies a structured failed check and appends its feedback to stderr', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-completion-feedback-'));
    const registry = new PluginRegistry();
    registry.registerPlugin('completions', 'judge', {
      name: 'judge',
      async check() {
        return { passed: false, feedback: 'Expected 42, received 41.' };
      },
    } as CompletionPlugin);

    try {
      const result = await runPipeline(
        {
          name: 'completion-feedback',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                {
                  id: 'answer',
                  command: 'answer',
                  completion: { type: 'judge' },
                },
              ],
            },
          ],
        },
        workDir,
        {
          registry,
          runtime: fakeRuntime(),
          skipPluginLoading: true,
        },
      );

      const state = result.states.get('main.answer');
      expect(result.success).toBe(false);
      expect(state?.status).toBe('failed');
      expect(state?.result?.failureKind).toBe('completion_failed');
      const completionSuffix = '\n[completion] Expected 42, received 41.';
      const expectedStderr = 'child warning' + completionSuffix;
      expect(state?.result?.stderr).toBe(expectedStderr);
      expect(state?.result?.stderrBytes).toBe(
        1_300 + new TextEncoder().encode(completionSuffix).byteLength,
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
