import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkflowView, buildWorkflowTaskSnapshots } from '../src/components/workflow/WorkflowView';
import type { WorkflowGraphEvent, WorkflowYamlEntry, WorkspaceYamlEntry } from '../src/api/client';

const workflows: WorkflowYamlEntry[] = [
  {
    name: 'release.workflow.yaml',
    path: 'E:/repo/.tagma/workflows/release.workflow.yaml',
    workflowName: 'release-flow',
    contentHash: 'abc',
    mtimeMs: 1,
    size: 120,
    pipelines: [
      { id: 'p1', path: '.tagma/p1/p1.yaml', depends_on: [] },
      {
        id: 'p2',
        path: '.tagma/p2/p2.yaml',
        depends_on: ['p1'],
        position: { x: 320, y: 96 },
        lifecycle: { max_runs: 2, stop_when: 'always' },
      },
      { id: 'p3', path: '.tagma/p3/p3.yaml', depends_on: ['p1'] },
    ],
  },
  {
    name: 'deploy.workflow.yaml',
    path: 'E:/repo/.tagma/workflows/deploy.workflow.yaml',
    workflowName: 'deploy-flow',
    contentHash: 'def',
    mtimeMs: 2,
    size: 90,
    pipelines: [{ id: 'deploy', path: '.tagma/deploy/deploy.yaml', depends_on: [] }],
  },
];

const workspacePipelines: WorkspaceYamlEntry[] = [
  {
    name: 'p1.yaml',
    path: 'E:/repo/.tagma/p1/p1.yaml',
    pipelineName: 'Pipeline One',
    contentHash: 'p1',
    layoutHash: null,
    layoutMtimeMs: null,
    layoutSize: null,
    mtimeMs: 1,
    size: 120,
  },
  {
    name: 'p2.yaml',
    path: 'E:/repo/.tagma/p2/p2.yaml',
    pipelineName: 'Pipeline Two',
    contentHash: 'p2',
    layoutHash: null,
    layoutMtimeMs: null,
    layoutSize: null,
    mtimeMs: 1,
    size: 120,
  },
  {
    name: 'lint.yaml',
    path: 'E:/repo/.tagma/lint/lint.yaml',
    pipelineName: 'Lint',
    contentHash: 'lint',
    layoutHash: null,
    layoutMtimeMs: null,
    layoutSize: null,
    mtimeMs: 1,
    size: 100,
  },
];

const events: WorkflowGraphEvent[] = [
  {
    type: 'pipeline_event',
    graphRunId: 'graph_1',
    pipelineId: 'p1',
    attempt: 1,
    event: {
      type: 'run_start',
      runId: 'run_p1',
      tasks: [
        {
          taskId: 'main.task',
          trackId: 'main',
          taskName: 'Build',
          status: 'waiting',
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          stdout: '',
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          stdoutBytes: null,
          stderrBytes: null,
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
        },
      ],
    },
  },
  {
    type: 'pipeline_event',
    graphRunId: 'graph_1',
    pipelineId: 'p1',
    attempt: 1,
    event: {
      type: 'task_update',
      runId: 'run_p1',
      taskId: 'main.task',
      status: 'success',
      stdout: 'built',
      exitCode: 0,
    },
  },
];

function setElectronApi(enabled: boolean): void {
  const g = globalThis as { window?: unknown };
  if (enabled) {
    g.window = {
      electronAPI: {
        minimizeWindow: async () => {},
        toggleMaximizeWindow: async () => false,
        closeWindow: async () => {},
        isWindowMaximized: async () => false,
        onMaximizedChanged: () => () => {},
      },
    };
    return;
  }
  delete g.window;
}

