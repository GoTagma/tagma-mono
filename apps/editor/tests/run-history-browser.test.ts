import { describe, expect, test } from 'bun:test';
import {
  applyStoppedRunToHistory,
  applyFocusedRunningRunToHistory,
  configDagEdgesForRunCanvas,
  filterRunHistoryEntries,
  formatHistoryYamlExportFilename,
  isHistoryReplayBusy,
  formatRunProgressLabel,
  getHistoryRunPrimaryAction,
  hasRunningRunEntries,
  shouldRenderLiveRunCanvas,
  summaryDagEdgesForRunCanvas,
  type OutcomeFilter,
} from '../src/components/run/RunHistoryBrowser';
import type { RunHistoryEntry, RunSummary } from '../src/api/client';

function entry(overrides: Partial<RunHistoryEntry>): RunHistoryEntry {
  return {
    runId: 'run_base',
    path: '/tmp/run_base',
    startedAt: '2026-05-22T08:00:00.000Z',
    sizeBytes: 0,
    ...overrides,
  };
}

const summary = {
  runId: 'run_done',
  pipelineName: 'Done',
  startedAt: '2026-05-22T07:00:00.000Z',
  finishedAt: '2026-05-22T07:01:00.000Z',
  success: true,
  error: null,
  tasks: [],
  tracks: [],
  hasYamlSnapshot: true,
} satisfies RunSummary;

