// RunView — read-only mirror of the editor board scoped to a running
// pipeline. It reuses TaskCard, TrackLane, Minimap, and TaskConfigPanel
// with readOnly props so the Run screen stays visually consistent with
// the editor.

import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Square,
  Loader2,
  Check,
  X,
  Search,
  Package,
  ChevronDown,
  ChevronRight,
  Clock,
  SkipForward,
  Ban,
  AlertCircle,
  RefreshCw,
  MessageSquare,
} from 'lucide-react';
import { useRunStore } from '../../store/run-store';
import { useChatStore } from '../../store/chat-store';
import { TaskCard } from '../board/TaskCard';
import { TrackLane } from '../board/TrackLane';
import { Minimap } from '../board/Minimap';
import { FolderHeaderBar } from '../board/FolderHeaderBar';
import { RunTaskPanel } from './RunTaskPanel';
import { TrackInfoPanel } from './TrackInfoPanel';
import { RunPluginsPanel } from './RunPluginsPanel';
import { ApprovalDialog } from './ApprovalDialog';
import { RunHistoryBrowser } from './RunHistoryBrowser';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { ProductLogo } from '../ProductLogo';

export const RUN_SEARCH_OVERLAY_CLASSES =
  'fixed inset-x-2 top-12 z-[150] max-h-[calc(100dvh-3.5rem)] max-w-[calc(100vw-1rem)] overflow-y-auto border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in sm:left-auto sm:right-4 sm:top-14 sm:w-[340px] sm:max-w-[calc(100vw-2rem)]';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';
import type {
  RawPipelineConfig,
  DagEdge,
  TaskStatus,
  RunTaskState,
  TrackFolder,
  ApprovalRequestInfo,
} from '../../api/client';
import type { TaskPosition } from '../../store/pipeline-store';
import { getZoom } from '../../utils/zoom';
import { formatRunErrorAttachment } from '../../utils/format-error-prompt';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  CANVAS_PAD_RIGHT,
} from '../board/layout-constants';
import {
  resolveCanvasBottomSpacer,
  resolveCanvasContentHeight,
  resolveCanvasPan,
} from '../board/canvas-pan';
import { usePipelineStore } from '../../store/pipeline-store';
import { buildRenderPlan, planTotalHeight, trackTopYInPlan } from '../board/render-plan';

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

export function approvalDialogConfigForRequest({
  request,
  focusedRunId,
  config,
}: {
  request: ApprovalRequestInfo;
  focusedRunId: string | null;
  config: RawPipelineConfig;
}): RawPipelineConfig | undefined {
  if (!request.runId || request.runId === focusedRunId) return config;
  return undefined;
}

