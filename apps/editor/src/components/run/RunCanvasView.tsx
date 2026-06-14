import { useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type {
  DagEdge,
  RawPipelineConfig,
  RunTaskState,
  TaskStatus,
  TrackFolder,
} from '../../api/client';
import { usePipelineStore, type TaskPosition } from '../../store/pipeline-store';
import { useRunStore } from '../../store/run-store';
import { getZoom } from '../../utils/zoom';
import { TaskCard } from '../board/TaskCard';
import { TrackLane } from '../board/TrackLane';
import { Minimap } from '../board/Minimap';
import { FolderHeaderBar } from '../board/FolderHeaderBar';
import {
  HEADER_W,
  TASK_W,
  TASK_H,
  TASK_GAP,
  PAD_LEFT,
  CANVAS_PAD_RIGHT,
} from '../board/layout-constants';
import { buildRenderPlan, planTotalHeight, trackTopYInPlan } from '../board/render-plan';
import { RunTaskPanel } from './RunTaskPanel';
import { TrackInfoPanel } from './TrackInfoPanel';

interface RunCanvasViewProps {
  config: RawPipelineConfig;
  dagEdges: DagEdge[];
  positions: Map<string, TaskPosition>;
  scrollElementId: string;
  useEditorFolders?: boolean;
}

function countByStatus(tasks: Map<string, { status: TaskStatus }>) {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const [, t] of tasks) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
  }
  return counts;
}

export function runCanvasStatusCounts(
  tasks: Map<string, { status: TaskStatus }>,
): Partial<Record<TaskStatus, number>> {
  return countByStatus(tasks);
}

export function RunCanvasView({
  config,
  dagEdges,
  positions,
  scrollElementId,
  useEditorFolders = true,
}: RunCanvasViewProps) {
  const { tasks, selectedTaskId, selectedTrackId, selectTask, selectTrack, replayPositions } =
    useRunStore();

  const headerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const panDidDragRef = useRef(false);

  const liveFolders = usePipelineStore((s) => s.folders);
  const liveTrackHeights = usePipelineStore((s) => s.trackHeights);
  const toggleFolderCollapsed = usePipelineStore((s) => s.toggleFolderCollapsed);
  const folders = useMemo<TrackFolder[]>(() => {
    if (!useEditorFolders || replayPositions) return [];
    const validTrackIds = new Set(config.tracks.map((t) => t.id));
    return liveFolders
      .map((f) => ({
        ...f,
        trackIds: f.trackIds.filter((tid) => validTrackIds.has(tid)),
      }))
      .filter((f) => f.trackIds.length > 0);
  }, [config.tracks, liveFolders, replayPositions, useEditorFolders]);

  const renderPlan = useMemo(
    () => buildRenderPlan(config.tracks, folders, replayPositions ? new Map() : liveTrackHeights),
    [config.tracks, folders, liveTrackHeights, replayPositions],
  );

  const flatTasks = useMemo(() => {
    type FlatTask = {
      qid: string;
      trackId: string;
      task: (typeof config.tracks)[number]['tasks'][number];
    };
    const result: FlatTask[] = [];
    for (const track of config.tracks) {
      for (const task of track.tasks) {
        result.push({ qid: `${track.id}.${task.id}`, trackId: track.id, task });
      }
    }
    return result;
  }, [config]);

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
      const row = renderPlan.find((entry) => entry.kind === 'track' && entry.trackId === ft.trackId);
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

  const canvasHeight = Math.max(planTotalHeight(renderPlan), 200);

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

  const syncScroll = useCallback(() => {
    if (headerRef.current && contentRef.current) {
      headerRef.current.scrollTop = contentRef.current.scrollTop;
    }
  }, []);

  const handlePanMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = contentRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startSL = el.scrollLeft;
    const startST = el.scrollTop;
    let started = false;
    panDidDragRef.current = false;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!started) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
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

  return (
    <>
      <div className="flex-1 flex overflow-hidden relative">
        <div
          ref={headerRef}
          className="shrink-0 border-r border-tagma-border overflow-hidden bg-tagma-surface/50"
          style={{ width: HEADER_W }}
        >
          {(() => {
            let zebra = 0;
            const out: ReactNode[] = [];
            for (const row of renderPlan) {
              if (row.kind === 'folder') {
                const f = folders.find((fl) => fl.id === row.folderId);
                if (!f) continue;
                out.push(
                  <FolderHeaderBar
                    key={`folder-${f.id}`}
                    folder={f}
                    memberCount={
                      f.trackIds.filter((tid) => config.tracks.some((t) => t.id === tid)).length
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
        </div>

        <div
          ref={contentRef}
          id={scrollElementId}
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
            {(() => {
              let zebra = 0;
              let yAcc = 0;
              const out: ReactNode[] = [];
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
                    onMouseDown={handlePanMouseDown}
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

        <Minimap
          scrollElementId={scrollElementId}
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
          return <TrackInfoPanel track={track} config={config} onClose={() => selectTrack(null)} />;
        })()}
    </>
  );
}
