import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry, runPipeline } from './index';
import type {
  PipelineConfig,
  RunEventPayload,
  TagmaRuntime,
  TaskResult,
  TriggerPlugin,
} from './types';

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
      const text =
        typeof command === 'string'
          ? command
          : 'shell' in command
            ? command.shell
            : command.argv.join(' ');
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
      expect(result.states.get('main.deploy')?.result).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('outside the selected target run set'),
        failureKind: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dependency-skipped tasks carry terminal TaskResult metadata', async () => {
    const dir = makeDir();
    const seenCommands: string[] = [];
    const events: RunEventPayload[] = [];
    try {
      const result = await runPipeline(config, dir, {
        registry: new PluginRegistry(),
        runtime: {
          ...fakeRuntime(seenCommands),
          async runCommand(command) {
            const text =
              typeof command === 'string'
                ? command
                : 'shell' in command
                  ? command.shell
                  : command.argv.join(' ');
            seenCommands.push(text);
            return {
              ...taskResult(text),
              exitCode: text === 'build' ? 1 : 0,
              stderr: text === 'build' ? 'build failed' : '',
              stderrBytes: text === 'build' ? 'build failed'.length : 0,
              failureKind: text === 'build' ? 'exit_nonzero' : null,
            };
          },
        },
        skipPluginLoading: true,
        onEvent: (event) => events.push(event),
      });

      expect(result.success).toBe(false);
      expect(result.states.get('main.build')?.status).toBe('failed');
      expect(result.states.get('main.test')?.status).toBe('skipped');
      expect(result.states.get('main.test')?.result).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('upstream "main.build"'),
        failureKind: null,
      });
      expect(result.states.get('main.deploy')?.status).toBe('skipped');
      expect(result.states.get('main.deploy')?.result).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('upstream "main.test"'),
        failureKind: null,
      });
      const skippedUpdates = events.filter(
        (event) => event.type === 'task_update' && event.status === 'skipped',
      );
      expect(skippedUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'main.test',
            exitCode: -1,
            stderr: expect.stringContaining('upstream "main.build"'),
          }),
          expect.objectContaining({
            taskId: 'main.deploy',
            exitCode: -1,
            stderr: expect.stringContaining('upstream "main.test"'),
          }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trigger-wait tasks skipped by stop_all carry terminal TaskResult metadata', async () => {
    const dir = makeDir();
    const seenCommands: string[] = [];
    const events: RunEventPayload[] = [];
    const registry = new PluginRegistry();
    registry.registerPlugin('triggers', 'never', {
      name: 'never',
      watch(_config, ctx) {
        let rejectFired: (err: Error) => void = () => {
          /* assigned synchronously below */
        };
        const fired = new Promise<void>((_, reject) => {
          rejectFired = reject;
        });
        const onAbort = () => rejectFired(new Error('aborted'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        return {
          fired,
          async dispose() {
            ctx.signal.removeEventListener('abort', onAbort);
          },
        };
      },
    } satisfies TriggerPlugin);

    try {
      const result = await runPipeline(
        {
          name: 'trigger-stop-all',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              on_failure: 'stop_all',
              tasks: [
                { id: 'fail', name: 'Fail', command: 'fail' },
                {
                  id: 'wait',
                  name: 'Wait',
                  trigger: { type: 'never' },
                  command: 'wait',
                },
              ],
            },
          ],
        },
        dir,
        {
          registry,
          runtime: {
            ...fakeRuntime(seenCommands),
            async runCommand(command) {
              const text =
                typeof command === 'string'
                  ? command
                  : 'shell' in command
                    ? command.shell
                    : command.argv.join(' ');
              seenCommands.push(text);
              return {
                ...taskResult(text),
                exitCode: text === 'fail' ? 1 : 0,
                stderr: text === 'fail' ? 'failed' : '',
                stderrBytes: text === 'fail' ? 'failed'.length : 0,
                failureKind: text === 'fail' ? 'exit_nonzero' : null,
              };
            },
          },
          skipPluginLoading: true,
          onEvent: (event) => events.push(event),
        },
      );

      expect(result.success).toBe(false);
      expect(result.states.get('main.fail')?.status).toBe('failed');
      expect(result.states.get('main.wait')?.status).toBe('skipped');
      expect(result.states.get('main.wait')?.result).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('pipeline stopped after a task failure'),
        failureKind: null,
      });
      expect(seenCommands).toEqual(['fail']);
      const waitSkipped = events.find(
        (event) =>
          event.type === 'task_update' &&
          event.taskId === 'main.wait' &&
          event.status === 'skipped',
      );
      expect(waitSkipped).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('pipeline stopped after a task failure'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trigger-wait tasks skipped by external abort carry terminal TaskResult metadata', async () => {
    const dir = makeDir();
    const seenCommands: string[] = [];
    const events: RunEventPayload[] = [];
    const controller = new AbortController();
    let triggerStarted!: () => void;
    const triggerReady = new Promise<void>((resolve) => {
      triggerStarted = resolve;
    });
    const registry = new PluginRegistry();
    registry.registerPlugin('triggers', 'never', {
      name: 'never',
      watch(_config, ctx) {
        triggerStarted();
        let rejectFired: (err: Error) => void = () => {
          /* assigned synchronously below */
        };
        const fired = new Promise<void>((_, reject) => {
          rejectFired = reject;
        });
        const onAbort = () => rejectFired(new Error('aborted'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        return {
          fired,
          async dispose() {
            ctx.signal.removeEventListener('abort', onAbort);
          },
        };
      },
    } satisfies TriggerPlugin);

    try {
      const run = runPipeline(
        {
          name: 'trigger-external-abort',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [
                {
                  id: 'wait',
                  name: 'Wait',
                  trigger: { type: 'never' },
                  command: 'wait',
                },
              ],
            },
          ],
        },
        dir,
        {
          registry,
          runtime: fakeRuntime(seenCommands),
          skipPluginLoading: true,
          signal: controller.signal,
          onEvent: (event) => events.push(event),
        },
      );
      await triggerReady;
      controller.abort();
      const result = await run;

      expect(result.success).toBe(false);
      expect(result.states.get('main.wait')?.status).toBe('skipped');
      expect(result.states.get('main.wait')?.result).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('before trigger "never" fired'),
        failureKind: null,
      });
      expect(seenCommands).toEqual([]);
      const waitSkipped = events.find(
        (event) =>
          event.type === 'task_update' &&
          event.taskId === 'main.wait' &&
          event.status === 'skipped',
      );
      expect(waitSkipped).toMatchObject({
        exitCode: -1,
        stderr: expect.stringContaining('before trigger "never" fired'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
