import type { WorkflowPipelineEntry, WorkspaceYamlEntry } from '../../api/client';

export const WORKFLOW_INFINITE_LOOP = 'infinite' as const;
export const WORKFLOW_DEFAULT_RETRY_MAX_RUNS = 3;
export const WORKFLOW_DEFAULT_REPEAT_COUNT = 2;

export type WorkflowPipelineRunMode =
  'run-once' | 'retry-success' | 'repeat-count' | 'repeat-infinite' | 'custom';

export interface WorkflowGraphPosition {
  x: number;
  y: number;
}

export interface GraphEdgeView {
  key: string;
  from: string;
  to: string;
  d: string;
  labelX: number;
  labelY: number;
}

export const WORKFLOW_NODE_W = 220;
export const WORKFLOW_NODE_H = 96;
export const WORKFLOW_CANVAS_PAD = 28;
const LAYER_GAP = 110;
const ROW_GAP = 36;
const MAX_COORD = 100_000;

function clampCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_COORD, Math.max(0, Math.round(value)));
}

export function workflowNodePointerOffset(
  pointer: { clientX: number; clientY: number },
  canvasRect: { left: number; top: number },
  nodePosition: WorkflowGraphPosition,
  zoom = 1,
): WorkflowGraphPosition {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return {
    x: (pointer.clientX - canvasRect.left) / scale - nodePosition.x,
    y: (pointer.clientY - canvasRect.top) / scale - nodePosition.y,
  };
}

export function workflowDragPositionFromPointer(
  pointer: { clientX: number; clientY: number },
  canvasRect: { left: number; top: number },
  pointerOffset: WorkflowGraphPosition,
  zoom = 1,
): WorkflowGraphPosition {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return normalizeWorkflowPosition({
    x: (pointer.clientX - canvasRect.left) / scale - pointerOffset.x,
    y: (pointer.clientY - canvasRect.top) / scale - pointerOffset.y,
  });
}

export function normalizeWorkflowPosition(position: WorkflowGraphPosition): WorkflowGraphPosition {
  return {
    x: clampCoord(position.x),
    y: clampCoord(position.y),
  };
}

function stemFromYamlName(name: string): string {
  return name.replace(/\.ya?ml$/i, '').replace(/\.workflow$/i, '');
}

function toPipelineIdBase(entry: WorkspaceYamlEntry): string {
  const stem = stemFromYamlName(entry.name || entry.pipelineName || 'pipeline');
  const normalized = stem.replace(/[^A-Za-z0-9_-]/g, '_');
  if (/^[A-Za-z_]/.test(normalized)) return normalized || 'pipeline';
  return normalized ? `p_${normalized}` : 'pipeline';
}

function uniquePipelineId(base: string, pipelines: readonly WorkflowPipelineEntry[]): string {
  const used = new Set(pipelines.map((pipeline) => pipeline.id));
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function isWindowsWorkflowPath(path: string): boolean {
  return /\\/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function normalizeComparableWorkflowPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return isWindowsWorkflowPath(path) ? normalized.toLowerCase() : normalized;
}

export function workflowPathEquals(left: string, right: string): boolean {
  return normalizeComparableWorkflowPath(left) === normalizeComparableWorkflowPath(right);
}

function isAbsoluteWorkflowPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\');
}

