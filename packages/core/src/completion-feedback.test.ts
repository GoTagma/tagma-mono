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

function fakeRuntime(result: TaskResult = commandResult()): TagmaRuntime {
  return {
    async runCommand() {
      return result;
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

  test('does not let completion checks override runtime output or binary failures', async () => {
    for (const failureKind of ['output_error', 'binary_missing'] as const) {
      const workDir = mkdtempSync(join(tmpdir(), `tagma-completion-${failureKind}-`));
      const registry = new PluginRegistry();
      let completionChecks = 0;
      registry.registerPlugin('completions', 'always-pass', {
        name: 'always-pass',
        async check() {
          completionChecks += 1;
          return true;
        },
      } as CompletionPlugin);
      const runtimeResult: TaskResult = {
        ...commandResult(),
        exitCode: failureKind === 'binary_missing' ? -1 : 0,
        failureKind,
        ...(failureKind === 'binary_missing'
          ? { missingBinary: 'fixture-command' }
          : {
              outputDiagnostics: [
                {
                  stream: 'stdout',
                  stage: 'read',
                  message: 'fixture stream fault',
                  capturedBytes: 2,
                  path: null,
                },
              ],
            }),
      };

      try {
        const result = await runPipeline(
          {
            name: `completion-${failureKind}`,
            tracks: [
              {
                id: 'main',
                name: 'Main',
                tasks: [
                  {
                    id: 'answer',
                    command: 'answer',
                    completion: { type: 'always-pass' },
                  },
                ],
              },
            ],
          },
          workDir,
          {
            registry,
            runtime: fakeRuntime(runtimeResult),
            skipPluginLoading: true,
          },
        );

        expect(result.success).toBe(false);
        expect(result.states.get('main.answer')?.status).toBe('failed');
        expect(result.states.get('main.answer')?.result?.failureKind).toBe(failureKind);
        expect(completionChecks).toBe(0);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });
});
