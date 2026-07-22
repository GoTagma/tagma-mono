import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HistoryFlowView,
  formatRunSummaryTaskErrorAttachment,
  historyAskAiModeForTask,
} from '../src/components/run/HistoryFlowView';
import type { RunSummary, RunSummaryTask } from '../src/api/client';

function task(overrides: Partial<RunSummaryTask>): RunSummaryTask {
  return {
    taskId: 'main.cmd',
    trackId: 'main',
    trackName: 'Main',
    taskName: 'Run command',
    status: 'failed',
    startedAt: '2026-05-22T08:00:00.000Z',
    finishedAt: '2026-05-22T08:00:01.000Z',
    durationMs: 1000,
    exitCode: 1,
    driver: null,
    model: null,
    depends_on: [],
    command: 'exit 1',
    stdoutPath: 'main_cmd.stdout',
    stderrPath: 'main_cmd.stderr',
    normalizedOutput: null,
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run_failed',
    pipelineName: 'Command Pipeline',
    startedAt: '2026-05-22T08:00:00.000Z',
    finishedAt: '2026-05-22T08:00:01.000Z',
    success: false,
    error: null,
    tasks: [task({})],
    tracks: [{ id: 'main', name: 'Main' }],
    hasYamlSnapshot: true,
    ...overrides,
  };
}

describe('HistoryFlowView', () => {
  test('uses fix mode for failed task Ask AI instead of history comparison', () => {
    const s = summary();
    const t = s.tasks[0]!;

    expect(historyAskAiModeForTask(s, t)).toBe('fix');

    const attachment = formatRunSummaryTaskErrorAttachment(s, t, {
      stdout: 'before failure',
      stderr: 'command failed',
    });
    expect(attachment.label).toContain('main.cmd');
    expect(attachment.content).toContain('Run `run_failed` task `main.cmd` failed');
    expect(attachment.content).toContain('Command:');
    expect(attachment.content).toContain('command failed');
  });

  test('keeps compare mode for successful historical task output', () => {
    const s = summary({
      success: true,
      tasks: [task({ status: 'success', exitCode: 0, stderrPath: null })],
    });

    expect(historyAskAiModeForTask(s, s.tasks[0]!)).toBe('compare');
  });

  test('animates running task icons in the flow graph', () => {
    const s = summary({
      running: true,
      finishedAt: null,
      tasks: [task({ status: 'running', exitCode: null, finishedAt: null })],
    });

    const html = renderToStaticMarkup(<HistoryFlowView summary={s} />);

    expect(html).toContain('animate-spin');
  });

  test('reserves viewport-relative blank space for two-dimensional drag panning', () => {
    const html = renderToStaticMarkup(<HistoryFlowView summary={summary()} />);

    expect(html).toContain('data-canvas-pan-surface');
    expect(html).toContain('data-canvas-bottom-spacer');
    expect(html).toContain('min-height:max(264px, calc(100% + 200px))');
  });

  test('bounds history inspectors to the available narrow viewport', async () => {
    const source = await Bun.file(
      new URL('../src/components/run/HistoryFlowView.tsx', import.meta.url),
    ).text();
    expect(source).toContain('w-[calc(100%-1rem)] max-w-[18rem]');
    expect(source).toContain('w-full h-full bg-tagma-surface');
  });
});
