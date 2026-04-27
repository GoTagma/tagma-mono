import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma } from './tagma';
import type { DriverPlugin, TagmaPlugin, TaskResult } from '@tagma/types';
import type { TagmaRuntime } from '@tagma/core';

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeDriver(name: string, marker: string[]): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    async buildCommand() {
      marker.push(name);
      return { args: ['echo', name] };
    },
  };
}

function memoryLogStore() {
  return {
    openRunLog({ runId }: { runId: string }) {
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
    taskOutputPath({
      runId,
      taskId,
      stream,
    }: {
      runId: string;
      taskId: string;
      stream: 'stdout' | 'stderr';
    }) {
      return `mem://${runId}/${taskId}.${stream}`;
    },
    logsDir(workDir: string) {
      return `mem://${workDir}/logs`;
    },
    async prune() {
      /* memory sink */
    },
  };
}

describe('createTagma', () => {
  test('runs command tasks through the configured runtime', async () => {
    const calls: string[] = [];
    const taskResult: TaskResult = {
      exitCode: 0,
      stdout: 'runtime-ok',
      stderr: '',
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 10,
      stderrBytes: 0,
      durationMs: 1,
      sessionId: null,
      normalizedOutput: null,
      failureKind: null,
    };
    const runtime: TagmaRuntime = {
      async runCommand(command, cwd) {
        calls.push(`${cwd}:${command}`);
        return taskResult;
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
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
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-04-26T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-runtime-run-');
    try {
      const result = await tagma.run(
        {
          name: 'runtime-run',
          tracks: [
            {
              id: 't',
              name: 'T',
              tasks: [{ id: 'cmd', name: 'cmd', command: 'fake-only-command' }],
            },
          ],
        },
        {
          cwd: dir,
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(calls).toEqual([`${dir}:fake-only-command`]);
      expect(result.states.get('t.cmd')?.result?.stdout).toBe('runtime-ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('routes run logs and task output artifacts through the runtime log store', async () => {
    const calls: string[] = [];
    let stdoutPath: string | undefined;
    let stderrPath: string | undefined;

    const runtime = {
      async runCommand(_command: string, _cwd: string, options?: { stdoutPath?: string; stderrPath?: string }) {
        stdoutPath = options?.stdoutPath;
        stderrPath = options?.stderrPath;
        return {
          exitCode: 0,
          stdout: 'runtime-log-ok',
          stderr: '',
          stdoutPath: options?.stdoutPath ?? null,
          stderrPath: options?.stderrPath ?? null,
          stdoutBytes: 14,
          stderrBytes: 0,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
        } satisfies TaskResult;
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
      },
      async ensureDir(path: string) {
        calls.push(`ensure:${path}`);
      },
      async fileExists(path: string) {
        calls.push(`exists:${path}`);
        return false;
      },
      async *watch(path: string) {
        calls.push(`watch:${path}`);
        if (path === '__never__') yield { type: 'ready' as const, path };
      },
      now() {
        return new Date('2026-04-26T00:00:00.000Z');
      },
      sleep(ms: number) {
        calls.push(`sleep:${ms}`);
        return Promise.resolve();
      },
      logStore: {
        openRunLog({ runId, header }: { runId: string; header: string }) {
          calls.push(`open:${runId}:${header.includes(runId)}`);
          return {
            path: `mem://${runId}/pipeline.log`,
            dir: `mem://${runId}`,
            append(line: string) {
              calls.push(`append:${line.length > 0}`);
            },
            close() {
              calls.push(`close:${runId}`);
            },
          };
        },
        taskOutputPath({
          runId,
          taskId,
          stream,
        }: {
          runId: string;
          taskId: string;
          stream: 'stdout' | 'stderr';
        }) {
          calls.push(`task-output:${taskId}:${stream}`);
          return `mem://${runId}/${taskId}.${stream}`;
        },
        logsDir(workDir: string) {
          calls.push(`logs-dir:${workDir}`);
          return `mem://${workDir}/logs`;
        },
        async prune({ keep, excludeRunId }: { keep: number; excludeRunId: string }) {
          calls.push(`prune:${keep}:${excludeRunId}`);
        },
      },
    } as unknown as TagmaRuntime;

    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-runtime-log-store-');
    try {
      const result = await tagma.run(
        {
          name: 'runtime-log-store',
          tracks: [
            {
              id: 't',
              name: 'T',
              tasks: [{ id: 'cmd', name: 'cmd', command: 'fake-only-command' }],
            },
          ],
        },
        {
          cwd: dir,
          skipPluginLoading: true,
        },
      );

      expect(result.success).toBe(true);
      expect(result.logPath).toMatch(/^mem:\/\/run_.+\/pipeline\.log$/);
      expect(stdoutPath).toMatch(/^mem:\/\/run_.+\/t\.cmd\.stdout$/);
      expect(stderrPath).toMatch(/^mem:\/\/run_.+\/t\.cmd\.stderr$/);
      expect(calls.some((call) => call.startsWith('open:run_'))).toBe(true);
      expect(calls).toContain('task-output:t.cmd:stdout');
      expect(calls).toContain('task-output:t.cmd:stderr');
      expect(calls.some((call) => call.startsWith('prune:20:run_'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('registers capability plugins passed to options', () => {
    const seen: string[] = [];
    const driver = makeDriver('driver-plugin', seen);
    const plugin: TagmaPlugin = {
      name: 'tagma-plugin-local',
      capabilities: {
        drivers: {
          mock: driver,
        },
      },
    };

    const tagma = createTagma({ builtins: false, plugins: [plugin] });

    expect(tagma.registry.getHandler<DriverPlugin>('drivers', 'mock')).toBe(driver);
    expect(seen).toEqual([]);
  });

  test('instances own isolated plugin registries', () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const tagmaA = createTagma({ builtins: false });
    const tagmaB = createTagma({ builtins: false });

    tagmaA.registry.registerPlugin('drivers', 'mock', makeDriver('driver-a', seenA));
    tagmaB.registry.registerPlugin('drivers', 'mock', makeDriver('driver-b', seenB));

    expect(tagmaA.registry.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('driver-a');
    expect(tagmaB.registry.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('driver-b');
    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
  });

  test('run uses only the instance registry', async () => {
    const tagma = createTagma({ builtins: false });
    const dir = makeDir('tagma-instance-run-');
    try {
      await expect(
        tagma.run(
          {
            name: 'instance-run',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [{ id: 'prompt', name: 'prompt', prompt: 'hello' }],
              },
            ],
          },
          {
            cwd: dir,
            skipPluginLoading: true,
          },
        ),
      ).rejects.toThrow(/driver "opencode" not registered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validate returns structural pipeline errors without running tasks', () => {
    const tagma = createTagma({ builtins: false });

    expect(
      tagma.validate({
        name: 'invalid',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [
              { id: 'a', name: 'A', command: 'echo a', depends_on: ['missing'] },
            ],
          },
        ],
      }),
    ).toEqual(['Task reference "missing" not found']);
  });
});
