import { useMemo, useState, useCallback, useRef } from 'react';
import {
  Check,
  X,
  Clock,
  SkipForward,
  Ban,
  Loader2,
  X as XIcon,
  Terminal,
  MessageSquare,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { api } from '../../api/client';
import type { RunSummary, RunSummaryTask, RunTaskOutput, TaskStatus } from '../../api/client';
import { useChatStore } from '../../store/chat-store';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  TRACK_H,
  CANVAS_PAD_RIGHT,
} from '../board/layout-constants';
import {
  resolveCanvasBottomSpacerHeight,
  resolveCanvasContentHeight,
  resolveCanvasScrollableMinHeight,
} from '../board/canvas-pan';
import { useCanvasPan } from '../board/use-canvas-pan';
import { CopyButton } from './CopyButton';

const HISTORY_COMPARE_INSTRUCTION =
  'Compare this historical version with the latest pipeline and explain what changed.';
const HISTORY_FIX_INSTRUCTION = 'Fix this bug.';
const HISTORY_FIX_STATUSES = new Set<TaskStatus>(['failed', 'timeout', 'blocked']);

const STATUS_CFG: Record<
  TaskStatus,
  { bar: string; bg: string; icon: typeof Check; iconColor: string }
> = {
  idle: { bar: '', bg: '', icon: Clock, iconColor: '' },
  waiting: { bar: 'bg-tagma-muted/50', bg: '', icon: Clock, iconColor: 'text-tagma-muted/60' },
  running: {
    bar: 'bg-tagma-ready',
    bg: 'bg-tagma-ready/8',
    icon: Loader2,
    iconColor: 'text-tagma-ready',
  },
  success: {
    bar: 'bg-tagma-success',
    bg: 'bg-tagma-success/8',
    icon: Check,
    iconColor: 'text-tagma-success',
  },
  failed: { bar: 'bg-tagma-error', bg: 'bg-tagma-error/8', icon: X, iconColor: 'text-tagma-error' },
  timeout: {
    bar: 'bg-tagma-warning',
    bg: 'bg-tagma-warning/8',
    icon: Clock,
    iconColor: 'text-tagma-warning',
  },
  skipped: {
    bar: 'bg-tagma-muted/40',
    bg: '',
    icon: SkipForward,
    iconColor: 'text-tagma-muted/50',
  },
  blocked: {
    bar: 'bg-tagma-warning',
    bg: 'bg-tagma-warning/8',
    icon: Ban,
    iconColor: 'text-tagma-warning',
  },
};

export function historyAskAiModeForTask(
  _summary: RunSummary,
  task: RunSummaryTask,
): 'compare' | 'fix' {
  if (HISTORY_FIX_STATUSES.has(task.status)) return 'fix';
  if (typeof task.exitCode === 'number' && task.exitCode !== 0) return 'fix';
  return 'compare';
}

function fenced(body: string): string {
  return '```\n' + body.trimEnd() + '\n```';
}

export function formatRunSummaryTaskErrorAttachment(
  summary: RunSummary,
  task: RunSummaryTask,
  output: { stdout?: string | null; stderr?: string | null } = {},
): { label: string; content: string } {
  const exitCode = task.exitCode == null ? 'n/a' : String(task.exitCode);
  const lines = [
    `Run \`${summary.runId}\` task \`${task.taskId}\` failed (status: ${task.status}, exit code: ${exitCode}).`,
    '',
    `Pipeline: ${summary.pipelineName}`,
    `Track: ${task.trackName}`,
    `Task: ${task.taskName}`,
    '',
  ];

  if (task.command) {
    lines.push('Command:', fenced(task.command), '');
  } else if (task.prompt) {
    lines.push('Prompt:', fenced(task.prompt), '');
  }

  if (output.stderr?.trim()) {
    lines.push('Last stderr:', fenced(output.stderr), '');
  }
  if (output.stdout?.trim()) {
    lines.push('Last stdout:', fenced(output.stdout), '');
  }
  if (task.normalizedOutput?.trim()) {
    lines.push('Normalized output:', fenced(task.normalizedOutput), '');
  }
  if (task.stderrPath) lines.push(`Full stderr log: ${task.stderrPath}`);
  if (task.stdoutPath) lines.push(`Full stdout log: ${task.stdoutPath}`);

  return {
    label: `Task \`${task.taskId}\` failed (exit ${exitCode})`,
    content: lines.join('\n').trimEnd(),
  };
}

