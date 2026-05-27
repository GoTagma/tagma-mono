import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
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
  removeWorkflowPipeline,
  workflowDragPositionFromPointer,
  workflowNodePointerOffset,
  workflowPathEquals,
  type WorkflowGraphPosition,
} from './workflow-graph-model';

interface WorkflowViewProps {
  workflows: WorkflowYamlEntry[];
  selectedPath: string | null;
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

interface PipelineRuntimeState {
  status: WorkflowGraphNodeStatus;
  runId: string | null;
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

function buildRuntimeStateByPipeline(
  workflow: WorkflowYamlEntry | undefined,
  events: readonly WorkflowGraphEvent[],
  result: WorkflowRunResult | null | undefined,
): Map<string, PipelineRuntimeState> {
  const states = new Map<string, PipelineRuntimeState>();
  for (const pipeline of workflow?.pipelines ?? []) {
    states.set(pipeline.id, {
      status: 'waiting',
      runId: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  }

  const applyNode = (node: {
    pipelineId: string;
    status: WorkflowGraphNodeStatus;
    runId?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    error?: string | null;
  }) => {
    const prev = states.get(node.pipelineId) ?? {
      status: 'waiting' as WorkflowGraphNodeStatus,
      runId: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    states.set(node.pipelineId, {
      status: node.status,
      runId: node.runId !== undefined ? node.runId : prev.runId,
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

export function WorkflowView({
  workflows,
  selectedPath,
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
  const selectedState = selectedPipeline
    ? (runtimeByPipeline.get(selectedPipeline.id) ?? null)
    : null;
  const selectedDownstream = selectedPipeline
    ? (downstreamByPipeline.get(selectedPipeline.id) ?? [])
    : [];
  const selectedTasks = selectedPipelineId ? (taskSnapshots[selectedPipelineId] ?? []) : [];
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
    return workflowDragPositionFromPointer(e, rect, {
      x: drag.offsetX,
      y: drag.offsetY,
    });
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
    const offset = workflowNodePointerOffset(e, rect, pos);
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
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    void savePipelines(next);
  };

  const canvasPointerPosition = (
    e: ReactPointerEvent<HTMLElement>,
  ): WorkflowGraphPosition | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
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
        <Workflow size={14} className="text-tagma-accent" />
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
          <span>New Graph</span>
        </button>
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
            <span>Run selected workflow</span>
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
            <span>Abort workflow</span>
          </button>
        )}
        {isDesktop && <DesktopWindowControls />}
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(420px,1fr)_360px] overflow-hidden">
        <aside className="border-r border-tagma-border bg-tagma-surface/70 min-h-0 overflow-auto p-3">
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
            <div className="text-[11px] font-mono text-tagma-muted">No workflow graphs found.</div>
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
                    workflowPathEquals(p.path, pipeline.path),
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

        <main className="min-w-0 min-h-0 flex flex-col overflow-hidden">
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
                        className={`workflow-edge-delete-button absolute inline-flex -translate-x-1/2 -translate-y-1/2 appearance-none border-0 bg-transparent p-0 leading-none text-tagma-muted shadow-none outline-none ring-0 hover:bg-transparent hover:text-tagma-error focus:bg-transparent focus:outline-none focus:ring-0 focus:shadow-none focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none focus-visible:text-tagma-error active:bg-transparent active:outline-none active:ring-0 active:shadow-none transition-opacity ${
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
                        aria-label={`Select pipeline ${pipeline.id}, ${meta.label}, upstream ${joinIds(
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
                            <span className="text-[12px] font-semibold truncate">
                              {pipeline.id}
                            </span>
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
                        <div className="mt-2 text-[10px] font-mono text-tagma-muted truncate">
                          {pipeline.path}
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex items-center gap-2 text-[9px] font-mono text-tagma-muted-dim">
                            <span>{pipeline.depends_on.length} upstream</span>
                            <span>{downstream.length} downstream</span>
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

        <aside className="border-l border-tagma-border bg-tagma-surface min-h-0 overflow-auto p-3">
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
                    <div className="text-[13px] font-semibold truncate">{selectedPipeline.id}</div>
                    <div className="text-[10px] font-mono text-tagma-muted truncate">
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

              <div className="grid grid-cols-2 gap-2">
                <div className="border border-tagma-border bg-tagma-bg p-2">
                  <div className="field-label">Upstream</div>
                  <div className="space-y-1">
                    {selectedPipeline.depends_on.length === 0 ? (
                      <div className="text-[11px] font-mono text-tagma-muted">
                        No upstream dependencies
                      </div>
                    ) : (
                      selectedPipeline.depends_on.map((dep) => (
                        <div key={dep} className="min-w-0 text-[11px] font-mono text-tagma-muted truncate">
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
                      <div key={task.taskId} className="border border-tagma-border bg-tagma-bg p-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[12px] font-semibold truncate">{task.taskName}</div>
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
    </div>
  );
}