export function resolveWorkflowPipelineEditorPath(workDir: string, pipelinePath: string): string {
  const path = pipelinePath.trim();
  if (!path) return path;
  const normalizedPath = path.replace(/\\/g, '/');
  if (isAbsoluteWorkflowPath(path)) return normalizedPath;

  const root = workDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const relativePath = normalizedPath.replace(/^\.\//, '');
  return root ? `${root}/${relativePath}` : relativePath;
}

export function addWorkspacePipelineToGraph(
  pipelines: readonly WorkflowPipelineEntry[],
  entry: WorkspaceYamlEntry,
  position: WorkflowGraphPosition,
): WorkflowPipelineEntry[] {
  const normalizedPosition = normalizeWorkflowPosition(position);
  return [
    ...pipelines,
    {
      id: uniquePipelineId(toPipelineIdBase(entry), pipelines),
      path: entry.path,
      depends_on: [],
      position: normalizedPosition,
    },
  ];
}

export function moveWorkflowPipeline(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
  position: WorkflowGraphPosition,
): WorkflowPipelineEntry[] {
  const normalizedPosition = normalizeWorkflowPosition(position);
  return pipelines.map((pipeline) =>
    pipeline.id === pipelineId ? { ...pipeline, position: normalizedPosition } : pipeline,
  );
}

export function removeWorkflowPipeline(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
): WorkflowPipelineEntry[] {
  return pipelines
    .filter((pipeline) => pipeline.id !== pipelineId)
    .map((pipeline) => ({
      ...pipeline,
      depends_on: pipeline.depends_on.filter((dep) => dep !== pipelineId),
    }));
}

export function workflowPipelineLoopCount(pipeline: WorkflowPipelineEntry): number {
  const count = pipeline.lifecycle?.max_runs;
  return typeof count === 'number' && Number.isInteger(count) && count > 1 ? count : 1;
}

export function workflowPipelineLoopIsInfinite(pipeline: WorkflowPipelineEntry): boolean {
  return pipeline.lifecycle?.max_runs === WORKFLOW_INFINITE_LOOP;
}

export function workflowPipelineRunLimit(pipeline: WorkflowPipelineEntry): number | null {
  return workflowPipelineLoopIsInfinite(pipeline) ? null : workflowPipelineLoopCount(pipeline);
}

function finiteWorkflowRunCount(pipeline: WorkflowPipelineEntry): number | null {
  const count = pipeline.lifecycle?.max_runs;
  return typeof count === 'number' && Number.isInteger(count) && count >= 2 ? count : null;
}

export function workflowPipelineRunMode(pipeline: WorkflowPipelineEntry): WorkflowPipelineRunMode {
  const lifecycle = pipeline.lifecycle;
  if (!lifecycle) return 'run-once';

  const stopWhen = lifecycle.stop_when ?? 'success';
  const finiteRuns = finiteWorkflowRunCount(pipeline);
  if (
    lifecycle.max_runs === WORKFLOW_INFINITE_LOOP &&
    stopWhen === 'always' &&
    lifecycle.repair !== true
  ) {
    return 'repeat-infinite';
  }
  if (finiteRuns !== null && stopWhen === 'success' && lifecycle.repair === true) {
    return 'retry-success';
  }
  if (finiteRuns !== null && stopWhen === 'always' && lifecycle.repair !== true) {
    return 'repeat-count';
  }
  if (
    (lifecycle.max_runs === undefined || lifecycle.max_runs === 1) &&
    stopWhen === 'success' &&
    lifecycle.repair !== true
  ) {
    return 'run-once';
  }
  return 'custom';
}

export function setWorkflowPipelineRunMode(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
  mode: Exclude<WorkflowPipelineRunMode, 'custom'>,
): WorkflowPipelineEntry[] {
  return pipelines.map((pipeline) => {
    if (pipeline.id !== pipelineId) return pipeline;
    const { lifecycle: _lifecycle, ...rest } = pipeline;
    if (mode === 'run-once') return rest;

    const currentRuns = finiteWorkflowRunCount(pipeline);
    if (mode === 'retry-success') {
      return {
        ...rest,
        lifecycle: {
          max_runs: currentRuns ?? WORKFLOW_DEFAULT_RETRY_MAX_RUNS,
          stop_when: 'success',
          repair: true,
        },
      };
    }
    if (mode === 'repeat-count') {
      return {
        ...rest,
        lifecycle: {
          max_runs: currentRuns ?? WORKFLOW_DEFAULT_REPEAT_COUNT,
          stop_when: 'always',
        },
      };
    }
    return {
      ...rest,
      lifecycle: { max_runs: WORKFLOW_INFINITE_LOOP, stop_when: 'always' },
    };
  });
}

export function setWorkflowPipelineMaxAttempts(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
  rawCount: number,
): WorkflowPipelineEntry[] {
  const count = Number.isFinite(rawCount) ? Math.max(2, Math.round(rawCount)) : 2;
  return pipelines.map((pipeline) => {
    if (pipeline.id !== pipelineId) return pipeline;
    const mode = workflowPipelineRunMode(pipeline);
    if (mode === 'retry-success') {
      return {
        ...pipeline,
        lifecycle: { max_runs: count, stop_when: 'success', repair: true },
      };
    }
    if (mode === 'repeat-count') {
      return { ...pipeline, lifecycle: { max_runs: count, stop_when: 'always' } };
    }
    return pipeline;
  });
}

export function setWorkflowPipelineLoopCount(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
  rawCount: number,
): WorkflowPipelineEntry[] {
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.round(rawCount)) : 1;
  if (count <= 1) return setWorkflowPipelineRunMode(pipelines, pipelineId, 'run-once');
  return pipelines.map((pipeline) =>
    pipeline.id === pipelineId
      ? { ...pipeline, lifecycle: { max_runs: count, stop_when: 'always' } }
      : pipeline,
  );
}

export function setWorkflowPipelineInfiniteLoop(
  pipelines: readonly WorkflowPipelineEntry[],
  pipelineId: string,
  infinite: boolean,
): WorkflowPipelineEntry[] {
  if (!infinite) return setWorkflowPipelineLoopCount(pipelines, pipelineId, 1);
  return setWorkflowPipelineRunMode(pipelines, pipelineId, 'repeat-infinite');
}

function hasAncestor(
  pipelines: readonly WorkflowPipelineEntry[],
  startId: string,
  targetId: string,
): boolean {
  const byId = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === targetId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const pipeline = byId.get(id);
    if (!pipeline) return false;
    return pipeline.depends_on.some((dep) => visit(dep));
  };
  return visit(startId);
}