async function readTaskOutputOrNull(
  runId: string,
  taskId: string,
  stream: 'stdout' | 'stderr',
  hasPath: boolean,
): Promise<string | null> {
  if (!hasPath) return null;
  try {
    const data = await api.getRunTaskOutput(runId, taskId, stream);
    return data?.content ?? null;
  } catch {
    return null;
  }
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

interface TrackGroup {
  id: string;
  name: string;
  color?: string;
  tasks: RunSummaryTask[];
  index: number;
}

interface TaskPos {
  x: number;
  y: number;
}

interface HistoryFlowViewProps {
  summary: RunSummary;
}

export function HistoryFlowView({ summary }: HistoryFlowViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const { didDragRef: panDidDragRef, handleMouseDown: handlePanMouseDown } =
    useCanvasPan(contentRef);

  const tracksMeta = useMemo(() => {
    if (summary.tracks?.length) return summary.tracks;
    const seen = new Map<string, { id: string; name: string; color?: string }>();
    for (const t of summary.tasks) {
      if (!seen.has(t.trackId)) {
        seen.set(t.trackId, { id: t.trackId, name: t.trackName, color: undefined });
      }
    }
    return Array.from(seen.values());
  }, [summary]);

  const trackGroups = useMemo((): TrackGroup[] => {
    const groups = new Map<string, TrackGroup>();
    for (let i = 0; i < tracksMeta.length; i++) {
      const tr = tracksMeta[i];
      groups.set(tr.id, { id: tr.id, name: tr.name, color: tr.color, tasks: [], index: i });
    }
    for (const t of summary.tasks) {
      const g = groups.get(t.trackId);
      if (g) g.tasks.push(t);
    }
    return Array.from(groups.values());
  }, [summary.tasks, tracksMeta]);

  const { taskPositions, edges } = useMemo(() => {
    const positions = new Map<string, TaskPos>();
    // Prefer the snapshotted editor layout so the history flowchart rebuilds
    // the exact left-to-right arrangement the user designed — otherwise
    // cross-track dependency edges tangle in a sequentially packed layout.
    const snapshot = summary.positions;
    const taskCountPerTrack = new Map<string, number>();
    for (const tg of trackGroups) {
      for (const t of tg.tasks) {
        const y = tg.index * TRACK_H + (TRACK_H - TASK_H) / 2;
        const snapX = snapshot?.[t.taskId]?.x;
        let x: number;
        if (typeof snapX === 'number') {
          x = snapX;
        } else {
          const count = taskCountPerTrack.get(tg.id) ?? 0;
          x = PAD_LEFT + count * (TASK_W + TASK_GAP);
          taskCountPerTrack.set(tg.id, count + 1);
        }
        positions.set(t.taskId, { x, y });
      }
    }

    const edgeList: { key: string; d: string }[] = [];
    for (const t of summary.tasks) {
      const deps = t.depends_on ?? [];
      for (const dep of deps) {
        const from = positions.get(dep);
        const to = positions.get(t.taskId);
        if (!from || !to) continue;
        const x1 = from.x + TASK_W + 4;
        const y1 = from.y + TASK_H / 2;
        const x2 = to.x - 4;
        const y2 = to.y + TASK_H / 2;
        const mx = (x1 + x2) / 2;
        edgeList.push({
          key: `${dep}->${t.taskId}`,
          d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        });
      }
    }

    return { taskPositions: positions, edges: edgeList };
  }, [trackGroups, summary.tasks, summary.positions]);

  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const [, pos] of taskPositions) {
      if (pos.x + TASK_W > maxX) maxX = pos.x + TASK_W;
    }
    // Match the live RunView canvas minimum so the history view has the
    // same "always scroll, never snap-back" feel when side panels toggle.
    return Math.max(maxX + CANVAS_PAD_RIGHT, 2000);
  }, [taskPositions]);

  const planHeight = trackGroups.length * TRACK_H;
  const canvasHeight = resolveCanvasContentHeight(planHeight);
  const canvasMinHeight = resolveCanvasScrollableMinHeight(planHeight);
  const canvasBottomSpacerHeight = resolveCanvasBottomSpacerHeight(planHeight);

  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current) {
      headerRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  const clearSelection = useCallback(() => {
    if (panDidDragRef.current) return;
    setSelectedTaskId(null);
    setSelectedTrackId(null);
  }, [panDidDragRef]);

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null;
    return summary.tasks.find((t) => t.taskId === selectedTaskId) ?? null;
  }, [selectedTaskId, summary.tasks]);

  const selectedTrack = useMemo((): TrackGroup | null => {
    if (!selectedTrackId) return null;
    return trackGroups.find((g) => g.id === selectedTrackId) ?? null;
  }, [selectedTrackId, trackGroups]);

  // Highlight the track row when either a track was explicitly clicked OR
  // a task inside that track is currently selected. The two selections are
  // otherwise fully independent — clicking a task does NOT set the track
  // selection, so closing the task panel cannot accidentally reveal the
  // track panel.
  const highlightTrackId = selectedTrackId ?? selectedTask?.trackId ?? null;

  return (
    // The side panels are positioned `absolute` inside this relative wrapper
    // so that opening/closing them does NOT reflow the canvas — matching the
    // live RunView's feel and eliminating the "jerk" the user sees when the
    // canvas is resized mid-scroll. `flex-1 h-full` ensures the canvas fills
    // the detail-pane body both when that body is flex (flow view) and when
    // it's a plain block fallback.
    <div className="flex-1 h-full flex overflow-hidden relative">
      <div
        ref={headerRef}
        className="shrink-0 border-r border-tagma-border overflow-hidden bg-tagma-surface/50"
        style={{ width: HEADER_W }}
      >
        {trackGroups.map((tg, i) => {
          const isSelected = highlightTrackId === tg.id;
          const successCount = tg.tasks.filter((t) => t.status === 'success').length;
          const failedCount = tg.tasks.filter((t) => t.status === 'failed').length;
          return (
            <div
              key={tg.id}
              className={`relative border-b border-tagma-border/60 overflow-hidden cursor-pointer transition-colors ${
                isSelected ? 'bg-tagma-accent/6' : ''
              } ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
              style={{ height: TRACK_H, width: HEADER_W, boxSizing: 'border-box' }}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedTaskId(null);
                setSelectedTrackId(tg.id);
              }}
            >
              <div className="h-full flex items-center px-3 gap-2">
                {tg.color && (
                  <span
                    className="w-2 h-2 shrink-0 rounded-sm"
                    style={{ backgroundColor: tg.color }}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-medium text-tagma-text truncate">{tg.name}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[8px] font-mono text-tagma-muted-dim">
                      {tg.tasks.length} tasks
                    </span>
                    {successCount > 0 && (
                      <span className="text-[8px] font-mono text-tagma-success">
                        {successCount} ok
                      </span>
                    )}
                    {failedCount > 0 && (
                      <span className="text-[8px] font-mono text-tagma-error">
                        {failedCount} fail
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div
          aria-hidden
          data-canvas-bottom-spacer
          className="pointer-events-none"
          style={{ height: canvasBottomSpacerHeight }}
        />
      </div>

      <div
        ref={contentRef}
        data-canvas-pan-surface={true}
        className="flex-1 min-w-0 overflow-auto timeline-grid hide-scrollbar cursor-grab active:cursor-grabbing"
        onScroll={syncScroll}
        onMouseDown={handlePanMouseDown}
      >
        <div
          className="relative w-full"
          style={{ minWidth: canvasWidth, minHeight: canvasMinHeight }}
          onClick={clearSelection}
        >
          {trackGroups.map((tg, i) => (
            <div
              key={tg.id}
              className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
              style={{ top: i * TRACK_H, height: TRACK_H }}
              onClick={clearSelection}
            />
          ))}

          <svg
            className="absolute left-0 top-0 pointer-events-none"
            width={canvasWidth}
            height={canvasHeight}
            style={{ overflow: 'visible' }}
          >
            {edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                style={{ stroke: 'var(--tagma-hist-edge)' }}
                strokeWidth={1.5}
              />
            ))}
          </svg>

          {summary.tasks.map((task) => {
            const pos = taskPositions.get(task.taskId);
            if (!pos) return null;
            const cfg = STATUS_CFG[task.status];
            const Icon = cfg.icon;
            const isSelected = selectedTaskId === task.taskId;
            return (
              <div
                key={task.taskId}
                data-task-id={task.taskId}
                className={`absolute border select-none flex flex-col justify-center px-2.5 cursor-pointer transition-colors ${
                  isSelected
                    ? 'border-tagma-accent bg-tagma-elevated'
                    : 'border-tagma-border/70 bg-tagma-elevated hover:bg-tagma-elevated/80'
                } ${cfg.bg && !isSelected ? cfg.bg : ''}`}
                style={{ left: pos.x, top: pos.y, width: TASK_W, height: TASK_H }}
                onMouseDown={(e) => {
                  // Block canvas pan from starting when the user clicks a
                  // task — otherwise the task appears draggable because
                  // the whole canvas scrolls under it. Also clear
                  // panDidDragRef inline so a prior pan's `true` doesn't
                  // stay stuck and block the click below.
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  panDidDragRef.current = false;
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (panDidDragRef.current) return;
                  setSelectedTrackId(null);
                  setSelectedTaskId(task.taskId);
                }}
              >
                {cfg.bar && <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${cfg.bar}`} />}
                <div className="flex items-center h-[24px] gap-[6px] pointer-events-none min-w-0 overflow-hidden">
                  <span className="text-[10px] font-medium truncate flex-1 leading-[24px] text-tagma-text">
                    {task.taskName}
                  </span>
                  <span className="flex items-center gap-[3px] shrink-0">
                    <Icon
                      size={9}
                      className={`${cfg.iconColor} ${task.status === 'running' ? 'animate-spin' : ''}`}
                    />
                    {task.durationMs != null && (
                      <span className={`text-[8px] font-mono tabular-nums ${cfg.iconColor}`}>
                        {formatDuration(task.durationMs)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="tagma-rail flex items-center h-[16px] gap-[4px] pointer-events-none min-w-0 overflow-hidden px-[3px]">
                  {task.command ? (
                    <span className="inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden bg-tagma-ready/15 text-tagma-ready/80">
                      <span className="truncate text-[7.5px] font-mono leading-[14px]">shell</span>
                    </span>
                  ) : (
                    <>
                      {task.driver && (
                        <span className="inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden bg-tagma-accent/12 text-tagma-accent/80">
                          <span className="truncate text-[7.5px] font-mono leading-[14px]">
                            {task.driver}
                          </span>
                        </span>
                      )}
                      {task.model && (
                        <span className="inline-flex items-center h-[14px] px-[4px] min-w-0 overflow-hidden bg-tagma-muted/12 text-tagma-muted/80">
                          <span className="truncate text-[7.5px] font-mono font-bold leading-[14px]">
                            {task.model}
                          </span>
                        </span>
                      )}
                    </>
                  )}
                  {task.exitCode != null && (
                    <span
                      className={`ml-auto shrink-0 whitespace-nowrap text-[7.5px] font-mono ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}
                    >
                      exit {task.exitCode}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Side panels as absolute overlays — canvas dimensions never change
          when they open/close, so scrollLeft/Top stay valid and the view
          doesn't jerk. */}
      {selectedTask && (
        <div className="absolute inset-y-0 right-0 z-20 w-[calc(100%-1rem)] max-w-[18rem]">
          <HistoryTaskPanel
            summary={summary}
            task={selectedTask}
            runId={summary.runId}
            onClose={() => {
              setSelectedTaskId(null);
            }}
          />
        </div>
      )}

      {!selectedTask && selectedTrack && (
        <div className="absolute inset-y-0 right-0 z-20 w-[calc(100%-1rem)] max-w-[18rem]">
          <HistoryTrackPanel
            track={selectedTrack}
            onClose={() => {
              setSelectedTrackId(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function HistoryTaskPanel({
  summary,
  task,
  runId,
  onClose,
}: {
  summary: RunSummary;
  task: RunSummaryTask;
  runId: string;
  onClose: () => void;
}) {
  const cfg = STATUS_CFG[task.status];
  const Icon = cfg.icon;
  return (
    <div className="w-full h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
      <div className="panel-header-sm">
        <h2 className="panel-title-sm truncate">{task.taskName}</h2>
        <button
          onClick={onClose}
          className="p-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
          aria-label="Close"
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <section>
          <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
            Result
          </div>
          <div className="pt-2.5 space-y-3">
            <div className="flex items-center gap-2 text-[10px] text-tagma-muted">
              {task.command ? (
                <>
                  <Terminal size={11} className="text-tagma-ready" /> Shell command
                </>
              ) : (
                <>
                  <MessageSquare size={11} className="text-tagma-muted/70" /> AI prompt
                </>
              )}
            </div>
            <div>
              <label className="field-label">Task ID</label>
              <div className="flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5">
                <span className="flex-1 min-w-0 truncate select-text" title={task.taskId}>
                  {task.taskId}
                </span>
                <CopyButton value={task.taskId} title="Copy task ID" />
              </div>
            </div>
            <div>
              <label className="field-label">Status</label>
              <div
                className={`chip-md ${
                  task.status === 'success'
                    ? 'bg-tagma-success/10 border-tagma-success/20 text-tagma-success'
                    : task.status === 'failed'
                      ? 'bg-tagma-error/10 border-tagma-error/20 text-tagma-error'
                      : task.status === 'timeout'
                        ? 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning'
                        : 'bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted'
                }`}
              >
                <Icon size={11} className={cfg.iconColor} />
                {task.status}
              </div>
            </div>
            {task.startedAt && (
              <div>
                <label className="field-label">Started</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {new Date(task.startedAt).toLocaleTimeString()}
                </div>
              </div>
            )}
            {task.finishedAt && (
              <div>
                <label className="field-label">Finished</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {new Date(task.finishedAt).toLocaleTimeString()}
                </div>
              </div>
            )}
            {task.durationMs != null && (
              <div>
                <label className="field-label">Duration</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {formatDuration(task.durationMs)}
                </div>
              </div>
            )}
            {task.exitCode != null && (
              <div>
                <label className="field-label">Exit Code</label>
                <div
                  className={`text-[11px] font-mono ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}
                >
                  {task.exitCode}
                </div>
              </div>
            )}
            {!task.command && task.driver && (
              <div>
                <label className="field-label">Driver</label>
                <div className="text-[11px] font-mono text-tagma-muted">{task.driver}</div>
              </div>
            )}
            {!task.command && task.model && (
              <div>
                <label className="field-label">Model</label>
                <div className="text-[11px] font-mono text-tagma-muted">{task.model}</div>
              </div>
            )}
            {!task.command && task.sessionId && (
              <div>
                <label className="field-label">Session</label>
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5">
                  <span className="flex-1 min-w-0 truncate select-text" title={task.sessionId}>
                    {task.sessionId}
                  </span>
                  <CopyButton value={task.sessionId} title="Copy session ID" />
                </div>
              </div>
            )}
          </div>
        </section>

        {(task.prompt || task.command) && (
          <section>
            <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
              {task.command ? 'Command' : 'Prompt'}
            </div>
            <pre className="select-text pt-2.5 text-[10px] font-mono text-tagma-muted whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {task.command ?? task.prompt}
            </pre>
          </section>
        )}

        <TaskOutputSection
          summary={summary}
          task={task}
          runId={runId}
          taskId={task.taskId}
          stdoutPath={task.stdoutPath}
          stderrPath={task.stderrPath}
          normalizedOutput={task.normalizedOutput}
        />
      </div>
    </div>
  );
}

function HistoryTrackPanel({ track, onClose }: { track: TrackGroup; onClose: () => void }) {
  const successCount = track.tasks.filter((t) => t.status === 'success').length;
  const failedCount = track.tasks.filter((t) => t.status === 'failed').length;
  const skippedCount = track.tasks.filter((t) => t.status === 'skipped').length;
  const totalMs = track.tasks.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  return (
    <div className="w-full h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
      <div className="panel-header-sm">
        <h2 className="panel-title-sm truncate">{track.name}</h2>
        <button
          onClick={onClose}
          className="p-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
          aria-label="Close"
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <section>
          <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
            Track Summary
          </div>
          <div className="pt-2.5 space-y-3">
            <div>
              <label className="field-label">Tasks</label>
              <div className="text-[11px] font-mono text-tagma-muted">{track.tasks.length}</div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {successCount > 0 && (
                <span className="chip-xs bg-tagma-success/10 border-tagma-success/20 text-tagma-success">
                  <Check size={7} />
                  <span className="tabular-nums">{successCount}</span>
                </span>
              )}
              {failedCount > 0 && (
                <span className="chip-xs bg-tagma-error/10 border-tagma-error/20 text-tagma-error">
                  <X size={7} />
                  <span className="tabular-nums">{failedCount}</span>
                </span>
              )}
              {skippedCount > 0 && (
                <span className="chip-xs bg-tagma-muted/6 border-tagma-muted/10 text-tagma-muted/60">
                  <SkipForward size={7} />
                  <span className="tabular-nums">{skippedCount}</span>
                </span>
              )}
            </div>
            {totalMs > 0 && (
              <div>
                <label className="field-label">Total Duration</label>
                <div className="text-[11px] font-mono text-tagma-muted">
                  {formatDuration(totalMs)}
                </div>
              </div>
            )}
          </div>
        </section>
        <section>
          <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
            Tasks
          </div>
          <div className="pt-2 space-y-0">
            {track.tasks.map((t) => {
              const tc = STATUS_CFG[t.status];
              const TIcon = tc.icon;
              return (
                <div
                  key={t.taskId}
                  className="flex items-center gap-2 py-1 text-[10px] font-mono border-b border-tagma-border/30 last:border-b-0"
                >
                  <TIcon
                    size={9}
                    className={`${tc.iconColor} ${t.status === 'running' ? 'animate-spin' : ''}`}
                  />
                  <span className="flex-1 min-w-0 truncate text-tagma-text">{t.taskName}</span>
                  {t.durationMs != null && (
                    <span className="shrink-0 text-tagma-muted tabular-nums text-[9px]">
                      {formatDuration(t.durationMs)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * History "Outputs" section. The live run panel only ever holds a bounded
 * in-memory tail of each stream; the full stdout/stderr are persisted to
 * disk by the engine and survive into history. This section reaches them
 * on demand via the task-output endpoint so a past command task's console
 * output is actually readable here — not just a dead file path like before.
 */
function TaskOutputSection({
  summary,
  task,
  runId,
  taskId,
  stdoutPath,
  stderrPath,
  normalizedOutput,
}: {
  summary: RunSummary;
  task: RunSummaryTask;
  runId: string;
  taskId: string;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  normalizedOutput?: string | null;
}) {
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const handleAskAi = useCallback(async () => {
    setAskBusy(true);
    setAskError(null);
    try {
      if (historyAskAiModeForTask(summary, task) === 'fix') {
        const [stdout, stderr] = await Promise.all([
          readTaskOutputOrNull(runId, taskId, 'stdout', !!stdoutPath),
          readTaskOutputOrNull(runId, taskId, 'stderr', !!stderrPath),
        ]);
        useChatStore
          .getState()
          .attachComposerContext(
            formatRunSummaryTaskErrorAttachment(summary, task, { stdout, stderr }),
            HISTORY_FIX_INSTRUCTION,
          );
      } else {
        const context = await api.getRunHistoryAskAiContext(runId, taskId);
        useChatStore.getState().attachComposerContext(context, HISTORY_COMPARE_INSTRUCTION);
      }
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'Failed to build Ask AI context');
    } finally {
      setAskBusy(false);
    }
  }, [runId, stderrPath, stdoutPath, summary, task, taskId]);

  // `stdoutPath` / `stderrPath` come from summary.json and signal that the
  // task actually ran a process that produced a stream file — only then is
  // it worth offering the viewer (skipped/blocked tasks have neither).
  if (!stdoutPath && !stderrPath && !normalizedOutput) return null;
  return (
    <section>
      <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
        Outputs
      </div>
      <div className="pt-2.5 space-y-3">
        {stdoutPath && <StreamViewer runId={runId} taskId={taskId} stream="stdout" />}
        {stderrPath && <StreamViewer runId={runId} taskId={taskId} stream="stderr" />}
        {normalizedOutput && (
          <div>
            <label className="field-label">normalized</label>
            <pre className="select-text text-[10px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-2 overflow-auto max-h-[200px] whitespace-pre-wrap break-words">
              {normalizedOutput}
            </pre>
          </div>
        )}
        <button
          type="button"
          onClick={handleAskAi}
          disabled={askBusy}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium text-tagma-accent border border-tagma-accent/30 hover:bg-tagma-accent/10 disabled:opacity-60 disabled:cursor-wait px-2.5 py-1.5 transition-colors"
          title={
            historyAskAiModeForTask(summary, task) === 'fix'
              ? 'Ask AI to fix this task error'
              : 'Ask AI to compare this historical output with the latest pipeline'
          }
        >
          {askBusy ? <Loader2 size={11} className="animate-spin" /> : <MessageSquare size={11} />}
          <span>Ask AI</span>
        </button>
        {askError && (
          <div className="text-[10px] font-mono text-tagma-error/80 bg-tagma-error/5 border border-tagma-error/20 px-2.5 py-2 whitespace-pre-wrap break-words">
            {askError}
          </div>
        )}
      </div>
    </section>
  );
}

type StreamState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; data: RunTaskOutput | null }
  | { kind: 'error'; message: string };

/**
 * Collapsible, lazily-loaded viewer for one persisted stream. Content is
 * fetched only on first expand (then cached) so opening the task panel
 * stays cheap even for runs with large logs. Visual treatment mirrors the
 * live RunTaskPanel Output/Errors boxes so run vs. history feel identical.
 */
function StreamViewer({
  runId,
  taskId,
  stream,
}: {
  runId: string;
  taskId: string;
  stream: 'stdout' | 'stderr';
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StreamState>({ kind: 'idle' });
  const isErr = stream === 'stderr';

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    // Fetch exactly once, on the first expand. Kept out of the setOpen
    // updater so React's double-invoked updaters can't double-fire it.
    if (next && state.kind === 'idle') {
      setState({ kind: 'loading' });
      api
        .getRunTaskOutput(runId, taskId, stream)
        .then((data) => setState({ kind: 'loaded', data }))
        .catch((e: unknown) =>
          setState({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to load output',
          }),
        );
    }
  }, [open, runId, taskId, stream, state.kind]);

  const hasContent = state.kind === 'loaded' && !!state.data && state.data.content.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-1.5 text-[10px] font-medium text-tagma-muted uppercase tracking-wider hover:text-tagma-text transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>{stream}</span>
        {state.kind === 'loading' && <Loader2 size={9} className="animate-spin ml-1" />}
      </button>
      {open && (
        <div className="mt-1.5">
          {state.kind === 'loading' && (
            <div className="text-[10px] font-mono text-tagma-muted-dim px-2.5 py-2 border border-tagma-border bg-tagma-bg">
              Loading…
            </div>
          )}
          {state.kind === 'error' && (
            <div className="text-[10px] font-mono text-tagma-error/80 bg-tagma-error/5 border border-tagma-error/20 px-2.5 py-2 whitespace-pre-wrap break-words">
              {state.message}
            </div>
          )}
          {state.kind === 'loaded' && !hasContent && (
            <div className="text-[10px] font-mono text-tagma-muted-dim px-2.5 py-2 border border-tagma-border bg-tagma-bg">
              (no {stream} recorded)
            </div>
          )}
          {state.kind === 'loaded' && hasContent && state.data && (
            <>
              {state.data.truncated && (
                <div className="text-[9px] font-mono text-tagma-warning/80 mb-1">
                  Showing last 1 MB of {formatBytes(state.data.size)} — full file on disk
                </div>
              )}
              <pre
                className={`select-text text-[10px] font-mono px-2.5 py-2 overflow-auto max-h-[320px] whitespace-pre-wrap break-words border ${
                  isErr
                    ? 'text-tagma-error/80 bg-tagma-error/5 border-tagma-error/20'
                    : 'text-tagma-text bg-tagma-bg border-tagma-border'
                }`}
              >
                {state.data.content}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
