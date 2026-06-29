import { describe, expect, test } from 'bun:test';
import type { WorkflowPipelineEntry, WorkspaceYamlEntry } from '../src/api/client';
import {
  addWorkspacePipelineToGraph,
  connectWorkflowPipelines,
  disconnectWorkflowPipelines,
  moveWorkflowPipeline,
  setWorkflowPipelineLoopCount,
  setWorkflowPipelineInfiniteLoop,
  resolveWorkflowPipelineEditorPath,
  removeWorkflowPipeline,
  workflowPipelineLoopCount,
  workflowPipelineLoopIsInfinite,
  workflowPipelineRunLimit,
  workflowDragPositionFromPointer,
  workflowNodePointerOffset,
} from '../src/components/workflow/workflow-graph-model';

const workspacePipeline: WorkspaceYamlEntry = {
  name: 'build.yaml',
  path: 'E:/repo/.tagma/build/build.yaml',
  pipelineName: 'Build Pipeline',
  contentHash: 'abc',
  layoutHash: null,
  layoutMtimeMs: null,
  layoutSize: null,
  mtimeMs: 1,
  size: 100,
};

describe('workflow graph model', () => {
  test('adds a workspace pipeline with a stable unique id and drop position', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      { id: 'build', path: '.tagma/old/build.yaml', depends_on: [] },
    ];

    const next = addWorkspacePipelineToGraph(pipelines, workspacePipeline, { x: 240, y: 160 });

    expect(next).toEqual([
      { id: 'build', path: '.tagma/old/build.yaml', depends_on: [] },
      {
        id: 'build_2',
        path: 'E:/repo/.tagma/build/build.yaml',
        depends_on: [],
        position: { x: 240, y: 160 },
      },
    ]);
  });

  test('dragging the same workspace pipeline again creates a separate graph instance', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      {
        id: 'build',
        path: 'E:/repo/.tagma/build/build.yaml',
        depends_on: [],
        position: { x: 20, y: 40 },
      },
    ];

    expect(addWorkspacePipelineToGraph(pipelines, workspacePipeline, { x: 300, y: 220 })).toEqual([
      {
        id: 'build',
        path: 'E:/repo/.tagma/build/build.yaml',
        depends_on: [],
        position: { x: 20, y: 40 },
      },
      {
        id: 'build_2',
        path: 'E:/repo/.tagma/build/build.yaml',
        depends_on: [],
        position: { x: 300, y: 220 },
      },
    ]);
  });

  test('connects many-to-one and one-to-many dependencies, then disconnects stale edges', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      { id: 'build', path: '.tagma/build/build.yaml', depends_on: [] },
      { id: 'test', path: '.tagma/test/test.yaml', depends_on: [] },
      { id: 'deploy', path: '.tagma/deploy/deploy.yaml', depends_on: ['test'] },
    ];

    const oneToMany = connectWorkflowPipelines(
      connectWorkflowPipelines(pipelines, 'build', 'test'),
      'build',
      'deploy',
    );
    expect(oneToMany.find((p) => p.id === 'test')?.depends_on).toEqual(['build']);
    expect(oneToMany.find((p) => p.id === 'deploy')?.depends_on).toEqual(['test', 'build']);

    const manyToOne = connectWorkflowPipelines(oneToMany, 'test', 'deploy');
    expect(manyToOne.find((p) => p.id === 'deploy')?.depends_on).toEqual(['test', 'build']);

    expect(() => connectWorkflowPipelines(oneToMany, 'deploy', 'build')).toThrow(
      /circular dependency/i,
    );

    const moved = moveWorkflowPipeline(oneToMany, 'test', { x: 420, y: 80 });
    expect(moved.find((p) => p.id === 'test')?.position).toEqual({ x: 420, y: 80 });

    const disconnected = disconnectWorkflowPipelines(moved, 'build', 'test');
    expect(disconnected.find((p) => p.id === 'test')?.depends_on).toEqual([]);

    const removed = removeWorkflowPipeline(disconnected, 'test');
    expect(removed.map((p) => p.id)).toEqual(['build', 'deploy']);
    expect(removed.find((p) => p.id === 'deploy')?.depends_on).toEqual(['build']);
  });

  test('connects repeated pipeline paths as distinct graph instances', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      { id: 'build', path: '.tagma/build/build.yaml', depends_on: [] },
      { id: 'build_2', path: '.tagma/build/build.yaml', depends_on: [] },
    ];

    const next = connectWorkflowPipelines(pipelines, 'build', 'build_2');

    expect(next.find((p) => p.id === 'build_2')?.depends_on).toEqual(['build']);
    expect(next.find((p) => p.id === 'build')?.depends_on).toEqual([]);
  });

  test('stores graph loop count as a fixed-count lifecycle', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      { id: 'build', path: '.tagma/build/build.yaml', depends_on: [] },
      {
        id: 'deploy',
        path: '.tagma/deploy/deploy.yaml',
        depends_on: [],
        lifecycle: { max_runs: 4, stop_when: 'always' },
      },
    ];

    expect(workflowPipelineLoopCount(pipelines[0]!)).toBe(1);
    expect(workflowPipelineLoopCount(pipelines[1]!)).toBe(4);

    expect(
      setWorkflowPipelineLoopCount(pipelines, 'build', 3).find((p) => p.id === 'build'),
    ).toMatchObject({
      lifecycle: { max_runs: 3, stop_when: 'always' },
    });

    expect(
      setWorkflowPipelineLoopCount(pipelines, 'deploy', 1).find((p) => p.id === 'deploy')
        ?.lifecycle,
    ).toBeUndefined();
  });

  test('stores graph infinite loop as an infinite lifecycle', () => {
    const pipelines: WorkflowPipelineEntry[] = [
      { id: 'build', path: '.tagma/build/build.yaml', depends_on: [] },
    ];

    const infinite = setWorkflowPipelineInfiniteLoop(pipelines, 'build', true);

    expect(infinite[0]?.lifecycle).toEqual({ max_runs: 'infinite', stop_when: 'always' });
    expect(workflowPipelineLoopIsInfinite(infinite[0]!)).toBe(true);
    expect(workflowPipelineLoopCount(infinite[0]!)).toBe(1);
    expect(workflowPipelineRunLimit(infinite[0]!)).toBeNull();
    expect(setWorkflowPipelineInfiniteLoop(infinite, 'build', false)[0]?.lifecycle).toBeUndefined();
  });

  test('converts pointer movement into canvas-relative node positions', () => {
    const offset = workflowNodePointerOffset(
      { clientX: 260, clientY: 190 },
      { left: 100, top: 50 },
      { x: 140, y: 120 },
    );

    expect(offset).toEqual({ x: 20, y: 20 });
    expect(
      workflowDragPositionFromPointer(
        { clientX: 310, clientY: 240 },
        { left: 100, top: 50 },
        offset,
      ),
    ).toEqual({ x: 190, y: 170 });
  });

  test('converts zoomed pointer movement into canvas-relative node positions', () => {
    const offset = workflowNodePointerOffset(
      { clientX: 350, clientY: 250 },
      { left: 100, top: 50 },
      { x: 180, y: 140 },
      1.25,
    );

    expect(offset).toEqual({ x: 20, y: 20 });
    expect(
      workflowDragPositionFromPointer(
        { clientX: 412.5, clientY: 300 },
        { left: 100, top: 50 },
        offset,
        1.25,
      ),
    ).toEqual({ x: 230, y: 180 });
  });

  test('resolves workspace-relative workflow pipeline paths before opening editor', () => {
    expect(resolveWorkflowPipelineEditorPath('E:/repo', '.tagma/build/build.yaml')).toBe(
      'E:/repo/.tagma/build/build.yaml',
    );
    expect(resolveWorkflowPipelineEditorPath('E:/repo', 'E:/repo/.tagma/build/build.yaml')).toBe(
      'E:/repo/.tagma/build/build.yaml',
    );
  });
});
