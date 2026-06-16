import { useState, useRef, useMemo, useCallback, useEffect, memo } from 'react';
import {
  Trash2,
  Pencil,
  ListPlus,
  Terminal,
  MessageSquare,
  FolderPlus,
  FolderOpen,
  FolderMinus,
} from 'lucide-react';
import { TrackLane } from './TrackLane';
import { TaskCard } from './TaskCard';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { Minimap } from './Minimap';
import { FolderHeaderBar } from './FolderHeaderBar';
import type {
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
  TrackFolder,
  DiagnosticItem,
} from '../../api/client';

import type { TaskPosition } from '../../store/pipeline-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { useChatStore } from '../../store/chat-store';
import type { DagEdge } from '../../api/client';
import { getZoom } from '../../utils/zoom';
import { buildModifyTargetAttachment } from '../../utils/ask-ai-context';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  TRACK_H,
  TRACK_MAX_H,
  TRACK_MIN_H,
  CANVAS_PAD_RIGHT,
  BOARD_SCROLL_ID,
} from './layout-constants';
import {
  buildRenderPlan,
  planTotalHeight,
  rowAtY,
  trackTopYInPlan,
  trackAtYInPlan,
  visibleTracksFromPlan,
  type RenderRow,
} from './render-plan';

const DRAG_THRESHOLD = 4;

interface Pos {
  x: number;
  y: number;
}

interface BoardCanvasProps {
  config: RawPipelineConfig;
  dagEdges: DagEdge[];
  positions: Map<string, TaskPosition>;
  selectedTaskIds: string[];
  invalidTaskIds: Set<string>;
  errorsByTask: Map<string, DiagnosticItem[]>;
  errorsByTrack: Map<string, DiagnosticItem[]>;
  onSelectTask: (qualifiedId: string | null) => void;
  onToggleTaskSelection: (qualifiedId: string) => void;
  onSelectTrack: (trackId: string | null) => void;
  onAddTask: (
    trackId: string,
    name: string,
    options?: { kind?: 'prompt' | 'command'; positionX?: number },
  ) => void;
  onAddTrack: (name: string, opts?: { folderId?: string }) => void;
  onDeleteTask: (trackId: string, taskId: string) => void;
  onDeleteTrack: (trackId: string) => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onMoveTrackTo: (trackId: string, toIndex: number) => void;
  onAddDependency: (
    fromTrackId: string,
    fromTaskId: string,
    toTrackId: string,
    toTaskId: string,
  ) => void;
  onRemoveDependency: (trackId: string, taskId: string, depRef: string) => void;
  onSetTaskPosition: (qualifiedId: string, x: number, y?: number) => void;
  onSetTrackHeight: (trackId: string, height: number) => void;
  onTransferTask: (fromTrackId: string, taskId: string, toTrackId: string) => void;
}

// Flatten tasks for rendering
interface FlatTask {
  trackId: string;
  task: RawTaskConfig;
  qid: string;
}

function flattenTasks(config: RawPipelineConfig): FlatTask[] {
  const result: FlatTask[] = [];
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      result.push({ trackId: track.id, task, qid: `${track.id}.${task.id}` });
    }
  }
  return result;
}

/**
 * Build the qid → screen position map for the canvas. Walks the render plan
 * so that folder header rows contribute their height (FOLDER_H) and tracks
 * inside collapsed folders contribute zero positions at all (their tasks
 * disappear from the canvas).
 */
function buildPositions(
  plan: readonly RenderRow[],
  tracks: readonly RawTrackConfig[],
  storedPositions: Map<string, TaskPosition>,
): Map<string, Pos> {
  const m = new Map<string, Pos>();
  const trackById = new Map<string, RawTrackConfig>();
  for (const t of tracks) trackById.set(t.id, t);

  let y = 0;
  for (const row of plan) {
    if (row.kind !== 'track') {
      y += row.height;
      continue;
    }
    const tr = trackById.get(row.trackId);
    if (!tr) {
      y += row.height;
      continue;
    }
    const defaultY = (row.height - TASK_H) / 2;
    for (let i = 0; i < tr.tasks.length; i++) {
      const task = tr.tasks[i];
      const qid = `${tr.id}.${task.id}`;
      const stored = storedPositions.get(qid);
      const x = stored ? stored.x : PAD_LEFT + i * (TASK_W + TASK_GAP);
      const innerY =
        stored?.y === undefined ? defaultY : Math.max(0, Math.min(row.height - TASK_H, stored.y));
      m.set(qid, { x, y: y + innerY });
    }
    y += row.height;
  }
  return m;
}

/* ── Memoized single edge ─────────────────────────────────────────────
 * Each edge manages its own hover state internally so that mousing over
 * one edge does NOT re-render siblings. The parent SVG only re-renders
 * when positions, dagEdges, or selEdge change structurally.
 */
interface EdgeLineProps {
  ek: string;
  d: string;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  isContinue: boolean;
  isDataflow: boolean;
  inCycle: boolean;
  selected: boolean;
  onSelect: (ek: string | null) => void;
  onCtx: (ek: string, e: React.MouseEvent) => void;
  onRemove: (ek: string) => void;
}

const EdgeLine = memo(function EdgeLine({
  ek,
  d,
  sx,
  sy,
  tx,
  ty,
  isContinue,
  isDataflow,
  inCycle,
  selected,
  onSelect,
  onCtx,
  onRemove,
}: EdgeLineProps) {
  const [hovered, setHovered] = useState(false);
  const highlighted = selected || hovered;
  const midX = (sx + tx) / 2,
    midY = (sy + ty) / 2;

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={14}
        className="pointer-events-auto cursor-pointer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onCtx(ek, e);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected ? null : ek);
        }}
      />
      <path
        d={d}
        fill="none"
        stroke={
          inCycle
            ? 'rgb(var(--tagma-error))'
            : highlighted
              ? isContinue
                ? 'var(--tagma-edge-continue-hi)'
                : isDataflow
                  ? 'var(--tagma-edge-dataflow-hi, rgb(var(--tagma-accent)))'
                  : 'rgb(var(--tagma-accent))'
              : isContinue
                ? 'var(--tagma-edge-continue)'
                : isDataflow
                  ? 'var(--tagma-edge-dataflow, var(--tagma-edge-default))'
                  : 'var(--tagma-edge-default)'
        }
        strokeWidth={inCycle ? 2.2 : highlighted ? 2 : 1}
        strokeDasharray={inCycle ? '4 3' : isContinue ? '6 3' : isDataflow ? '3 3' : undefined}
        opacity={inCycle || isContinue || highlighted || !isDataflow ? 1 : 0.5}
        markerEnd={
          inCycle
            ? 'url(#ah-cycle)'
            : highlighted
              ? isContinue
                ? 'url(#ah-cont-hi)'
                : 'url(#ah-hi)'
              : isContinue
                ? 'url(#ah-cont)'
                : 'url(#ah)'
        }
        className="transition-[stroke,stroke-width] duration-75"
      />
      {selected && (
        <g
          className="pointer-events-auto cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(ek);
          }}
        >
          <circle cx={midX} cy={midY} r={8} fill="transparent" />
          <rect
            data-board-edge-delete-frame="true"
            x={midX - 6}
            y={midY - 6}
            width={12}
            height={12}
            rx={2}
            fill="rgb(var(--tagma-surface))"
            style={{ stroke: 'rgb(var(--tagma-border))' }}
            strokeWidth={1}
          />
          <line
            x1={midX - 3}
            y1={midY - 3}
            x2={midX + 3}
            y2={midY + 3}
            style={{ stroke: 'rgb(var(--tagma-error))' }}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
          <line
            x1={midX + 3}
            y1={midY - 3}
            x2={midX - 3}
            y2={midY + 3}
            style={{ stroke: 'rgb(var(--tagma-error))' }}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </g>
      )}
    </g>
  );
});

/**
 * Y offset (top edge) of a track in the rendered stack. Returns `0` when the
 * track is hidden inside a collapsed folder — callers either gate on
 * visibility before computing positions, or treat 0 as a harmless fallback
 * (the only callers that hit this path drop the result anyway).
 */
