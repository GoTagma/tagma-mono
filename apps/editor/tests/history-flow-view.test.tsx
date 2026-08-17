import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  HistoryFlowView,
  HistoryInspectorOverlay,
  canAskAiForHistoryTask,
  historyAskAiModeForTask,
} from '../src/components/run/HistoryFlowView';
import {
  RUN_HISTORY_INSPECTOR_PANEL_CLASSES,
  RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT,
  RUN_HISTORY_INSPECTOR_WIDTH_MAX,
  RUN_HISTORY_INSPECTOR_WIDTH_MIN,
  resolveRunHistoryInspectorWidth,
  resizeRunHistoryInspectorWidth,
  resizeRunHistoryInspectorWidthFromKey,
  storedRunHistoryInspectorWidth,
} from '../src/components/run/run-layout';
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

  test('uses the existing inspector width as the bounded resize minimum', () => {
    expect(RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT).toBe(320);
    expect(RUN_HISTORY_INSPECTOR_WIDTH_MIN).toBe(RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT);
    expect(RUN_HISTORY_INSPECTOR_WIDTH_MAX).toBe(640);

    expect(resizeRunHistoryInspectorWidth(320, 400, 320)).toBe(400);
    expect(resizeRunHistoryInspectorWidth(320, 400, -1000)).toBe(640);
    expect(resizeRunHistoryInspectorWidth(500, 400, 1000)).toBe(320);
  });

  test('resolves a saved width against the inspector container without a resize dead zone', () => {
    expect(resolveRunHistoryInspectorWidth(640, 376)).toEqual({
      width: 360,
      min: 320,
      max: 360,
    });
    expect(resolveRunHistoryInspectorWidth(640, 300)).toEqual({
      width: 284,
      min: 284,
      max: 284,
    });
    expect(resolveRunHistoryInspectorWidth(480, null)).toEqual({
      width: 480,
      min: 320,
      max: 640,
    });
  });

  test('maps keyboard resize controls to increasing and decreasing width', () => {
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'ArrowRight')).toBe(416);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'ArrowLeft')).toBe(384);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'ArrowUp', true)).toBe(464);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'ArrowDown', true)).toBe(336);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'Home')).toBe(320);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'End')).toBe(640);
    expect(resizeRunHistoryInspectorWidthFromKey(400, 'Escape')).toBeNull();
    expect(
      resizeRunHistoryInspectorWidthFromKey(284, 'ArrowRight', false, { min: 284, max: 284 }),
    ).toBeNull();
  });

  test('sanitizes persisted inspector widths', () => {
    expect(storedRunHistoryInspectorWidth(null)).toBe(320);
    expect(storedRunHistoryInspectorWidth('480')).toBe(480);
    expect(storedRunHistoryInspectorWidth('9999')).toBe(640);
    expect(storedRunHistoryInspectorWidth('not-a-width')).toBe(320);
  });

  test('renders the inspector resize separator with current bounds', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      <HistoryInspectorOverlay
        width={480}
        minWidth={320}
        maxWidth={640}
        style={{ width: 480, maxWidth: 'calc(100% - 1rem)' }}
        onPointerDown={noop}
        onPointerMove={noop}
        onPointerEnd={noop}
        onLostPointerCapture={noop}
        onKeyDown={noop}
      >
        <div>Inspector contents</div>
      </HistoryInspectorOverlay>,
    );

    expect(html).toContain('style="width:480px;max-width:calc(100% - 1rem)"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-valuemin="320"');
    expect(html).toContain('aria-valuemax="640"');
    expect(html).toContain('aria-valuenow="480"');
    expect(html).toContain('tabindex="0"');

    const disabledHtml = renderToStaticMarkup(
      <HistoryInspectorOverlay
        width={284}
        minWidth={284}
        maxWidth={284}
        style={{ width: 284 }}
        onPointerDown={noop}
        onPointerMove={noop}
        onPointerEnd={noop}
        onLostPointerCapture={noop}
        onKeyDown={noop}
      >
        <div>Inspector contents</div>
      </HistoryInspectorOverlay>,
    );
    expect(disabledHtml).toContain('aria-disabled="true"');
    expect(disabledHtml).toContain('tabindex="-1"');
  });

  test('keeps resizable history inspectors bounded to the available narrow viewport', async () => {
    const source = await Bun.file(
      new URL('../src/components/run/HistoryFlowView.tsx', import.meta.url),
    ).text();
    expect(source).toContain('className={RUN_HISTORY_INSPECTOR_PANEL_CLASSES}');
    expect(source.match(/<HistoryInspectorOverlay/g)).toHaveLength(2);
    expect(RUN_HISTORY_INSPECTOR_PANEL_CLASSES).not.toContain('w-[calc(100%-1rem)]');
    expect(RUN_HISTORY_INSPECTOR_PANEL_CLASSES).not.toContain('max-w-[20rem]');
    expect(source).toContain("maxWidth: 'calc(100% - 1rem)'");
    expect(source).toContain('Resize run inspector');
    expect(source).toContain('aria-valuemin={minWidth}');
    expect(source).toContain('aria-valuemax={maxWidth}');
    expect(source).toContain('w-full h-full flex flex-col');
  });

  test('allows unbroken inspector metadata and task names to wrap', async () => {
    const source = await Bun.file(
      new URL('../src/components/run/HistoryFlowView.tsx', import.meta.url),
    ).text();

    expect(source).toContain(
      'className="text-body font-mono text-tagma-muted [overflow-wrap:anywhere]"',
    );
    expect(source).toContain(
      'className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere] text-tagma-text"',
    );
  });
});