describe('run history browser helpers', () => {
  test('running filter uses the explicit running marker, not missing success metadata', () => {
    const runs = [
      entry({ runId: 'run_live', running: true, pipelineName: 'Live' }),
      entry({ runId: 'run_old_unknown', pipelineName: 'Old without summary' }),
      entry({ runId: 'run_failed', success: false, pipelineName: 'Failed' }),
      entry({ runId: 'run_success', success: true, pipelineName: 'Success' }),
    ];

    expect(filterRunHistoryEntries(runs, 'running', '').map((run) => run.runId)).toEqual([
      'run_live',
    ]);
    expect(filterRunHistoryEntries(runs, 'failed', '').map((run) => run.runId)).toEqual([
      'run_failed',
    ]);
  });

  test('all outcome tabs keep applying the pipeline-name search', () => {
    const runs = [
      entry({ runId: 'run_live', running: true, pipelineName: 'Deploy API' }),
      entry({ runId: 'run_success', success: true, pipelineName: 'Build Web' }),
    ];

    expect(filterRunHistoryEntries(runs, 'all' satisfies OutcomeFilter, 'deploy')).toEqual([
      runs[0],
    ]);
    expect(filterRunHistoryEntries(runs, 'running', 'api')).toEqual([runs[0]]);
    expect(filterRunHistoryEntries(runs, 'running', 'web')).toEqual([]);
  });

  test('a selected running row gets Stop instead of Replay', () => {
    expect(
      getHistoryRunPrimaryAction({
        selectedRun: entry({ runId: 'run_live', running: true }),
        summary: { ...summary, runId: 'run_live', running: true, finishedAt: null },
        replayBusy: false,
        stopBusy: false,
      }),
    ).toMatchObject({ kind: 'stop', label: 'Stop', disabled: false });
  });

  test('replay busy is scoped to the replay request, not other live runs', () => {
    expect(isHistoryReplayBusy({ replayLoading: false, runStatus: 'running' })).toBe(false);
    expect(isHistoryReplayBusy({ replayLoading: true, runStatus: 'idle' })).toBe(true);
  });

  test('running tab spin state is driven by explicit live entries', () => {
    const runs = [entry({ runId: 'run_done', success: true }), entry({ runId: 'run_unknown' })];

    expect(hasRunningRunEntries(runs)).toBe(false);
    expect(hasRunningRunEntries([...runs, entry({ runId: 'run_live', running: true })])).toBe(true);
  });

  test('running progress label keeps the completed-over-total count', () => {
    expect(
      formatRunProgressLabel(
        entry({
          running: true,
          taskCounts: {
            total: 6,
            success: 2,
            failed: 1,
            timeout: 0,
            skipped: 1,
            blocked: 0,
            running: 1,
            waiting: 1,
            idle: 0,
          },
        }),
      ),
    ).toBe('4/6');
    expect(formatRunProgressLabel(entry({ running: true }))).toBeNull();
  });

  test('a manually stopped running row moves into Failed while staying selected', () => {
    const runs = [entry({ runId: 'run_live', running: true, pipelineName: 'Live' })];
    const stopped = applyStoppedRunToHistory(runs, 'run_live', '2026-05-22T08:01:00.000Z');

    expect(stopped[0]).toMatchObject({
      runId: 'run_live',
      running: false,
      success: false,
      finishedAt: '2026-05-22T08:01:00.000Z',
    });
    expect(filterRunHistoryEntries(stopped, 'failed', '').map((run) => run.runId)).toEqual([
      'run_live',
    ]);
  });

  test('focused running run is inserted at the top of RUNS before history reload returns', () => {
    const runs = [entry({ runId: 'run_old', running: false, success: true, pipelineName: 'Old' })];

    const focused = applyFocusedRunningRunToHistory(runs, {
      runId: 'run_live',
      pipelineName: 'Live Pipeline',
      startedAt: '2026-05-27T00:00:00.000Z',
    });

    expect(focused[0]).toMatchObject({
      runId: 'run_live',
      running: true,
      pipelineName: 'Live Pipeline',
    });
    expect(filterRunHistoryEntries(focused, 'running', '').map((run) => run.runId)).toEqual([
      'run_live',
    ]);
  });

  test('focused running run updates an existing RUNS row instead of duplicating it', () => {
    const runs = [entry({ runId: 'run_live', running: false, success: false })];

    const focused = applyFocusedRunningRunToHistory(runs, {
      runId: 'run_live',
      pipelineName: 'Live Pipeline',
      startedAt: '2026-05-27T00:00:00.000Z',
    });

    expect(focused).toHaveLength(1);
    expect(focused[0]).toMatchObject({ runId: 'run_live', running: true, success: undefined });
  });

  test('yaml export filenames use a safe pipeline/run stem', () => {
    expect(
      formatHistoryYamlExportFilename({
        selectedRunId: 'run_abc123',
        summary: { ...summary, pipelineName: 'Deploy: Web/API' },
      }),
    ).toBe('deploy-web-api-run_abc123.yaml');

    expect(formatHistoryYamlExportFilename({ selectedRunId: 'run_abc123', summary: null })).toBe(
      'run_abc123.yaml',
    );
  });

  test('selected current running instance uses the live run canvas', () => {
    expect(
      shouldRenderLiveRunCanvas({
        selectedRunId: 'run_live',
        liveRunId: 'run_live',
        summaryRunning: true,
        hasLiveSnapshot: true,
      }),
    ).toBe(true);

    expect(
      shouldRenderLiveRunCanvas({
        selectedRunId: 'run_past',
        liveRunId: 'run_live',
        summaryRunning: true,
        hasLiveSnapshot: true,
      }),
    ).toBe(false);
  });

  test('live history canvas derives dependency edges from the selected run summary', () => {
    const edges = summaryDagEdgesForRunCanvas({
      tasks: [
        { taskId: 'main.a', depends_on: [] },
        { taskId: 'main.b', depends_on: ['main.a'] },
        { taskId: 'main.c', depends_on: ['main.a', 'main.b'] },
      ],
    });

    expect(edges).toEqual([
      { from: 'main.a', to: 'main.b' },
      { from: 'main.a', to: 'main.c' },
      { from: 'main.b', to: 'main.c' },
    ]);
  });

  test('immediate live history canvas derives edges from the running snapshot before summary loads', () => {
    const edges = configDagEdgesForRunCanvas({
      name: 'Live',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            { id: 'a', name: 'A', command: 'echo a' },
            { id: 'b', name: 'B', command: 'echo b', depends_on: ['a'] },
          ],
        },
        {
          id: 'qa',
          name: 'QA',
          tasks: [{ id: 'c', name: 'C', command: 'echo c', depends_on: ['main.b'] }],
        },
      ],
    });

    expect(edges).toEqual([
      { from: 'main.a', to: 'main.b' },
      { from: 'main.b', to: 'qa.c' },
    ]);
  });
});
