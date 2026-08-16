import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RunTaskPanel,
  canAskChatForTaskError,
  openTaskOutputPath,
} from '../src/components/run/RunTaskPanel';
import type { RawPipelineConfig, RunTaskState } from '../src/api/client';

const config: RawPipelineConfig = {
  name: 'Task error chat',
  tracks: [
    {
      id: 'main',
      name: 'Main',
      tasks: [{ id: 'command', command: 'true' }],
    },
  ],
};

function taskShape(
  overrides: Partial<RunTaskState>,
): Pick<RunTaskState, 'status' | 'stderr' | 'stderrPath'> {
  return {
    status: 'success',
    stderr: '',
    stderrPath: null,
    ...overrides,
  };
}

function runTask(overrides: Partial<RunTaskState> = {}): RunTaskState {
  return {
    taskId: 'main.command',
    trackId: 'main',
    taskName: 'Command',
    status: 'success',
    startedAt: null,
    finishedAt: null,
    durationMs: 1,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutPath: '/workspace/.tagma/logs/run/main_command.stdout',
    stderrPath: '/workspace/.tagma/logs/run/main_command.stderr',
    stdoutBytes: 0,
    stderrBytes: 0,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
    missingBinary: null,
    outputs: null,
    inputs: null,
    resolvedDriver: null,
    resolvedModel: null,
    resolvedPermissions: null,
    logs: [],
    totalLogCount: 0,
    ...overrides,
  };
}

describe('canAskChatForTaskError', () => {
  test('allows failed, timed out, and blocked task states', () => {
    expect(canAskChatForTaskError(taskShape({ status: 'failed' }))).toBe(true);
    expect(canAskChatForTaskError(taskShape({ status: 'timeout' }))).toBe(true);
    expect(canAskChatForTaskError(taskShape({ status: 'blocked' }))).toBe(true);
  });

  test('does not infer failure from a successful task stderr stream', () => {
    expect(canAskChatForTaskError(taskShape({ stderr: 'warned anyway' }))).toBe(false);
    expect(canAskChatForTaskError(taskShape({ stderrPath: 'D:/logs/task.stderr.log' }))).toBe(
      false,
    );
  });

  test('does not allow successful tasks without error context', () => {
    expect(canAskChatForTaskError(taskShape({ status: 'success' }))).toBe(false);
  });

  test('does not render error Ask AI for a successful task with persisted stream paths', () => {
    const successHtml = renderToStaticMarkup(
      createElement(RunTaskPanel, { task: runTask(), config, onClose: () => {} }),
    );
    const failedHtml = renderToStaticMarkup(
      createElement(RunTaskPanel, {
        task: runTask({ status: 'failed', exitCode: 0 }),
        config,
        onClose: () => {},
      }),
    );

    expect(successHtml).not.toContain('Ask AI');
    expect(failedHtml).toContain('Ask AI');
  });
});

