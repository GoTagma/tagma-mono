import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma } from './tagma';
import { PipelineValidationError } from './schema';
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

  test('passes structured argv command tasks through the runtime boundary', async () => {
    const calls: unknown[] = [];
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
      async runCommand(command) {
        calls.push(command);
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
    const dir = makeDir('tagma-runtime-argv-');
    try {
      await tagma.run(
        {
          name: 'runtime-argv',
          tracks: [
            {
              id: 't',
              name: 'T',
              tasks: [{ id: 'cmd', name: 'cmd', command: { argv: ['tool', '--flag'] } }],
            },
          ],
        },
        { cwd: dir, skipPluginLoading: true },
      );

      expect(calls).toEqual([{ argv: ['tool', '--flag'] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('lets exit_code completion accept a non-zero process exit', async () => {
    const taskResult: TaskResult = {
      exitCode: 1,
      stdout: '',
      stderr: '',
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 1,
      sessionId: null,
      normalizedOutput: null,
      failureKind: 'exit_nonzero',
    };
    const runtime: TagmaRuntime = {
      async runCommand() {
        return taskResult;
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-04-26T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ runtime });
    const dir = makeDir('tagma-completion-nonzero-');
    try {
      const result = await tagma.run(
        {
          name: 'completion-nonzero',
          tracks: [
            {
              id: 't',
              name: 'T',
              tasks: [
                {
                  id: 'cmd',
                  name: 'cmd',
                  command: 'fake-failing-command',
                  completion: { type: 'exit_code', expect: 1 },
                },
              ],
            },
          ],
        },
        { cwd: dir, skipPluginLoading: true },
      );

      expect(result.success).toBe(true);
      expect(result.states.get('t.cmd')?.status).toBe('success');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('routes run logs and task output artifacts through the runtime log store', async () => {
    const calls: string[] = [];
    let stdoutPath: string | undefined;
    let stderrPath: string | undefined;

    const runtime = {
      async runCommand(
        _command: string,
        _cwd: string,
        options?: { stdoutPath?: string; stderrPath?: string },
      ) {
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
            tasks: [{ id: 'a', name: 'A', command: 'echo a', depends_on: ['missing'] }],
          },
        ],
      }),
    ).toEqual([
      'tracks[0].tasks[0].depends_on: Task "a": depends_on "missing"  - no such task found',
    ]);
  });

  test('validate reports malformed runtime config inputs instead of throwing', () => {
    const tagma = createTagma({ builtins: false });
    const dir = makeDir('tagma-validate-malformed-');

    try {
      expect(tagma.validate(null as never)).toEqual(['pipeline: pipeline must be an object']);
      expect(tagma.validate(null as never, { cwd: dir })).toEqual([
        'pipeline: pipeline must be an object',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validate can include cwd safety checks when a cwd is provided', () => {
    const tagma = createTagma({ builtins: false });
    const dir = makeDir('tagma-validate-cwd-');
    try {
      const config = {
        name: 'unsafe-cwd',
        tracks: [
          {
            id: 't',
            name: 'T',
            cwd: '../outside-track',
            tasks: [
              {
                id: 'a',
                name: 'A',
                command: 'echo a',
                cwd: '../outside-task',
              },
            ],
          },
        ],
      } as const;

      expect(tagma.validate(config)).toEqual([]);
      expect(tagma.validate(config, { cwd: dir })).toEqual(
        expect.arrayContaining([
          expect.stringContaining('tracks[0].cwd: Security: path "../outside-track"'),
          expect.stringContaining('tracks[0].tasks[0].cwd: Security: path "../outside-task"'),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validate reports an invalid cwd instead of falling back to process cwd', () => {
    const tagma = createTagma({ builtins: false });

    expect(
      tagma.validate(
        {
          name: 'invalid-cwd',
          tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', command: 'echo a' }] }],
        },
        { cwd: '' },
      ),
    ).toEqual(['workDir: workDir must be a non-empty string']);
  });

  test('run rejects missing or blank options.cwd before execution starts', async () => {
    const tagma = createTagma({ builtins: false, runtime: {} as TagmaRuntime });
    const config = {
      name: 'options-cwd-required',
      tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', command: 'echo a' }] }],
    } as const;
    const run = tagma.run as unknown as (
      config: typeof config,
      options?: unknown,
    ) => Promise<unknown>;

    await expect(run(config, {})).rejects.toThrow(/options\.cwd must be a non-empty string/);
    await expect(run(config, { cwd: ' ' })).rejects.toThrow(
      /options\.cwd must be a non-empty string/,
    );
  });

  test('runYaml rejects missing options.cwd before parsing execution paths', async () => {
    const tagma = createTagma({ builtins: false, runtime: {} as TagmaRuntime });
    const runYaml = tagma.runYaml as unknown as (
      content: string,
      options?: unknown,
    ) => Promise<unknown>;

    await expect(
      runYaml(
        `pipeline:
  name: Missing Cwd
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          command: echo a
`,
        {},
      ),
    ).rejects.toThrow(/options\.cwd must be a non-empty string/);
  });

  test('run rejects programmatic configs that bypass YAML structural validation', async () => {
    const tagma = createTagma({ builtins: false, runtime: {} as TagmaRuntime });
    const dir = makeDir('tagma-programmatic-validation-');
    const run = tagma.run as unknown as (config: unknown, options: unknown) => Promise<unknown>;
    try {
      await expect(
        tagma.run(
          {
            name: 'invalid-programmatic',
            tracks: [
              {
                id: 't',
                name: 'T',
                tasks: [{ id: 'a', name: 'A', prompt: 'x', command: 'echo x' }],
              },
            ],
          },
          { cwd: dir, skipPluginLoading: true },
        ),
      ).rejects.toThrow(PipelineValidationError);
      await expect(run(null, { cwd: dir, skipPluginLoading: true })).rejects.toThrow(
        /pipeline must be an object/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('run accepts a programmatic pipeline graph config', async () => {
    const calls: string[] = [];
    const runtime: TagmaRuntime = {
      async runCommand(command) {
        calls.push(String(command));
        return {
          exitCode: 0,
          stdout: `${command}\n`,
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: String(command).length + 1,
          stderrBytes: 0,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
        };
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-05-23T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-graph-run-');
    try {
      const result = await tagma.run(
        {
          name: 'graph-run',
          pipelines: [
            {
              id: 'first',
              cwd: dir,
              config: {
                name: 'First',
                tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 'task', command: 'first' }] }],
              },
            },
            {
              id: 'second',
              cwd: dir,
              depends_on: ['first'],
              config: {
                name: 'Second',
                tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 'task', command: 'second' }] }],
              },
            },
          ],
        },
        { cwd: dir, skipPluginLoading: true },
      );

      expect(result.success).toBe(true);
      expect('pipelines' in result).toBe(true);
      expect(calls).toEqual(['first', 'second']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runYaml does not import YAML-declared plugins without explicit opt-in', async () => {
    const runtime: TagmaRuntime = {
      async runCommand() {
        throw new Error('runCommand should not be called for driver tasks');
      },
      async runSpawn() {
        return {
          exitCode: 0,
          stdout: 'driver-ok\n',
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: 10,
          stderrBytes: 0,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: 'driver-ok',
          failureKind: null,
        };
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-05-23T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-yaml-plugin-safe-default-');
    const pluginDir = join(dir, 'node_modules', 'tagma-plugin-workspace-driver');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'tagma-plugin-workspace-driver',
        version: '1.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        'const driver = {',
        "  name: 'workspace-driver',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'workspace'] }; },",
        '};',
        'export default {',
        "  name: 'tagma-plugin-workspace-driver',",
        '  capabilities: { drivers: { workspace: driver } },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );
    const yaml = `pipeline:
  name: Plugin Pipeline
  driver: workspace
  plugins:
    - tagma-plugin-workspace-driver
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          prompt: hello
`;

    try {
      await expect(tagma.runYaml(yaml, { cwd: dir })).rejects.toThrow(
        /driver "workspace" not registered/,
      );
      expect(tagma.registry.hasHandler('drivers', 'workspace')).toBe(false);

      const result = await tagma.runYaml(yaml, { cwd: dir, loadDeclaredPlugins: true });
      expect(result.kind).toBe('pipeline');
      expect(result.result.success).toBe(true);
      expect(tagma.registry.hasHandler('drivers', 'workspace')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('runYaml detects and runs either pipeline or workflow YAML documents', async () => {
    const calls: string[] = [];
    const runtime: TagmaRuntime = {
      async runCommand(command) {
        calls.push(String(command));
        return {
          exitCode: 0,
          stdout: `${command}\n`,
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: String(command).length + 1,
          stderrBytes: 0,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
        };
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-05-23T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-yaml-document-run-');
    const pipelineYaml = `pipeline:
  name: Single
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: single
`;
    const workflowYaml = `workflow:
  kind: graph
  name: Flow
  pipelines:
    - id: first
      path: .tagma/first/first.yaml
`;
    try {
      mkdirSync(join(dir, '.tagma', 'first'), { recursive: true });
      writeFileSync(join(dir, '.tagma', 'first', 'first.yaml'), pipelineYaml, 'utf-8');

      const pipelineRun = await tagma.runYaml(pipelineYaml, {
        cwd: dir,
        skipPluginLoading: true,
      });
      const workflowRun = await tagma.runYaml(workflowYaml, {
        cwd: dir,
        skipPluginLoading: true,
      });

      expect(pipelineRun.kind).toBe('pipeline');
      expect(pipelineRun.result.success).toBe(true);
      expect(workflowRun.kind).toBe('workflow');
      expect(workflowRun.result.success).toBe(true);
      expect(calls).toEqual(['single', 'single']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('runYaml honors workflow pipeline lifecycle controls from YAML', async () => {
    const calls: string[] = [];
    const runtime: TagmaRuntime = {
      async runCommand(command) {
        calls.push(String(command));
        return {
          exitCode: 0,
          stdout: `${command}\n`,
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: String(command).length + 1,
          stderrBytes: 0,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          failureKind: null,
        };
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called for command tasks');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: memoryLogStore(),
      now() {
        return new Date('2026-05-23T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
    };
    const tagma = createTagma({ builtins: false, runtime });
    const dir = makeDir('tagma-yaml-lifecycle-run-');
    try {
      mkdirSync(join(dir, '.tagma', 'build'), { recursive: true });
      writeFileSync(
        join(dir, '.tagma', 'build', 'build.yaml'),
        `pipeline:
  name: Build
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: build
`,
        'utf-8',
      );

      const workflowRun = await tagma.runYaml(
        `workflow:
  name: Flow
  pipelines:
    - id: build
      path: .tagma/build/build.yaml
      lifecycle:
        max_runs: 2
        stop_when: always
`,
        { cwd: dir, skipPluginLoading: true },
      );

      expect(workflowRun.kind).toBe('workflow');
      expect(workflowRun.result.success).toBe(true);
      expect(workflowRun.result.pipelines[0]?.runCount).toBe(2);
      expect(workflowRun.result.pipelines[0]?.attempts.map((attempt) => attempt.attempt)).toEqual([
        1, 2,
      ]);
      expect(calls).toEqual(['build', 'build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
