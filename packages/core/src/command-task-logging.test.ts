import { expect, test } from 'bun:test';

import { PluginRegistry, runPipeline } from './index';
import type { PipelineConfig, TagmaRuntime, TaskResult } from './types';

function successfulCommandResult(): TaskResult {
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

test('command task logs describe host execution without inert AI configuration', async () => {
  const lines: string[] = [];
  const runtime: TagmaRuntime = {
    async runCommand() {
      return successfulCommandResult();
    },
    async runSpawn() {
      throw new Error('runSpawn should not be called');
    },
    async ensureDir() {},
    async fileExists() {
      return false;
    },
    async *watch() {},
    logStore: {
      openRunLog() {
        return {
          path: 'mem://pipeline.log',
          dir: 'mem://run',
          append(line) {
            lines.push(line);
          },
          close() {},
        };
      },
      taskOutputPath({ taskId, stream }) {
        return `mem://${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
    },
    now: () => new Date('2026-07-30T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
  const config: PipelineConfig = {
    name: 'command-logging',
    driver: 'opencode',
    model: 'provider/model',
    permissions: { read: true, write: false, execute: false },
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'command', name: 'Command', command: 'Write-Output ok' }],
      },
    ],
  };

  const result = await runPipeline(config, 'C:\\workspace', {
    registry: new PluginRegistry(),
    runtime,
    skipPluginLoading: true,
  });
  const log = lines.join('\n');

  expect(result.success).toBe(true);
  expect(log).toContain('[task:main.command] DEBUG: executor: host-command shell=');
  expect(log).not.toContain('resolved: driver=');
  expect(log).not.toContain('permissions:');
});
