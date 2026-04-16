import { useState, useEffect, useCallback } from 'react';
import { Plus, Minus } from 'lucide-react';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 1.5; // matches html { zoom: 1.5 } in index.css

function readZoom(): number {
  const raw = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ZOOM;
}

function clamp(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

/**
 * Bottom-right floating zoom controls (U14).
 * Drives the global document zoom by writing to
 * document.documentElement.style.zoom — the same channel the existing
 * getZoom() utility reads from. Keeps zoom state in a simple local hook
 * so the display is reactive.
 */
export function ZoomControls() {
  const [zoom, setZoom] = useState<number>(() => readZoom());

  // Sync when other code (eg. ctrl+scroll) changes the zoom out from under us.
  useEffect(() => {
    const id = setInterval(() => {
      const current = readZoom();
      setZoom((prev) => (Math.abs(prev - current) > 0.005 ? current : prev));
    }, 500);
    return () => clearInterval(id);
  }, []);

  const applyZoom = useCallback((next: number) => {
    const clamped = clamp(next);
    document.documentElement.style.zoom = String(clamped);
    setZoom(clamped);
  }, []);

  const zoomIn = useCallback(() => applyZoom(zoom + ZOOM_STEP), [zoom, applyZoom]);
  const zoomOut = useCallback(() => applyZoom(zoom - ZOOM_STEP), [zoom, applyZoom]);
  const zoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  const pct = Math.round(zoom * 100);

  return (
    <div
      className="absolute bottom-3 right-3 z-20 flex items-center bg-tagma-surface/90 border border-tagma-border shadow-panel"
      style={{ height: 22 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={zoomOut}
        disabled={zoom <= MIN_ZOOM + 0.001}
        className="flex items-center justify-center w-5 h-full text-tagma-muted hover:text-tagma-text disabled:opacity-30 disabled:cursor-not-allowed border-r border-tagma-border/60"
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={10} />
      </button>
      <button
        type="button"
        onClick={zoomReset}
        className="px-2 h-full text-[9px] font-mono text-tagma-text hover:text-tagma-accent tabular-nums"
        title="Reset zoom"
        style={{ minWidth: 36 }}
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={zoomIn}
        disabled={zoom >= MAX_ZOOM - 0.001}
        className="flex items-center justify-center w-5 h-full text-tagma-muted hover:text-tagma-text disabled:opacity-30 disabled:cursor-not-allowed border-l border-tagma-border/60"
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}