function trackTopY(plan: readonly RenderRow[], trackId: string): number {
  return trackTopYInPlan(plan, trackId) ?? 0;
}

function trackHeightInPlan(plan: readonly RenderRow[], trackId: string): number {
  return plan.find((row) => row.kind === 'track' && row.trackId === trackId)?.height ?? TRACK_H;
}

function clampTaskYInTrack(plan: readonly RenderRow[], trackId: string, contentY: number): number {
  const top = trackTopY(plan, trackId);
  const height = trackHeightInPlan(plan, trackId);
  return Math.max(0, Math.min(Math.max(0, height - TASK_H), contentY - top));
}

function clampTrackHeight(height: number): number {
  if (!Number.isFinite(height)) return TRACK_H;
  return Math.max(TRACK_MIN_H, Math.min(TRACK_MAX_H, Math.round(height)));
}

/** Reverse lookup: which track row sits at the given Y? Folder header rows
 *  return null. */
function trackAtY(plan: readonly RenderRow[], cursorY: number): string | null {
  return trackAtYInPlan(plan, cursorY);
}

function stepPath(s: Pos, t: Pos) {
  const sx = s.x + TASK_W,
    sy = s.y + TASK_H / 2;
  const tx = t.x,
    ty = t.y + TASK_H / 2;
  const c = Math.max(40, Math.abs(tx - sx) * 0.5);
  return `M${sx} ${sy} C${sx + c} ${sy}, ${tx - c} ${ty}, ${tx} ${ty}`;
}

function toContent(e: { clientX: number; clientY: number }, el: HTMLDivElement) {
  const r = el.getBoundingClientRect();
  const z = getZoom();
  // clientX/rect.left are in screen pixels; scrollLeft is in logical pixels.
  // Convert screen offset to logical before combining with scroll.
  return { x: (e.clientX - r.left) / z + el.scrollLeft, y: (e.clientY - r.top) / z + el.scrollTop };
}

