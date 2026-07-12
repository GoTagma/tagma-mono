import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit3,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  Workflow,
  X,
  XCircle,
} from 'lucide-react';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';
import { getZoom } from '../../utils/zoom';
import { WorkflowTimeline } from './WorkflowTimeline';
import type {
  RunTaskState,
  TaskLogLine,
  WorkflowGraphEvent,
  WorkflowGraphNodeStatus,
  WorkflowRunResult,
  WorkflowPipelineEntry,
  WorkflowYamlEntry,
  WorkspaceYamlEntry,
} from '../../api/client';
import { appendLiveOutput, TASK_LOG_CAP } from '@tagma/types';
import {
  WORKFLOW_NODE_H,
  WORKFLOW_NODE_W,
  addWorkspacePipelineToGraph,
  buildDownstreamByPipeline,
  buildWorkflowGraphLayout,
  connectWorkflowPipelines,
  disconnectWorkflowPipelines,
  moveWorkflowPipeline,
  setWorkflowPipelineInfiniteLoop,
  removeWorkflowPipeline,
  resolveWorkflowPipelineEditorPath,
  setWorkflowPipelineLoopCount,
  workflowDragPositionFromPointer,
  workflowNodePointerOffset,
  workflowPathEquals,
  workflowPipelineLoopCount,
  workflowPipelineLoopIsInfinite,
  workflowPipelineRunLimit,
  type WorkflowGraphPosition,
} from './workflow-graph-model';

interface WorkflowViewProps {
  workflows: WorkflowYamlEntry[];
  selectedPath: string | null;
  workDir: string;
  workspacePipelines: WorkspaceYamlEntry[];
  events: WorkflowGraphEvent[];
  result?: WorkflowRunResult | null;
  running: boolean;
  onSelectWorkflow: (path: string) => void;
  onBack: () => void;
  onRefresh: () => void;
  onStart: (path: string) => void;
  onAbort?: () => void;
  onCreateWorkflow: () => void;
  onSaveWorkflow: (path: string, pipelines: WorkflowPipelineEntry[]) => Promise<void>;
  onEditPipeline: (path: string, workflowPath: string | null) => void;
}

