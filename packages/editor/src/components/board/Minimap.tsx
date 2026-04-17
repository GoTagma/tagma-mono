import { useMemo, useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import { Map as MapIcon, X } from 'lucide-react';
import { usePipelineStore } from '../../store/pipeline-store';
import { getZoom } from '../../utils/zoom';
import { TASK_W, TASK_H, TRACK_H, TASK_GAP, PAD_LEFT, BOARD_SCROLL_ID } from './layout-constants';
import type { RawPipelineConfig } from '../../api/client';
import type { TaskPosition } from '../../store/pipeline-store';

// Floating minimap footprint — fixed so it doesn't react to sidebar resize.
const MAP_W = 240;
const MAP_H = 140;
const PAD = 4;

interface MinimapProps {
  /**
   * DOM id of the scroll container whose extents and scroll state should be
   * mirrored. Defaults to the editor board id so existing call sites keep
   * working. Run mode passes its own id so the minimap can be reused.
   */
  scrollElementId?: string;
  /**
   * Optional config override. When omitted, the component reads from the
   * pipeline store (editor mode). Run mode passes the run snapshot.
   */
  config?: RawPipelineConfig;
  /**
   * Optional positions override. When omitted, reads from the pipeline store.
   * Run mode passes its computed task positions.
   */
  positions?: Map<string, TaskPosition>;
}

/**
 * Floating minimap overlaid on the canvas at bottom-right, just above the
 * ZoomControls. Previously embedded in the right-side config panels, which
 * caused the content rect to stretch/shrink with sidebar width. Pinning it to
 * the canvas keeps coordinate math dependent only on the canvas itself.
 */
export function Minimap({ scrollElementId = BOARD_SCROLL_ID, config: configProp, positions: positionsProp }: MinimapProps = {}) {
  const storeConfig = usePipelineStore((s) => s.config);
  const storePositions = usePipelineStore((s) => s.positions);
  const config = configProp ?? storeConfig;
  const positions = positionsProp ?? storePositions;
  const tracks = useMemo(() => config?.tracks ?? [], [config?.tracks]);

  const [visible, setVisible] = useState(true);
  const [scrollTick, setScrollTick] = useState(0);
  const [contentW, setContentW] = useState(1);
  const [contentH, setContentH] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);

  // Use the real canvas scroll extents so task positions, viewport rect, and
  // scroll state always map consistently into minimap coordinates. Sampling
  // happens in useLayoutEffect (after DOM commit) so that scrollWidth reflects
  // the latest layout — reading it inside useMemo sees stale values.
  useLayoutEffect(() => {
    const el = document.getElementById(scrollElementId) as HTMLDivElement | null;
    if (!el) return;
    const cw = Math.max(el.scrollWidth, 1);
    const ch = Math.max(el.scrollHeight, 1);
    setContentW((prev) => (prev === cw ? prev : cw));
    setContentH((prev) => (prev === ch ? prev : ch));
  }, [scrollTick, tracks, positions, scrollElementId]);

  // Scale to fit content inside map with padding.
  const { scale, offsetX, offsetY } = useMemo(() => {
    const availW = MAP_W - PAD * 2;
    const availH = MAP_H - PAD * 2;
    const sX = availW / Math.max(contentW, 1);
    const sY = availH / Math.max(contentH, 1);
    const s = Math.min(sX, sY);
    const oX = PAD + (availW - contentW * s) / 2;
    const oY = PAD + (availH - contentH * s) / 2;
    return { scale: s, offsetX: oX, offsetY: oY };
  }, [contentW, contentH]);

  // Subscribe to canvas scroll + size changes so the minimap stays live.
  useEffect(() => {
    const el = document.getElementById(scrollElementId) as HTMLDivElement | null;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTick((n) => (n + 1) & 0xffff);
      });
    };
    el.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick);
    // Watch the scroll container AND its inner content div so dragged tasks
    // that extend the canvas width/height trigger a resample.
    const ro = new ResizeObserver(tick);
    ro.observe(el);
    const inner = el.firstElementChild;
    if (inner) ro.observe(inner);
    tick();
    return () => {
      el.removeEventListener('scroll', tick);
      window.removeEventListener('resize', tick);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollElementId]);

  const viewport = useMemo(() => {
    void scrollTick;
    const el = document.getElementById(scrollElementId) as HTMLDivElement | null;
    if (!el) return null;
    return {
      x: offsetX + el.scrollLeft * scale,
      y: offsetY + el.scrollTop * scale,
      w: el.clientWidth * scale,
      h: el.clientHeight * scale,
    };
  }, [scrollTick, offsetX, offsetY, scale, scrollElementId]);

  const panToMapPoint = useCallback((mapX: number, mapY: number) => {
    const el = document.getElementById(scrollElementId) as HTMLDivElement | null;
    if (!el) return;
    const cx = (mapX - offsetX) / scale;
    const cy = (mapY - offsetY) / scale;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    el.scrollLeft = Math.max(0, cx - vw / 2);
    el.scrollTop = Math.max(0, cy - vh / 2);
  }, [offsetX, offsetY, scale, scrollElementId]);

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const z = getZoom();
    const toLocal = (clientX: number, clientY: number) => ({
      x: (clientX - rect.left) / z,
      y: (clientY - rect.top) / z,
    });
    const p0 = toLocal(e.clientX, e.clientY);
    panToMapPoint(p0.x, p0.y);

    const onMove = (ev: PointerEvent) => {
      const p = toLocal(ev.clientX, ev.clientY);
      panToMapPoint(p.x, p.y);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [panToMapPoint]);

  const rects = useMemo(() => {
    const out: { x: number; y: number; w: number; h: number; fill: string }[] = [];
    tracks.forEach((track, i) => {
      const fill = track.color || '#64748b';
      track.tasks.forEach((task, taskIdx) => {
        const qid = `${track.id}.${task.id}`;
        const stored = positions.get(qid);
        const x = stored ? stored.x : PAD_LEFT + taskIdx * (TASK_W + TASK_GAP);
        out.push({
          x: offsetX + x * scale,
          y: offsetY + (i * TRACK_H + (TRACK_H - TASK_H) / 2) * scale,
          w: Math.max(1, TASK_W * scale),
          h: Math.max(1, TASK_H * scale),
          fill,
        });
      });
    });
    return out;
  }, [tracks, positions, scale, offsetX, offsetY]);

  if (!config || tracks.length === 0) return null;

  if (!visible) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute z-20 flex items-center gap-1 px-2 bg-tagma-surface/90 border border-tagma-border shadow-panel text-tagma-muted hover:text-tagma-text"
        style={{ bottom: 12, right: 96, height: 22 }}
        title="Show minimap"
      >
        <MapIcon size={11} />
        <span className="text-[9px] font-mono uppercase tracking-wider">minimap</span>
      </button>
    );
  }

  return (
    <div
      className="absolute z-20 bg-tagma-surface/90 border border-tagma-border shadow-panel"
      style={{ bottom: 12, right: 96 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between px-2 h-[18px] border-b border-tagma-border/60 bg-black/20">
        <span className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted">minimap</span>
        <button
          type="button"
          className="text-tagma-muted hover:text-tagma-text"
          onClick={() => setVisible(false)}
          title="Hide minimap"
        >
          <X size={10} />
        </button>
      </div>
      <div className="p-1.5">
        <svg
          ref={svgRef}
          width={MAP_W}
          height={MAP_H}
          onPointerDown={handlePointerDown}
          style={{ cursor: 'crosshair', display: 'block' }}
        >
          {tracks.map((track, i) => (
            <rect
              key={`mm-row-${track.id}`}
              x={offsetX}
              y={offsetY + i * TRACK_H * scale}
              width={contentW * scale}
              height={TRACK_H * scale}
              fill={i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.04)'}
            />
          ))}
          {rects.map((r, i) => (
            <rect
              key={`mm-t-${i}`}
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              fill={r.fill}
              fillOpacity={0.75}
            />
          ))}
          {viewport && (
            <rect
              x={viewport.x}
              y={viewport.y}
              width={Math.max(4, viewport.w)}
              height={Math.max(4, viewport.h)}
              fill="rgba(212, 132, 90, 0.1)"
              stroke="#d4845a"
              strokeWidth={1}
              pointerEvents="none"
            />
          )}
        </svg>
      </div>
    </div>
  );
}
