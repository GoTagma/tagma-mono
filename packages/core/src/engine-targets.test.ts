import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from './index';
import type { PipelineConfig, TagmaRuntime, TaskResult } from './types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-target-run-'));
}

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

function fakeRuntime(seenCommands: string[]): TagmaRuntime {
  return {
    async runCommand(command) {
      const text = typeof command === 'string' ? command : 'shell' in command ? command.shell : command.argv.join(' ');
      seenCommands.push(text);
      return taskResult(text);
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
    now: () => new Date('2026-05-12T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

const config: PipelineConfig = {
  name: 'targeted',
  mode: 'trusted',
  tracks: [
    {
      id: 'main',
      name: 'Main',
      tasks: [
        { id: 'prepare', name: 'Prepare', command: 'prepare' },
        { id: 'build', name: 'Build', command: 'build', depends_on: ['prepare'] },
        { id: 'test', name: 'Test', command: 'test', depends_on: ['build'] },
        { id: 'deploy', name: 'Deploy', command: 'deploy', depends_on: ['test'] },
      ],
    },
  ],
};

describe('targeted pipeline runs', () => {
  test('runs selected tasks and their upstream prerequisites, not downstream tasks', async () => {
    const dir = makeDir();
    const seenCommands: string[] = [];
    try {
      const result = await runPipeline(config, dir, {
        registry: new PluginRegistry(),
        runtime: fakeRuntime(seenCommands),
        skipPluginLoading: true,
        targetTaskIds: ['main.test'],
      });

      expect(result.success).toBe(true);
      expect(seenCommands).toEqual(['prepare', 'build', 'test']);
      expect(result.states.get('main.prepare')?.status).toBe('success');
      expect(result.states.get('main.build')?.status).toBe('success');
      expect(result.states.get('main.test')?.status).toBe('success');
      expect(result.states.get('main.deploy')?.status).toBe('skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