function countByStatus(tasks: Map<string, { status: TaskStatus }>) {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const [, t] of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

export function shouldShowRunErrorBanner({
  error,
}: {
  showHistory: boolean;
  error: string | null;
}): boolean {
  return typeof error === 'string' && error.trim().length > 0;
}

export function RunView({
  config: liveConfig,
  dagEdges: liveDagEdges,
  positions: livePositions,
  onBack,
}: RunViewProps) {
  const {
    status,
    runId,
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
    replayDagEdges,
    replayPositions,
    viewMode,
  } = useRunStore();

  // Prefer the snapshot captured at startRun time — that is the config the
  // pipeline is actually running with. Fall back to the live editor config
  // only when no snapshot exists (e.g. idle state showing history).
  const config = snapshot ?? liveConfig;
  // For replay runs the editor's dagEdges/positions describe a completely
  // different pipeline; use the overrides captured at startRun time. For
  // normal runs (no override) we stick with the editor-derived props so
  // live edits to the canvas still reflect in the RunView.
  const dagEdges = replayDagEdges ?? liveDagEdges;
  const positions = replayPositions ?? livePositions;

  // "Live" covers the only states in which aborting is meaningful.
  // We deliberately do NOT derive this as `!isTerminal` because during a
  // Back-from-terminal transition the store resets status to 'idle' while
  // AnimatePresence still keeps RunView mounted for its exit animation —
  // a `!isTerminal` check would flip true for one frame and flash the
  // Abort button into view. Same trap the `showHistory` guard addresses.
  const isLive = status === 'running' || status === 'starting';

  // C7: Abort confirmation state
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);
  const handleAbortClick = useCallback(() => setShowAbortConfirm(true), []);
  const handleAbortConfirm = useCallback(() => {
    setShowAbortConfirm(false);
    abortRun();
  }, [abortRun]);
  const handleAbortCancel = useCallback(() => setShowAbortConfirm(false), []);
  const handleAskChatForRunError = useCallback(() => {
    if (!error) return;
    useChatStore.getState().attachErrorContext(formatRunErrorAttachment(error, runId));
  }, [error, runId]);

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
    const panStart = {
      clientX: e.clientX,
      clientY: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    let started = false;
    panDidDragRef.current = false;
    const onMove = (ev: MouseEvent) => {
      const next = resolveCanvasPan(panStart, ev, getZoom(), started);
      if (!started) {
        if (!next.didDrag) return;
        started = true;
        panDidDragRef.current = true;
      }
      el.scrollLeft = next.scrollLeft;
      el.scrollTop = next.scrollTop;
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
  const firstApprovalConfig = firstApproval
    ? approvalDialogConfigForRequest({ request: firstApproval, focusedRunId: runId, config })
    : undefined;

  // Folders from the editor store. RunView is read-only but shares the live
  // editor layout for normal runs. Replay-from-history does not currently
  // capture layout folders, so suppress live folders there rather than mixing
  // an unrelated editor layout with the replay snapshot.
  const liveFolders = usePipelineStore((s) => s.folders);
  const liveTrackHeights = usePipelineStore((s) => s.trackHeights);
  const toggleFolderCollapsed = usePipelineStore((s) => s.toggleFolderCollapsed);
  const folders = useMemo<TrackFolder[]>(() => {
    if (replayPositions) return [];
    const validTrackIds = new Set(config.tracks.map((t) => t.id));
    return liveFolders
      .map((f) => ({
        ...f,
        trackIds: f.trackIds.filter((tid) => validTrackIds.has(tid)),
      }))
      .filter((f) => f.trackIds.length > 0);
  }, [config.tracks, liveFolders, replayPositions]);
  const renderPlan = useMemo(
    () => buildRenderPlan(config.tracks, folders, replayPositions ? new Map() : liveTrackHeights),
    [config.tracks, folders, liveTrackHeights, replayPositions],
  );

  // Build flat task list with positions (same layout as BoardCanvas).
  const flatTasks = useMemo(() => {
    type FT = {
      qid: string;
      trackId: string;
      task: (typeof config.tracks)[number]['tasks'][number];
    };
    const result: FT[] = [];
    for (const track of config.tracks) {
      for (const task of track.tasks) {
        result.push({ qid: `${track.id}.${task.id}`, trackId: track.id, task });
      }
    }
    return result;
  }, [config]);

  // Local runtime position map. `TaskPosition` from the store only carries
  // `x` — the y-coordinate is derived from the track's plan-resolved Y
  // (folders mixed in shift tracks down by their FOLDER_H bands). Tracks
  // hidden inside a collapsed folder produce no entry, matching the
  // editor's BoardCanvas behavior.
  type RunPos = { x: number; y: number };
  const taskPositions = useMemo(() => {
    const taskCountPerTrack = new Map<string, number>();
    const posMap = new Map<string, RunPos>();
    for (const ft of flatTasks) {
      const trackTop = trackTopYInPlan(renderPlan, ft.trackId);
      if (trackTop === null) continue;
      const count = taskCountPerTrack.get(ft.trackId) ?? 0;
      const stored = positions.get(ft.qid);
      const x = stored ? stored.x : PAD_LEFT + count * (TASK_W + TASK_GAP);
      const row = renderPlan.find(
        (entry) => entry.kind === 'track' && entry.trackId === ft.trackId,
      );
      const rowHeight = row?.height ?? TASK_H;
      const innerY =
        stored?.y === undefined
          ? (rowHeight - TASK_H) / 2
          : Math.max(0, Math.min(Math.max(0, rowHeight - TASK_H), stored.y));
      const y = trackTop + innerY;
      posMap.set(ft.qid, { x, y });
      taskCountPerTrack.set(ft.trackId, count + 1);
    }
    return posMap;
  }, [flatTasks, positions, renderPlan]);

  // Minimap reads from the pipeline store by default. We pass an override
  // shape (x-only) keyed on qualified id so the minimap's layout math maps
  // into the same coordinate space as the run canvas.
  const minimapPositions = useMemo(() => {
    const out = new Map<string, TaskPosition>();
    for (const [qid, pos] of taskPositions) {
      const trackTop = trackTopYInPlan(renderPlan, qid.split('.')[0] ?? '');
      out.set(qid, trackTop === null ? { x: pos.x } : { x: pos.x, y: pos.y - trackTop });
    }
    return out;
  }, [taskPositions, renderPlan]);

  const canvasWidth = useMemo(() => {
    let maxX = 0;
    for (const [, pos] of taskPositions) {
      if (pos.x + TASK_W > maxX) maxX = pos.x + TASK_W;
    }
    return Math.max(maxX + CANVAS_PAD_RIGHT, 2000);
  }, [taskPositions]);

  const planHeight = planTotalHeight(renderPlan);
  const canvasHeight = resolveCanvasContentHeight(planHeight);
  const canvasBottomSpacer = resolveCanvasBottomSpacer(planHeight);

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
      if (taskCount <= 1) {
        out.set(track.id, false);
        continue;
      }
      const depCount = dagEdges.filter(
        (e) => e.from.startsWith(track.id + '.') && e.to.startsWith(track.id + '.'),
      ).length;
      out.set(track.id, depCount < taskCount - 1);
    }
    return out;
  }, [config.tracks, dagEdges]);

  const edges = useMemo(() => {
    return dagEdges
      .map((edge) => {
        const from = taskPositions.get(edge.from);
        const to = taskPositions.get(edge.to);
        if (!from || !to) return null;
        const x1 = from.x + TASK_W + 4;
        const y1 = from.y + TASK_H / 2;
        const x2 = to.x - 4;
        const y2 = to.y + TASK_H / 2;
        const mx = (x1 + x2) / 2;
        return {
          key: `${edge.from}->${edge.to}`,
          d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        };
      })
      .filter(Boolean) as { key: string; d: string }[];
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
  }, [selectedTaskId, tasks, config]);

  const counts = countByStatus(tasks);
  // History browser is shown only when the user explicitly opened it via
  // the History button. We intentionally do NOT fall back to the history
  // view when `status === 'idle'`: during a Back-from-live-run transition
  // the store atomically resets status to 'idle', and AnimatePresence
  // keeps the RunView mounted for its exit animation — with a fallback
  // here, the live canvas would flip to the history browser for a frame
  // before the exit completes, producing a visible flash.
  const showHistory = viewMode === 'history';
  const showRunErrorBanner = shouldShowRunErrorBanner({ showHistory, error });

  // Refresh-button state for the history browser: the button lives in
  // the RunView toolbar (next to Back + pipeline name) so the h-9 bar
  // stays the same between live and history modes. Bumping
  // `historyRefreshToken` tells RunHistoryBrowser to reload; it reports
  // its loading state back via `onLoadingChange` so the spinner stays
  // in sync.
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Keyboard: Ctrl+F opens search, Escape clears selection or closes search.
  // In history mode the search target (the run canvas) isn't rendered, so
  // the shortcut is a no-op there.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
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
    },
    [searchVisible, selectedTaskId, selectedTrackId, selectTask, selectTrack, showHistory],
  );

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
    <div className="h-full flex flex-col bg-tagma-surface relative">
      {/* Header — height matches the editor Toolbar (h-9) so switching
          between the two views doesn't shift the canvas. */}
      <header
        className={`relative z-[40] h-9 overflow-visible bg-tagma-surface border-b border-tagma-border flex items-stretch pl-2 shrink-0 ${hasDesktopBridge() ? 'app-drag-region pr-0' : 'pr-2'}`}
        onDoubleClick={(e) => {
          if (!hasDesktopBridge()) return;
          if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
        }}
      >
        {/* Shrinkable wrapper so DesktopWindowControls stays pinned right
            at narrow window widths instead of being clipped. */}
        <div className="flex items-center gap-2 flex-1 min-w-0 h-full">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 shrink-0"
            title="Back to Editor"
          >
            <ArrowLeft size={12} />
            <span className="hidden md:inline">Back to Editor</span>
          </button>
          <div className="w-px h-5 bg-tagma-border shrink-0" />

          <div className="hidden items-center gap-1.5 px-2 min-w-0 shrink sm:flex">
            <ProductLogo size={14} />
            <span className="text-xs font-medium text-tagma-text truncate max-w-[160px]">
              {config.name}
            </span>
          </div>

          {/* In history mode the header collapses to Back + pipeline name
            plus a Refresh button pinned on the right — none of the live-
            run controls (status, counts, approvals, plugins, settings,
            search, abort) make sense when browsing past runs. */}
          {showHistory && (
            <>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setHistoryRefreshToken((t) => t + 1)}
                disabled={historyLoading}
                title="Reload run history"
                className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw size={11} className={historyLoading ? 'animate-spin' : ''} />
                <span className="hidden md:inline">Refresh</span>
              </button>
            </>
          )}

          {!showHistory && (
            <>
              <div className="hidden w-px h-5 bg-tagma-border sm:block" />

              {/* Run status */}
              <div className="flex items-center gap-2 text-[10px] font-medium">
                {status === 'running' && (
                  <span
                    className="chip-sm gap-1.5 px-2 bg-tagma-ready/10 border-tagma-ready/20 text-tagma-ready"
                    aria-label="Run status: Running"
                    title="Running"
                  >
                    <Loader2 size={10} className="animate-spin" />
                    <span className="hidden sm:inline">Running</span>
                  </span>
                )}
                {status === 'done' && (
                  <span
                    className="chip-sm gap-1.5 px-2 bg-tagma-success/10 border-tagma-success/20 text-tagma-success"
                    aria-label="Run status: Completed"
                    title="Completed"
                  >
                    <Check size={10} />
                    <span className="hidden sm:inline">Completed</span>
                  </span>
                )}
                {(status === 'error' || status === 'aborted' || status === 'failed') && (
                  <span
                    className="chip-sm gap-1.5 px-2 bg-tagma-error/10 border-tagma-error/20 text-tagma-error"
                    aria-label={`Run status: ${RUN_STATUS_LABEL[status] ?? status}`}
                    title={RUN_STATUS_LABEL[status] ?? status}
                  >
                    <X size={10} />
                    <span className="hidden sm:inline">{RUN_STATUS_LABEL[status] ?? status}</span>
                  </span>
                )}
                {status === 'starting' && (
                  <span
                    className="chip-sm gap-1.5 px-2 bg-tagma-muted/8 border-tagma-muted/15 text-tagma-muted"
                    aria-label={`Run status: ${RUN_STATUS_LABEL[status] ?? status}`}
                    title={RUN_STATUS_LABEL[status] ?? status}
                  >
                    <Loader2 size={10} className="animate-spin" />
                    <span className="hidden sm:inline">{RUN_STATUS_LABEL[status] ?? status}</span>
                  </span>
                )}
              </div>

              {tasks.size > 0 && (
                <div className="hidden items-center gap-1 lg:flex">
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
                  <span className="hidden sm:inline">
                    approval{pendingApprovals.size === 1 ? '' : 's'}
                  </span>
                </span>
              )}

              <div className="flex-1" />

              {/* Plugins (read-only) */}
              <button
                onClick={() => setShowPlugins(true)}
                className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs text-tagma-muted hover:text-tagma-text transition-colors"
                title="View loaded plugins (read-only)"
                aria-label="View loaded plugins"
              >
                <Package size={12} />
              </button>

              {/* Search */}
              <button
                onClick={() => setSearchVisible(true)}
                className="flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs text-tagma-muted hover:text-tagma-text transition-colors"
                title="Search tasks (Ctrl+F)"
                aria-label="Search tasks"
              >
                <Search size={12} />
              </button>

              {/* Abort with confirmation (C7) */}
              {isLive && !showAbortConfirm && (
                <button
                  onClick={handleAbortClick}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-tagma-error border border-tagma-error/20 hover:bg-tagma-error/10 transition-colors mr-1 shrink-0"
                  title="Abort run"
                  aria-label="Abort run"
                >
                  <Square size={10} />
                  <span className="hidden md:inline">Abort</span>
                </button>
              )}
              {showAbortConfirm && (
                <div className="absolute right-2 top-full z-[120] flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-2 border border-tagma-error/20 bg-tagma-surface px-2 py-1 shadow-panel sm:static sm:mr-1 sm:bg-tagma-error/5 sm:shadow-none">
                  <span className="text-[10px] font-medium text-tagma-error">Stop all?</span>
                  <button
                    onClick={handleAbortConfirm}
                    className="px-2 py-0.5 text-[10px] font-medium bg-tagma-error/20 text-tagma-error border border-tagma-error/30 hover:bg-tagma-error/30 transition-colors"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={handleAbortCancel}
                    className="px-2 py-0.5 text-[10px] text-tagma-muted border border-tagma-border hover:bg-tagma-elevated transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {hasDesktopBridge() && <DesktopWindowControls />}
      </header>

      {showRunErrorBanner && (
        <div className="flex items-center gap-2 bg-tagma-error/5 border-b border-tagma-error/20">
          <div className="w-[3px] self-stretch shrink-0 bg-tagma-error" />
          <span
            className="flex-1 min-w-0 text-[11px] text-tagma-error font-mono py-2 truncate"
            title={error ?? undefined}
          >
            {error}
          </span>
          <button
            type="button"
            onClick={handleAskChatForRunError}
            className="mr-3 flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-tagma-error border border-tagma-error/20 hover:bg-tagma-error/10 transition-colors shrink-0"
            title="Ask AI to diagnose this run error"
            aria-label="Ask AI to diagnose this run error"
          >
            <MessageSquare size={11} />
            <span className="hidden sm:inline">Ask AI</span>
          </button>
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
                <div
                  key={i}
                  className={`text-[10px] font-mono leading-relaxed ${
                    line.level === 'error'
                      ? 'text-tagma-error'
                      : line.level === 'warn'
                        ? 'text-tagma-warning'
                        : 'text-tagma-muted/80'
                  }`}
                >
                  <span className="text-tagma-muted/50">{line.timestamp}</span> {line.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main area */}
      <div className="relative flex-1 flex overflow-hidden">
        {showHistory ? (
          <div className="flex-1 overflow-hidden">
            <RunHistoryBrowser
              refreshToken={historyRefreshToken}
              onLoadingChange={setHistoryLoading}
            />
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
                {(() => {
                  // Walk the render plan so folder bars and track lanes
                  // share Y geometry with the canvas backgrounds below.
                  let zebra = 0;
                  const out: React.ReactNode[] = [];
                  for (const row of renderPlan) {
                    if (row.kind === 'folder') {
                      const f = folders.find((fl) => fl.id === row.folderId);
                      if (!f) continue;
                      out.push(
                        <FolderHeaderBar
                          key={`folder-${f.id}`}
                          folder={f}
                          memberCount={
                            f.trackIds.filter((tid) => config.tracks.some((t) => t.id === tid))
                              .length
                          }
                          height={row.height}
                          onToggle={() => toggleFolderCollapsed(f.id)}
                        />,
                      );
                      continue;
                    }
                    const track = config.tracks.find((t) => t.id === row.trackId);
                    if (!track) continue;
                    const taskCount = track.tasks.length;
                    const isSelected = selectedTrackId === track.id;
                    const hasParallel = parallelWarnings.get(track.id) ?? false;
                    const inFolder = row.folderId !== null;
                    out.push(
                      <div
                        key={track.id}
                        className={`relative border-b border-tagma-border/60 overflow-hidden cursor-pointer transition-colors ${
                          isSelected ? 'bg-tagma-accent/6' : ''
                        } ${zebra % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
                        style={{
                          height: row.height,
                          width: HEADER_W,
                          boxSizing: 'border-box',
                          boxShadow: inFolder
                            ? 'inset 3px 0 0 rgb(var(--tagma-muted) / 0.25)'
                            : undefined,
                        }}
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
                      </div>,
                    );
                    zebra += 1;
                  }
                  return out;
                })()}
                <div
                  aria-hidden
                  data-canvas-bottom-spacer={canvasBottomSpacer}
                  className={'pointer-events-none'}
                  style={{ height: canvasBottomSpacer }}
                />
              </div>

              {/* Task canvas */}
              <div
                ref={contentRef}
                id={RUN_SCROLL_ID}
                data-canvas-pan-surface={true}
                className="flex-1 min-w-0 overflow-auto timeline-grid hide-scrollbar"
                onScroll={syncScroll}
                onMouseDown={handlePanMouseDown}
              >
                <div
                  className="relative w-full cursor-grab active:cursor-grabbing"
                  style={{ minWidth: canvasWidth, minHeight: canvasHeight }}
                  onClick={() => {
                    if (!panDidDragRef.current) selectTask(null);
                  }}
                >
                  {/* Track row backgrounds + folder spacer bands — walks
                      the render plan so the canvas mirrors the sidebar. */}
                  {(() => {
                    let zebra = 0;
                    let yAcc = 0;
                    const out: React.ReactNode[] = [];
                    for (const row of renderPlan) {
                      if (row.kind === 'folder') {
                        const f = folders.find((fl) => fl.id === row.folderId);
                        out.push(
                          <div
                            key={`bg-folder-${row.folderId}`}
                            className="absolute left-0 right-0 pointer-events-none"
                            style={{
                              top: yAcc,
                              height: row.height,
                              background: 'rgb(var(--tagma-muted) / 0.04)',
                              borderBottom: f?.collapsed
                                ? '1px dashed rgb(var(--tagma-border) / 0.7)'
                                : '1px solid rgb(var(--tagma-border) / 0.6)',
                            }}
                          />,
                        );
                        yAcc += row.height;
                        continue;
                      }
                      out.push(
                        <div
                          key={`bg-${row.trackId}`}
                          className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${zebra % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
                          style={{ top: yAcc, height: row.height }}
                          onClick={() => {
                            if (!panDidDragRef.current) selectTask(null);
                          }}
                        />,
                      );
                      yAcc += row.height;
                      zebra += 1;
                    }
                    return out;
                  })()}

                  {/* Edges */}
                  <svg
                    className="absolute inset-0 pointer-events-none"
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
                        x={pos.x}
                        y={pos.y}
                        w={TASK_W}
                        h={TASK_H}
                        isSelected={selectedTaskId === ft.qid}
                        isInvalid={false}
                        isDragging={false}
                        isTrackDragging={false}
                        isEdgeTarget={false}
                        readOnly
                        runtimeStatus={runtimeStatus}
                        runtimeDurationMs={taskState?.durationMs ?? null}
                        runtimeInputs={taskState?.inputs ?? null}
                        runtimeOutputs={taskState?.outputs ?? null}
                        onClickRun={(qid) => selectTask(qid)}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Floating minimap — same UX as editor */}
              <Minimap
                scrollElementId={RUN_SCROLL_ID}
                config={config}
                positions={minimapPositions}
                folders={folders}
                trackHeights={replayPositions ? new Map() : liveTrackHeights}
              />
            </div>

            {selectedTask && (
              <RunTaskPanel task={selectedTask} config={config} onClose={() => selectTask(null)} />
            )}

            {!selectedTask &&
              selectedTrackId &&
              (() => {
                const track = config.tracks.find((t) => t.id === selectedTrackId);
                if (!track) return null;
                return (
                  <TrackInfoPanel track={track} config={config} onClose={() => selectTrack(null)} />
                );
              })()}
          </>
        )}
      </div>

      {/* Approval overlay (F3) */}
      {firstApproval && (
        <ApprovalDialog
          request={firstApproval}
          config={firstApprovalConfig}
          onApprove={() => resolveApproval(firstApproval.id, 'approved')}
          onReject={() => resolveApproval(firstApproval.id, 'rejected')}
        />
      )}

      {/* Plugins modal (read-only) */}
      {showPlugins && <RunPluginsPanel config={config} onClose={() => setShowPlugins(false)} />}

      {/* Search overlay — read-only, navigates selection on click */}
      {searchVisible && (
        <div className={RUN_SEARCH_OVERLAY_CLASSES}>
          <div className="flex items-center gap-2 px-3 py-2 border-b border-tagma-border">
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchVisible(false);
                  setSearchQuery('');
                }
              }}
              placeholder="Search tasks by name or prompt..."
              className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-border focus:border-tagma-accent px-2 py-1 text-tagma-text outline-none"
            />
            <button
              onClick={() => {
                setSearchVisible(false);
                setSearchQuery('');
              }}
              className="p-1 text-tagma-muted hover:text-tagma-text"
              aria-label="Close search"
            >
              <X size={12} />
            </button>
          </div>
          <div className="max-h-[min(240px,calc(100dvh-7rem))] overflow-y-auto">
            {searchQuery.trim() === '' && (
              <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">
                Type to search tasks
              </div>
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
                  <div className="text-[10px] font-mono text-tagma-muted/60 truncate">
                    {m.snippet}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
