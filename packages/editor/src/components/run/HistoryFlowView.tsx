import { useMemo, useState, useCallback, useRef } from 'react';
import {
  Check, X, Clock, SkipForward, Ban, Loader2, X as XIcon,
} from 'lucide-react';
import type { RunSummary, RunSummaryTask, TaskStatus } from '../../api/client';
import {
  HEADER_W, TASK_W, TASK_H, TASK_GAP, PAD_LEFT, TRACK_H, CANVAS_PAD_RIGHT,
} from '../board/layout-constants';

const STATUS_CFG: Record<TaskStatus, { bar: string; bg: string; icon: typeof Check; iconColor: string }> = {
  idle:    { bar: '',                    bg: '',                      icon: Clock,       iconColor: '' },
  waiting: { bar: 'bg-tagma-muted/50',   bg: '',                      icon: Clock,       iconColor: 'text-tagma-muted/60' },
  running: { bar: 'bg-tagma-ready',      bg: 'bg-tagma-ready/8',      icon: Loader2,     iconColor: 'text-tagma-ready' },
  success: { bar: 'bg-tagma-success',    bg: 'bg-tagma-success/8',    icon: Check,       iconColor: 'text-tagma-success' },
  failed:  { bar: 'bg-tagma-error',      bg: 'bg-tagma-error/8',      icon: X,           iconColor: 'text-tagma-error' },
  timeout: { bar: 'bg-tagma-warning',    bg: 'bg-tagma-warning/8',    icon: Clock,       iconColor: 'text-tagma-warning' },
  skipped: { bar: 'bg-tagma-muted/40',   bg: '',                      icon: SkipForward, iconColor: 'text-tagma-muted/50' },
  blocked: { bar: 'bg-tagma-warning',    bg: 'bg-tagma-warning/8',    icon: Ban,         iconColor: 'text-tagma-warning' },
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
    const taskCountPerTrack = new Map<string, number>();
    for (const tg of trackGroups) {
      for (const t of tg.tasks) {
        const count = taskCountPerTrack.get(tg.id) ?? 0;
        const x = PAD_LEFT + count * (TASK_W + TASK_GAP);
        const y = tg.index * TRACK_H + (TRACK_H - TASK_H) / 2;
        positions.set(t.taskId, { x, y });
        taskCountPerTrack.set(tg.id, count + 1);
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
  }, [trackGroups, summary.tasks]);

  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const [, pos] of taskPositions) {
      if (pos.x + TASK_W > maxX) maxX = pos.x + TASK_W;
    }
    return Math.max(maxX + CANVAS_PAD_RIGHT, 800);
  }, [taskPositions]);

  const canvasHeight = Math.max(trackGroups.length * TRACK_H, 200);

  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current) {
      headerRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  const handleBackgroundClick = useCallback(() => {
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

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex overflow-hidden relative">
        <div
          ref={headerRef}
          className="shrink-0 border-r border-tagma-border overflow-hidden bg-tagma-surface/50"
          style={{ width: HEADER_W }}
        >
          {trackGroups.map((tg, i) => {
            const isSelected = selectedTrackId === tg.id && !selectedTaskId;
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
                  setSelectedTrackId(tg.id);
                  setSelectedTaskId(null);
                }}
              >
                <div className="h-full flex items-center px-3 gap-2">
                  {tg.color && (
                    <span className="w-2 h-2 shrink-0 rounded-sm" style={{ backgroundColor: tg.color }} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-medium text-tagma-text truncate">{tg.name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[8px] font-mono text-tagma-muted-dim">{tg.tasks.length} tasks</span>
                      {successCount > 0 && (
                        <span className="text-[8px] font-mono text-tagma-success">{successCount} ok</span>
                      )}
                      {failedCount > 0 && (
                        <span className="text-[8px] font-mono text-tagma-error">{failedCount} fail</span>
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
          className="flex-1 min-w-0 overflow-auto timeline-grid hide-scrollbar"
          onScroll={syncScroll}
        >
          <div
            className="relative w-full"
            style={{ minWidth: canvasWidth, minHeight: canvasHeight }}
            onClick={handleBackgroundClick}
          >
            {trackGroups.map((tg, i) => (
              <div
                key={tg.id}
                className={`absolute left-0 right-0 border-b border-tagma-border/40 ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
                style={{ top: i * TRACK_H, height: TRACK_H }}
                onClick={handleBackgroundClick}
              />
            ))}

            <svg className="absolute inset-0 pointer-events-none" width={canvasWidth} height={canvasHeight} style={{ overflow: 'visible' }}>
              {edges.map((e) => (
                <path key={e.key} d={e.d} fill="none" stroke="rgba(107,114,128,0.25)" strokeWidth={1.5} />
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
                    isSelected ? 'border-tagma-accent bg-tagma-accent/6' : 'border-tagma-border/70 bg-tagma-elevated hover:bg-tagma-elevated/80'
                  } ${cfg.bg && !isSelected ? cfg.bg : ''}`}
                  style={{ left: pos.x, top: pos.y, width: TASK_W, height: TASK_H }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedTaskId(task.taskId);
                    setSelectedTrackId(task.trackId);
                  }}
                >
                  {cfg.bar && (
                    <div className={`absolute left-0 top-0 bottom-0 w-[2px] ${cfg.bar}`} />
                  )}
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
                      <span className="inline-flex items-center justify-center h-[14px] px-[4px] text-[7.5px] font-mono leading-[14px] shrink-0 bg-tagma-accent/12 text-tagma-accent/80">
                        {task.driver}
                      </span>
                    )}
                    {task.modelTier && (
                      <span className="inline-flex items-center justify-center h-[14px] px-[4px] text-[7.5px] font-mono leading-[14px] shrink-0 bg-tagma-muted/12 text-tagma-muted/80 font-bold">
                        {task.modelTier}
                      </span>
                    )}
                    {task.exitCode != null && (
                      <span className={`ml-auto text-[7.5px] font-mono ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}>
                        exit {task.exitCode}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {selectedTask && (
        <HistoryTaskPanel
          task={selectedTask}
          onClose={() => { setSelectedTaskId(null); }}
        />
      )}

      {!selectedTask && selectedTrack && (
        <HistoryTrackPanel
          track={selectedTrack}
          onClose={() => { setSelectedTrackId(null); }}
        />
      )}
    </div>
  );
}

function HistoryTaskPanel({ task, onClose }: { task: RunSummaryTask; onClose: () => void }) {
  const cfg = STATUS_CFG[task.status];
  const Icon = cfg.icon;
  return (
    <div className="w-72 h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
      <div className="panel-header">
        <h2 className="panel-title truncate">{task.taskName}</h2>
        <button onClick={onClose} className="p-1 text-tagma-muted hover:text-tagma-text transition-colors">
          <XIcon size={14} />
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
              <div className={`chip-md ${
                task.status === 'success' ? 'bg-tagma-success/10 border-tagma-success/20 text-tagma-success' :
                task.status === 'failed' ? 'bg-tagma-error/10 border-tagma-error/20 text-tagma-error' :
                task.status === 'timeout' ? 'bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning' :
                'bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted'
              }`}>
                <Icon size={11} className={cfg.iconColor} />
                {task.status}
              </div>
            </div>
            {task.startedAt && (
              <div>
                <label className="field-label">Started</label>
                <div className="text-[11px] font-mono text-tagma-muted">{new Date(task.startedAt).toLocaleTimeString()}</div>
              </div>
            )}
            {task.finishedAt && (
              <div>
                <label className="field-label">Finished</label>
                <div className="text-[11px] font-mono text-tagma-muted">{new Date(task.finishedAt).toLocaleTimeString()}</div>
              </div>
            )}
            {task.durationMs != null && (
              <div>
                <label className="field-label">Duration</label>
                <div className="text-[11px] font-mono text-tagma-muted">{formatDuration(task.durationMs)}</div>
              </div>
            )}
            {task.exitCode != null && (
              <div>
                <label className="field-label">Exit Code</label>
                <div className={`text-[11px] font-mono ${task.exitCode === 0 ? 'text-tagma-success' : 'text-tagma-error'}`}>
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
            {task.modelTier && (
              <div>
                <label className="field-label">Model</label>
                <div className="text-[11px] font-mono text-tagma-muted">{task.modelTier}</div>
              </div>
            )}
          </div>
        </section>
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
      <div className="panel-header">
        <h2 className="panel-title truncate">{track.name}</h2>
        <button onClick={onClose} className="p-1 text-tagma-muted hover:text-tagma-text transition-colors">
          <XIcon size={14} />
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
                <div className="text-[11px] font-mono text-tagma-muted">{formatDuration(totalMs)}</div>
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
                <div key={t.taskId} className="flex items-center gap-2 py-1 text-[10px] font-mono border-b border-tagma-border/30 last:border-b-0">
                  <TIcon size={9} className={tc.iconColor} />
                  <span className="flex-1 min-w-0 truncate text-tagma-text">{t.taskName}</span>
                  {t.durationMs != null && (
                    <span className="shrink-0 text-tagma-muted tabular-nums text-[9px]">{formatDuration(t.durationMs)}</span>
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
