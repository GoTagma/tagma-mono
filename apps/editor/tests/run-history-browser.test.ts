import { describe, expect, test } from 'bun:test';
import {
  applyStoppedRunToHistory,
  applyCompletedRunToHistory,
  applyFocusedRunningRunToHistory,
  applyTerminalRunFocusToHistory,
  configDagEdgesForRunCanvas,
  filterRunHistoryEntries,
  formatHistoryYamlExportFilename,
  isHistoryReplayBusy,
  formatRunProgressLabel,
  getHistoryRunPrimaryAction,
  hasRunningRunEntries,
  runHistoryEntryKind,
  shouldRenderLiveRunCanvas,
  summaryDagEdgesForRunCanvas,
  terminalRunFocusForStatus,
  terminalOutcomeForRunStatus,
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

  test('graph history entries are identifiable and searchable', () => {
    const runs = [
      entry({
        kind: 'graph',
        runId: 'graph_release',
        running: true,
        pipelineName: 'Release Flow',
        pipelineCounts: {
          total: 3,
          success: 1,
          failed: 0,
          skipped: 0,
          aborted: 0,
          running: 1,
          waiting: 1,
        },
      }),
      entry({ kind: 'pipeline', runId: 'run_build', success: true, pipelineName: 'Build Web' }),
    ];

    expect(runHistoryEntryKind(runs[0])).toBe('graph');
    expect(formatRunProgressLabel(runs[0])).toBe('1/3');
    expect(filterRunHistoryEntries(runs, 'running', 'release').map((run) => run.runId)).toEqual([
      'graph_release',
    ]);
    expect(filterRunHistoryEntries(runs, 'all', 'graph_release').map((run) => run.runId)).toEqual([
      'graph_release',
    ]);
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

  test('terminal run status selects the final outcome tab', () => {
    expect(terminalOutcomeForRunStatus('done')).toBe('success');
    expect(terminalOutcomeForRunStatus('failed')).toBe('failed');
    expect(terminalOutcomeForRunStatus('aborted')).toBe('failed');
    expect(terminalOutcomeForRunStatus('error')).toBe('failed');
    expect(terminalOutcomeForRunStatus('running')).toBeNull();
    expect(terminalOutcomeForRunStatus('starting')).toBeNull();
  });

  test('terminal run focus mirrors selecting the completed run row', () => {
    expect(terminalRunFocusForStatus('done', 'run_live')).toEqual({
      outcome: 'success',
      runId: 'run_live',
      viewMode: 'flow',
      success: true,
    });
    expect(terminalRunFocusForStatus('failed', 'run_live')).toEqual({
      outcome: 'failed',
      runId: 'run_live',
      viewMode: 'flow',
      success: false,
    });
    expect(terminalRunFocusForStatus('running', 'run_live')).toBeNull();
    expect(terminalRunFocusForStatus('done', null)).toBeNull();
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

  test('a completed running row moves into Successful while staying selected', () => {
    const runs = [entry({ runId: 'run_live', running: true, pipelineName: 'Live' })];
    const completed = applyCompletedRunToHistory(runs, 'run_live', '2026-05-22T08:01:00.000Z');

    expect(completed[0]).toMatchObject({
      runId: 'run_live',
      running: false,
      success: true,
      finishedAt: '2026-05-22T08:01:00.000Z',
    });
    expect(filterRunHistoryEntries(completed, 'success', '').map((run) => run.runId)).toEqual([
      'run_live',
    ]);
  });

  test('terminal focus keeps a stale refreshed row visible in the final tab', () => {
    const runs = [entry({ runId: 'run_live', running: true, pipelineName: 'Live' })];
    const focused = terminalRunFocusForStatus('done', 'run_live');
    expect(focused).not.toBeNull();

    const completed = applyTerminalRunFocusToHistory(runs, focused!, '2026-05-22T08:01:00.000Z');

    expect(completed[0]).toMatchObject({ runId: 'run_live', running: false, success: true });
    expect(filterRunHistoryEntries(completed, 'success', '').map((run) => run.runId)).toEqual([
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