describe('WorkflowView', () => {
  test('renders draggable desktop chrome in the header when running in Electron', () => {
    setElectronApi(true);
    try {
      const html = renderToStaticMarkup(
        <WorkflowView
          workflows={workflows}
          selectedPath={workflows[0]!.path}
          workspacePipelines={workspacePipelines}
          events={events}
          running={false}
          onSelectWorkflow={() => {}}
          onBack={() => {}}
          onRefresh={() => {}}
          onStart={() => {}}
          onCreateWorkflow={() => {}}
          onSaveWorkflow={async () => {}}
          onEditPipeline={() => {}}
        />,
      );

      expect(html).toContain('app-drag-region');
      expect(html).toContain('aria-label="Minimize window"');
      expect(html).toContain('aria-label="Maximize window"');
      expect(html).toContain('aria-label="Close window"');
    } finally {
      setElectronApi(false);
    }
  });

  test('renders workflow nodes, dependency fan-out, and task details', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('release-flow');
    expect(html).toContain('Pipeline One');
    expect(html).toContain('ID: p1');
    expect(html).toContain('p2');
    expect(html).toContain('p3');
    expect(html).toContain('p1 -&gt; p2');
    expect(html).toContain('p1 -&gt; p3');
    expect(html).toContain('left:320px');
    expect(html).toContain('top:96px');
    expect(html).toContain('Loop Count');
    expect(html).toContain('value="1"');
    expect(html).toContain('Loop x2');
    expect(html).toContain('Build');
    expect(html).toContain('success');
  });

  test('renders workflow selection, pipeline library, and graph operation affordances', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[1]!.path}
        workspacePipelines={workspacePipelines}
        events={[]}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('Workflow Graphs');
    expect(html).toContain('New Graph');
    expect(html).toContain('Workspace Pipelines');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('Lint');
    expect(html).toContain('deploy-flow');
    expect(html).toContain('release-flow');
    expect(html).toContain('Select workflow release.workflow.yaml');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('Graph Canvas');
    expect(html).toContain('Run selected workflow');
    expect(html).toContain('Drag dependency from deploy');
    expect(html).toContain('Drop dependency on deploy');
    expect(html).toContain('data-workflow-output-slot="deploy"');
    expect(html).toContain('data-workflow-input-slot="deploy"');
    expect(html).toContain('data-workflow-slot-role="source"');
    expect(html).toContain('data-workflow-slot-role="target"');
    expect(html).toContain('hover:scale-125');
    expect(html).toContain('hover:bg-tagma-accent');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('cursor-grab');
    expect(html).toContain('cursor-crosshair');
    expect(html).toContain('Edit deploy in pipeline editor');
  });

  test('renders a workflow graph run result page with runtime counts', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        result={{
          graphRunId: 'graph_1',
          success: true,
          abortReason: null,
          pipelines: [
            {
              pipelineId: 'p1',
              path: '.tagma/p1/p1.yaml',
              dependsOn: [],
              status: 'success',
              runId: 'run_p1',
              runCount: 1,
              maxRuns: 1,
              attempts: [
                {
                  attempt: 1,
                  runId: 'run_p1',
                  status: 'success',
                  startedAt: '2026-05-22T08:00:00.000Z',
                  finishedAt: '2026-05-22T08:00:01.000Z',
                  error: null,
                },
              ],
              startedAt: '2026-05-22T08:00:00.000Z',
              finishedAt: '2026-05-22T08:00:01.000Z',
              error: null,
            },
            {
              pipelineId: 'p2',
              path: '.tagma/p2/p2.yaml',
              dependsOn: ['p1'],
              status: 'success',
              runId: 'run_p2',
              runCount: 2,
              maxRuns: 2,
              attempts: [],
              startedAt: '2026-05-22T08:00:01.000Z',
              finishedAt: '2026-05-22T08:00:03.000Z',
              error: null,
            },
          ],
        }}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('Graph Run');
    expect(html).toContain('Succeeded');
    expect(html).toContain('graph_1');
    expect(html).toContain('Pipeline Runtime');
    expect(html).toContain('Pipeline Two');
    expect(html).toContain('Run 2/2');
    expect(html).toContain('Edit graph');
  });

  test('renders an abort affordance while a workflow graph is running', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={[]}
        running={true}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onAbort={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('Abort workflow');
    expect(html).toContain('aria-label="Abort workflow"');
  });

  test('renders selected pipeline dependency context and edit controls in the detail pane', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('Upstream');
    expect(html).toContain('No upstream dependencies');
    expect(html).toContain('Downstream');
    expect(html).toContain('p2');
    expect(html).toContain('p3');
    expect(html).toContain('Status');
    expect(html).toContain('Remove from graph');
    expect(html).toContain('Disconnect edge p1 to p2');
    expect(html).toContain('data-edge-delete="p1-&gt;p2"');
    expect(html).toContain('workflow-edge-delete-button');
    expect(html).toContain('bg-tagma-surface');
  });

  test('renders edge delete affordance with a tight square box around the icon', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('workflow-edge-delete-button');
    const edgeDeleteClasses = [
      ...html.matchAll(/class="([^"]*workflow-edge-delete-button[^"]*)"/g),
    ].map((match) => match[1] ?? '');
    expect(edgeDeleteClasses.length).toBeGreaterThan(0);
    for (const className of edgeDeleteClasses) {
      expect(className).toContain('h-4');
      expect(className).toContain('w-4');
      expect(className).toContain('p-0');
      expect(className).toContain('border');
      expect(className).toContain('border-tagma-border');
      expect(className).toContain('outline-none');
      expect(className).toContain('focus:outline-none');
      expect(className).toContain('focus:ring-0');
      expect(className).toContain('focus:shadow-none');
      expect(className).toContain('active:bg-tagma-surface');
      expect(className).toContain('active:outline-none');
    }
  });

  test('renders workflow edge hit paths without a browser focus rectangle', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('data-workflow-edge="p1-&gt;p2"');
    const edgeHitClasses = [...html.matchAll(/class="([^"]*workflow-edge-hit-path[^"]*)"/g)].map(
      (match) => match[1] ?? '',
    );
    expect(edgeHitClasses.length).toBeGreaterThan(0);
    for (const className of edgeHitClasses) {
      expect(className).toContain('outline-none');
      expect(className).toContain('focus:outline-none');
      expect(className).toContain('focus-visible:outline-none');
    }
  });

  test('renders panning affordance for large free-form graphs', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('data-workflow-pan-surface="true"');
    expect(html).toContain('Drag canvas to pan');
  });

  test('uses the full visible graph viewport as the pipeline drop surface', () => {
    const html = renderToStaticMarkup(
      <WorkflowView
        workflows={workflows}
        selectedPath={workflows[0]!.path}
        workspacePipelines={workspacePipelines}
        events={events}
        running={false}
        onSelectWorkflow={() => {}}
        onBack={() => {}}
        onRefresh={() => {}}
        onStart={() => {}}
        onCreateWorkflow={() => {}}
        onSaveWorkflow={async () => {}}
        onEditPipeline={() => {}}
      />,
    );

    expect(html).toContain('data-workflow-pan-surface="true"');
    expect(html).toContain('data-workflow-drop-surface="true"');
  });

  test('buildWorkflowTaskSnapshots folds nested pipeline events by pipeline id', () => {
    const snapshots = buildWorkflowTaskSnapshots(events);
    expect(snapshots.p1?.[0]?.taskName).toBe('Build');
    expect(snapshots.p1?.[0]?.status).toBe('success');
    expect(snapshots.p1?.[0]?.stdout).toBe('built');
  });
});
