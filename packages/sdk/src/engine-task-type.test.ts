import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline, type RunEventPayload } from '@tagma/core';
import type { PipelineConfig, TagmaRuntime, TaskResult } from '@tagma/types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-task-type-'));
}

function taskResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
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
      return taskResult();
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
    now() {
      return new Date('2026-04-26T00:00:00.000Z');
    },
    sleep() {
      return Promise.resolve();
    },
  };
}

describe('engine task type detection', () => {
  test('empty command is still a command task and does not require a driver', async () => {
    const dir = makeDir();
    try {
      const events: RunEventPayload[] = [];
      const config: PipelineConfig = {
        name: 'empty-command',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'cmd', name: 'cmd', command: '' }],
          },
        ],
      };

      const result = await runPipeline(config, dir, {
        registry: new PluginRegistry(),
        runtime: fakeRuntime(),
        skipPluginLoading: true,
        onEvent: (event) => events.push(event),
      });

      expect(result.success).toBe(true);
      expect(events.some((event) => event.type === 'run_start')).toBe(true);
      const final = events.findLast(
        (event) => event.type === 'task_update' && event.taskId === 't.cmd',
      );
      expect(final?.type).toBe('task_update');
      if (final?.type === 'task_update') {
        expect(final.status).toBe('success');
        expect(final.resolvedDriver).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
