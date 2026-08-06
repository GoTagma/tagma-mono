import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HistoryFlowView,
  canAskAiForHistoryTask,
  historyAskAiModeForTask,
} from '../src/components/run/HistoryFlowView';
import { RUN_HISTORY_INSPECTOR_PANEL_CLASSES } from '../src/components/run/run-layout';
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
  });

  test('keeps compare mode for successful historical task output', () => {
    const s = summary({
      success: true,
      tasks: [task({ status: 'success', exitCode: 0, stderrPath: null })],
    });

    expect(historyAskAiModeForTask(s, s.tasks[0]!)).toBe('compare');
  });

  test('offers Ask AI for a failed task that produced no output artifacts', () => {
    const s = summary({
      tasks: [
        task({
          stdoutPath: null,
          stderrPath: null,
          normalizedOutput: null,
        }),
      ],
    });

    expect(canAskAiForHistoryTask(s, s.tasks[0]!)).toBe(true);
  });

  test('does not offer output comparison for a successful task with no output', () => {
    const s = summary({
      success: true,
      tasks: [
        task({
          status: 'success',
          exitCode: 0,
          stdoutPath: null,
          stderrPath: null,
          normalizedOutput: null,
        }),
      ],
    });

    expect(canAskAiForHistoryTask(s, s.tasks[0]!)).toBe(false);
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

  test('restores snapshotted track heights and task y positions after the run finishes', () => {
    const html = renderToStaticMarkup(
      <HistoryFlowView
        summary={summary({
          tasks: [
            task({}),
            task({
              taskId: 'verify.check',
              trackId: 'verify',
              trackName: 'Verify',
              taskName: 'Check',
              status: 'success',
              exitCode: 0,
              stderrPath: null,
            }),
          ],
          tracks: [
            { id: 'main', name: 'Main' },
            { id: 'verify', name: 'Verify' },
          ],
          positions: {
            'main.cmd': { x: 120, y: 24 },
            'verify.check': { x: 320, y: 10 },
          },
          trackHeights: { main: 132, verify: 96 },
        })}
      />,
    );

    expect(html).toContain('height:132px');
    expect(html).toContain('left:120px;top:24px;width:176px;height:52px');
    expect(html).toContain('top:132px;height:96px');
    expect(html).toContain('left:320px;top:142px;width:176px;height:52px');
  });

  test('reserves viewport-relative blank space for two-dimensional drag panning', () => {
    const html = renderToStaticMarkup(<HistoryFlowView summary={summary()} />);

    expect(html).toContain('data-canvas-pan-surface');
    expect(html).toContain('data-canvas-bottom-spacer');
    expect(html).toContain('min-height:max(264px, calc(100% + 200px))');
    expect(html).toContain('height:64px');
  });

  test('bounds history inspectors to the available narrow viewport', async () => {
    const source = await Bun.file(
      new URL('../src/components/run/HistoryFlowView.tsx', import.meta.url),
    ).text();
    expect(source).toContain('className={RUN_HISTORY_INSPECTOR_PANEL_CLASSES}');
    expect(RUN_HISTORY_INSPECTOR_PANEL_CLASSES).toContain('w-[calc(100%-1rem)]');
    expect(RUN_HISTORY_INSPECTOR_PANEL_CLASSES).toContain('max-w-[20rem]');
    expect(source).toContain('w-full h-full flex flex-col');
  });

  test('allows unbroken inspector metadata and task names to wrap', async () => {
    const source = await Bun.file(
      new URL('../src/components/run/HistoryFlowView.tsx', import.meta.url),
    ).text();

    expect(source).toContain(
      'className="text-[11px] font-mono text-tagma-muted [overflow-wrap:anywhere]"',
    );
    expect(source).toContain(
      'className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] text-tagma-text"',
    );
  });
});