export function connectWorkflowPipelines(
  pipelines: readonly WorkflowPipelineEntry[],
  upstreamId: string,
  downstreamId: string,
): WorkflowPipelineEntry[] {
  if (upstreamId === downstreamId) {
    throw new Error('A pipeline cannot depend on itself');
  }
  const ids = new Set(pipelines.map((pipeline) => pipeline.id));
  if (!ids.has(upstreamId) || !ids.has(downstreamId)) {
    throw new Error('Both pipelines must exist before they can be connected');
  }
  if (hasAncestor(pipelines, upstreamId, downstreamId)) {
    throw new Error('Connecting these pipelines would create a circular dependency');
  }
  return pipelines.map((pipeline) => {
    if (pipeline.id !== downstreamId) return pipeline;
    if (pipeline.depends_on.includes(upstreamId)) return pipeline;
    return { ...pipeline, depends_on: [...pipeline.depends_on, upstreamId] };
  });
}

export function disconnectWorkflowPipelines(
  pipelines: readonly WorkflowPipelineEntry[],
  upstreamId: string,
  downstreamId: string,
): WorkflowPipelineEntry[] {
  return pipelines.map((pipeline) =>
    pipeline.id === downstreamId
      ? { ...pipeline, depends_on: pipeline.depends_on.filter((dep) => dep !== upstreamId) }
      : pipeline,
  );
}

export function buildDownstreamByPipeline(
  pipelines: readonly WorkflowPipelineEntry[],
): Map<string, string[]> {
  const downstream = new Map<string, string[]>();
  for (const pipeline of pipelines) downstream.set(pipeline.id, []);
  for (const pipeline of pipelines) {
    for (const dep of pipeline.depends_on) {
      const list = downstream.get(dep);
      if (list) list.push(pipeline.id);
    }
  }
  return downstream;
}

export function buildWorkflowGraphLayout(pipelines: readonly WorkflowPipelineEntry[]): {
  positions: Map<string, WorkflowGraphPosition>;
  edges: GraphEdgeView[];
  width: number;
  height: number;
} {
  const byId = new Map<string, WorkflowPipelineEntry>();
  for (const pipeline of pipelines) byId.set(pipeline.id, pipeline);

  const depthById = new Map<string, number>();
  const visiting = new Set<string>();
  const depthFor = (id: string): number => {
    const cached = depthById.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const pipeline = byId.get(id);
    if (!pipeline) return 0;
    visiting.add(id);
    const deps = pipeline.depends_on.filter((dep) => byId.has(dep));
    const depth = deps.length === 0 ? 0 : Math.max(...deps.map(depthFor)) + 1;
    visiting.delete(id);
    depthById.set(id, depth);
    return depth;
  };

  for (const pipeline of pipelines) depthFor(pipeline.id);

  const columns = new Map<number, WorkflowPipelineEntry[]>();
  for (const pipeline of pipelines) {
    const depth = depthById.get(pipeline.id) ?? 0;
    const column = columns.get(depth) ?? [];
    column.push(pipeline);
    columns.set(depth, column);
  }

  const positions = new Map<string, WorkflowGraphPosition>();
  for (const [depth, column] of columns) {
    for (let row = 0; row < column.length; row++) {
      const pipeline = column[row]!;
      positions.set(
        pipeline.id,
        pipeline.position
          ? normalizeWorkflowPosition(pipeline.position)
          : {
              x: WORKFLOW_CANVAS_PAD + depth * (WORKFLOW_NODE_W + LAYER_GAP),
              y: WORKFLOW_CANVAS_PAD + row * (WORKFLOW_NODE_H + ROW_GAP),
            },
      );
    }
  }

  const edges: GraphEdgeView[] = [];
  for (const pipeline of pipelines) {
    const to = positions.get(pipeline.id);
    if (!to) continue;
    for (const dep of pipeline.depends_on) {
      const from = positions.get(dep);
      if (!from) continue;
      const x1 = from.x + WORKFLOW_NODE_W + 6;
      const y1 = from.y + WORKFLOW_NODE_H / 2;
      const x2 = to.x - 6;
      const y2 = to.y + WORKFLOW_NODE_H / 2;
      const mx = (x1 + x2) / 2;
      edges.push({
        key: `${dep}->${pipeline.id}`,
        from: dep,
        to: pipeline.id,
        d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        labelX: mx,
        labelY: (y1 + y2) / 2,
      });
    }
  }

  let maxX = WORKFLOW_CANVAS_PAD + WORKFLOW_NODE_W;
  let maxY = WORKFLOW_CANVAS_PAD + WORKFLOW_NODE_H;
  for (const pos of positions.values()) {
    maxX = Math.max(maxX, pos.x + WORKFLOW_NODE_W);
    maxY = Math.max(maxY, pos.y + WORKFLOW_NODE_H);
  }

  return {
    positions,
    edges,
    width: Math.max(maxX + WORKFLOW_CANVAS_PAD, 720),
    height: Math.max(maxY + WORKFLOW_CANVAS_PAD, 320),
  };
}
