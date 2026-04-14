// RunView — read-only mirror of the editor board scoped to a running
// pipeline. It reuses TaskCard, TrackLane, Minimap, ZoomControls and
// TaskConfigPanel with readOnly props so the Run screen stays visually
// consistent with the editor.

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { ArrowLeft, Square, Loader2, Check, X, LayoutGrid, Settings, Search, Package, ChevronDown, ChevronRight, Clock, SkipForward, Ban, AlertCircle } from 'lucide-react';
import { useRunStore } from '../../store/run-store';
import { TaskCard } from '../board/TaskCard';
import { TrackLane } from '../board/TrackLane';
import { Minimap } from '../board/Minimap';
import { ZoomControls } from '../board/ZoomControls';
import { RunTaskPanel } from './RunTaskPanel';
import { TrackInfoPanel } from './TrackInfoPanel';
import { RunPluginsPanel } from './RunPluginsPanel';
import { ApprovalDialog } from './ApprovalDialog';
import { RunHistoryBrowser } from './RunHistoryBrowser';
import { PipelineConfigPanel } from '../panels/PipelineConfigPanel';
import type { RawPipelineConfig, DagEdge, TaskStatus, RunTaskState } from '../../api/client';
import type { TaskPosition } from '../../store/pipeline-store';
import { getZoom } from '../../utils/zoom';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  TRACK_H,
  CANVAS_PAD_RIGHT,
} from '../board/layout-constants';

// Dedicated scroll container id so the Minimap (which samples DOM scroll
// extents by id) doesn't collide with the editor board when both components
// exist elsewhere in the tree.
const RUN_SCROLL_ID = 'run-scroll';

interface RunViewProps {
  config: RawPipelineConfig;
  dagEdges: DagEdge[];
  positions: Map<string, TaskPosition>;
  onBack: () => void;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  starting: 'Starting...',
  running: 'Running',
  done: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
  error: 'Error',
};