describe('waiting details', () => {
  test('renders the active dependency wait instead of a blank waiting state', () => {
    const waitingConfig: RawPipelineConfig = {
      name: 'Dependency wait',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            { id: 'first', command: 'first' },
            { id: 'second', command: 'second' },
            {
              id: 'command',
              command: 'true',
              depends_on: ['first', 'second'],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(RunTaskPanel, {
        task: runTask({
          status: 'waiting',
          waitReason: {
            kind: 'dependencies',
            taskIds: ['main.first', 'main.second'],
          },
        } as Partial<RunTaskState>),
        config: waitingConfig,
        onClose: () => {},
      }),
    );

    expect(html).toContain('data-task-wait-reason="dependencies"');
    expect(html).toContain('Waiting for 2 dependencies');
    expect(html).toContain('main.first');
    expect(html).toContain('main.second');
  });

  test('renders actionable local trigger path and timeout without requiring them on the wire', () => {
    const waitingConfig: RawPipelineConfig = {
      name: 'Trigger wait',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'command',
              command: 'true',
              trigger: { type: 'file', path: 'input/drop.txt', timeout: '5m' },
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(RunTaskPanel, {
        task: runTask({
          status: 'waiting',
          waitReason: { kind: 'trigger', triggerType: 'file' },
        } as Partial<RunTaskState>),
        config: waitingConfig,
        onClose: () => {},
      }),
    );

    expect(html).toContain('data-task-wait-reason="trigger"');
    expect(html).toContain('Waiting for file trigger');
    expect(html).toContain('Watching input/drop.txt — relative to workspace root');
    expect(html).toContain('Trigger timeout 5m');
  });

  test('shows every authored deadline and does not hide possible defaults when none are authored', () => {
    const renderTriggerWait = (
      config: RawPipelineConfig,
      hostPlatform: 'windows' | 'linux' | 'mac' | null = null,
    ) =>
      renderToStaticMarkup(
        createElement(RunTaskPanel, {
          task: runTask({
            status: 'waiting',
            waitReason: { kind: 'trigger', triggerType: 'file' },
          } as Partial<RunTaskState>),
          config,
          hostPlatform,
          onClose: () => {},
        }),
      );
    const pipeline = (task: RawPipelineConfig['tracks'][number]['tasks'][number]) => ({
      name: 'Trigger wait',
      tracks: [{ id: 'main', name: 'Main', tasks: [task] }],
    });

    const taskTimeoutHtml = renderTriggerWait(
      pipeline({
        id: 'command',
        command: 'true',
        cwd: 'work/inbox',
        timeout: '10m',
        trigger: { type: 'file', path: 'drop.txt' },
      }),
    );
    expect(taskTimeoutHtml).toContain('Watching drop.txt — relative to CWD work/inbox');
    expect(taskTimeoutHtml).toContain('Task timeout 10m');

    const pipelineTimeoutHtml = renderTriggerWait({
      ...pipeline({ id: 'command', command: 'true', trigger: { type: 'file' } }),
      timeout: '30m',
    });
    expect(pipelineTimeoutHtml).toContain('Pipeline timeout 30m');

    const combinedHtml = renderTriggerWait({
      ...pipeline({
        id: 'command',
        command: 'true',
        timeout: '1m',
        trigger: { type: 'file', timeout: '5m' },
      }),
      timeout: '30s',
    });
    expect(combinedHtml).toContain('Authored deadlines');
    expect(combinedHtml).toContain('Trigger timeout 5m');
    expect(combinedHtml).toContain('Task timeout 1m');
    expect(combinedHtml).toContain('Pipeline timeout 30s');
    expect(combinedHtml).toContain('The earliest applicable deadline ends the wait.');

    const workspaceDefaultHtml = renderTriggerWait(
      pipeline({ id: 'command', command: 'true', trigger: { type: 'file' } }),
    );
    expect(workspaceDefaultHtml).toContain(
      'No authored deadline — runtime, trigger, or workspace defaults may still apply.',
    );

    const rootRelativeConfig = pipeline({
      id: 'command',
      command: 'true',
      trigger: { type: 'file', path: String.raw`\drop.txt` },
    });
    const posixHtml = renderTriggerWait(rootRelativeConfig, 'linux');
    expect(posixHtml).toContain('Watching \\drop.txt — relative to workspace root');

    const windowsHtml = renderTriggerWait(rootRelativeConfig, 'windows');
    expect(windowsHtml).toContain('Watching \\drop.txt — absolute path');
  });
});

describe('openTaskOutputPath', () => {
  test('reports reveal failures to the caller instead of swallowing them', async () => {
    const errors: string[] = [];

    await openTaskOutputPath('E:/repo/.tagma/logs/run_1/t.stdout', {
      reveal: async () => {
        throw new Error('File not found');
      },
      onError: (message) => errors.push(message),
    });

    expect(errors).toEqual(['File not found']);
  });
});
