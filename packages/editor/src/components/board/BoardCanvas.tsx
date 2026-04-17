import { useState, useRef, useMemo, useCallback, useEffect, memo } from 'react';
import { Trash2, Pencil, ListPlus, Terminal, MessageSquare } from 'lucide-react';
import { TrackLane } from './TrackLane';
import { TaskCard } from './TaskCard';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { ZoomControls } from './ZoomControls';
import { Minimap } from './Minimap';
import type { RawPipelineConfig, RawTrackConfig, RawTaskConfig } from '../../api/client';

import type { TaskPosition } from '../../store/pipeline-store';
import { usePipelineStore } from '../../store/pipeline-store';
import type { DagEdge } from '../../api/client';
import { getZoom } from '../../utils/zoom';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  TRACK_H,
  CANVAS_PAD_RIGHT,
  BOARD_SCROLL_ID,
} from './layout-constants';

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
  errorsByTask: Map<string, string[]>;
  errorsByTrack: Map<string, string[]>;
  onSelectTask: (qualifiedId: string | null) => void;
  onToggleTaskSelection: (qualifiedId: string) => void;
  onSelectTrack: (trackId: string | null) => void;
  onAddTask: (
    trackId: string,
    name: string,
    options?: { kind?: 'prompt' | 'command'; positionX?: number },
  ) => void;
  onAddTrack: (name: string) => void;
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
  onSetTaskPosition: (qualifiedId: string, x: number) => void;
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

function buildPositions(
  tracks: readonly RawTrackConfig[],
  storedPositions: Map<string, TaskPosition>,
) {
  const m = new Map<string, Pos>();
  let y = 0;
  for (const tr of tracks) {
    const centerY = y + (TRACK_H - TASK_H) / 2;
    for (let i = 0; i < tr.tasks.length; i++) {
      const task = tr.tasks[i];
      const qid = `${tr.id}.${task.id}`;
      const stored = storedPositions.get(qid);
      const x = stored ? stored.x : PAD_LEFT + i * (TASK_W + TASK_GAP);
      m.set(qid, { x, y: centerY });
    }
    y += TRACK_H;
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
            ? '#f87171'
            : highlighted
              ? isContinue
                ? '#c4b5fd'
                : '#d4845a'
              : isContinue
                ? 'rgba(167, 139, 250, 0.5)'
                : 'rgba(100, 100, 100, 0.4)'
        }
        strokeWidth={inCycle ? 2.2 : highlighted ? 2 : 1}
        strokeDasharray={inCycle ? '4 3' : isContinue ? '6 3' : undefined}
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
          <rect
            x={midX - 8}
            y={midY - 8}
            width={16}
            height={16}
            rx={0}
            fill="#1e1e1e"
            stroke="#f87171"
            strokeWidth={1.2}
          />
          <line
            x1={midX - 3}
            y1={midY - 3}
            x2={midX + 3}
            y2={midY + 3}
            stroke="#f87171"
            strokeWidth={1.5}
          />
          <line
            x1={midX + 3}
            y1={midY - 3}
            x2={midX - 3}
            y2={midY + 3}
            stroke="#f87171"
            strokeWidth={1.5}
          />
        </g>
      )}
    </g>
  );
});

function trackTopY(tracks: readonly RawTrackConfig[], trackId: string): number {
  let y = 0;
  for (const tr of tracks) {
    if (tr.id === trackId) return y;
    y += TRACK_H;
  }
  return y;
}

function trackAtY(tracks: readonly RawTrackConfig[], cursorY: number): string | null {
  let y = 0;
  for (const tr of tracks) {
    if (cursorY >= y && cursorY < y + TRACK_H) return tr.id;
    y += TRACK_H;
  }
  return null;
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
}
interface TaskDragState {
  qid: string;
  taskId: string;
  trackId: string;
  contentX: number;
  targetTrackId: string;
  startX: number;
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
  deltaY: number;
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
  const [taskDrag, setTaskDrag] = useState<TaskDragState | null>(null);
  const [edgeDrag, setEdgeDrag] = useState<EdgeDragState | null>(null);
  const [trackDrag, setTrackDrag] = useState<TrackDragState | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const dropRef = useRef<{ trackId: string; positionX: number } | null>(null);
  const nearRef = useRef<string | null>(null);

