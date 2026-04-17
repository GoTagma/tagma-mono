import { useMemo, useState, useCallback, useRef } from 'react';
import { Check, X, Clock, SkipForward, Ban, Loader2, X as XIcon } from 'lucide-react';
import type { RunSummary, RunSummaryTask, TaskStatus } from '../../api/client';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  TRACK_H,
  CANVAS_PAD_RIGHT,
} from '../board/layout-constants';

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

  const canvasHeight = Math.max(trackGroups.length * TRACK_H, 200);

  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current) {
      headerRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  // Drag-to-pan (matches BoardCanvas / RunView). Document-level listeners
  // keep the drag alive even when the cursor leaves the canvas element,
  // and `panDidDragRef` lets the subsequent click skip deselection when
  // the gesture was actually a pan.
  const panDidDragRef = useRef(false);
  const handlePanMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = contentRef.current;
    if (!el) return;
    const startX = e.clientX,
      startY = e.clientY;
    const startSL = el.scrollLeft,
      startST = el.scrollTop;
    let started = false;
    panDidDragRef.current = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX,
        dy = ev.clientY - startY;
      if (!started) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        started = true;
        panDidDragRef.current = true;
      }
      el.scrollLeft = startSL - dx;
      el.scrollTop = startST - dy;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, []);

  const clearSelection = useCallback(() => {
    if (panDidDragRef.current) return;
    setSelectedTaskId(null);
    setSelectedTrackId(null);
  }, []);

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
      </div>

      <div
        ref={contentRef}
        className="flex-1 min-w-0 overflow-auto timeline-grid hide-scrollbar cursor-grab active:cursor-grabbing"
        onScroll={syncScroll}
        onMouseDown={handlePanMouseDown}
      >
        <div
          className="relative w-full"
          style={{ minWidth: canvasWidth, minHeight: Math.max(canvasHeight, 0) }}
          onClick={clearSelection}
        >
          {trackGroups.map((tg, i) => (
            <div
              key={tg.id}
              className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
              style={{ top: i * TRACK_H, height: TRACK_H }}
              onMouseDown={handlePanMouseDown}
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
                stroke="rgba(107,114,128,0.25)"
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
                    ? 'border-tagma-accent bg-tagma-accent/6'
                    : 'border-tagma-border/70 bg-tagma-elevated hover:bg-tagma-elevated/80'
                } ${cfg.bg && !isSelected ? cfg.bg : ''}`}
                style={{ left: pos.x, top: pos.y, width: TASK_W, height: TASK_H }}
                // Intentionally NOT stopping mousedown propagation: the pan
                // handler on the parent resets `panDidDragRef` at the start
                // of every gesture. If we swallow mousedown here, a prior
                // drag's `true` value stays stuck and blocks all future task
                // clicks. Letting mousedown bubble means the pan handler
                // runs, resets the ref, and — because the user isn't moving
                // while clicking — the flag stays `false` so the click
                // handler below can select the task.
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
                    <Icon size={9} className={cfg.iconColor} />
                    {task.durationMs != null && (
                      <span className={`text-[8px] font-mono tabular-nums ${cfg.iconColor}`}>
                        {formatDuration(task.durationMs)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex items-center h-[16px] gap-[4px] pointer-events-none min-w-0 overflow-hidden bg-black/20 px-[3px]">
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
        <div className="absolute right-0 top-0 bottom-0 z-20">
          <HistoryTaskPanel
            task={selectedTask}
            onClose={() => {
              setSelectedTaskId(null);
            }}
          />
        </div>
      )}

      {!selectedTask && selectedTrack && (
        <div className="absolute right-0 top-0 bottom-0 z-20">
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

function HistoryTaskPanel({ task, onClose }: { task: RunSummaryTask; onClose: () => void }) {
  const cfg = STATUS_CFG[task.status];
  const Icon = cfg.icon;
  return (
    <div className="w-72 h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
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
            {task.driver && (
              <div>
                <label className="field-label">Driver</label>
                <div className="text-[11px] font-mono text-tagma-muted">{task.driver}</div>
              </div>
            )}
            {task.model && (
              <div>
                <label className="field-label">Model</label>
                <div className="text-[11px] font-mono text-tagma-muted">{task.model}</div>
              </div>
            )}
            {task.sessionId && (
              <div>
                <label className="field-label">Session</label>
                <div
                  className="text-[11px] font-mono text-tagma-muted truncate"
                  title={task.sessionId}
                >
                  {task.sessionId}
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
            <pre className="pt-2.5 text-[10px] font-mono text-tagma-muted whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {task.command ?? task.prompt}
            </pre>
          </section>
        )}

        {(task.stderrPath || task.normalizedOutput) && (
          <section>
            <div className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/60 pb-1.5 border-b border-tagma-border/40">
              Outputs
            </div>
            <div className="pt-2.5 space-y-3">
              {task.stderrPath && (
                <div>
                  <label className="field-label">stderr</label>
                  <div className="text-[10px] font-mono text-tagma-muted break-all">
                    {task.stderrPath}
                  </div>
                </div>
              )}
              {task.normalizedOutput && (
                <div>
                  <label className="field-label">normalized</label>
                  <div className="text-[10px] font-mono text-tagma-muted break-all">
                    {task.normalizedOutput}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
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
    <div className="w-72 h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
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
                  <TIcon size={9} className={tc.iconColor} />
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
