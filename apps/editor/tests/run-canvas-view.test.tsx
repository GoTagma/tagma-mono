import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RunCanvasView } from '../src/components/run/RunCanvasView';
import { RunTaskPanel } from '../src/components/run/RunTaskPanel';
import { TrackInfoPanel } from '../src/components/run/TrackInfoPanel';
import type { RawPipelineConfig, RunTaskState } from '../src/api/client';
import { useRunStore } from '../src/store/run-store';

const config: RawPipelineConfig = {
  name: 'Live Pipeline',
  tracks: [
    {
      id: 'main',
      name: 'Main',
      tasks: [{ id: 'build', name: 'Build', command: 'echo build' }],
    },
  ],
};

function runningTask(): RunTaskState {
  return {
    taskId: 'main.build',
    trackId: 'main',
    taskName: 'Build',
    status: 'running',
    startedAt: '2026-05-27T00:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    stdout: 'building...',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: null,
    stderrBytes: null,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
    missingBinary: null,
    resolvedDriver: null,
    resolvedModel: null,
    resolvedPermissions: null,
    outputs: null,
    inputs: null,
    logs: [],
    totalLogCount: 0,
  };
}

beforeEach(() => {
  Object.assign(globalThis, {
    document: { documentElement: {}, getElementById: () => null },
    getComputedStyle: () => ({ zoom: '1' }),
  });
  useRunStore.setState({
    active: true,
    viewMode: 'history',
    runId: 'run_live',
    status: 'running',
    tasks: new Map([['main.build', runningTask()]]),
    selectedTaskId: 'main.build',
    selectedTrackId: null,
    snapshot: config,
  });
});

describe('RunCanvasView', () => {
  test('renders the selected running instance as a live task canvas', () => {
    const html = renderToStaticMarkup(
      <RunCanvasView
        config={config}
        dagEdges={[]}
        positions={new Map([['main.build', { x: 120 }]])}
        scrollElementId="test-run-canvas"
        useEditorFolders={false}
      />,
    );

    expect(html).toContain('data-task-card="true"');
    expect(html).toContain('data-task-id="main.build"');
    expect(html).toContain('Build');
    expect(html).toContain('minimap');
    expect(html).toContain('data-canvas-pan-surface');
    expect(html).toContain('data-canvas-bottom-spacer');
    expect(html).toContain('min-height:264px');
    expect(html).toContain('flex-1 min-h-0 min-w-0 flex overflow-hidden relative');

    const panel = renderToStaticMarkup(
      <RunTaskPanel task={runningTask()} config={config} onClose={() => {}} />,
    );
    expect(panel).toContain('absolute inset-y-0 right-0 z-30');
    expect(panel).toContain('w-[calc(100%-1rem)]');
    expect(panel).toContain('md:relative');
  });

  test('uses the same compact overlay contract for track details', () => {
    const html = renderToStaticMarkup(
      <TrackInfoPanel track={config.tracks[0]!} config={config} onClose={() => {}} />,
    );

    expect(html).toContain('absolute inset-y-0 right-0 z-30');
    expect(html).toContain('w-[calc(100%-1rem)]');
    expect(html).toContain('Main');
  });
});