function countByStatus(tasks: Map<string, { status: TaskStatus }>) {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const [, t] of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

export function RunView({ config: liveConfig, dagEdges, positions, onBack }: RunViewProps) {
  const {
    status,
    tasks,
    error,
    pipelineLogs,
    selectedTaskId,
    selectedTrackId,
    selectTask,
    selectTrack,
    abortRun,
    pendingApprovals,
    resolveApproval,
    snapshot,
    viewMode,
  } = useRunStore();

  // Prefer the snapshot captured at startRun time — that is the config the
  // pipeline is actually running with. Fall back to the live editor config
  // only when no snapshot exists (e.g. idle state showing history).
  const config = snapshot ?? liveConfig;

  const isTerminal = status === 'done' || status === 'failed' || status === 'aborted' || status === 'error';

  // C7: Abort confirmation state
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const handleAbortClick = useCallback(() => setShowAbortConfirm(true), []);
  const handleAbortConfirm = useCallback(() => {
    setShowAbortConfirm(false);
    abortRun();
  }, [abortRun]);
  const handleAbortCancel = useCallback(() => setShowAbortConfirm(false), []);
  const isActive = status !== 'idle';

  const [showPipelineSettings, setShowPipelineSettings] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pipelineLogExpanded, setPipelineLogExpanded] = useState(false);

  // Scroll sync between the track-header column and the task canvas.
  // Same pattern as BoardCanvas: the header column is `overflow-hidden`
  // (so it doesn't get its own scrollbar) but we still push scrollTop
  // into it from the task canvas's onScroll so the two columns stay
  // aligned while the canvas scrolls vertically.
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current) {
      headerRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  // Canvas pan: drag background to scroll (same as BoardCanvas).
  const panDidDragRef = useRef(false);
  const handlePanMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = contentRef.current;
    if (!el) return;
    const startX = e.clientX, startY = e.clientY;
    const startSL = el.scrollLeft, startST = el.scrollTop;
    let started = false;
    panDidDragRef.current = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!started) { if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; started = true; panDidDragRef.current = true; }
      const z = getZoom();
      el.scrollLeft = startSL - dx / z;
      el.scrollTop = startST - dy / z;
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

  // First pending approval (FIFO by Map iteration order).
  const firstApproval = useMemo(() => {
    const it = pendingApprovals.values().next();
    return it.done ? null : it.value;
  }, [pendingApprovals]);

  // Build flat task list with positions (same layout as BoardCanvas).
  const flatTasks = useMemo(() => {
    type FT = { qid: string; trackId: string; trackIndex: number; task: (typeof config.tracks)[number]['tasks'][number] };
    const result: FT[] = [];
    for (let ti = 0; ti < config.tracks.length; ti++) {
      const track = config.tracks[ti];
      for (const task of track.tasks) {
        result.push({ qid: `${track.id}.${task.id}`, trackId: track.id, trackIndex: ti, task });
      }
    }
    return result;
  }, [config]);

  // Local runtime position map. `TaskPosition` from the store only carries
  // `x` — the y-coordinate is derived from the track index, which lives in
  // RunView since the read-only canvas owns its own layout.
  type RunPos = { x: number; y: number };
  const taskPositions = useMemo(() => {
    const taskCountPerTrack = new Map<string, number>();
    const posMap = new Map<string, RunPos>();
    for (const ft of flatTasks) {
      const count = taskCountPerTrack.get(ft.trackId) ?? 0;
      const stored = positions.get(ft.qid);
      const x = stored ? stored.x : PAD_LEFT + count * (TASK_W + TASK_GAP);
      const y = ft.trackIndex * TRACK_H + (TRACK_H - TASK_H) / 2;
      posMap.set(ft.qid, { x, y });
      taskCountPerTrack.set(ft.trackId, count + 1);
    }
    return posMap;
  }, [flatTasks, positions]);

  // Minimap reads from the pipeline store by default. We pass an override
  // shape (x-only) keyed on qualified id so the minimap's layout math maps
  // into the same coordinate space as the run canvas.
  const minimapPositions = useMemo(() => {
    const out = new Map<string, TaskPosition>();
    for (const [qid, pos] of taskPositions) {
      out.set(qid, { x: pos.x });
    }
    return out;
  }, [taskPositions]);

  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const [, pos] of taskPositions) {
      if (pos.x + TASK_W > maxX) maxX = pos.x + TASK_W;
    }
    return maxX + CANVAS_PAD_RIGHT;
  }, [taskPositions]);

  const canvasHeight = config.tracks.length * TRACK_H;

  // Per-track parallel warning flag. Editor BoardCanvas computes this
  // from dagEdges; we do the same so the Run view's TrackLane shows the
  // same warning icon the editor shows for tracks whose sibling tasks
  // aren't chained by explicit depends_on (meaning they run in parallel).
  //
  // L7: This heuristic (`depCount < taskCount - 1`) is a conservative
  // approximation — it flags any track where the number of intra-track
  // dependency edges is fewer than the minimum needed for a linear chain.
  // This means a diamond-shaped DAG (A→B, A→C, B→D, C→D) with 4 tasks
  // and 4 edges would show no warning, while a 3-task track with 1 edge
  // (A→B only, C unconstrained) would correctly show one. The heuristic
  // does not distinguish "truly parallel" from "loosely chained" — that
  // would require computing the maximum antichain size, which is overkill
  // for a visual hint.
  const parallelWarnings = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const track of config.tracks) {
      const taskCount = track.tasks.length;
      if (taskCount <= 1) { out.set(track.id, false); continue; }
      const depCount = dagEdges.filter((e) => e.from.startsWith(track.id + '.') && e.to.startsWith(track.id + '.')).length;
      out.set(track.id, depCount < taskCount - 1);
    }
    return out;
  }, [config.tracks, dagEdges]);

  const edges = useMemo(() => {
    return dagEdges.map((edge) => {
      const from = taskPositions.get(edge.from);
      const to = taskPositions.get(edge.to);
      if (!from || !to) return null;
      const x1 = from.x + TASK_W + 4;
      const y1 = from.y + TASK_H / 2;
      const x2 = to.x - 4;
      const y2 = to.y + TASK_H / 2;
      const mx = (x1 + x2) / 2;
      return { key: `${edge.from}->${edge.to}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` };
    }).filter(Boolean) as { key: string; d: string }[];
  }, [dagEdges, taskPositions]);

  // Build selected task state. Fall back to the snapshot config when the
  // task hasn't received any runtime updates yet so the right-hand panel
  // can still show the readOnly task config.
  const selectedTask = useMemo((): RunTaskState | null => {
    if (!selectedTaskId) return null;
    const fromRun = tasks.get(selectedTaskId);
    if (fromRun) return fromRun;
    const [trackId, taskId] = selectedTaskId.split('.');
    const track = config.tracks.find((t) => t.id === trackId);
    const task = track?.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    return {
      taskId: selectedTaskId,
      trackId,
      taskName: task.name || task.id,
      status: 'idle',
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      stdout: '',
      stderr: '',
      outputPath: null,
      stderrPath: null,
      sessionId: null,
      normalizedOutput: null,
      resolvedDriver: null,
      resolvedModelTier: null,
      resolvedPermissions: null,
      logs: [],
      totalLogCount: 0,
    };
  }, [selectedTaskId, tasks, config]);

  const counts = countByStatus(tasks);
  // History browser is shown when the user explicitly opened it via the
  // History button, OR as a fallback when the engine is idle.
  const showHistory = viewMode === 'history' || !isActive;

  // Keyboard: Ctrl+F opens search, Escape clears selection or closes search.
  // In history mode the search target (the run canvas) isn't rendered, so
  // the shortcut is a no-op there.
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      if (showHistory) return;
      e.preventDefault();
      setSearchVisible(true);
      return;
    }
    if (e.key === 'Escape') {
      if (searchVisible) {
        setSearchVisible(false);
        setSearchQuery('');
      } else if (selectedTaskId) {
        selectTask(null);
      } else if (selectedTrackId) {
        selectTrack(null);
      }
    }
  }, [searchVisible, selectedTaskId, selectedTrackId, selectTask, selectTrack, showHistory]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Focus a task by qualified id — scrolls the run canvas so the card lands
  // in the viewport center, then briefly pulses it. Driven by the search
  // overlay (and shared with the editor's tagma:focus-task channel).
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<string>;
      const qid = ce.detail;
      const el = contentRef.current;
      if (!qid || !el) return;
      const pos = taskPositions.get(qid);
      if (!pos) return;
      const z = getZoom();
      const visW = el.clientWidth;
      const visH = el.clientHeight;
      el.scrollTo({
        left: Math.max(0, pos.x + TASK_W / 2 - visW / (2 * z)),
        top: Math.max(0, pos.y + TASK_H / 2 - visH / (2 * z)),
        behavior: 'smooth',
      });
      window.setTimeout(() => {
        const card = document.querySelector(`[data-task-id="${qid}"]`) as HTMLElement | null;
        if (!card) return;
        card.classList.remove('focus-pulse');
        void card.offsetWidth;
        card.classList.add('focus-pulse');
        window.setTimeout(() => card.classList.remove('focus-pulse'), 1400);
      }, 60);
    };
    window.addEventListener('tagma:focus-task', handler);
    return () => window.removeEventListener('tagma:focus-task', handler);
  }, [taskPositions]);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as { trackId: string; taskId: string; label: string; snippet: string }[];
    const out: { trackId: string; taskId: string; label: string; snippet: string }[] = [];
    for (const t of config.tracks) {
      for (const task of t.tasks) {
        const name = (task.name ?? '').toLowerCase();
        const prompt = (task.prompt ?? '').toLowerCase();
        if (name.includes(q) || prompt.includes(q)) {
          out.push({
            trackId: t.id,
            taskId: task.id,
            label: task.name ?? task.id,
            snippet: (task.prompt ?? '').slice(0, 80),
          });
        }
      }
    }
    return out;
  }, [searchQuery, config]);

  return (
    <div className="h-full flex flex-col bg-tagma-bg relative">
      {/* Header — height matches the editor Toolbar (h-11) so switching
          between the two views doesn't shift the canvas by 4px. */}
      <header className="h-11 bg-tagma-surface border-b border-tagma-border flex items-center px-2 gap-2 shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1">
          <ArrowLeft size={12} />
          <span>Back to Editor</span>
        </button>
        <div className="w-px h-5 bg-tagma-border" />

        <div className="flex items-center gap-1.5 px-2">
          <LayoutGrid size={13} className="text-tagma-accent" />
          <span className="text-xs font-medium text-tagma-text truncate max-w-[160px]">{config.name}</span>
        </div>

        {/* In history mode the header collapses to Back + pipeline name —
            none of the live-run controls (status, counts, approvals, plugins,
            settings, search, abort) make sense when browsing past runs. */}
        {!showHistory && (
        <>
        <div className="w-px h-5 bg-tagma-border" />

        {/* Run status */}
        <div className="flex items-center gap-2 text-[10px] font-medium">
          {status === 'running' && (
            <span className="chip-sm gap-1.5 px-2 bg-tagma-ready/10 border-tagma-ready/20 text-tagma-ready">
              <Loader2 size={10} className="animate-spin" />
              Running
            </span>
          )}
          {status === 'done' && (
            <span className="chip-sm gap-1.5 px-2 bg-tagma-success/10 border-tagma-success/20 text-tagma-success">
              <Check size={10} />
              Completed
            </span>
          )}
          {(status === 'error' || status === 'aborted' || status === 'failed') && (
            <span className="chip-sm gap-1.5 px-2 bg-tagma-error/10 border-tagma-error/20 text-tagma-error">
              <X size={10} />
              {RUN_STATUS_LABEL[status] ?? status}
            </span>
          )}
          {status === 'starting' && (
            <span className="chip-sm gap-1.5 px-2 bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted">
              {RUN_STATUS_LABEL[status] ?? status}
            </span>
          )}
        </div>

        {tasks.size > 0 && (
          <div className="flex items-center gap-1">
            {counts.success != null && counts.success > 0 && (
              <span className="chip-sm bg-tagma-success/10 border-tagma-success/20 text-tagma-success">
                <Check size={9} />
                <span className="tabular-nums">{counts.success}</span>
              </span>
            )}
            {counts.failed != null && counts.failed > 0 && (
              <span className="chip-sm bg-tagma-error/10 border-tagma-error/20 text-tagma-error">
                <X size={9} />
                <span className="tabular-nums">{counts.failed}</span>
              </span>
            )}
            {counts.running != null && counts.running > 0 && (
              <span className="chip-sm bg-tagma-ready/10 border-tagma-ready/20 text-tagma-ready">
                <Loader2 size={9} className="animate-spin" />
                <span className="tabular-nums">{counts.running}</span>
              </span>
            )}
            {counts.blocked != null && counts.blocked > 0 && (
              <span className="chip-sm bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning">
                <Ban size={9} />
                <span className="tabular-nums">{counts.blocked}</span>
              </span>
            )}
            {counts.waiting != null && counts.waiting > 0 && (
              <span className="chip-sm bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted">
                <Clock size={9} />
                <span className="tabular-nums">{counts.waiting}</span>
              </span>
            )}
            {counts.timeout != null && counts.timeout > 0 && (
              <span className="chip-sm bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning">
                <Clock size={9} />
                <span className="tabular-nums">{counts.timeout}</span>
              </span>
            )}
            {counts.skipped != null && counts.skipped > 0 && (
              <span className="chip-sm bg-tagma-muted/6 border-tagma-muted/10 text-tagma-muted/60">
                <SkipForward size={9} />
                <span className="font-semibold tabular-nums">{counts.skipped}</span>
              </span>
            )}
          </div>
        )}

        {pendingApprovals.size > 0 && (
          <span className="chip-sm bg-tagma-warning/10 border-tagma-warning/20 text-tagma-warning">
            <AlertCircle size={9} className="animate-pulse-slow" />
            <span className="tabular-nums">{pendingApprovals.size}</span>
            approval{pendingApprovals.size === 1 ? '' : 's'}
          </span>
        )}

        <div className="flex-1" />

        {/* Plugins (read-only) */}
        <button
          onClick={() => setShowPlugins(true)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-tagma-muted hover:text-tagma-text transition-colors"
          title="View loaded plugins (read-only)"
          aria-label="View loaded plugins"
        >
          <Package size={12} />
        </button>

        {/* Pipeline settings (read-only) */}
        <button
          onClick={() => setShowPipelineSettings(true)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-tagma-muted hover:text-tagma-text transition-colors"
          title="View pipeline settings (read-only)"
          aria-label="View pipeline settings"
        >
          <Settings size={12} />
        </button>

        {/* Search */}
        <button
          onClick={() => setSearchVisible(true)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-tagma-muted hover:text-tagma-text transition-colors"
          title="Search tasks (Ctrl+F)"
          aria-label="Search tasks"
        >
          <Search size={12} />
        </button>

        {/* Abort with confirmation (C7) */}
        {!isTerminal && !showAbortConfirm && (
          <button onClick={handleAbortClick} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-tagma-error border border-tagma-error/20 hover:bg-tagma-error/10 transition-colors mr-1">
            <Square size={10} />
            <span>Abort</span>
          </button>
        )}
        {showAbortConfirm && (
          <div className="flex items-center gap-2 mr-1 px-2 py-1 bg-tagma-error/5 border border-tagma-error/20">
            <span className="text-[10px] font-medium text-tagma-error">Stop all?</span>
            <button onClick={handleAbortConfirm} className="px-2 py-0.5 text-[10px] font-medium bg-tagma-error/20 text-tagma-error border border-tagma-error/30 hover:bg-tagma-error/30 transition-colors">
              Confirm
            </button>
            <button onClick={handleAbortCancel} className="px-2 py-0.5 text-[10px] text-tagma-muted border border-tagma-border hover:bg-tagma-elevated transition-colors">
              Cancel
            </button>
          </div>
        )}
        </>
        )}
      </header>

      {!showHistory && error && (
        <div className="flex items-center gap-2 bg-tagma-error/5 border-b border-tagma-error/20">
          <div className="w-[3px] self-stretch shrink-0 bg-tagma-error" />
          <span className="text-[11px] text-tagma-error font-mono py-2">{error}</span>
        </div>
      )}

      {/* Pipeline log (hook execution, lifecycle events) */}
      {!showHistory && pipelineLogs.length > 0 && (
        <div className="border-b border-tagma-border">
          <button
            onClick={() => setPipelineLogExpanded(!pipelineLogExpanded)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
          >
            {pipelineLogExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span>Pipeline Log ({pipelineLogs.length})</span>
          </button>
          {pipelineLogExpanded && (
            <div className="max-h-[120px] overflow-y-auto px-3 pb-2">
              {pipelineLogs.map((line, i) => (
                <div key={i} className={`text-[10px] font-mono leading-relaxed ${
                  line.level === 'error' ? 'text-tagma-error' :
                  line.level === 'warn' ? 'text-tagma-warning' :
                  'text-tagma-muted/80'
                }`}>
                  <span className="text-tagma-muted/50">{line.timestamp}</span>{' '}
                  {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        {showHistory ? (
          <div className="flex-1 overflow-hidden">
            <RunHistoryBrowser />
          </div>
        ) : (
          <>
            <div className="flex-1 flex overflow-hidden relative">
              {/* Track headers (reuses TrackLane for metadata parity with
                  editor). Container styling mirrors BoardCanvas exactly:
                  same bg tint, same border weight, same row wrapper. */}
              <div
                ref={headerRef}
                className="shrink-0 border-r border-tagma-border overflow-hidden bg-tagma-surface/50"
                style={{ width: HEADER_W }}
              >
                {config.tracks.map((track, i) => {
                  const taskCount = track.tasks.length;
                  const isSelected = selectedTrackId === track.id;
                  const hasParallel = parallelWarnings.get(track.id) ?? false;
                  return (
                    <div
                      key={track.id}
                      className={`relative border-b border-tagma-border/60 overflow-hidden cursor-pointer transition-colors ${
                        isSelected ? 'bg-tagma-accent/6' : ''
                      } ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
                      style={{ height: TRACK_H, width: HEADER_W, boxSizing: 'border-box' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectTrack(track.id);
                      }}
                    >
                      <div className="h-full flex">
                        <div className="flex-1 min-w-0 flex items-center">
                          <TrackLane
                            track={track}
                            taskCount={taskCount}
                            hasParallelWarning={hasParallel}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Task canvas */}
              <div
                ref={contentRef}
                id={RUN_SCROLL_ID}
                className="flex-1 overflow-auto timeline-grid hide-scrollbar"
                onScroll={syncScroll}
                onMouseDown={handlePanMouseDown}
              >
                <div className="relative cursor-grab active:cursor-grabbing" style={{ width: canvasWidth, height: canvasHeight }}
                  onClick={() => { if (!panDidDragRef.current) selectTask(null); }}>
                  {/* Track row backgrounds — even/odd classes match the
                      editor so the zebra striping is identical. */}
                  {config.tracks.map((track, i) => (
                    <div
                      key={track.id}
                      className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
                      style={{ top: i * TRACK_H, height: TRACK_H }}
                      onMouseDown={handlePanMouseDown}
                      onClick={() => { if (!panDidDragRef.current) selectTask(null); }}
                    />
                  ))}

                  {/* Edges */}
                  <svg className="absolute inset-0 pointer-events-none" style={{ width: canvasWidth, height: canvasHeight }}>
                    {edges.map((e) => (
                      <path key={e.key} d={e.d} fill="none" stroke="rgba(107,114,128,0.25)" strokeWidth={1.5} />
                    ))}
                  </svg>

                  {/* Task nodes (reuses TaskCard in readOnly mode) */}
                  {flatTasks.map((ft) => {
                    const pos = taskPositions.get(ft.qid);
                    if (!pos) return null;
                    const taskState = tasks.get(ft.qid);
                    const runtimeStatus: TaskStatus = taskState?.status ?? 'idle';
                    return (
                      <TaskCard
                        key={ft.qid}
                        task={ft.task}
                        trackId={ft.trackId}
                        pipelineConfig={config}
                        x={pos.x} y={pos.y} w={TASK_W} h={TASK_H}
                        isSelected={selectedTaskId === ft.qid}
                        isInvalid={false}
                        isDragging={false}
                        isTrackDragging={false}
                        isEdgeTarget={false}
                        readOnly
                        runtimeStatus={runtimeStatus}
                        runtimeDurationMs={taskState?.durationMs ?? null}
                        onClickRun={(taskId) => selectTask(`${ft.trackId}.${taskId}`)}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Floating minimap + zoom controls — same UX as editor */}
              <Minimap scrollElementId={RUN_SCROLL_ID} config={config} positions={minimapPositions} />
              <ZoomControls />
            </div>

            {selectedTask && (
              <RunTaskPanel
                task={selectedTask}
                config={config}
                onClose={() => selectTask(null)}
              />
            )}

            {!selectedTask && selectedTrackId && (() => {
              const track = config.tracks.find((t) => t.id === selectedTrackId);
              if (!track) return null;
              return (
                <TrackInfoPanel
                  track={track}
                  config={config}
                  onClose={() => selectTrack(null)}
                />
              );
            })()}
          </>
        )}
      </div>

      {/* Approval overlay (F3) */}
      {firstApproval && (
        <ApprovalDialog
          request={firstApproval}
          config={config}
          onApprove={() => resolveApproval(firstApproval.id, 'approved')}
          onReject={() => resolveApproval(firstApproval.id, 'rejected')}
        />
      )}

      {/* Pipeline settings modal (read-only) */}
      {showPipelineSettings && (
        <PipelineConfigPanel
          config={config}
          drivers={[]}
          errors={[]}
          onUpdate={() => { /* readOnly — no-op */ }}
          onClose={() => setShowPipelineSettings(false)}
          readOnly
        />
      )}

      {/* Plugins modal (read-only) */}
      {showPlugins && (
        <RunPluginsPanel
          config={config}
          onClose={() => setShowPlugins(false)}
        />
      )}

      {/* Search overlay — read-only, navigates selection on click */}
      {searchVisible && (
        <div className="fixed top-14 right-4 z-[150] w-[340px] bg-tagma-surface border border-tagma-border shadow-panel animate-fade-in">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-tagma-border">
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setSearchVisible(false); setSearchQuery(''); }
              }}
              placeholder="Search tasks by name or prompt..."
              className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-border focus:border-tagma-accent px-2 py-1 text-tagma-text outline-none"
            />
            <button
              onClick={() => { setSearchVisible(false); setSearchQuery(''); }}
              className="p-1 text-tagma-muted hover:text-tagma-text"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {searchQuery.trim() === '' && (
              <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">Type to search tasks</div>
            )}
            {searchQuery.trim() !== '' && searchMatches.length === 0 && (
              <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">No matches</div>
            )}
            {searchMatches.map((m) => (
              <button
                key={`${m.trackId}.${m.taskId}`}
                className="w-full text-left px-3 py-2 border-b border-tagma-border/30 last:border-b-0 hover:bg-tagma-bg/60"
                onClick={() => {
                  const qid = `${m.trackId}.${m.taskId}`;
                  selectTask(qid);
                  setSearchVisible(false);
                  setSearchQuery('');
                  requestAnimationFrame(() => {
                    window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qid }));
                  });
                }}
              >
                <div className="text-[11px] font-mono text-tagma-text truncate">{m.label}</div>
                {m.snippet && (
                  <div className="text-[10px] font-mono text-tagma-muted/60 truncate">{m.snippet}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