export interface PipelineRuntimeState {
  status: WorkflowGraphNodeStatus;
  runId: string | null;
  runCount: number;
  maxRuns: number | null;
  attempts: Array<{
    attempt: number;
    runId: string | null;
    status: WorkflowGraphNodeStatus;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  }>;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface ConnectionDragState {
  fromId: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

const DRAG_PIPELINE_PATH = 'application/x-tagma-pipeline-path';

const STATUS_META: Record<
  WorkflowGraphNodeStatus,
  {
    label: string;
    icon: typeof Clock;
    dot: string;
    border: string;
    bg: string;
    text: string;
  }
> = {
  waiting: {
    label: 'Waiting',
    icon: Clock,
    dot: 'bg-tagma-muted/60',
    border: 'border-tagma-border',
    bg: 'bg-tagma-elevated',
    text: 'text-tagma-muted',
  },
  running: {
    label: 'Running',
    icon: Loader2,
    dot: 'bg-tagma-ready',
    border: 'border-tagma-ready/70',
    bg: 'bg-tagma-ready/8',
    text: 'text-tagma-ready',
  },
  success: {
    label: 'Success',
    icon: CheckCircle2,
    dot: 'bg-tagma-success',
    border: 'border-tagma-success/70',
    bg: 'bg-tagma-success/8',
    text: 'text-tagma-success',
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    dot: 'bg-tagma-error',
    border: 'border-tagma-error/70',
    bg: 'bg-tagma-error/8',
    text: 'text-tagma-error',
  },
  skipped: {
    label: 'Skipped',
    icon: SkipForward,
    dot: 'bg-tagma-muted/50',
    border: 'border-tagma-muted/30',
    bg: 'bg-tagma-muted/8',
    text: 'text-tagma-muted',
  },
  aborted: {
    label: 'Aborted',
    icon: Ban,
    dot: 'bg-tagma-warning',
    border: 'border-tagma-warning/70',
    bg: 'bg-tagma-warning/8',
    text: 'text-tagma-warning',
  },
};

export function buildWorkflowTaskSnapshots(
  events: readonly WorkflowGraphEvent[],
): Record<string, RunTaskState[]> {
  const byPipeline = new Map<string, Map<string, RunTaskState>>();

  function tasksFor(pipelineId: string): Map<string, RunTaskState> {
    const existing = byPipeline.get(pipelineId);
    if (existing) return existing;
    const next = new Map<string, RunTaskState>();
    byPipeline.set(pipelineId, next);
    return next;
  }

  for (const graphEvent of events) {
    if (graphEvent.type !== 'pipeline_event') continue;
    const event = graphEvent.event;
    const tasks = tasksFor(graphEvent.pipelineId);
    if (event.type === 'run_start') {
      tasks.clear();
      for (const task of event.tasks) tasks.set(task.taskId, { ...task, logs: [...task.logs] });
      continue;
    }
    if (event.type === 'task_update') {
      const prev = tasks.get(event.taskId);
      if (!prev) continue;
      const pick = <T,>(incoming: T | undefined, previous: T): T =>
        incoming !== undefined ? incoming : previous;
      tasks.set(event.taskId, {
        ...prev,
        status: event.status,
        startedAt: pick(event.startedAt, prev.startedAt),
        finishedAt: pick(event.finishedAt, prev.finishedAt),
        durationMs: pick(event.durationMs, prev.durationMs),
        exitCode: pick(event.exitCode, prev.exitCode),
        stdout: pick(event.stdout, prev.stdout),
        stderr: pick(event.stderr, prev.stderr),
        stdoutPath: pick(event.stdoutPath, prev.stdoutPath),
        stderrPath: pick(event.stderrPath, prev.stderrPath),
        stdoutBytes: pick(event.stdoutBytes, prev.stdoutBytes),
        stderrBytes: pick(event.stderrBytes, prev.stderrBytes),
        sessionId: pick(event.sessionId, prev.sessionId),
        normalizedOutput: pick(event.normalizedOutput, prev.normalizedOutput),
        failureKind: pick(event.failureKind, prev.failureKind),
        missingBinary: pick(event.missingBinary, prev.missingBinary),
        outputs: pick(event.outputs, prev.outputs),
        inputs: pick(event.inputs, prev.inputs),
        resolvedDriver: pick(event.resolvedDriver, prev.resolvedDriver),
        resolvedModel: pick(event.resolvedModel, prev.resolvedModel),
        resolvedPermissions: pick(event.resolvedPermissions, prev.resolvedPermissions),
      });
      continue;
    }
    if (event.type === 'task_log' && event.taskId !== null) {
      const prev = tasks.get(event.taskId);
      if (!prev) continue;
      const line: TaskLogLine = {
        level: event.level,
        timestamp: event.timestamp,
        text: event.text,
      };
      const logs =
        prev.logs.length >= TASK_LOG_CAP
          ? [...prev.logs.slice(prev.logs.length - TASK_LOG_CAP + 1), line]
          : [...prev.logs, line];
      tasks.set(event.taskId, { ...prev, logs, totalLogCount: prev.totalLogCount + 1 });
      continue;
    }
    if (event.type === 'task_output') {
      const prev = tasks.get(event.taskId);
      if (!prev) continue;
      tasks.set(
        event.taskId,
        event.stream === 'stdout'
          ? { ...prev, stdout: appendLiveOutput(prev.stdout, event.chunk) }
          : { ...prev, stderr: appendLiveOutput(prev.stderr, event.chunk) },
      );
    }
  }

  const out: Record<string, RunTaskState[]> = {};
  for (const [pipelineId, tasks] of byPipeline) out[pipelineId] = [...tasks.values()];
  return out;
}

export function buildRuntimeStateByPipeline(
  workflow: WorkflowYamlEntry | undefined,
  events: readonly WorkflowGraphEvent[],
  result: WorkflowRunResult | null | undefined,
): Map<string, PipelineRuntimeState> {
  const states = new Map<string, PipelineRuntimeState>();
  for (const pipeline of workflow?.pipelines ?? []) {
    states.set(pipeline.id, {
      status: 'waiting',
      runId: null,
      runCount: 0,
      maxRuns: workflowPipelineRunLimit(pipeline),
      attempts: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  }

  const applyNode = (node: {
    pipelineId: string;
    status: WorkflowGraphNodeStatus;
    runId?: string | null;
    runCount?: number | null;
    maxRuns?: number | null;
    attempts?: PipelineRuntimeState['attempts'];
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  }) => {
    const prev = states.get(node.pipelineId) ?? {
      status: 'waiting' as WorkflowGraphNodeStatus,
      runId: null,
      runCount: 0,
      maxRuns: 1,
      attempts: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    states.set(node.pipelineId, {
      status: node.status,
      runId: node.runId !== undefined ? node.runId : prev.runId,
      runCount:
        node.runCount !== undefined && node.runCount !== null ? node.runCount : prev.runCount,
      maxRuns: node.maxRuns !== undefined ? node.maxRuns : prev.maxRuns,
      attempts: node.attempts !== undefined ? node.attempts : prev.attempts,
      startedAt: node.startedAt !== undefined ? node.startedAt : prev.startedAt,
      finishedAt: node.finishedAt !== undefined ? node.finishedAt : prev.finishedAt,
      error: node.error !== undefined ? node.error : prev.error,
    });
  };

  for (const event of events) {
    if (event.type === 'graph_start' || event.type === 'graph_end') {
      for (const pipeline of event.pipelines) applyNode(pipeline);
      continue;
    }
    if (event.type === 'pipeline_update') {
      applyNode(event);
    }
  }

  for (const pipeline of result?.pipelines ?? []) applyNode(pipeline);
  return states;
}

function joinIds(ids: readonly string[], emptyLabel: string): string {
  return ids.length > 0 ? ids.join(', ') : emptyLabel;
}

function displayPipelineName(entry: WorkspaceYamlEntry): string {
  return entry.pipelineName && entry.pipelineName.trim() ? entry.pipelineName : entry.name;
}

function workflowPathMatchesPipelineEntry(
  workDir: string,
  workflowPath: string,
  entryPath: string,
): boolean {
  const resolvedWorkflowPath = resolveWorkflowPipelineEditorPath(workDir, workflowPath);
  const resolvedEntryPath = resolveWorkflowPipelineEditorPath(workDir, entryPath);
  return workflowPathEquals(resolvedWorkflowPath, resolvedEntryPath);
}

function workflowPipelineDisplayInfo(
  workDir: string,
  pipeline: WorkflowPipelineEntry,
  workspacePipelines: readonly WorkspaceYamlEntry[],
): { title: string; subtitle: string; pathLabel: string } {
  const entry =
    workspacePipelines.find((candidate) =>
      workflowPathMatchesPipelineEntry(workDir, pipeline.path, candidate.path),
    ) ?? null;
  return {
    title: entry ? displayPipelineName(entry) : pipeline.id,
    subtitle: `ID: ${pipeline.id}`,
    pathLabel: entry?.name ?? pipeline.path,
  };
}

function graphRunIdFromEvents(events: readonly WorkflowGraphEvent[]): string | null {
  return events[events.length - 1]?.graphRunId ?? null;
}

function formatWorkflowRunTime(value: string | null | undefined): string {
  if (!value) return 'n/a';
  return new Date(value).toLocaleTimeString();
}

function formatWorkflowRunLimit(maxRuns: number | null): string {
  return maxRuns === null ? 'infinite' : String(maxRuns);
}

function formatWorkflowRunProgress(runCount: number, maxRuns: number | null): string {
  const limit = formatWorkflowRunLimit(maxRuns);
  return runCount > 0 ? `Run ${runCount}/${limit}` : `0/${limit}`;
}

const WORKFLOW_LOOP_COUNT_DRAFT_RE = /^\d+$/;

export function parseWorkflowLoopCountDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!WORKFLOW_LOOP_COUNT_DRAFT_RE.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : null;
}

function WorkflowLoopCountInput({
  value,
  infinite,
  onCommit,
}: {
  value: number;
  infinite: boolean;
  onCommit: (count: number) => void;
}) {
  const [draft, setDraft] = useState(() => String(value));
  const [editing, setEditing] = useState(false);
  const [pendingValue, setPendingValue] = useState<number | null>(null);

  useEffect(() => {
    if (infinite) {
      setDraft('infinite');
      setEditing(false);
      setPendingValue(null);
      return;
    }
    if (pendingValue !== null) {
      if (pendingValue === value) setPendingValue(null);
      return;
    }
    if (!editing) setDraft(String(value));
  }, [editing, infinite, pendingValue, value]);

  const commitDraft = () => {
    if (infinite) return;
    const parsed = parseWorkflowLoopCountDraft(draft) ?? 1;
    setDraft(String(parsed));
    setEditing(false);
    if (parsed === value) {
      setPendingValue(null);
      return;
    }
    setPendingValue(parsed);
    onCommit(parsed);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.currentTarget.blur();
  };

  return (
    <input
      id="workflow-loop-count"
      type="text"
      inputMode={infinite ? undefined : 'numeric'}
      pattern={infinite ? undefined : '[0-9]*'}
      value={draft}
      disabled={infinite}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commitDraft}
      onKeyDown={handleKeyDown}
      className="w-full bg-tagma-surface border border-tagma-border px-2 py-1 text-[11px] font-mono text-tagma-text disabled:text-tagma-muted disabled:cursor-not-allowed"
      aria-label="Loop count"
    />
  );
}

export function WorkflowView({
  workflows,
  selectedPath,
  workDir,
  workspacePipelines,
  events,
  result,
  running,
  onSelectWorkflow,
  onBack,
  onRefresh,
  onStart,
  onAbort = () => {},
  onCreateWorkflow,
  onSaveWorkflow,
  onEditPipeline,
}: WorkflowViewProps) {
  const selectedWorkflow = workflows.find((entry) => entry.path === selectedPath) ?? workflows[0];
  const selectedWorkflowPath = selectedWorkflow?.path ?? null;
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(
    selectedWorkflow?.pipelines[0]?.id ?? null,
  );
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDragState | null>(null);
  const [hoveredConnectionTargetId, setHoveredConnectionTargetId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [draftPositions, setDraftPositions] = useState<Record<string, WorkflowGraphPosition>>({});
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [runPageVisible, setRunPageVisible] = useState(() => running || !!result);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setSelectedPipelineId(selectedWorkflow?.pipelines[0]?.id ?? null);
    setConnectionDrag(null);
    setHoveredConnectionTargetId(null);
    setSelectedEdgeKey(null);
    setDraftPositions({});
    setLocalError(null);
  }, [selectedWorkflowPath, selectedWorkflow]);

  useEffect(() => {
    setRunPageVisible(false);
  }, [selectedWorkflowPath]);

  useEffect(() => {
    if (running || result) setRunPageVisible(true);
  }, [result, running]);

  useEffect(() => {
    if (!selectedWorkflow) {
      setSelectedPipelineId(null);
      return;
    }
    if (!selectedWorkflow.pipelines.some((pipeline) => pipeline.id === selectedPipelineId)) {
      setSelectedPipelineId(selectedWorkflow.pipelines[0]?.id ?? null);
    }
  }, [selectedPipelineId, selectedWorkflow]);

  const renderedPipelines = useMemo(
    () =>
      (selectedWorkflow?.pipelines ?? []).map((pipeline) =>
        draftPositions[pipeline.id]
          ? { ...pipeline, position: draftPositions[pipeline.id] }
          : pipeline,
      ),
    [draftPositions, selectedWorkflow],
  );
  const taskSnapshots = useMemo(() => buildWorkflowTaskSnapshots(events), [events]);
  const runtimeByPipeline = useMemo(
    () => buildRuntimeStateByPipeline(selectedWorkflow, events, result),
    [events, result, selectedWorkflow],
  );
  const downstreamByPipeline = useMemo(
    () => buildDownstreamByPipeline(selectedWorkflow?.pipelines ?? []),
    [selectedWorkflow],
  );
  const graphLayout = useMemo(
    () => buildWorkflowGraphLayout(renderedPipelines),
    [renderedPipelines],
  );
  useEffect(() => {
    if (selectedEdgeKey && !graphLayout.edges.some((edge) => edge.key === selectedEdgeKey)) {
      setSelectedEdgeKey(null);
    }
  }, [graphLayout.edges, selectedEdgeKey]);
  const selectedPipeline =
    selectedWorkflow?.pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? null;
  const selectedPipelineDisplay = selectedPipeline
    ? workflowPipelineDisplayInfo(workDir, selectedPipeline, workspacePipelines)
    : null;
  const selectedState = selectedPipeline
    ? (runtimeByPipeline.get(selectedPipeline.id) ?? null)
    : null;
  const selectedDownstream = selectedPipeline
    ? (downstreamByPipeline.get(selectedPipeline.id) ?? [])
    : [];
  const selectedTasks = selectedPipelineId ? (taskSnapshots[selectedPipelineId] ?? []) : [];
  const selectedLoopCount = selectedPipeline ? workflowPipelineLoopCount(selectedPipeline) : 1;
  const selectedLoopInfinite = selectedPipeline
    ? workflowPipelineLoopIsInfinite(selectedPipeline)
    : false;
  const selectedLoopCountInputKey = selectedPipeline
    ? `${selectedWorkflowPath ?? ''}:${selectedPipeline.id}:${selectedLoopInfinite ? 'infinite' : 'count'}`
    : 'none';
  const graphRunId = result?.graphRunId ?? graphRunIdFromEvents(events);
  const hasRunActivity = running || !!result || events.length > 0;
  const isDesktop = hasDesktopBridge();

  const savePipelines = async (pipelines: WorkflowPipelineEntry[]) => {
    if (!selectedWorkflow) return;
    setLocalError(null);
    try {
      await onSaveWorkflow(selectedWorkflow.path, pipelines);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const pointerPosition = (
    e: ReactPointerEvent<HTMLElement>,
    drag: NonNullable<typeof dragRef.current>,
  ): WorkflowGraphPosition | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return workflowDragPositionFromPointer(
      e,
      rect,
      {
        x: drag.offsetX,
        y: drag.offsetY,
      },
      getZoom(),
    );
  };

  const beginNodeDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    pipelineId: string,
    pos: WorkflowGraphPosition,
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const offset = workflowNodePointerOffset(e, rect, pos, getZoom());
    dragRef.current = {
      id: pipelineId,
      pointerId: e.pointerId,
      offsetX: offset.x,
      offsetY: offset.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveNodeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const next = pointerPosition(e, drag);
    if (!next) return;
    drag.moved = true;
    setDraftPositions((current) => ({ ...current, [drag.id]: next }));
  };

  const finishNodeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
    if (!drag.moved || !selectedWorkflow) return;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const next = pointerPosition(e, drag);
    if (!next) return;
    void savePipelines(moveWorkflowPipeline(selectedWorkflow.pipelines, drag.id, next)).finally(
      () =>
        setDraftPositions((current) => {
          const copy = { ...current };
          delete copy[drag.id];
          return copy;
        }),
    );
  };

  const handleCanvasDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!selectedWorkflow) return;
    const path = e.dataTransfer.getData(DRAG_PIPELINE_PATH);
    const entry = workspacePipelines.find((pipeline) => pipeline.path === path);
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!entry || !rect) return;
    const next = addWorkspacePipelineToGraph(selectedWorkflow.pipelines, entry, {
      x: (e.clientX - rect.left) / getZoom(),
      y: (e.clientY - rect.top) / getZoom(),
    });
    void savePipelines(next);
  };

  const canvasPointerPosition = (
    e: ReactPointerEvent<HTMLElement>,
  ): WorkflowGraphPosition | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const zoom = getZoom();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const connectPipelineSlots = (upstreamId: string, downstreamId: string) => {
    if (!selectedWorkflow || upstreamId === downstreamId) return;
    try {
      const next = connectWorkflowPipelines(selectedWorkflow.pipelines, upstreamId, downstreamId);
      setSelectedEdgeKey(`${upstreamId}->${downstreamId}`);
      void savePipelines(next);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const beginConnectionDrag = (
    e: ReactPointerEvent<HTMLButtonElement>,
    pipelineId: string,
    pos: WorkflowGraphPosition,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const pointer = canvasPointerPosition(e);
    const startX = pos.x + WORKFLOW_NODE_W + 6;
    const startY = pos.y + WORKFLOW_NODE_H / 2;
    setConnectionDrag({
      fromId: pipelineId,
      pointerId: e.pointerId,
      startX,
      startY,
      x: pointer?.x ?? startX,
      y: pointer?.y ?? startY,
    });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveConnectionDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const pointer = canvasPointerPosition(e);
    if (!pointer) return;
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest('[data-workflow-input-slot]') as HTMLElement | null;
    const targetId = target?.dataset.workflowInputSlot ?? null;
    setHoveredConnectionTargetId(targetId && targetId !== connectionDrag?.fromId ? targetId : null);
    setConnectionDrag((current) =>
      current && current.pointerId === e.pointerId
        ? { ...current, x: pointer.x, y: pointer.y }
        : current,
    );
  };

  const finishConnectionDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connectionDrag || connectionDrag.pointerId !== e.pointerId) return;
    e.stopPropagation();
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest('[data-workflow-input-slot]') as HTMLElement | null;
    const downstreamId = target?.dataset.workflowInputSlot ?? null;
    const upstreamId = connectionDrag.fromId;
    setConnectionDrag(null);
    setHoveredConnectionTargetId(null);
    if (downstreamId) connectPipelineSlots(upstreamId, downstreamId);
  };

  const cancelConnectionDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connectionDrag || connectionDrag.pointerId !== e.pointerId) return;
    setConnectionDrag(null);
    setHoveredConnectionTargetId(null);
  };

  const beginCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-workflow-node], button, [data-workflow-edge]')) return;
    panRef.current = {
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      scrollLeft: e.currentTarget.scrollLeft,
      scrollTop: e.currentTarget.scrollTop,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const moveCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollLeft = pan.scrollLeft - (e.clientX - pan.clientX);
    scroller.scrollTop = pan.scrollTop - (e.clientY - pan.clientY);
  };

  const finishCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    panRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
  };

  const disconnect = (upstreamId: string, downstreamId: string) => {
    if (!selectedWorkflow) return;
    setSelectedEdgeKey(null);
    void savePipelines(
      disconnectWorkflowPipelines(selectedWorkflow.pipelines, upstreamId, downstreamId),
    );
  };

  const removeSelected = () => {
    if (!selectedWorkflow || !selectedPipeline) return;
    void savePipelines(removeWorkflowPipeline(selectedWorkflow.pipelines, selectedPipeline.id));
  };

  const updateSelectedLoopCount = (rawCount: number) => {
    if (!selectedWorkflow || !selectedPipeline) return;
    if (!selectedLoopInfinite && rawCount === selectedLoopCount) return;
    void savePipelines(
      setWorkflowPipelineLoopCount(selectedWorkflow.pipelines, selectedPipeline.id, rawCount),
    );
  };

  const updateSelectedInfiniteLoop = (infinite: boolean) => {
    if (!selectedWorkflow || !selectedPipeline) return;
    if (infinite === selectedLoopInfinite) return;
    void savePipelines(
      setWorkflowPipelineInfiniteLoop(selectedWorkflow.pipelines, selectedPipeline.id, infinite),
    );
  };

  return (
    <div className="h-full flex flex-col bg-tagma-bg text-tagma-text">
      <header
        className={`h-10 shrink-0 border-b border-tagma-border bg-tagma-surface flex items-center gap-2 pl-3 ${isDesktop ? 'app-drag-region pr-0' : 'pr-3'}`}
        onDoubleClick={(e) => {
          if (!isDesktop) return;
          if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
        }}
      >
        <button
          type="button"
          onClick={onBack}
          className="h-7 w-7 flex items-center justify-center border border-tagma-border text-tagma-muted hover:text-tagma-text"
          aria-label="Back to editor"
          title="Back to editor"
        >
          <ArrowLeft size={14} />
        </button>
        <Workflow size={14} className="hidden shrink-0 text-tagma-accent sm:block" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold truncate">
            {selectedWorkflow?.workflowName ?? selectedWorkflow?.name ?? 'Pipeline Graph'}
          </div>
          <div className="text-[10px] font-mono text-tagma-muted truncate">
            {selectedWorkflow?.path ?? 'No workflow graph selected'}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="h-7 w-7 flex items-center justify-center border border-tagma-border text-tagma-muted hover:text-tagma-text"
          aria-label="Refresh workflows"
          title="Refresh workflows"
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          onClick={onCreateWorkflow}
          className="h-7 px-2 flex items-center gap-1 border border-tagma-border text-[11px] text-tagma-muted hover:text-tagma-text"
          aria-label="New Graph"
          title="New Graph"
        >
          <Plus size={12} />
          <span className="hidden sm:inline">New Graph</span>
        </button>
        {selectedWorkflow && hasRunActivity && (
          <button
            type="button"
            onClick={() => setRunPageVisible((visible) => !visible)}
            className="h-7 px-2 flex items-center gap-1 border border-tagma-border text-[11px] text-tagma-muted hover:text-tagma-text"
            aria-label={runPageVisible ? 'Edit graph' : 'Show graph run'}
            title={runPageVisible ? 'Edit graph' : 'Show graph run'}
          >
            {runPageVisible ? <Workflow size={11} /> : <Play size={11} />}
            <span className="hidden md:inline">{runPageVisible ? 'Edit graph' : 'Graph run'}</span>
          </button>
        )}
        {selectedWorkflow && !running && (
          <button
            type="button"
            onClick={() => onStart(selectedWorkflow.path)}
            disabled={selectedWorkflow.pipelines.length === 0}
            aria-label="Run selected workflow"
            title="Run selected workflow"
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play size={11} />
            <span className="hidden md:inline">Run selected workflow</span>
          </button>
        )}
        {selectedWorkflow && running && (
          <button
            type="button"
            onClick={onAbort}
            aria-label="Abort workflow"
            title="Abort workflow"
            className="h-7 px-2 flex items-center gap-1 border border-tagma-error/40 text-[11px] text-tagma-error hover:bg-tagma-error/10"
          >
            <Ban size={11} />
            <span className="hidden md:inline">Abort workflow</span>
          </button>
        )}
        {isDesktop && <DesktopWindowControls />}
      </header>

      {runPageVisible && selectedWorkflow ? (
        <WorkflowRunPage
          workflow={selectedWorkflow}
          workDir={workDir}
          workspacePipelines={workspacePipelines}
          runtimeByPipeline={runtimeByPipeline}
          taskSnapshots={taskSnapshots}
          events={events}
          result={result ?? null}
          running={running}
          graphRunId={graphRunId}
          onEditGraph={() => setRunPageVisible(false)}
          onRunAgain={() => onStart(selectedWorkflow.path)}
          onAbort={onAbort}
        />
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 grid-rows-[minmax(12rem,auto)_minmax(24rem,1fr)_minmax(16rem,auto)] overflow-y-auto lg:grid-cols-[220px_minmax(360px,1fr)_320px] lg:grid-rows-1 lg:overflow-hidden xl:grid-cols-[260px_minmax(420px,1fr)_360px]">
          <aside className="max-h-[18rem] min-h-0 overflow-auto border-b border-tagma-border bg-tagma-surface/70 p-3 lg:max-h-none lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="text-[10px] font-mono uppercase tracking-wide text-tagma-muted">
                Workflow Graphs
              </div>
              <button
                type="button"
                onClick={onCreateWorkflow}
                className="h-6 px-2 inline-flex items-center gap-1 border border-tagma-border text-[10px] text-tagma-muted hover:text-tagma-text"
                title="New Graph"
                aria-label="New Graph"
              >
                <Plus size={11} />
                <span>New Graph</span>
              </button>
            </div>
            {workflows.length === 0 ? (
              <div className="text-[11px] font-mono text-tagma-muted">
                No workflow graphs found.
              </div>
            ) : (
              <div className="space-y-2">
                {workflows.map((workflow) => {
                  const active = workflow.path === selectedWorkflow?.path;
                  return (
                    <button
                      key={workflow.path}
                      type="button"
                      onClick={() => {
                        onSelectWorkflow(workflow.path);
                        setSelectedPipelineId(workflow.pipelines[0]?.id ?? null);
                      }}
                      aria-current={active ? true : undefined}
                      aria-label={`Select workflow ${workflow.name}`}
                      className={`w-full text-left border px-2.5 py-2 transition-colors ${
                        active
                          ? 'border-tagma-accent bg-tagma-elevated'
                          : 'border-tagma-border bg-tagma-bg hover:border-tagma-accent/50'
                      }`}
                    >
                      <div className="text-[12px] font-semibold truncate">
                        {workflow.workflowName ?? workflow.name}
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-tagma-muted truncate">
                        {workflow.name}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[9px] font-mono text-tagma-muted-dim">
                        <span>{workflow.pipelines.length} pipelines</span>
                        <span>
                          {workflow.pipelines.reduce((sum, p) => sum + p.depends_on.length, 0)} deps
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-5 text-[10px] font-mono uppercase tracking-wide text-tagma-muted mb-2">
              Workspace Pipelines
            </div>
            {workspacePipelines.length === 0 ? (
              <div className="text-[11px] font-mono text-tagma-muted">No pipelines found.</div>
            ) : (
              <div className="space-y-2">
                {workspacePipelines.map((pipeline) => {
                  const inGraph = Boolean(
                    selectedWorkflow?.pipelines.some((p) =>
                      workflowPathMatchesPipelineEntry(workDir, p.path, pipeline.path),
                    ),
                  );
                  return (
                    <button
                      key={pipeline.path}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_PIPELINE_PATH, pipeline.path);
                        e.dataTransfer.effectAllowed = 'copyMove';
                      }}
                      className="w-full text-left border border-tagma-border bg-tagma-bg px-2.5 py-2 hover:border-tagma-accent/60"
                      title={pipeline.path}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 text-[12px] font-semibold truncate">
                          {displayPipelineName(pipeline)}
                        </span>
                        {inGraph && (
                          <span className="shrink-0 text-[9px] font-mono text-tagma-accent">
                            In graph
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-tagma-muted truncate">
                        {pipeline.name}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <main className="min-h-[24rem] min-w-0 flex flex-col overflow-hidden border-b border-tagma-border lg:min-h-0 lg:border-b-0">
            {!selectedWorkflow ? (
              <div className="flex-1 flex items-center justify-center text-[12px] font-mono text-tagma-muted">
                No workflow graph selected.
              </div>
            ) : (
              <>
                <div className="h-9 shrink-0 border-b border-tagma-border bg-tagma-surface/40 px-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="text-[10px] font-mono uppercase tracking-wide text-tagma-muted">
                      Graph Canvas
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] font-mono text-tagma-muted">
                    <span>{selectedWorkflow.pipelines.length} pipelines</span>
                    <span>{graphLayout.edges.length} edges</span>
                  </div>
                </div>

                {localError && (
                  <div className="shrink-0 border-b border-tagma-error/30 bg-tagma-error/8 px-3 py-2 text-[11px] font-mono text-tagma-error">
                    {localError}
                  </div>
                )}

                <div
                  ref={scrollRef}
                  className="flex-1 min-h-0 overflow-auto timeline-grid cursor-grab active:cursor-grabbing"
                  data-workflow-pan-surface="true"
                  data-workflow-drop-surface="true"
                  aria-label="Drag canvas to pan"
                  title="Drag canvas to pan"
                  onPointerDown={beginCanvasPan}
                  onPointerMove={moveCanvasPan}
                  onPointerUp={finishCanvasPan}
                  onPointerCancel={finishCanvasPan}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDrop={handleCanvasDrop}
                >
                  <div
                    ref={canvasRef}
                    className="relative"
                    style={{
                      minWidth: graphLayout.width,
                      minHeight: graphLayout.height,
                    }}
                  >
                    <svg
                      className="absolute left-0 top-0 pointer-events-none"
                      width={graphLayout.width}
                      height={graphLayout.height}
                      style={{ overflow: 'visible' }}
                    >
                      <defs>
                        <marker
                          id="workflow-graph-arrow"
                          markerWidth="8"
                          markerHeight="8"
                          refX="7"
                          refY="4"
                          orient="auto"
                        >
                          <path d="M0,0 L8,4 L0,8 Z" fill="var(--tagma-edge-default-marker)" />
                        </marker>
                      </defs>
                      {graphLayout.edges.map((edge) => {
                        return (
                          <g key={edge.key}>
                            <path
                              d={edge.d}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={14}
                              pointerEvents="stroke"
                              role="button"
                              tabIndex={0}
                              data-workflow-edge={edge.key}
                              className="workflow-edge-hit-path outline-none focus:outline-none focus-visible:outline-none"
                              aria-label={`Select dependency ${edge.from} to ${edge.to}`}
                              style={{ outline: 'none' }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedEdgeKey(edge.key);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setSelectedEdgeKey(edge.key);
                                }
                              }}
                            />
                            <path
                              d={edge.d}
                              fill="none"
                              stroke="var(--tagma-edge-default)"
                              strokeWidth={1.6}
                              markerEnd="url(#workflow-graph-arrow)"
                              pointerEvents="none"
                            />
                          </g>
                        );
                      })}
                      {connectionDrag && (
                        <path
                          d={`M${connectionDrag.startX},${connectionDrag.startY} C${
                            (connectionDrag.startX + connectionDrag.x) / 2
                          },${connectionDrag.startY} ${
                            (connectionDrag.startX + connectionDrag.x) / 2
                          },${connectionDrag.y} ${connectionDrag.x},${connectionDrag.y}`}
                          fill="none"
                          stroke="rgb(var(--tagma-accent))"
                          strokeWidth={1.8}
                          strokeDasharray="4 4"
                          markerEnd="url(#workflow-graph-arrow)"
                          pointerEvents="none"
                        />
                      )}
                    </svg>

                    {graphLayout.edges.map((edge) => {
                      const selected = selectedEdgeKey === edge.key;
                      return (
                        <button
                          key={`${edge.key}:delete`}
                          type="button"
                          data-edge-delete={`${edge.from}->${edge.to}`}
                          aria-label={`Disconnect edge ${edge.from} to ${edge.to}`}
                          aria-hidden={selected ? undefined : true}
                          tabIndex={selected ? 0 : -1}
                          onClick={(e) => {
                            e.stopPropagation();
                            disconnect(edge.from, edge.to);
                          }}
                          className={`workflow-edge-delete-button absolute inline-flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 appearance-none items-center justify-center border border-tagma-border bg-tagma-surface p-0 leading-none text-tagma-muted shadow-none outline-none ring-0 hover:border-tagma-error hover:bg-tagma-surface hover:text-tagma-error focus:bg-tagma-surface focus:outline-none focus:ring-0 focus:shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none focus-visible:border-tagma-error focus-visible:text-tagma-error active:bg-tagma-surface active:outline-none active:ring-0 active:shadow-none transition-opacity ${
                            selected
                              ? 'pointer-events-auto opacity-100'
                              : 'pointer-events-none opacity-0'
                          }`}
                          title={`Disconnect edge ${edge.from} to ${edge.to}`}
                          style={{
                            left: edge.labelX,
                            top: edge.labelY,
                          }}
                        >
                          <X size={13} />
                        </button>
                      );
                    })}

                    {renderedPipelines.length === 0 && (
                      <div className="absolute left-8 top-8 border border-dashed border-tagma-border bg-tagma-surface/70 px-4 py-3 text-[12px] font-mono text-tagma-muted">
                        No pipelines in this graph.
                      </div>
                    )}

                    {renderedPipelines.map((pipeline) => {
                      const pos = graphLayout.positions.get(pipeline.id);
                      if (!pos) return null;
                      const state = runtimeByPipeline.get(pipeline.id);
                      const status = state?.status ?? 'waiting';
                      const meta = STATUS_META[status];
                      const Icon = meta.icon;
                      const selected = pipeline.id === selectedPipelineId;
                      const downstream = downstreamByPipeline.get(pipeline.id) ?? [];
                      const targetSlotActive = hoveredConnectionTargetId === pipeline.id;
                      const display = workflowPipelineDisplayInfo(
                        workDir,
                        pipeline,
                        workspacePipelines,
                      );
                      const loopCount = workflowPipelineLoopCount(pipeline);
                      const infiniteLoop = workflowPipelineLoopIsInfinite(pipeline);
                      const runCount = state?.runCount ?? 0;
                      const maxRuns = state ? state.maxRuns : workflowPipelineRunLimit(pipeline);
                      return (
                        <div
                          key={pipeline.id}
                          data-workflow-node={pipeline.id}
                          role="button"
                          tabIndex={0}
                          onPointerDown={(e) => beginNodeDrag(e, pipeline.id, pos)}
                          onPointerMove={moveNodeDrag}
                          onPointerUp={finishNodeDrag}
                          onPointerCancel={finishNodeDrag}
                          onClick={() => {
                            if (suppressClickRef.current) return;
                            setSelectedPipelineId(pipeline.id);
                          }}
                          onDoubleClick={() => onEditPipeline(pipeline.path, selectedWorkflowPath)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelectedPipelineId(pipeline.id);
                            }
                          }}
                          aria-pressed={selected}
                          aria-label={`Select pipeline ${display.title} (${pipeline.id}), ${meta.label}, upstream ${joinIds(
                            pipeline.depends_on,
                            'none',
                          )}, downstream ${joinIds(downstream, 'none')}`}
                          className={`absolute text-left border px-3 py-2 transition-colors cursor-grab active:cursor-grabbing ${meta.bg} ${
                            selected ? 'border-tagma-accent shadow-glow-accent' : meta.border
                          } hover:border-tagma-accent/70`}
                          style={{
                            left: pos.x,
                            top: pos.y,
                            width: WORKFLOW_NODE_W,
                            height: WORKFLOW_NODE_H,
                          }}
                        >
                          <button
                            type="button"
                            data-workflow-input-slot={pipeline.id}
                            data-workflow-slot-role="target"
                            aria-label={`Drop dependency on ${pipeline.id}`}
                            title={`Drop dependency on ${pipeline.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className={`absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 border bg-tagma-bg transition-all duration-100 cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tagma-accent/70 hover:scale-125 hover:border-tagma-accent hover:bg-tagma-accent hover:shadow-glow-accent ${
                              targetSlotActive
                                ? 'scale-125 border-tagma-accent bg-tagma-accent shadow-glow-accent ring-2 ring-tagma-accent/40'
                                : 'border-tagma-border'
                            }`}
                          />
                          <button
                            type="button"
                            data-workflow-output-slot={pipeline.id}
                            data-workflow-slot-role="source"
                            aria-label={`Drag dependency from ${pipeline.id}`}
                            title={`Drag dependency from ${pipeline.id}`}
                            onPointerDown={(e) => beginConnectionDrag(e, pipeline.id, pos)}
                            onPointerMove={moveConnectionDrag}
                            onPointerUp={finishConnectionDrag}
                            onPointerCancel={cancelConnectionDrag}
                            onClick={(e) => e.stopPropagation()}
                            className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 border border-tagma-border bg-tagma-bg transition-all duration-100 cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tagma-accent/70 hover:scale-125 hover:border-tagma-accent hover:bg-tagma-accent hover:shadow-glow-accent"
                          />
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-2">
                              <span className={`h-2 w-2 shrink-0 ${meta.dot}`} />
                              <div className="min-w-0">
                                <div className="text-[12px] font-semibold truncate">
                                  {display.title}
                                </div>
                                <div className="text-[9px] font-mono text-tagma-muted truncate">
                                  {display.subtitle}
                                </div>
                              </div>
                            </div>
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] font-mono ${meta.text}`}
                            >
                              <Icon
                                size={11}
                                className={status === 'running' ? 'animate-spin' : ''}
                              />
                              {meta.label}
                            </span>
                          </div>
                          <div className="mt-1 text-[10px] font-mono text-tagma-muted truncate">
                            {display.pathLabel}
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <div className="min-w-0 flex items-center gap-2 text-[9px] font-mono text-tagma-muted-dim">
                              <span>{pipeline.depends_on.length} upstream</span>
                              <span>{downstream.length} downstream</span>
                              {infiniteLoop ? (
                                <span>Loop infinite</span>
                              ) : (
                                loopCount > 1 && <span>Loop x{loopCount}</span>
                              )}
                              {runCount > 0 && (
                                <span>{formatWorkflowRunProgress(runCount, maxRuns)}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onEditPipeline(pipeline.path, selectedWorkflowPath);
                                }}
                                className="h-5 w-5 flex items-center justify-center border border-tagma-border text-tagma-muted hover:text-tagma-text"
                                title={`Edit ${pipeline.id} in pipeline editor`}
                                aria-label={`Edit ${pipeline.id} in pipeline editor`}
                              >
                                <Edit3 size={11} />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="shrink-0 border-t border-tagma-border bg-tagma-surface/70 p-3">
                  <div className="text-[10px] font-mono uppercase tracking-wide text-tagma-muted mb-2">
                    Dependency Edges
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {graphLayout.edges.length === 0 ? (
                      <span className="text-[11px] font-mono text-tagma-muted">
                        No dependency edges
                      </span>
                    ) : (
                      graphLayout.edges.map((edge) => (
                        <span
                          key={edge.key}
                          className="inline-flex items-center gap-1 text-[11px] font-mono border border-tagma-border bg-tagma-bg px-2 py-1"
                        >
                          {edge.from} -&gt; {edge.to}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </main>

          <aside className="max-h-[20rem] min-h-0 overflow-auto bg-tagma-surface p-3 lg:max-h-none lg:border-l lg:border-tagma-border">
            <div className="text-[10px] font-mono uppercase tracking-wide text-tagma-muted mb-2">
              Pipeline Detail
            </div>
            {!selectedPipeline ? (
              <div className="text-[11px] font-mono text-tagma-muted">No pipeline selected.</div>
            ) : (
              <div className="space-y-2">
                <div className="border border-tagma-border bg-tagma-bg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        {selectedPipelineDisplay?.title ?? selectedPipeline.id}
                      </div>
                      <div className="text-[10px] font-mono text-tagma-muted truncate">
                        ID: {selectedPipeline.id}
                      </div>
                      <div className="text-[10px] font-mono text-tagma-muted-dim truncate">
                        {selectedPipeline.path}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onEditPipeline(selectedPipeline.path, selectedWorkflowPath)}
                        className="h-6 w-6 flex items-center justify-center border border-tagma-border text-tagma-muted hover:text-tagma-text"
                        title="Edit in pipeline editor"
                        aria-label="Edit in pipeline editor"
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={removeSelected}
                        className="h-6 w-6 flex items-center justify-center border border-tagma-border text-tagma-muted hover:text-tagma-error"
                        title="Remove from graph"
                        aria-label="Remove from graph"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  {selectedState && (
                    <div
                      className={`mt-2 inline-flex chip-sm ${STATUS_META[selectedState.status].text} ${STATUS_META[selectedState.status].border}`}
                    >
                      Status {STATUS_META[selectedState.status].label}
                    </div>
                  )}
                </div>

                <div className="border border-tagma-border bg-tagma-bg p-2">
                  <label
                    className="field-label flex items-center gap-1"
                    htmlFor="workflow-loop-count"
                  >
                    <RefreshCw size={9} />
                    Loop Count
                  </label>
                  <WorkflowLoopCountInput
                    key={selectedLoopCountInputKey}
                    value={selectedLoopCount}
                    infinite={selectedLoopInfinite}
                    onCommit={updateSelectedLoopCount}
                  />
                  <label
                    className="mt-2 flex items-center gap-2 text-[11px] text-tagma-text cursor-pointer"
                    htmlFor="workflow-loop-infinite"
                  >
                    <input
                      id="workflow-loop-infinite"
                      type="checkbox"
                      checked={selectedLoopInfinite}
                      onChange={(e) => updateSelectedInfiniteLoop(e.currentTarget.checked)}
                      className="accent-tagma-accent"
                      aria-label="Infinite loop"
                    />
                    <span>Infinite loop</span>
                  </label>
                  <div className="mt-1 text-[10px] font-mono text-tagma-muted-dim">
                    1 runs once. Values above 1 repeat this pipeline exactly that many times.
                    Infinite loop repeats until the graph run is aborted.
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="border border-tagma-border bg-tagma-bg p-2">
                    <div className="field-label">Upstream</div>
                    <div className="space-y-1">
                      {selectedPipeline.depends_on.length === 0 ? (
                        <div className="text-[11px] font-mono text-tagma-muted">
                          No upstream dependencies
                        </div>
                      ) : (
                        selectedPipeline.depends_on.map((dep) => (
                          <div
                            key={dep}
                            className="min-w-0 text-[11px] font-mono text-tagma-muted truncate"
                          >
                            {dep}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="border border-tagma-border bg-tagma-bg p-2">
                    <div className="field-label">Downstream</div>
                    <div className="space-y-1">
                      {selectedDownstream.length === 0 ? (
                        <div className="text-[11px] font-mono text-tagma-muted">
                          No downstream pipelines
                        </div>
                      ) : (
                        selectedDownstream.map((downstream) => (
                          <div
                            key={downstream}
                            className="min-w-0 text-[11px] font-mono text-tagma-muted truncate"
                          >
                            {downstream}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {selectedState?.runId && (
                  <div className="border border-tagma-border bg-tagma-bg p-2">
                    <div className="field-label">Run</div>
                    <div className="text-[11px] font-mono text-tagma-muted truncate">
                      {selectedState.runId}
                    </div>
                  </div>
                )}

                {selectedState?.error && (
                  <div className="border border-tagma-error/30 bg-tagma-error/8 p-2">
                    <div className="field-label text-tagma-error">Error</div>
                    <div className="text-[11px] font-mono text-tagma-error select-text">
                      {selectedState.error}
                    </div>
                  </div>
                )}

                <div className="pt-2">
                  <div className="text-[10px] font-mono uppercase tracking-wide text-tagma-muted mb-2">
                    Task Events
                  </div>
                  {selectedTasks.length === 0 ? (
                    <div className="text-[11px] font-mono text-tagma-muted">
                      No task events for this pipeline yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {selectedTasks.map((task) => (
                        <div
                          key={task.taskId}
                          className="border border-tagma-border bg-tagma-bg p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[12px] font-semibold truncate">
                              {task.taskName}
                            </div>
                            <div className="text-[10px] font-mono uppercase text-tagma-muted">
                              {task.status}
                            </div>
                          </div>
                          <div className="text-[10px] font-mono text-tagma-muted truncate">
                            {task.taskId}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Execution Timeline - Collapsible Section */}
                {events.length > 0 && (
                  <div className="pt-2 border-t border-tagma-border">
                    <button
                      type="button"
                      onClick={() => setTimelineExpanded(!timelineExpanded)}
                      className="flex items-center gap-2 w-full text-left mb-2 hover:text-tagma-text text-tagma-muted transition-colors"
                    >
                      {timelineExpanded ? (
                        <ChevronDown size={14} className="shrink-0" />
                      ) : (
                        <ChevronRight size={14} className="shrink-0" />
                      )}
                      <div className="text-[10px] font-mono uppercase tracking-wide">
                        Execution Timeline
                      </div>
                    </button>
                    {timelineExpanded && (
                      <WorkflowTimeline
                        events={events}
                        pipelineIds={selectedWorkflow.pipelines.map((p) => p.id)}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function workflowRunOutcome(
  running: boolean,
  result: WorkflowRunResult | null,
): { label: string; status: WorkflowGraphNodeStatus; icon: typeof Clock } {
  if (running) return { label: 'Running', status: 'running', icon: Loader2 };
  if (!result) return { label: 'Waiting', status: 'waiting', icon: Clock };
  if (result.success) return { label: 'Succeeded', status: 'success', icon: CheckCircle2 };
  return { label: 'Failed', status: 'failed', icon: XCircle };
}

function workflowRuntimeCounts(states: readonly PipelineRuntimeState[]): {
  total: number;
  completed: number;
  failed: number;
  running: number;
} {
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const state of states) {
    if (
      state.status === 'success' ||
      state.status === 'failed' ||
      state.status === 'skipped' ||
      state.status === 'aborted'
    ) {
      completed += 1;
    }
    if (state.status === 'failed' || state.status === 'aborted') failed += 1;
    if (state.status === 'running') running += 1;
  }
  return { total: states.length, completed, failed, running };
}

export function WorkflowRunPage({
  workflow,
  workDir,
  workspacePipelines,
  runtimeByPipeline,
  taskSnapshots,
  events,
  result,
  running,
  graphRunId,
  onEditGraph,
  onRunAgain,
  onAbort,
}: {
  workflow: WorkflowYamlEntry;
  workDir: string;
  workspacePipelines: WorkspaceYamlEntry[];
  runtimeByPipeline: Map<string, PipelineRuntimeState>;
  taskSnapshots: Record<string, RunTaskState[]>;
  events: WorkflowGraphEvent[];
  result: WorkflowRunResult | null;
  running: boolean;
  graphRunId: string | null;
  onEditGraph?: () => void;
  onRunAgain?: () => void;
  onAbort?: () => void;
}) {
  const pipelineStates = workflow.pipelines.map(
    (pipeline) =>
      runtimeByPipeline.get(pipeline.id) ?? {
        status: 'waiting' as WorkflowGraphNodeStatus,
        runId: null,
        runCount: 0,
        maxRuns: workflowPipelineRunLimit(pipeline),
        attempts: [],
        startedAt: null,
        finishedAt: null,
        error: null,
      },
  );
  const counts = workflowRuntimeCounts(pipelineStates);
  const outcome = workflowRunOutcome(running, result);
  const OutcomeIcon = outcome.icon;
  const outcomeMeta = STATUS_META[outcome.status];

  return (
    <main className="flex-1 min-h-0 overflow-auto bg-tagma-bg">
      <div className="border-b border-tagma-border bg-tagma-surface/70 px-5 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-tagma-muted-dim">
              Graph Run
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <OutcomeIcon
                size={16}
                className={`${outcomeMeta.text} ${running ? 'animate-spin' : ''}`}
              />
              <h1 className="text-[18px] font-semibold text-tagma-text truncate">
                {outcome.label}
              </h1>
              <span className={`chip-sm ${outcomeMeta.text} ${outcomeMeta.border} bg-tagma-bg/60`}>
                {counts.completed}/{counts.total} pipelines
              </span>
              {counts.running > 0 && (
                <span className="chip-sm border-tagma-ready/30 text-tagma-ready bg-tagma-ready/8">
                  {counts.running} running
                </span>
              )}
              {counts.failed > 0 && (
                <span className="chip-sm border-tagma-error/30 text-tagma-error bg-tagma-error/8">
                  {counts.failed} failed
                </span>
              )}
            </div>
            <div className="mt-1 text-[11px] font-mono text-tagma-muted truncate">
              {workflow.workflowName ?? workflow.name}
              {graphRunId ? ` · ${graphRunId}` : ''}
            </div>
          </div>
          {(onEditGraph || onRunAgain || (running && onAbort)) && (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end">
              {onEditGraph && (
                <button
                  type="button"
                  onClick={onEditGraph}
                  className="h-7 px-2 flex items-center gap-1 border border-tagma-border text-[11px] text-tagma-muted hover:text-tagma-text"
                  title="Edit graph"
                  aria-label="Edit graph"
                >
                  <Workflow size={11} />
                  <span>Edit graph</span>
                </button>
              )}
              {running && onAbort ? (
                <button
                  type="button"
                  onClick={onAbort}
                  className="h-7 px-2 flex items-center gap-1 border border-tagma-error/40 text-[11px] text-tagma-error hover:bg-tagma-error/10"
                  title="Abort workflow"
                  aria-label="Abort workflow"
                >
                  <Ban size={11} />
                  <span>Abort</span>
                </button>
              ) : onRunAgain ? (
                <button
                  type="button"
                  onClick={onRunAgain}
                  disabled={workflow.pipelines.length === 0}
                  className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Run selected workflow"
                  aria-label="Run selected workflow"
                >
                  <Play size={11} />
                  <span>Run again</span>
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className="grid min-h-[calc(100%-80px)] grid-cols-1 gap-0 xl:grid-cols-[minmax(420px,1fr)_360px]">
        <section className="min-w-0 border-b border-tagma-border p-3 sm:p-4 xl:border-b-0 xl:border-r">
          <div className="mb-3 text-[10px] font-mono uppercase tracking-wide text-tagma-muted">
            Pipeline Runtime
          </div>
          <div className="space-y-3">
            {workflow.pipelines.map((pipeline, index) => {
              const state = pipelineStates[index]!;
              const meta = STATUS_META[state.status];
              const Icon = meta.icon;
              const display = workflowPipelineDisplayInfo(workDir, pipeline, workspacePipelines);
              const tasks = taskSnapshots[pipeline.id] ?? [];
              return (
                <div key={pipeline.id} className={`border ${meta.border} ${meta.bg} p-3`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Icon
                          size={13}
                          className={`${meta.text} ${state.status === 'running' ? 'animate-spin' : ''}`}
                        />
                        <div className="text-[13px] font-semibold truncate">{display.title}</div>
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-tagma-muted truncate">
                        {display.subtitle} · {display.pathLabel}
                      </div>
                    </div>
                    <div className={`shrink-0 text-[10px] font-mono ${meta.text}`}>
                      {meta.label}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] font-mono sm:grid-cols-3">
                    <div className="border border-tagma-border/60 bg-tagma-bg/60 px-2 py-1.5">
                      <div className="text-tagma-muted-dim">Run</div>
                      <div className="text-tagma-text">
                        {formatWorkflowRunProgress(state.runCount, state.maxRuns)}
                      </div>
                    </div>
                    <div className="border border-tagma-border/60 bg-tagma-bg/60 px-2 py-1.5">
                      <div className="text-tagma-muted-dim">Started</div>
                      <div className="text-tagma-text">
                        {formatWorkflowRunTime(state.startedAt)}
                      </div>
                    </div>
                    <div className="border border-tagma-border/60 bg-tagma-bg/60 px-2 py-1.5">
                      <div className="text-tagma-muted-dim">Finished</div>
                      <div className="text-tagma-text">
                        {formatWorkflowRunTime(state.finishedAt)}
                      </div>
                    </div>
                  </div>
                  {state.runId && (
                    <div className="mt-2 text-[10px] font-mono text-tagma-muted truncate">
                      Run ID: {state.runId}
                    </div>
                  )}
                  {state.error && (
                    <div className="mt-2 border border-tagma-error/25 bg-tagma-error/8 px-2 py-1.5 text-[10px] font-mono text-tagma-error">
                      {state.error}
                    </div>
                  )}
                  {tasks.length > 0 && (
                    <div className="mt-3 border-t border-tagma-border/50 pt-2">
                      <div className="mb-1.5 text-[9px] font-mono uppercase tracking-wide text-tagma-muted-dim">
                        Task Events
                      </div>
                      <div className="space-y-1">
                        {tasks.map((task) => (
                          <div
                            key={task.taskId}
                            className="flex items-center gap-2 text-[10px] font-mono"
                          >
                            <span className="w-16 shrink-0 uppercase text-tagma-muted">
                              {task.status}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-tagma-text">
                              {task.taskName}
                            </span>
                            <span className="shrink-0 text-tagma-muted-dim">{task.taskId}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <aside className="min-w-0 bg-tagma-surface/70 p-3 sm:p-4">
          <div className="mb-3 text-[10px] font-mono uppercase tracking-wide text-tagma-muted">
            Execution Timeline
          </div>
          {events.length === 0 ? (
            <div className="text-[11px] font-mono text-tagma-muted">
              No workflow events recorded yet.
            </div>
          ) : (
            <WorkflowTimeline events={events} pipelineIds={workflow.pipelines.map((p) => p.id)} />
          )}
        </aside>
      </div>
    </main>
  );
}
