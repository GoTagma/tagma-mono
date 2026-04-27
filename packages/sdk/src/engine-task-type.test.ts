import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline, type RunEventPayload } from './engine';
import { PluginRegistry } from '@tagma/core';
import type { PipelineConfig } from './types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-task-type-'));
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
