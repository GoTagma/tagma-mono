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

function runtimeForLogs(lines: string[]): TagmaRuntime {
  return {
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
}

function runtimeForSpawnedCommandLogs(lines: string[]): TagmaRuntime {
  return {
    ...runtimeForLogs(lines),
    async runCommand(command, cwd) {
      if (typeof command !== 'object' || !('argv' in command)) {
        throw new Error('test runtime expects an argv command');
      }

      const start = performance.now();
      const child = Bun.spawn([...command.argv], {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return {
        exitCode,
        stdout,
        stderr,
        stdoutPath: null,
        stderrPath: null,
        stdoutBytes: new TextEncoder().encode(stdout).byteLength,
        stderrBytes: new TextEncoder().encode(stderr).byteLength,
        durationMs: Math.round(performance.now() - start),
        sessionId: null,
        normalizedOutput: null,
        failureKind: null,
      };
    },
  };
}

test('command task logs describe host execution without inert AI configuration', async () => {
  const lines: string[] = [];
  const runtime = runtimeForLogs(lines);
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
  expect(log).toContain('status:   completed');
  expect(log).toContain('[pipeline] completed "command-logging"');
  expect(log).not.toContain('[pipeline] failed "command-logging"');
  expect(log).toContain('[task:main.command] DEBUG: executor: host-command shell=');
  expect(log).not.toContain('resolved: driver=');
  expect(log).not.toContain('permissions:');
});

test('invalid command spawn configuration is captured as a task failure', async () => {
  const lines: string[] = [];
  const result = await runPipeline(
    {
      name: 'invalid-command',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'command', name: 'Command', command: { argv: [] } }],
        },
      ],
    },
    'C:\\workspace',
    {
      registry: new PluginRegistry(),
      runtime: runtimeForLogs(lines),
      skipPluginLoading: true,
    },
  );

  expect(result.success).toBe(false);
  expect(result.states.get('main.command')).toMatchObject({
    status: 'failed',
    result: { exitCode: -1, failureKind: 'spawn_error' },
  });
  const log = lines.join('\n');
  expect(log).toContain('failed before execution');
  expect(log).toContain('status:   failed');
  expect(log).toContain('[pipeline] failed "invalid-command"');
  expect(log).not.toContain('[pipeline] completed "invalid-command"');
});

test('non-zero command exit logs the terminal pipeline result as failed', async () => {
  const lines: string[] = [];
  const result = await runPipeline(
    {
      name: 'nonzero-command',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'command',
              name: 'Command',
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  "process.stdout.write('child-started'); process.exitCode = 17;",
                ],
              },
            },
          ],
        },
      ],
    },
    process.cwd(),
    {
      registry: new PluginRegistry(),
      runtime: runtimeForSpawnedCommandLogs(lines),
      skipPluginLoading: true,
    },
  );

  expect(result.success).toBe(false);
  expect(result.states.get('main.command')).toMatchObject({
    status: 'failed',
    result: { exitCode: 17, stdout: 'child-started' },
  });
  const log = lines.join('\n');
  expect(log).toContain('status:   failed');
  expect(log).toContain('[pipeline] failed "nonzero-command"');
  expect(log).not.toContain('status:   completed');
  expect(log).not.toContain('[pipeline] completed "nonzero-command"');
});

test('external cancellation is logged as aborted rather than completed or failed', async () => {
  const lines: string[] = [];
  const controller = new AbortController();
  controller.abort();

  const result = await runPipeline(
    {
      name: 'external-abort',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'command', name: 'Command', command: 'Write-Output should-not-run' }],
        },
      ],
    },
    'C:\\workspace',
    {
      registry: new PluginRegistry(),
      runtime: runtimeForLogs(lines),
      skipPluginLoading: true,
      signal: controller.signal,
    },
  );

  expect(result.success).toBe(false);
  const log = lines.join('\n');
  expect(log).toContain('status:   aborted (external)');
  expect(log).toContain('[pipeline] aborted "external-abort"');
  expect(log).not.toContain('[pipeline] completed "external-abort"');
  expect(log).not.toContain('[pipeline] failed "external-abort"');
});
