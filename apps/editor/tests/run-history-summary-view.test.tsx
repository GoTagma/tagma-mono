import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunSummary, RunSummaryTask } from '../src/api/client';
import { DetailPane } from '../src/components/run/RunHistoryBrowser';

function task(overrides: Partial<RunSummaryTask>): RunSummaryTask {
  return {
    taskId: 'main.running',
    trackId: 'main',
    trackName: 'Main',
    taskName: 'Running task',
    status: 'running',
    startedAt: '2026-08-12T08:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    driver: null,
    model: null,
    ...overrides,
  };
}

describe('run history summary view', () => {
  test('animates the run and task icons while they are running', () => {
    const runningTask = task({});
    const completedTask = task({
      taskId: 'main.completed',
      taskName: 'Completed task',
      status: 'success',
      finishedAt: '2026-08-12T08:00:01.000Z',
      durationMs: 1000,
      exitCode: 0,
    });
    const summary: RunSummary = {
      runId: 'run_live',
      pipelineName: 'Live pipeline',
      startedAt: '2026-08-12T08:00:00.000Z',
      finishedAt: null,
      success: false,
      running: true,
      error: null,
      tasks: [runningTask, completedTask],
      tracks: [{ id: 'main', name: 'Main' }],
    };

    const html = renderToStaticMarkup(
      <DetailPane
        selectedRunId={summary.runId}
        summary={summary}
        summaryLoading={false}
        summaryError={null}
        logContent={''}
        logRead={null}
        logLoading={false}
        yamlContent={null}
        yamlLoading={false}
        viewMode={'summary'}
        onViewMode={() => {}}
        primaryAction={null}
        actionError={null}
        tasksByTrack={new Map([['main', summary.tasks]])}
        showLiveRunCanvas={false}
        liveSnapshot={null}
        liveRunCanvasEdges={[]}
        liveRunCanvasPositions={new Map()}
      />,
    );

    expect(html.match(/animate-spin/g) ?? []).toHaveLength(2);
  });
});