function findNearestTarget(
  mx: number,
  my: number,
  positions: Map<string, Pos>,
  exclude: string,
): string | null {
  let best: string | null = null,
    bestD = 24;
  for (const [id, p] of positions) {
    if (id === exclude) continue;
    const d = Math.hypot(mx - p.x, my - (p.y + TASK_H / 2));
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

interface CtxState {
  x: number;
  y: number;
  items: MenuEntry[];
}
interface DragCompanion {
  qid: string;
  taskId: string;
  trackId: string;
  startX: number;
  startY: number;
}
interface TaskDragState {
  qid: string;
  taskId: string;
  trackId: string;
  contentX: number;
  contentY: number;
  targetTrackId: string;
  startX: number;
  startY: number;
  companions: DragCompanion[];
}
interface EdgeDragState {
  srcQid: string;
  mx: number;
  my: number;
  target: string | null;
}
interface TrackDragState {
  trackId: string;
  startIndex: number;
  dropIndex: number;
  folderId: string | null;
  folderStartIndex: number | null;
  folderDropIndex: number | null;
  deltaY: number;
}

interface TrackResizeState {
  trackId: string;
  height: number;
}

/**
 * Parse cycle-containing edges from a SDK cycle-detection message of the form
 * "Circular dependency detected: A → B → C → A" (or the older "cycle detected:").
 * Returns a set of edge keys (`from->to`) that participate in the cycle.
 */
function parseCycleEdges(messages: string[]): Set<string> {
  const out = new Set<string>();
  for (const msg of messages) {
    const m = /(?:cycle|circular dependency) detected:\s*(.+)$/i.exec(msg);
    if (!m) continue;
    // Split on → (U+2192), -> or spaces around arrows, tolerate whitespace.
    const nodes = m[1]
      .split(/\s*(?:→|->|⇒)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < nodes.length - 1; i += 1) {
      out.add(`${nodes[i]}->${nodes[i + 1]}`);
    }
  }
  return out;
}

/**
 * Given the task positions and DAG edges for a single track, return a list of
 * contiguous groups where none of the tasks in a group have a depends_on
 * relationship among themselves — these are "parallel zones".
 */
interface ParallelZone {
  trackId: string;
  qids: string[];
  minX: number;
  maxX: number;
}

function computeParallelZones(
  tracks: readonly RawTrackConfig[],
  positionsMap: Map<string, Pos>,
  dagEdges: DagEdge[],
): ParallelZone[] {
  const zones: ParallelZone[] = [];
  // Index edges by "from" for O(1) lookup.
  const edgeSet = new Set<string>();
  for (const e of dagEdges) edgeSet.add(`${e.from}->${e.to}`);

  for (const track of tracks) {
    if (track.tasks.length < 2) continue;
    const qids = track.tasks
      .map((t) => `${track.id}.${t.id}`)
      .filter((q) => positionsMap.has(q))
      .sort((a, b) => positionsMap.get(a)!.x - positionsMap.get(b)!.x);
    if (qids.length < 2) continue;

    // Greedy grouping: extend a group while every pair inside has no edge.
    let group: string[] = [];
    const flush = () => {
      if (group.length >= 2) {
        let minX = Infinity,
          maxX = -Infinity;
        for (const q of group) {
          const p = positionsMap.get(q)!;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
        }
        zones.push({ trackId: track.id, qids: [...group], minX, maxX });
      }
      group = [];
    };
    for (const q of qids) {
      const independent = group.every(
        (g) => !edgeSet.has(`${g}->${q}`) && !edgeSet.has(`${q}->${g}`),
      );
      if (independent) group.push(q);
      else {
        flush();
        group = [q];
      }
    }
    flush();
  }
  return zones;
}

export function BoardCanvas({
  config,
  dagEdges,
  positions: storedPositions,
  selectedTaskIds,
  invalidTaskIds,
  errorsByTask,
  errorsByTrack,
  onSelectTask,
  onToggleTaskSelection,
  onSelectTrack,
  onAddTask,
  onAddTrack,
  onDeleteTask,
  onDeleteTrack,
  onRenameTrack,
  onMoveTrackTo,
  onAddDependency,
  onRemoveDependency,
  onSetTaskPosition,
  onSetTrackHeight,
  onTransferTask,
}: BoardCanvasProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Re-render on viewport scroll so the minimap viewport rect follows the
  // canvas (cheap rAF-throttled tick, see effect below).
  const [, setScrollTick] = useState(0);
  // Subscribe to store fields the parent does NOT thread through props.
  // We only use these for read-only visualization (cycle highlight, parallel
  // zones, selected-track-aware delete). All mutation continues to go through
  // the props callbacks owned by App.tsx.
  const validationErrors = usePipelineStore((s) => s.validationErrors);
  const selectedTrackId = usePipelineStore((s) => s.selectedTrackId);
  const deleteTaskAction = usePipelineStore((s) => s.deleteTask);
  const deleteTrackAction = usePipelineStore((s) => s.deleteTrack);
  // ── Track folders (editor-only grouping). Read directly from the store so
  // App.tsx doesn't need to thread a dozen folder callbacks through props.
  const folders = usePipelineStore((s) => s.folders);
  const createFolder = usePipelineStore((s) => s.createFolder);
  const deleteFolder = usePipelineStore((s) => s.deleteFolder);
  const renameFolder = usePipelineStore((s) => s.renameFolder);
  const toggleFolderCollapsed = usePipelineStore((s) => s.toggleFolderCollapsed);
  const moveTrackToFolder = usePipelineStore((s) => s.moveTrackToFolder);
  const moveTrackToRoot = usePipelineStore((s) => s.moveTrackToRoot);
  const storedTrackHeights = usePipelineStore((s) => s.trackHeights);
  const [taskDrag, setTaskDrag] = useState<TaskDragState | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<EdgeDragState | null>(null);
  const [trackDrag, setTrackDrag] = useState<TrackDragState | null>(null);
  const [trackResize, setTrackResize] = useState<TrackResizeState | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const dropRef = useRef<{ trackId: string; positionX: number; positionY: number } | null>(null);
  const nearRef = useRef<string | null>(null);

  const [inlineAdd, setInlineAdd] = useState<
    | { type: 'task'; trackId: string; kind: 'prompt' | 'command'; positionX?: number }
    | { type: 'track'; folderId?: string }
    | { type: 'rename'; trackId: string }
    | { type: 'rename-folder'; folderId: string }
    | null
  >(null);
  const [inlineValue, setInlineValue] = useState('');
  const inlineRef = useRef<HTMLInputElement>(null);

  const closeCtx = useCallback(() => setCtx(null), []);

  const tracks = config.tracks;
  const allTasks = useMemo(() => flattenTasks(config), [config]);

  // Build a lookup: qid → task for quick access
  const taskByQid = useMemo(() => {
    const m = new Map<string, RawTaskConfig>();
    for (const ft of allTasks) m.set(ft.qid, ft.task);
    return m;
  }, [allTasks]);

  // Build a lookup: qualified id ("trackId.taskId") → FlatTask for O(1)
  // callback lookups. Keying by bare task.id would collide when two tracks
  // contain tasks with the same id (e.g. `say_hello` in multiple tracks of
  // all-drivers-compare.yaml), routing every click to the last-written one.
  const flatTaskByQid = useMemo(() => {
    const m = new Map<string, FlatTask>();
    for (const ft of allTasks) m.set(ft.qid, ft);
    return m;
  }, [allTasks]);

  // Convert selectedTaskIds to a Set for O(1) membership tests
  const selectedIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);

  // Visual sort during track drag. Root tracks keep using config.tracks order;
  // folder member tracks are previewed by reordering folder.trackIds below.
  const orderedTracks = useMemo(() => {
    if (!trackDrag || trackDrag.folderId !== null) return tracks;
    const { trackId, dropIndex } = trackDrag;
    const without = tracks.filter((t) => t.id !== trackId);
    const dragged = tracks.find((t) => t.id === trackId);
    if (!dragged) return tracks;
    const result = [...without];
    result.splice(Math.min(dropIndex, result.length), 0, dragged);
    return result;
  }, [tracks, trackDrag]);

  const planFolders = useMemo(() => {
    if (!trackDrag) return folders;
    // Strip the dragged track from every folder so cross-folder previews
    // don't show it in two places at once. Then, if the current target is a
    // folder, splice it back in at the drop index.
    const targetFolder =
      trackDrag.folderId === null ? null : folders.find((f) => f.id === trackDrag.folderId);
    if (targetFolder?.collapsed) {
      return folders;
    }
    const stripped = folders.map((f) => ({
      ...f,
      trackIds: f.trackIds.filter((tid) => tid !== trackDrag.trackId),
    }));
    if (trackDrag.folderId === null || trackDrag.folderDropIndex === null) {
      return stripped;
    }
    const targetFolderId = trackDrag.folderId;
    const folderDropIndex = trackDrag.folderDropIndex;
    return stripped.map((f) => {
      if (f.id !== targetFolderId) return f;
      const ids = [...f.trackIds];
      const insertAt = Math.max(0, Math.min(folderDropIndex, ids.length));
      ids.splice(insertAt, 0, trackDrag.trackId);
      return { ...f, trackIds: ids };
    });
  }, [folders, trackDrag]);

  const effectiveTrackHeights = useMemo(() => {
    if (!trackResize) return storedTrackHeights;
    const next = new Map(storedTrackHeights);
    next.set(trackResize.trackId, trackResize.height);
    return next;
  }, [storedTrackHeights, trackResize]);

  /**
   * Render plan — the single source of truth for lane geometry. Folders
   * inject thin (FOLDER_H) header rows, and collapsed folders hide their
   * member tracks from the plan entirely. Every position/Y computation in
   * this component derives from this plan.
   */
  const renderPlan = useMemo(
    () => buildRenderPlan(orderedTracks, planFolders, effectiveTrackHeights),
    [orderedTracks, planFolders, effectiveTrackHeights],
  );

  /** Tracks that actually have a lane on screen (collapsed-folder members
   * filtered out), in plan order. Replaces the old `visualTracks`. */
  const visualTracks = useMemo(
    () => visibleTracksFromPlan(renderPlan, orderedTracks),
    [renderPlan, orderedTracks],
  );

  const staticPositions = useMemo(
    () => buildPositions(renderPlan, orderedTracks, storedPositions),
    [renderPlan, orderedTracks, storedPositions],
  );

  /**
   * During a track drag, renderPlan already places every non-dragged track at
   * its target slot. Only the dragged track needs a visual offset so the lane
   * stays at its original Y plus the raw cursor delta.
   */
  const trackDragOffsetByTrackId = useMemo(() => {
    if (!trackDrag) return null;
    const origPlan = buildRenderPlan(tracks, folders, effectiveTrackHeights);
    const fromY = trackTopYInPlan(origPlan, trackDrag.trackId);
    const toY = trackTopYInPlan(renderPlan, trackDrag.trackId);
    if (fromY === null || toY === null) return null;
    return new Map([[trackDrag.trackId, trackDrag.deltaY - (toY - fromY)]]);
  }, [trackDrag, tracks, folders, renderPlan, effectiveTrackHeights]);

  const positionsMap = useMemo(() => {
    let base = staticPositions;
    const draggedTrackOffset = trackDrag && trackDragOffsetByTrackId?.get(trackDrag.trackId);
    if (draggedTrackOffset) {
      const withTrackDrag = new Map(staticPositions);
      for (const ft of allTasks) {
        if (ft.trackId !== trackDrag.trackId) continue;
        const pos = staticPositions.get(ft.qid);
        if (pos) withTrackDrag.set(ft.qid, { ...pos, y: pos.y + draggedTrackOffset });
      }
      base = withTrackDrag;
    }
    if (!taskDrag) return base;
    const result = new Map(base);
    const targetY = trackTopY(renderPlan, taskDrag.targetTrackId);
    const innerY = clampTaskYInTrack(renderPlan, taskDrag.targetTrackId, taskDrag.contentY);
    result.set(taskDrag.qid, {
      x: Math.max(PAD_LEFT, taskDrag.contentX),
      y: targetY + innerY,
    });
    // Move companion tasks by the same delta (stay on own track).
    const dx = taskDrag.contentX - taskDrag.startX;
    const dy = taskDrag.contentY - taskDrag.startY;
    for (const c of taskDrag.companions) {
      const cx = Math.max(PAD_LEFT, c.startX + dx);
      const cy = trackTopY(renderPlan, c.trackId);
      const innerCompanionY = Math.max(
        0,
        Math.min(Math.max(0, trackHeightInPlan(renderPlan, c.trackId) - TASK_H), c.startY + dy),
      );
      result.set(c.qid, { x: cx, y: cy + innerCompanionY });
    }
    return result;
  }, [taskDrag, staticPositions, renderPlan, trackDrag, trackDragOffsetByTrackId, allTasks]);

  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current)
      headerRef.current.scrollTop = contentRef.current.scrollTop;
  }, []);

  const { contentW, contentH } = useMemo(() => {
    let maxX = 0;
    for (const [, pos] of positionsMap) {
      if (pos.x + TASK_W > maxX) maxX = pos.x + TASK_W;
    }
    return {
      contentW: Math.max(maxX + CANVAS_PAD_RIGHT, 2000),
      contentH: Math.max(planTotalHeight(renderPlan), 200),
    };
  }, [positionsMap, renderPlan]);

  const panDidDragRef = useRef(false);

  const handleBackgroundPanMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
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
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        started = true;
        panDidDragRef.current = true;
      }
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

  // ── Task drag (supports multi-select) ──
  const selectedIdsRef = useRef(selectedTaskIds);
  selectedIdsRef.current = selectedTaskIds;

  const handleTaskPointerDown = useCallback(
    (qid: string, e: React.PointerEvent) => {
      e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const isMultiKey = e.ctrlKey || e.metaKey;
      const ft = flatTaskByQid.get(qid);
      if (!ft) return;
      const taskId = ft.task.id;
      const pos = staticPositions.get(qid);
      if (!pos) return;
      const cp = toContent(e, el);
      const offX = cp.x - pos.x;
      const offY = cp.y - pos.y;
      const startCX = e.clientX,
        startCY = e.clientY;
      let started = false;

      // Build companion list: other selected tasks that will move together.
      // If the grabbed task is already selected, drag all selected; otherwise
      // just drag the single grabbed task (selection updates on pointerup).
      const curSel = selectedIdsRef.current;
      const isAlreadySelected = curSel.includes(qid);
      const companionQids =
        isAlreadySelected && !isMultiKey ? curSel.filter((id) => id !== qid) : [];
      const companions: DragCompanion[] = companionQids.map((cqid) => {
        const [trkId, tskId] = cqid.split('.');
        const cPos = staticPositions.get(cqid);
        return {
          qid: cqid,
          taskId: tskId,
          trackId: trkId,
          startX: cPos?.x ?? 0,
          startY: cPos ? cPos.y - trackTopY(renderPlan, trkId) : 0,
        };
      });
      const startX = pos.x;
      const startY = pos.y;

      const hasCompanions = companions.length > 0;

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientX - startCX) + Math.abs(ev.clientY - startCY) < DRAG_THRESHOLD)
            return;
          started = true;
        }
        const c = toContent(ev, el);
        const cx = Math.max(PAD_LEFT, c.x - offX);
        const rawY = c.y - offY;
        // Multi-drag is horizontal only — lock to original track
        const trkId = hasCompanions ? ft.trackId : (trackAtY(renderPlan, c.y) ?? ft.trackId);
        const positionY = clampTaskYInTrack(renderPlan, trkId, rawY);
        dropRef.current = { trackId: trkId, positionX: cx, positionY };
        setTaskDrag({
          qid,
          taskId,
          trackId: ft.trackId,
          contentX: cx,
          contentY: trackTopY(renderPlan, trkId) + positionY,
          targetTrackId: trkId,
          startX,
          startY,
          companions,
        });
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (!started) {
          // Click: Ctrl/Cmd toggles selection, plain click selects single
          if (isMultiKey) {
            onToggleTaskSelection(qid);
          } else {
            onSelectTask(qid);
          }
        } else {
          const d = dropRef.current;
          if (d) {
            const dx = d.positionX - startX;
            const dy = d.positionY - (startY - trackTopY(renderPlan, ft.trackId));
            // Commit position for grabbed task
            onSetTaskPosition(`${d.trackId}.${taskId}`, d.positionX, d.positionY);
            if (d.trackId !== ft.trackId) onTransferTask(ft.trackId, taskId, d.trackId);
            // Commit horizontal positions for companions (no cross-track)
            for (const c of companions) {
              const cx = Math.max(PAD_LEFT, c.startX + dx);
              const companionY = Math.max(
                0,
                Math.min(
                  Math.max(0, trackHeightInPlan(renderPlan, c.trackId) - TASK_H),
                  c.startY + dy,
                ),
              );
              onSetTaskPosition(`${c.trackId}.${c.taskId}`, cx, companionY);
            }
          }
        }
        dropRef.current = null;
        setTaskDrag(null);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.userSelect = 'none';
    },
    [
      staticPositions,
      renderPlan,
      flatTaskByQid,
      onSelectTask,
      onToggleTaskSelection,
      onSetTaskPosition,
      onTransferTask,
    ],
  );

  // ── Edge drag ──
  const handleHandlePointerDown = useCallback(
    (qid: string, _e: React.PointerEvent) => {
      _e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const srcQid = qid;
      if (!flatTaskByQid.has(srcQid)) return;

      const onMove = (ev: PointerEvent) => {
        const cp = toContent(ev, el);
        const near = findNearestTarget(cp.x, cp.y, positionsMap, srcQid);
        nearRef.current = near;
        setEdgeDrag({ srcQid, mx: cp.x, my: cp.y, target: near });
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        const targetQid = nearRef.current;
        if (targetQid) {
          const [srcTrack, srcTask] = srcQid.split('.');
          const [tgtTrack, tgtTask] = targetQid.split('.');
          onAddDependency(srcTrack, srcTask, tgtTrack, tgtTask);
        }
        nearRef.current = null;
        setEdgeDrag(null);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'crosshair';
    },
    [flatTaskByQid, positionsMap, onAddDependency],
  );

  const handleTargetPointerUp = useCallback(
    (qid: string) => {
      if (edgeDrag) {
        if (flatTaskByQid.has(qid) && qid !== edgeDrag.srcQid) nearRef.current = qid;
      }
    },
    [edgeDrag, flatTaskByQid],
  );

  // ── Track drag ──
  const handleTrackDragStart = useCallback(
    (trackId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startIndex = tracks.findIndex((t) => t.id === trackId);
      if (startIndex < 0) return;
      const startFolder = folders.find((f) => f.trackIds.includes(trackId)) ?? null;
      const startFolderIndex = startFolder?.trackIds.indexOf(trackId) ?? null;
      const headerEl = headerRef.current;
      if (!headerEl) return;
      const headerRect = headerEl.getBoundingClientRect();
      let started = false;
      const startClientY = e.clientY;
      const startRelY = (e.clientY - headerRect.top) / getZoom() + headerEl.scrollTop;
      // Plan-aware start: where this track's lane currently sits.
      const startTopY = trackTopYInPlan(renderPlan, trackId) ?? startIndex * TRACK_H;
      const grabOffsetY = startRelY - startTopY;

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientY - startClientY) < DRAG_THRESHOLD) return;
          started = true;
        }
        const relY = (ev.clientY - headerRect.top) / getZoom() + headerEl.scrollTop;
        const deltaY = relY - startRelY;
        // Map dragged-track center Y to a lane via the plan. The cursor row
        // determines the drop target — folder header → into that folder
        // (append); folder member → into that folder at the member's slot;
        // top-level track → top-level reorder. When the cursor falls outside
        // any row, hold the previous target so the indicator doesn't jitter.
        const draggedCenterY = relY - grabOffsetY + trackHeightInPlan(renderPlan, trackId) / 2;
        const row = rowAtY(renderPlan, draggedCenterY);

        const startTargetFolderId = startFolder?.id ?? null;
        const startTargetFolderIdx = startFolderIndex;

        let targetFolderId: string | null;
        let targetFolderDropIndex: number | null;
        let topLevelDropIndex: number;

        if (row?.kind === 'folder') {
          const f = folders.find((ff) => ff.id === row.folderId);
          targetFolderId = row.folderId;
          // Append to end of the destination folder. If we're already in
          // that folder, "end" means the existing length minus the
          // dragged-track slot we're vacating.
          const memberCount = f ? f.trackIds.filter((tid) => tid !== trackId).length : 0;
          targetFolderDropIndex = memberCount;
          topLevelDropIndex = startIndex;
        } else if (row?.kind === 'track' && row.folderId !== null) {
          const f = folders.find((ff) => ff.id === row.folderId);
          targetFolderId = row.folderId;
          // Same-folder drags use the original slot index: after stripping
          // the dragged track, every row below it shifts up by one.
          // Cross-folder drags use the destination's post-strip slot.
          const stripped = f ? f.trackIds.filter((tid) => tid !== trackId) : [];
          const idx =
            row.folderId === startTargetFolderId
              ? (f?.trackIds.indexOf(row.trackId) ?? -1)
              : stripped.indexOf(row.trackId);
          targetFolderDropIndex = idx >= 0 ? idx : stripped.length;
          topLevelDropIndex = startIndex;
        } else if (row?.kind === 'track' && row.folderId === null) {
          targetFolderId = null;
          targetFolderDropIndex = null;
          const idx = tracks.findIndex((t) => t.id === row.trackId);
          topLevelDropIndex = idx === -1 ? startIndex : idx;
        } else {
          // Cursor isn't on a row (gap above/below the plan, or unmapped).
          // Preserve the previous target so the indicator stays put.
          const prev = trackDragRef.current;
          if (prev) {
            targetFolderId = prev.folderId;
            targetFolderDropIndex = prev.folderDropIndex;
            topLevelDropIndex = prev.dropIndex;
          } else {
            targetFolderId = startTargetFolderId;
            targetFolderDropIndex = startTargetFolderIdx;
            topLevelDropIndex = startIndex;
          }
        }

        setTrackDrag({
          trackId,
          startIndex,
          dropIndex: topLevelDropIndex,
          folderId: targetFolderId,
          folderStartIndex: startTargetFolderIdx,
          folderDropIndex: targetFolderDropIndex,
          deltaY,
        });
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (started) {
          const current = trackDragRef.current;
          const startTargetFolderId = startFolder?.id ?? null;
          if (current) {
            const folderChanged = current.folderId !== startTargetFolderId;
            const sameFolderReordered =
              current.folderId !== null &&
              current.folderId === startTargetFolderId &&
              current.folderDropIndex !== null &&
              current.folderDropIndex !== current.folderStartIndex;
            if (folderChanged) {
              if (current.folderId === null) {
                moveTrackToRoot(trackId, current.dropIndex);
              } else {
                moveTrackToFolder(trackId, current.folderId, current.folderDropIndex ?? undefined);
              }
            } else if (sameFolderReordered) {
              moveTrackToFolder(trackId, current.folderId, current.folderDropIndex ?? undefined);
            } else if (
              current.folderId === null &&
              startTargetFolderId === null &&
              current.startIndex !== current.dropIndex
            ) {
              onMoveTrackTo(trackId, current.dropIndex);
            }
          }
        } else {
          onSelectTrack(trackId);
        }
        setTrackDrag(null);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    },
    [tracks, folders, renderPlan, moveTrackToFolder, moveTrackToRoot, onMoveTrackTo, onSelectTrack],
  );

  const trackDragRef = useRef<TrackDragState | null>(null);
  useEffect(() => {
    trackDragRef.current = trackDrag;
  }, [trackDrag]);

  const handleTrackResizeStart = useCallback(
    (trackId: string, e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startHeight = trackHeightInPlan(renderPlan, trackId);
      const startClientY = e.clientY;
      let latestHeight = startHeight;

      const onMove = (ev: PointerEvent) => {
        const dy = (ev.clientY - startClientY) / getZoom();
        latestHeight = clampTrackHeight(startHeight + dy);
        setTrackResize({ trackId, height: latestHeight });
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setTrackResize(null);
        if (latestHeight !== startHeight) onSetTrackHeight(trackId, latestHeight);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    },
    [onSetTrackHeight, renderPlan],
  );

  // ── Context menus ──
  const handleTaskModifyClick = useCallback(
    (qid: string) => {
      const ft = flatTaskByQid.get(qid);
      if (!ft) return;
      const track = tracks.find((t) => t.id === ft.trackId);
      if (!track) return;

      setSelEdge(null);
      setCtx(null);

      const attachment = buildModifyTargetAttachment({
        kind: 'task',
        track,
        task: ft.task,
      });
      useChatStore
        .getState()
        .attachComposerContext(attachment, attachment.defaultInstruction);
    },
    [flatTaskByQid, tracks],
  );

  const handleTrackModifyClick = useCallback(
    (trackId: string) => {
      const track = tracks.find((t) => t.id === trackId);
      if (!track) return;

      setSelEdge(null);
      setCtx(null);

      const attachment = buildModifyTargetAttachment({ kind: 'track', track });
      useChatStore
        .getState()
        .attachComposerContext(attachment, attachment.defaultInstruction);
    },
    [tracks],
  );

  const handleHeaderContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const headerEl = headerRef.current;
      if (!headerEl) return;
      const rect = headerEl.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / getZoom() + headerEl.scrollTop;
      const row = rowAtY(renderPlan, relY);

      // Empty area (or unmapped Y): just offer track / folder creation.
      if (!row) {
        setCtx({
          x: e.clientX,
          y: e.clientY,
          items: [
            {
              label: 'Add Track',
              icon: <ListPlus size={12} />,
              onAction: () => {
                setInlineAdd({ type: 'track' });
                setInlineValue('');
              },
            },
            {
              label: 'New Folder',
              icon: <FolderPlus size={12} />,
              onAction: () => {
                createFolder({});
              },
            },
          ],
        });
        return;
      }

      // Folder bar: folder-specific actions.
      if (row.kind === 'folder') {
        const folder = folders.find((f) => f.id === row.folderId);
        if (!folder) return;
        setCtx({
          x: e.clientX,
          y: e.clientY,
          items: [
            {
              label: 'Add Track to Folder',
              icon: <ListPlus size={12} />,
              onAction: () => {
                if (folder.collapsed) toggleFolderCollapsed(folder.id);
                setInlineAdd({ type: 'track', folderId: folder.id });
                setInlineValue('');
              },
            },
            { separator: true },
            {
              label: folder.collapsed ? 'Expand Folder' : 'Collapse Folder',
              icon: folder.collapsed ? <FolderOpen size={12} /> : <FolderMinus size={12} />,
              onAction: () => toggleFolderCollapsed(folder.id),
            },
            {
              label: 'Rename Folder',
              icon: <Pencil size={12} />,
              onAction: () => {
                setInlineAdd({ type: 'rename-folder', folderId: folder.id });
                setInlineValue(folder.name);
              },
            },
            { separator: true },
            {
              label: 'New Folder',
              icon: <FolderPlus size={12} />,
              onAction: () => createFolder({}),
            },
            {
              label: 'Delete Folder',
              icon: <Trash2 size={12} />,
              danger: true,
              onAction: () => deleteFolder(folder.id),
            },
          ],
        });
        return;
      }

      // Track row: existing track items + folder-membership controls.
      const trackId = row.trackId;
      const track = config.tracks.find((t) => t.id === trackId);
      const currentFolder = folders.find((f) => f.trackIds.includes(trackId));
      const moveSubmenuItems: MenuEntry[] = [
        ...folders
          .filter((f) => f.id !== currentFolder?.id)
          .map<MenuEntry>((f) => ({
            label: f.name,
            icon: <FolderOpen size={12} />,
            onAction: () => moveTrackToFolder(trackId, f.id),
          })),
        ...(folders.length > 0 ? [{ separator: true } as const] : []),
        {
          label: 'New folder…',
          icon: <FolderPlus size={12} />,
          onAction: () => createFolder({ trackIds: [trackId] }),
        },
      ];
      setCtx({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Add Prompt Task',
            icon: <MessageSquare size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'task', trackId, kind: 'prompt' });
              setInlineValue('');
            },
          },
          {
            label: 'Add Command Task',
            icon: <Terminal size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'task', trackId, kind: 'command' });
              setInlineValue('');
            },
          },
          {
            label: 'Rename Track',
            icon: <Pencil size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'rename', trackId });
              setInlineValue(track?.name ?? '');
            },
          },
          { separator: true },
          {
            label: currentFolder
              ? `Move to folder… (now in ${currentFolder.name})`
              : 'Move to folder…',
            icon: <FolderOpen size={12} />,
            submenu: { items: moveSubmenuItems },
          },
          ...(currentFolder
            ? [
                {
                  label: 'Remove from Folder',
                  icon: <FolderMinus size={12} />,
                  onAction: () => moveTrackToFolder(trackId, null),
                } as MenuEntry,
              ]
            : []),
          { separator: true },
          {
            label: 'Add Track',
            icon: <ListPlus size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'track' });
              setInlineValue('');
            },
          },
          {
            label: 'Delete Track',
            icon: <Trash2 size={12} />,
            danger: true,
            onAction: () => onDeleteTrack(trackId),
          },
        ],
      });
    },
    [
      renderPlan,
      config.tracks,
      onDeleteTrack,
      folders,
      createFolder,
      deleteFolder,
      toggleFolderCollapsed,
      moveTrackToFolder,
    ],
  );

  const handleTaskContextMenu = useCallback(
    (qid: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ft = flatTaskByQid.get(qid);
      if (!ft) return;
      setCtx({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Delete Task',
            icon: <Trash2 size={12} />,
            danger: true,
            onAction: () => onDeleteTask(ft.trackId, ft.task.id),
          },
        ],
      });
    },
    [flatTaskByQid, onDeleteTask],
  );

  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const cp = toContent(e, el);
      const trackId = trackAtY(renderPlan, cp.y);
      if (!trackId) return;
      const clickX = Math.max(PAD_LEFT, cp.x);
      setCtx({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Add Prompt Task Here',
            icon: <MessageSquare size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'task', trackId, kind: 'prompt', positionX: clickX });
              setInlineValue('');
            },
          },
          {
            label: 'Add Command Task Here',
            icon: <Terminal size={12} />,
            onAction: () => {
              setInlineAdd({ type: 'task', trackId, kind: 'command', positionX: clickX });
              setInlineValue('');
            },
          },
        ],
      });
    },
    [renderPlan],
  );

  useEffect(() => {
    if (inlineAdd && inlineRef.current) inlineRef.current.focus();
  }, [inlineAdd]);

  const commitInlineAdd = useCallback(() => {
    const name = inlineValue.trim();
    if (!name || !inlineAdd) {
      setInlineAdd(null);
      return;
    }
    if (inlineAdd.type === 'task')
      onAddTask(inlineAdd.trackId, name, { kind: inlineAdd.kind, positionX: inlineAdd.positionX });
    else if (inlineAdd.type === 'track')
      onAddTrack(name, inlineAdd.folderId ? { folderId: inlineAdd.folderId } : undefined);
    else if (inlineAdd.type === 'rename') onRenameTrack(inlineAdd.trackId, name);
    else if (inlineAdd.type === 'rename-folder') renameFolder(inlineAdd.folderId, name);
    setInlineAdd(null);
    setInlineValue('');
  }, [inlineValue, inlineAdd, onAddTask, onAddTrack, onRenameTrack, renameFolder]);

  // ── Remove the currently selected edge by looking up the dep ref that
  // resolves to edge.from on the edge.to task. Mirrors the inline click
  // handler on the X button but is reused by the Delete key and the edge
  // context menu so behavior stays consistent.
  const removeSelectedEdge = useCallback(() => {
    const ek = selEdge;
    if (!ek) return;
    const [fromQid, toQid] = ek.split('->');
    if (!fromQid || !toQid) return;
    const [toTrack, toTaskId] = toQid.split('.');
    const track = config.tracks.find((t) => t.id === toTrack);
    if (!track) {
      setSelEdge(null);
      return;
    }
    const task = track.tasks.find((t) => t.id === toTaskId);
    if (!task?.depends_on) {
      setSelEdge(null);
      return;
    }
    for (const dep of task.depends_on) {
      const resolved = dep.includes('.')
        ? dep
        : track.tasks.some((t) => t.id === dep)
          ? `${toTrack}.${dep}`
          : dep;
      if (resolved === fromQid || `${toTrack}.${dep}` === fromQid) {
        onRemoveDependency(toTrack, toTaskId, dep);
        break;
      }
    }
    setSelEdge(null);
  }, [selEdge, config.tracks, onRemoveDependency]);

  // ── Stable callbacks for memoized EdgeLine ──
  const handleEdgeSelect = useCallback((ek: string | null) => {
    setSelEdge(ek);
  }, []);

  const handleEdgeContextMenu = useCallback(
    (ek: string, e: React.MouseEvent) => {
      setSelEdge(ek);
      const [fromQid, toQid] = ek.split('->');
      setCtx({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Delete dependency',
            icon: <Trash2 size={12} />,
            danger: true,
            onAction: () => {
              if (!toQid) return;
              const [toTrackId, toTaskId] = toQid.split('.');
              const track = config.tracks.find((t) => t.id === toTrackId);
              if (!track) return;
              const task = track.tasks.find((t) => t.id === toTaskId);
              if (!task?.depends_on) return;
              for (const dep of task.depends_on) {
                const resolved = dep.includes('.')
                  ? dep
                  : track.tasks.some((t) => t.id === dep)
                    ? `${toTrackId}.${dep}`
                    : dep;
                if (resolved === fromQid || `${toTrackId}.${dep}` === fromQid) {
                  onRemoveDependency(toTrackId, toTaskId, dep);
                  break;
                }
              }
              setSelEdge(null);
            },
          },
        ],
      });
    },
    [config.tracks, onRemoveDependency],
  );

  const handleEdgeRemove = useCallback(
    (ek: string) => {
      const [fromQid, toQid] = ek.split('->');
      if (!fromQid || !toQid) return;
      const [toTrack, toTaskId] = toQid.split('.');
      const track = config.tracks.find((t) => t.id === toTrack);
      if (!track) {
        setSelEdge(null);
        return;
      }
      const task = track.tasks.find((t) => t.id === toTaskId);
      if (!task?.depends_on) {
        setSelEdge(null);
        return;
      }
      for (const dep of task.depends_on) {
        const resolved = dep.includes('.')
          ? dep
          : track.tasks.some((t) => t.id === dep)
            ? `${toTrack}.${dep}`
            : dep;
        if (resolved === fromQid || `${toTrack}.${dep}` === fromQid) {
          onRemoveDependency(toTrack, toTaskId, dep);
          break;
        }
      }
      setSelEdge(null);
    },
    [config.tracks, onRemoveDependency],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTaskDrag(null);
        setEdgeDrag(null);
        setTrackDrag(null);
        setCtx(null);
        setInlineAdd(null);
        setSelEdge(null);
        return;
      }
      // Delete / Backspace removes the current selection. We skip when the
      // user is typing in a form control so field editing isn't hijacked.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const target = e.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
        }
        // Priority: edge > task > track. Group 3 will layer a confirm dialog
        // over task/track delete; for now we just call the store action.
        if (selEdge) {
          e.preventDefault();
          removeSelectedEdge();
          return;
        }
        if (selectedTaskIds.length > 0) {
          e.preventDefault();
          for (const qid of selectedTaskIds) {
            const [trkId, tskId] = qid.split('.');
            if (trkId && tskId) deleteTaskAction(trkId, tskId);
          }
          return;
        }
        if (selectedTrackId) {
          e.preventDefault();
          deleteTrackAction(selectedTrackId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    selEdge,
    selectedTaskIds,
    selectedTrackId,
    removeSelectedEdge,
    deleteTaskAction,
    deleteTrackAction,
  ]);

  // ── Cycle edge highlighting (L3) ──
  const cycleEdgeSet = useMemo(() => {
    const msgs = validationErrors
      .filter((err) => /cycle|circular/i.test(err.message))
      .map((err) => err.message);
    return parseCycleEdges(msgs);
  }, [validationErrors]);

  // ── Focus-task side channel (U5) ──
  // Task cards dispatch a `tagma:focus-task` CustomEvent whose detail is the
  // qualified task id. BoardCanvas listens and scrolls the canvas so the
  // card is centered in the viewport.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<string>;
      const qid = ce.detail;
      const el = contentRef.current;
      if (!qid || !el) return;
      const pos = staticPositions.get(qid);
      if (!pos) return;
      const z = getZoom();
      const visW = el.clientWidth;
      const visH = el.clientHeight;
      el.scrollTo({
        left: Math.max(0, pos.x + TASK_W / 2 - visW / (2 * z)),
        top: Math.max(0, pos.y + TASK_H / 2 - visH / (2 * z)),
        behavior: 'smooth',
      });
      // Brief glow so the user can spot the result after the scroll lands.
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
  }, [staticPositions]);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<string>;
      const trackId = ce.detail;
      const el = contentRef.current;
      if (!trackId || !el || !visualTracks.some((track) => track.id === trackId)) return;
      const top = trackTopY(renderPlan, trackId);
      const z = getZoom();
      const targetTop = Math.max(
        0,
        top + trackHeightInPlan(renderPlan, trackId) / 2 - el.clientHeight / (2 * z),
      );
      el.scrollTo({ top: targetTop, behavior: 'smooth' });
      headerRef.current?.scrollTo({ top: targetTop, behavior: 'smooth' });
      window.setTimeout(() => {
        const header = Array.from(document.querySelectorAll<HTMLElement>('[data-track-id]')).find(
          (candidate) => candidate.dataset.trackId === trackId,
        );
        if (!header) return;
        header.classList.remove('focus-pulse');
        void header.offsetWidth;
        header.classList.add('focus-pulse');
        window.setTimeout(() => header.classList.remove('focus-pulse'), 1400);
      }, 60);
    };
    window.addEventListener('tagma:focus-track', handler);
    return () => window.removeEventListener('tagma:focus-track', handler);
  }, [visualTracks, renderPlan]);

  // ── Minimap viewport tracking — re-render on scroll of canvas. ──
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let rafId = 0;
    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        setScrollTick((t) => (t + 1) & 0xffff);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // ── Parallel zones (L1) ──
  const parallelZones = useMemo(
    () => computeParallelZones(visualTracks, staticPositions, dagEdges),
    [visualTracks, staticPositions, dagEdges],
  );

  /**
   * Walk the render plan once to materialize per-row geometry: top Y, the
   * raw row descriptor, and (for tracks) the underlying RawTrackConfig +
   * raw config.tracks index. The sidebar and canvas-background loops both
   * consume this so folder rows and track rows stay vertically aligned to
   * the pixel.
   */
  const planRows = useMemo(() => {
    const trackById = new Map<string, RawTrackConfig>();
    for (const t of tracks) trackById.set(t.id, t);
    const trackIndexById = new Map<string, number>();
    tracks.forEach((t, i) => trackIndexById.set(t.id, i));
    const folderById = new Map<string, TrackFolder>();
    for (const f of folders) folderById.set(f.id, f);

    type TrackRow = {
      kind: 'track';
      top: number;
      height: number;
      track: RawTrackConfig;
      origIndex: number;
      folderId: string | null;
    };
    type FolderRow = {
      kind: 'folder';
      top: number;
      height: number;
      folder: TrackFolder;
    };
    const rows: Array<TrackRow | FolderRow> = [];
    let y = 0;
    for (const r of renderPlan) {
      if (r.kind === 'folder') {
        const f = folderById.get(r.folderId);
        if (f) rows.push({ kind: 'folder', top: y, height: r.height, folder: f });
      } else {
        const t = trackById.get(r.trackId);
        if (t) {
          rows.push({
            kind: 'track',
            top: y,
            height: r.height,
            track: t,
            origIndex: trackIndexById.get(t.id) ?? 0,
            folderId: r.folderId,
          });
        }
      }
      y += r.height;
    }
    return rows;
  }, [renderPlan, tracks, folders]);

  // Build edge key for selection
  const edgeKey = (from: string, to: string) => `${from}->${to}`;

  return (
    <div className="h-full w-full min-w-0 flex bg-tagma-bg relative">
      {/* Left: Track headers */}
      <div
        ref={headerRef}
        className="shrink-0 border-r border-tagma-border overflow-hidden bg-tagma-surface/50"
        style={{ width: HEADER_W }}
        onContextMenu={handleHeaderContextMenu}
      >
        {planRows.map((row) => {
          if (row.kind === 'folder') {
            const f = row.folder;
            return (
              <FolderHeaderBar
                key={`folder-${f.id}`}
                folder={f}
                memberCount={f.trackIds.filter((tid) => tracks.some((t) => t.id === tid)).length}
                height={row.height}
                onToggle={() => toggleFolderCollapsed(f.id)}
              />
            );
          }
          const track = row.track;
          const taskCount = track.tasks.length;
          // Check if tasks have dependencies connecting them all
          const depCount = dagEdges.filter(
            (e) => e.from.startsWith(track.id + '.') && e.to.startsWith(track.id + '.'),
          ).length;
          const hasParallel = taskCount > 1 && depCount < taskCount - 1;
          const isDraggedTrack = trackDrag?.trackId === track.id;
          const isResizingTrack = trackResize?.trackId === track.id;
          const isSelectedTrack = selectedTrackId === track.id;
          const inFolder = row.folderId !== null;

          let translateY = 0;
          if (trackDrag) {
            if (isDraggedTrack) {
              translateY = trackDragOffsetByTrackId?.get(track.id) ?? trackDrag.deltaY;
            }
          }

          return (
            <div
              key={track.id}
              data-track-id={track.id}
              className={`relative border-b border-tagma-border/60 overflow-hidden ${isDraggedTrack ? 'opacity-60 bg-tagma-accent/5' : ''} ${isSelectedTrack ? 'selected-track-row' : ''}`}
              style={{
                height: row.height,
                width: HEADER_W,
                boxSizing: 'border-box',
                transform: translateY ? `translateY(${translateY}px)` : undefined,
                transition: trackDrag
                  ? isDraggedTrack
                    ? 'none'
                    : 'transform 150ms ease-out'
                  : undefined,
                zIndex: isDraggedTrack ? 10 : 0,
                position: 'relative',
                // Subtle inset highlight on the left when this track lives in
                // a folder, so the grouping is visible without spending a
                // whole indent column on it.
                boxShadow: inFolder ? 'inset 3px 0 0 rgb(var(--tagma-muted) / 0.25)' : undefined,
              }}
            >
              <div
                className="h-full flex cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => handleTrackDragStart(track.id, e)}
              >
                <div className="flex-1 min-w-0 flex items-stretch">
                  <TrackLane
                    track={track}
                    taskCount={taskCount}
                    hasParallelWarning={hasParallel}
                    errorMessages={errorsByTrack.get(track.id)}
                    onModifyClick={handleTrackModifyClick}
                  />
                </div>
              </div>
              <div
                data-track-resize-edge="bottom"
                className={`absolute left-0 right-0 bottom-0 h-1 cursor-ns-resize z-20 transition-colors ${
                  isResizingTrack
                    ? 'bg-tagma-accent'
                    : 'bg-transparent hover:bg-tagma-accent/60 active:bg-tagma-accent'
                }`}
                title="Resize track"
                onPointerDown={(e) => handleTrackResizeStart(track.id, e)}
              />
            </div>
          );
        })}
      </div>

      {/* Right: Timeline canvas */}
      <div
        ref={contentRef}
        id={BOARD_SCROLL_ID}
        className="flex-1 min-w-0 overflow-auto timeline-grid hide-scrollbar"
        onScroll={syncScroll}
        onContextMenu={handleCanvasContextMenu}
        onMouseDown={handleBackgroundPanMouseDown}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onSelectTask(null);
            onSelectTrack(null);
            setSelEdge(null);
          }
        }}
      >
        <div
          className="relative w-full cursor-grab active:cursor-grabbing"
          style={{ minWidth: contentW, minHeight: contentH }}
        >
          {/* Row backgrounds — folder bars get a subtle dashed band so the
              canvas mirrors the sidebar's folder header at the same Y. */}
          {planRows.map((row, idx) => {
            if (row.kind === 'folder') {
              return (
                <div
                  key={`bg-folder-${row.folder.id}`}
                  className="absolute left-0 right-0 pointer-events-none"
                  style={{
                    top: row.top,
                    height: row.height,
                    background: 'rgb(var(--tagma-muted) / 0.04)',
                    borderBottom: row.folder.collapsed
                      ? '1px dashed rgb(var(--tagma-border) / 0.7)'
                      : '1px solid rgb(var(--tagma-border) / 0.6)',
                  }}
                />
              );
            }
            const track = row.track;
            const isSelectedTrack = selectedTrackId === track.id;
            const zebra = idx % 2 === 0 ? 'track-row-even' : 'track-row-odd';
            return (
              <div
                key={`bg-${track.id}`}
                className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${zebra} ${isSelectedTrack ? 'selected-track-row' : ''}`}
                style={{ top: row.top, height: row.height }}
                onMouseDown={handleBackgroundPanMouseDown}
                onClick={() => {
                  if (!panDidDragRef.current) {
                    onSelectTask(null);
                    onSelectTrack(null);
                    setSelEdge(null);
                  }
                }}
              />
            );
          })}

          {/* Parallel zone hints (L1) — subtle dashed rectangle behind
              sibling tasks in a track that have no depends_on relationship
              among themselves, with a small corner label. */}
          {parallelZones.map((zone, idx) => {
            const trackTop = trackTopYInPlan(renderPlan, zone.trackId);
            if (trackTop === null) return null;
            const topY = trackTop + 4;
            const h = trackHeightInPlan(renderPlan, zone.trackId) - 8;
            const left = zone.minX - 6;
            const LABEL_TAB_W = 56;
            const tasksRight = zone.maxX + TASK_W + 6 - left;
            const width = tasksRight + LABEL_TAB_W;
            return (
              <div
                key={`pz-${zone.trackId}-${idx}`}
                className="absolute pointer-events-none"
                style={{
                  left,
                  top: topY,
                  width,
                  height: h,
                  border: '1px dashed rgb(var(--tagma-muted-dim) / 0.35)',
                  background: 'rgb(var(--tagma-muted-dim) / 0.06)',
                  borderRadius: 2,
                }}
              >
                <span
                  className="absolute flex items-center justify-center text-[9px] font-mono uppercase tracking-wider text-tagma-muted/70 select-none"
                  style={{ left: tasksRight, top: 0, width: LABEL_TAB_W, height: h }}
                >
                  parallel
                </span>
              </div>
            );
          })}

          {/* Task cards */}
          {allTasks.map((ft) => {
            const pos = positionsMap.get(ft.qid);
            if (!pos) return null;
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
                isSelected={selectedIdSet.has(ft.qid)}
                isInvalid={invalidTaskIds.has(ft.qid)}
                errorMessages={errorsByTask.get(ft.qid)}
                isDragging={
                  taskDrag !== null &&
                  (taskDrag.qid === ft.qid || taskDrag.companions.some((c) => c.qid === ft.qid))
                }
                isTrackDragging={trackDrag !== null}
                isEdgeTarget={
                  edgeDrag !== null && edgeDrag.srcQid !== ft.qid && edgeDrag.target === ft.qid
                }
                onPointerDown={handleTaskPointerDown}
                onHandlePointerDown={handleHandlePointerDown}
                onTargetPointerUp={handleTargetPointerUp}
                onContextMenu={handleTaskContextMenu}
                onModifyClick={handleTaskModifyClick}
              />
            );
          })}

          {/* SVG edges */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={contentW}
            height={contentH}
            style={{ overflow: 'visible' }}
          >
            <defs>
              <marker id="ah" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon
                  points="0 0, 7 2.5, 0 5"
                  style={{ fill: 'var(--tagma-edge-default-marker)' }}
                />
              </marker>
              <marker id="ah-hi" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" style={{ fill: 'rgb(var(--tagma-accent))' }} />
              </marker>
              <marker
                id="ah-cont"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 2.5, 0 5"
                  style={{ fill: 'var(--tagma-edge-continue-marker)' }}
                />
              </marker>
              <marker
                id="ah-cont-hi"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 2.5, 0 5"
                  style={{ fill: 'var(--tagma-edge-continue-hi)' }}
                />
              </marker>
              <marker
                id="ah-cycle"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon points="0 0, 7 2.5, 0 5" style={{ fill: 'rgb(var(--tagma-error))' }} />
              </marker>
            </defs>

            {dagEdges.map((edge) => {
              const sp = positionsMap.get(edge.from);
              const tp = positionsMap.get(edge.to);
              if (!sp || !tp) return null;
              const d = stepPath(sp, tp);
              const ek = edgeKey(edge.from, edge.to);
              const sx = sp.x + TASK_W,
                sy = sp.y + TASK_H / 2;
              const tx = tp.x,
                ty = tp.y + TASK_H / 2;
              const toTask = taskByQid.get(edge.to);
              const cf = toTask?.continue_from;
              // Match the same resolution order as dag.ts / validate-raw.ts:
              //   1. Fully-qualified ref → exact match
              //   2. Bare ref, same-track → ${toTrackId}.${cf} === edge.from
              //   3. Bare ref, cross-track (unambiguous) → edge.from endsWith `.${cf}`
              // Without (3) a bare cross-track continue_from still draws the
              // edge, but the style falls back to the default dep arrow
              // instead of the purple continue arrow.
              const isContinue =
                !!cf &&
                (cf === edge.from ||
                  (cf.includes('.')
                    ? false
                    : `${edge.to.split('.')[0]}.${cf}` === edge.from ||
                      edge.from.endsWith(`.${cf}`)));
              const inCycle = cycleEdgeSet.has(ek);
              const isDataflow = edge.kind === 'dataflow';

              return (
                <EdgeLine
                  key={ek}
                  ek={ek}
                  d={d}
                  sx={sx}
                  sy={sy}
                  tx={tx}
                  ty={ty}
                  isContinue={isContinue}
                  isDataflow={isDataflow}
                  inCycle={inCycle}
                  selected={selEdge === ek}
                  onSelect={handleEdgeSelect}
                  onCtx={handleEdgeContextMenu}
                  onRemove={handleEdgeRemove}
                />
              );
            })}

            {edgeDrag &&
              (() => {
                const sp = positionsMap.get(edgeDrag.srcQid);
                if (!sp) return null;
                const sx = sp.x + TASK_W,
                  sy = sp.y + TASK_H / 2;
                const tp = edgeDrag.target ? positionsMap.get(edgeDrag.target) : null;
                const ex = tp ? tp.x : edgeDrag.mx;
                const ey = tp ? tp.y + TASK_H / 2 : edgeDrag.my;
                if (tp) {
                  const c = Math.max(40, Math.abs(ex - sx) * 0.5);
                  return (
                    <path
                      d={`M${sx} ${sy} C${sx + c} ${sy}, ${ex - c} ${ey}, ${ex} ${ey}`}
                      fill="none"
                      style={{ stroke: 'rgb(var(--tagma-accent))' }}
                      strokeWidth={1.5}
                      strokeDasharray="5 3"
                      opacity={0.7}
                    />
                  );
                }
                return (
                  <line
                    x1={sx}
                    y1={sy}
                    x2={ex}
                    y2={ey}
                    style={{ stroke: 'rgb(var(--tagma-accent))' }}
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    opacity={0.4}
                  />
                );
              })()}
          </svg>
        </div>
      </div>

      {/* Inline name input */}
      {inlineAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={() => setInlineAdd(null)}
        >
          <div
            className="bg-tagma-surface border border-tagma-border shadow-panel p-3 animate-fade-in w-64"
            onClick={(e) => e.stopPropagation()}
          >
            <label className="text-[10px] font-mono text-tagma-muted uppercase tracking-wider mb-1.5 block">
              {inlineAdd.type === 'task'
                ? inlineAdd.kind === 'command'
                  ? 'New Command Task'
                  : 'New Prompt Task'
                : inlineAdd.type === 'rename'
                  ? 'Rename Track'
                  : inlineAdd.type === 'rename-folder'
                    ? 'Rename Folder'
                    : 'New Track Name'}
            </label>
            <input
              ref={inlineRef}
              type="text"
              value={inlineValue}
              onChange={(e) => setInlineValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitInlineAdd();
                if (e.key === 'Escape') setInlineAdd(null);
              }}
              placeholder={
                inlineAdd.type === 'task'
                  ? 'Task name...'
                  : inlineAdd.type === 'rename-folder'
                    ? 'Folder name...'
                    : 'Track name...'
              }
              className="field-input"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => setInlineAdd(null)}
                className="text-[10px] text-tagma-muted hover:text-tagma-text"
              >
                Cancel
              </button>
              <button onClick={commitInlineAdd} className="btn-primary text-[10px]">
                {inlineAdd.type === 'rename' || inlineAdd.type === 'rename-folder'
                  ? 'Rename'
                  : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Minimap — floats at bottom-right. */}
      <Minimap />

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={closeCtx} />}
    </div>
  );
}
