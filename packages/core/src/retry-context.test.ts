import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from './index';
import type {
  DriverPlugin,
  MiddlewarePlugin,
  PromptDocument,
  TagmaRuntime,
  TaskResult,
} from './types';

function taskResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 2,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand() {
      throw new Error('runCommand should not be called');
    },
    async runSpawn() {
      return taskResult();
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

describe('retry prompt context', () => {
  test('appends host context after middleware enrichment so it is closest to the task', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-retry-context-'));
    const registry = new PluginRegistry();
    let seenPrompt = '';
    let seenDocument: PromptDocument | undefined;

    const middleware: MiddlewarePlugin = {
      name: 'memory',
      async enhanceDoc(doc) {
        return {
          contexts: [...doc.contexts, { label: 'Memory', content: 'middleware context' }],
          task: doc.task,
        };
      },
    };
    const driver: DriverPlugin = {
      name: 'mock',
      capabilities: { sessionResume: true, systemPrompt: false, outputFormat: false },
      async buildCommand(task, _track, ctx) {
        seenPrompt = task.prompt ?? '';
        seenDocument = ctx.promptDoc;
        return { args: ['mock'] };
      },
    };
    registry.registerPlugin('middlewares', 'memory', middleware);
    registry.registerPlugin('drivers', 'mock', driver);

    try {
      const result = await runPipeline(
        {
          name: 'retry-context',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                {
                  id: 'repair',
                  name: 'Repair',
                  prompt: 'Fix the implementation.',
                  driver: 'mock',
                  middlewares: [{ type: 'memory' }],
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
          taskPromptContexts: {
            'main.repair': [{ label: 'Repair Feedback', content: 'The assertion still fails.' }],
          },
        },
      );

      expect(result.success).toBe(true);
      expect(seenDocument).toEqual({
        contexts: [
          { label: 'Memory', content: 'middleware context' },
          { label: 'Repair Feedback', content: 'The assertion still fails.' },
        ],
        task: 'Fix the implementation.',
      });
      expect(seenPrompt).toBe(
        '[Memory]\nmiddleware context\n\n' +
          '[Repair Feedback]\nThe assertion still fails.\n\n' +
          'Fix the implementation.',
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('seeds existing driver continuation maps under a synthetic same-task key', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-retry-continuation-'));
    const registry = new PluginRegistry();
    let seen:
      | {
          continuationKey: string | undefined;
          sessionId: string | undefined;
          driver: string | undefined;
          normalizedOutput: string | undefined;
          sessionKeys: string[];
          driverKeys: string[];
          normalizedKeys: string[];
        }
      | undefined;

    registry.registerPlugin('drivers', 'mock', {
      name: 'mock',
      capabilities: { sessionResume: true, systemPrompt: false, outputFormat: false },
      async buildCommand(task, _track, ctx) {
        const continuationKey = task.continue_from;
        seen = {
          continuationKey,
          sessionId: continuationKey ? ctx.sessionMap.get(continuationKey) : undefined,
          driver: continuationKey ? ctx.sessionDriverMap.get(continuationKey) : undefined,
          normalizedOutput: continuationKey ? ctx.normalizedMap.get(continuationKey) : undefined,
          sessionKeys: [...ctx.sessionMap.keys()],
          driverKeys: [...ctx.sessionDriverMap.keys()],
          normalizedKeys: [...ctx.normalizedMap.keys()],
        };
        return { args: ['mock'] };
      },
    } satisfies DriverPlugin);

    try {
      const result = await runPipeline(
        {
          name: 'retry-continuation',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [{ id: 'repair', prompt: 'Try again.', driver: 'mock' }],
            },
          ],
        },
        workDir,
        {
          registry,
          runtime: fakeRuntime(),
          skipPluginLoading: true,
          taskContinuations: {
            'main.repair': {
              sessionId: 'session-from-attempt-1',
              driver: 'mock',
              normalizedOutput: 'previous attempt output',
            },
          },
        },
      );

      expect(result.success).toBe(true);
      expect(seen?.continuationKey).toBeString();
      expect(seen?.continuationKey).not.toBe('main.repair');
      expect(seen).toMatchObject({
        sessionId: 'session-from-attempt-1',
        driver: 'mock',
        normalizedOutput: 'previous attempt output',
      });
      expect(seen?.sessionKeys).toEqual([seen?.continuationKey]);
      expect(seen?.driverKeys).toEqual([seen?.continuationKey]);
      expect(seen?.normalizedKeys).toEqual([seen?.continuationKey]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('preserves an authored upstream continue_from over same-task retry state', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-retry-authored-continuation-'));
    const registry = new PluginRegistry();
    let consumerContinuation:
      | {
          key: string | undefined;
          sessionId: string | undefined;
          normalizedOutput: string | undefined;
        }
      | undefined;

    registry.registerPlugin('drivers', 'mock', {
      name: 'mock',
      capabilities: { sessionResume: true, systemPrompt: false, outputFormat: false },
      async buildCommand(task, _track, ctx) {
        if (task.id === 'consumer') {
          const key = task.continue_from;
          consumerContinuation = {
            key,
            sessionId: key ? ctx.sessionMap.get(key) : undefined,
            normalizedOutput: key ? ctx.normalizedMap.get(key) : undefined,
          };
        }
        return { args: ['mock'] };
      },
    } satisfies DriverPlugin);
    const runtime: TagmaRuntime = {
      ...fakeRuntime(),
      async runSpawn() {
        return {
          ...taskResult(),
          sessionId: 'current-upstream-session',
          normalizedOutput: 'current upstream output',
        };
      },
    };

    try {
      const result = await runPipeline(
        {
          name: 'retry-authored-continuation',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                { id: 'source', prompt: 'Produce context.', driver: 'mock' },
                {
                  id: 'consumer',
                  prompt: 'Use current context.',
                  driver: 'mock',
                  continue_from: 'source',
                },
              ],
            },
          ],
        },
        workDir,
        {
          registry,
          runtime,
          skipPluginLoading: true,
          taskContinuations: {
            'main.consumer': {
              sessionId: 'stale-consumer-session',
              driver: 'mock',
              normalizedOutput: 'stale consumer output',
            },
          },
        },
      );

      expect(result.success).toBe(true);
      expect(consumerContinuation).toEqual({
        key: 'main.source',
        sessionId: 'current-upstream-session',
        normalizedOutput: 'current upstream output',
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