  const [inlineAdd, setInlineAdd] = useState<
    | { type: 'task'; trackId: string; kind: 'prompt' | 'command'; positionX?: number }
    | { type: 'track' }
    | { type: 'rename'; trackId: string }
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

  // Build a lookup: taskId → FlatTask for O(1) callback lookups
  const flatTaskById = useMemo(() => {
    const m = new Map<string, FlatTask>();
    for (const ft of allTasks) m.set(ft.task.id, ft);
    return m;
  }, [allTasks]);

  // Convert selectedTaskIds to a Set for O(1) membership tests
  const selectedIdSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);

  // Visual sort during track drag
  const visualTracks = useMemo(() => {
    if (!trackDrag) return tracks;
    const { trackId, dropIndex } = trackDrag;
    const without = tracks.filter((t) => t.id !== trackId);
    const dragged = tracks.find((t) => t.id === trackId);
    if (!dragged) return tracks;
    const result = [...without];
    result.splice(Math.min(dropIndex, result.length), 0, dragged);
    return result;
  }, [tracks, trackDrag]);

  const staticPositions = useMemo(
    () => buildPositions(visualTracks, storedPositions),
    [visualTracks, storedPositions],
  );

  const positionsMap = useMemo(() => {
    if (!taskDrag) return staticPositions;
    const result = new Map(staticPositions);
    const targetY = trackTopY(visualTracks, taskDrag.targetTrackId);
    result.set(taskDrag.qid, {
      x: Math.max(PAD_LEFT, taskDrag.contentX),
      y: targetY + (TRACK_H - TASK_H) / 2,
    });
    // Move companion tasks by the same horizontal delta (stay on own track)
    const dx = taskDrag.contentX - taskDrag.startX;
    for (const c of taskDrag.companions) {
      const cx = Math.max(PAD_LEFT, c.startX + dx);
      const cy = trackTopY(visualTracks, c.trackId);
      result.set(c.qid, { x: cx, y: cy + (TRACK_H - TASK_H) / 2 });
    }
    return result;
  }, [taskDrag, staticPositions, visualTracks]);

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
      contentH: Math.max(visualTracks.length * TRACK_H, 200),
    };
  }, [positionsMap, visualTracks]);

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
    (taskId: string, e: React.PointerEvent) => {
      e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const isMultiKey = e.ctrlKey || e.metaKey;
      // Find which track this task belongs to
      const ft = flatTaskById.get(taskId);
      if (!ft) return;
      const qid = ft.qid;
      const pos = staticPositions.get(qid);
      if (!pos) return;
      const cp = toContent(e, el);
      const offX = cp.x - pos.x;
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
        return { qid: cqid, taskId: tskId, trackId: trkId, startX: cPos?.x ?? 0 };
      });
      const startX = pos.x;

      const hasCompanions = companions.length > 0;

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientX - startCX) + Math.abs(ev.clientY - startCY) < DRAG_THRESHOLD)
            return;
          started = true;
        }
        const c = toContent(ev, el);
        const cx = Math.max(PAD_LEFT, c.x - offX);
        // Multi-drag is horizontal only — lock to original track
        const trkId = hasCompanions ? ft.trackId : (trackAtY(visualTracks, c.y) ?? ft.trackId);
        dropRef.current = { trackId: trkId, positionX: cx };
        setTaskDrag({
          qid,
          taskId,
          trackId: ft.trackId,
          contentX: cx,
          targetTrackId: trkId,
          startX,
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
            // Commit position for grabbed task
            onSetTaskPosition(`${d.trackId}.${taskId}`, d.positionX);
            if (d.trackId !== ft.trackId) onTransferTask(ft.trackId, taskId, d.trackId);
            // Commit horizontal positions for companions (no cross-track)
            for (const c of companions) {
              const cx = Math.max(PAD_LEFT, c.startX + dx);
              onSetTaskPosition(`${c.trackId}.${c.taskId}`, cx);
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
      visualTracks,
      flatTaskById,
      onSelectTask,
      onToggleTaskSelection,
      onSetTaskPosition,
      onTransferTask,
    ],
  );

  // ── Edge drag ──
  const handleHandlePointerDown = useCallback(
    (taskId: string, _e: React.PointerEvent) => {
      _e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const ft = flatTaskById.get(taskId);
      if (!ft) return;
      const srcQid = ft.qid;

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
    [flatTaskById, positionsMap, onAddDependency],
  );

  const handleTargetPointerUp = useCallback(
    (taskId: string) => {
      if (edgeDrag) {
        const ft = flatTaskById.get(taskId);
        if (ft && ft.qid !== edgeDrag.srcQid) nearRef.current = ft.qid;
      }
    },
    [edgeDrag, flatTaskById],
  );

  // ── Track drag ──
  const handleTrackDragStart = useCallback(
    (trackId: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startIndex = tracks.findIndex((t) => t.id === trackId);
      if (startIndex < 0) return;
      const headerEl = headerRef.current;
      if (!headerEl) return;
      const headerRect = headerEl.getBoundingClientRect();
      let started = false;
      const startClientY = e.clientY;
      const startRelY = (e.clientY - headerRect.top) / getZoom() + headerEl.scrollTop;
      const grabOffsetY = startRelY - startIndex * TRACK_H;

      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientY - startClientY) < DRAG_THRESHOLD) return;
          started = true;
        }
        const relY = (ev.clientY - headerRect.top) / getZoom() + headerEl.scrollTop;
        const deltaY = relY - startRelY;
        // Use dragged track center for drop index — provides natural hysteresis
        const draggedCenterY = relY - grabOffsetY + TRACK_H / 2;
        const dropIdx = Math.max(
          0,
          Math.min(tracks.length - 1, Math.floor(draggedCenterY / TRACK_H)),
        );
        setTrackDrag({ trackId, startIndex, dropIndex: dropIdx, deltaY });
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (started) {
          const current = trackDragRef.current;
          if (current && current.startIndex !== current.dropIndex) {
            onMoveTrackTo(trackId, current.dropIndex);
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
    [tracks, onMoveTrackTo, onSelectTrack],
  );

  const trackDragRef = useRef<TrackDragState | null>(null);
  useEffect(() => {
    trackDragRef.current = trackDrag;
  }, [trackDrag]);

  // ── Context menus ──
  const handleHeaderContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const headerEl = headerRef.current;
      if (!headerEl) return;
      const rect = headerEl.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / getZoom() + headerEl.scrollTop;
      const trackId = trackAtY(visualTracks, relY);

      if (!trackId) {
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
          ],
        });
        return;
      }

      const track = config.tracks.find((t) => t.id === trackId);
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
    [visualTracks, config.tracks, onDeleteTrack],
  );

  const handleTaskContextMenu = useCallback(
    (taskId: string, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ft = flatTaskById.get(taskId);
      if (!ft) return;
      setCtx({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Delete Task',
            icon: <Trash2 size={12} />,
            danger: true,
            onAction: () => onDeleteTask(ft.trackId, taskId),
          },
        ],
      });
    },
    [flatTaskById, onDeleteTask],
  );

  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const el = contentRef.current;
      if (!el) return;
      const cp = toContent(e, el);
      const trackId = trackAtY(visualTracks, cp.y);
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
    [visualTracks],
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
    else if (inlineAdd.type === 'track') onAddTrack(name);
    else if (inlineAdd.type === 'rename') onRenameTrack(inlineAdd.trackId, name);
    setInlineAdd(null);
    setInlineValue('');
  }, [inlineValue, inlineAdd, onAddTask, onAddTrack, onRenameTrack]);

  // ── Remove the currently selected edge by looking up the dep ref that
  // resolves to edge.from on the edge.to task. Mirrors the inline click
  // handler on the X-badge but is reused by the Delete key and the edge
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
        {tracks.map((track, origIdx) => {
          const taskCount = track.tasks.length;
          // Check if tasks have dependencies connecting them all
          const depCount = dagEdges.filter(
            (e) => e.from.startsWith(track.id + '.') && e.to.startsWith(track.id + '.'),
          ).length;
          const hasParallel = taskCount > 1 && depCount < taskCount - 1;
          const isDraggedTrack = trackDrag?.trackId === track.id;

          let translateY = 0;
          if (trackDrag) {
            if (isDraggedTrack) {
              translateY = trackDrag.deltaY;
            } else {
              const visIdx = visualTracks.findIndex((t) => t.id === track.id);
              translateY = (visIdx - origIdx) * TRACK_H;
            }
          }

          return (
            <div
              key={track.id}
              className={`relative border-b border-tagma-border/60 overflow-hidden ${isDraggedTrack ? 'opacity-60 bg-tagma-accent/5' : ''}`}
              style={{
                height: TRACK_H,
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
              }}
            >
              <div
                className="h-full flex cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => handleTrackDragStart(track.id, e)}
              >
                <div className="flex-1 min-w-0 flex items-center">
                  <TrackLane
                    track={track}
                    taskCount={taskCount}
                    hasParallelWarning={hasParallel}
                    errorMessages={errorsByTrack.get(track.id)}
                  />
                </div>
              </div>
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
          {/* Row backgrounds */}
          {visualTracks.map((track, i) => (
            <div
              key={`bg-${track.id}`}
              className={`absolute left-0 right-0 border-b border-tagma-border/40 cursor-grab active:cursor-grabbing ${i % 2 === 0 ? 'track-row-even' : 'track-row-odd'}`}
              style={{ top: i * TRACK_H, height: TRACK_H }}
              onMouseDown={handleBackgroundPanMouseDown}
              onClick={() => {
                if (!panDidDragRef.current) {
                  onSelectTask(null);
                  onSelectTrack(null);
                  setSelEdge(null);
                }
              }}
            />
          ))}

          {/* Parallel zone hints (L1) — subtle dashed rectangle behind
              sibling tasks in a track that have no depends_on relationship
              among themselves, with a small corner label. */}
          {parallelZones.map((zone, idx) => {
            const vIdx = visualTracks.findIndex((t) => t.id === zone.trackId);
            if (vIdx < 0) return null;
            const topY = vIdx * TRACK_H + 4;
            const h = TRACK_H - 8;
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
                  border: '1px dashed rgba(148, 163, 184, 0.25)',
                  background: 'rgba(148, 163, 184, 0.035)',
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
                <polygon points="0 0, 7 2.5, 0 5" fill="#666" fillOpacity="0.7" />
              </marker>
              <marker id="ah-hi" markerWidth="7" markerHeight="5" refX="7" refY="2.5" orient="auto">
                <polygon points="0 0, 7 2.5, 0 5" fill="#d4845a" />
              </marker>
              <marker
                id="ah-cont"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="#a78bfa" fillOpacity="0.8" />
              </marker>
              <marker
                id="ah-cont-hi"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="#c4b5fd" />
              </marker>
              <marker
                id="ah-cycle"
                markerWidth="7"
                markerHeight="5"
                refX="7"
                refY="2.5"
                orient="auto"
              >
                <polygon points="0 0, 7 2.5, 0 5" fill="#f87171" />
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
              const isContinue =
                !!cf &&
                (cf === edge.from ||
                  (cf.includes('.') ? false : `${edge.to.split('.')[0]}.${cf}` === edge.from));
              const inCycle = cycleEdgeSet.has(ek);

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
                      stroke="#d4845a"
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
                    stroke="#d4845a"
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
              placeholder={inlineAdd.type === 'task' ? 'Task name...' : 'Track name...'}
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
                {inlineAdd.type === 'rename' ? 'Rename' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Minimap — floats at bottom-right, above the zoom controls. */}
      <Minimap />

      {/* Zoom controls (U14) — bottom-right */}
      <ZoomControls />

      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={closeCtx} />}
    </div>
  );
}
