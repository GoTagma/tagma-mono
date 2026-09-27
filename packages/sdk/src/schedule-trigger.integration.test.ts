import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PluginRegistry, runPipeline } from '@tagma/core';
import type { PipelineConfig, RunEventPayload, TagmaRuntime, TaskResult } from '@tagma/types';

function taskResult(stdout: string): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

/**
 * Virtual-clock runtime: `sleep` advances the clock immediately, so a
 * schedule-gated task fires on its first tick without real waiting. Mirrors
 * how the editor's Sandbox Trial host virtualizes time for this trigger.
 */
function virtualClockRuntime(start: Date): TagmaRuntime & { nowMs(): number } {
  let nowMs = start.getTime();
  return {
    nowMs: () => nowMs,
    async runCommand() {
      return taskResult('ok');
    },
    async runSpawn() {
      return taskResult('ok');
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
    },
    now: () => new Date(nowMs),
    sleep: (ms: number) => {
      nowMs += ms;
      return Promise.resolve();
    },
  };
}

function scheduledPipeline(): PipelineConfig {
  return {
    name: 'site-monitor',
    tracks: [
      {
        id: 'monitor',
        name: 'Monitor',
        tasks: [
          {
            id: 'scrape',
            name: 'Scrape',
            command: 'echo scraped',
            trigger: { type: 'schedule', cron: '0 8 * * 1-5' },
          },
        ],
      },
    ],
  };
}

describe('schedule trigger engine integration', () => {
  test('a schedule-gated task waits for the tick, then runs successfully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-schedule-'));
    const events: RunEventPayload[] = [];
    try {
      // Friday 2026-09-25 20:00 local; the next weekday 08:00 tick is Monday.
      const runtime = virtualClockRuntime(new Date(2026, 8, 25, 20, 0, 0, 0));
      const result = await runPipeline(scheduledPipeline(), dir, {
        registry: (() => {
          const reg = new PluginRegistry();
          bootstrapBuiltins(reg);
          return reg;
        })(),
        runtime,
        skipPluginLoading: true,
        onEvent: (event) => events.push(event),
      });

      expect(result.success).toBe(true);
      expect(result.states.get('monitor.scrape')?.status).toBe('success');
      // The task ran only after the clock reached Monday 08:00 local.
      expect(runtime.nowMs()).toBeGreaterThanOrEqual(new Date(2026, 8, 28, 8, 0, 0, 0).getTime());

      const waitUpdate = events.find(
        (event) =>
          event.type === 'task_update' &&
          event.taskId === 'monitor.scrape' &&
          event.waitReason !== undefined &&
          event.waitReason !== null,
      );
      expect(waitUpdate).toMatchObject({
        waitReason: { kind: 'trigger', triggerType: 'schedule' },
      });
      const finalUpdate = events.find(
        (event) =>
          event.type === 'task_update' &&
          event.taskId === 'monitor.scrape' &&
          event.status === 'success',
      );
      expect(finalUpdate).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an invalid cron expression fails the task at run time with a clear message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-schedule-'));
    try {
      const config = scheduledPipeline();
      const task = config.tracks[0]!.tasks[0]!;
      const bad: PipelineConfig = {
        ...config,
        tracks: [
          {
            ...config.tracks[0]!,
            tasks: [{ ...task, trigger: { type: 'schedule', cron: '0 8 * *' } }],
          },
        ],
      };
      const result = await runPipeline(bad, dir, {
        registry: (() => {
          const reg = new PluginRegistry();
          bootstrapBuiltins(reg);
          return reg;
        })(),
        runtime: virtualClockRuntime(new Date(2026, 8, 26, 12, 0, 0, 0)),
        skipPluginLoading: true,
      });
      expect(result.success).toBe(false);
      const state = result.states.get('monitor.scrape');
      expect(state?.status).toBe('failed');
      expect(state?.result?.stderr ?? '').toMatch(/5 fields/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
