import { useState, useEffect, useCallback } from 'react';
import { Plus, Minus } from 'lucide-react';
import {
  hasDesktopBridge,
  setDesktopZoomFactor,
  getDesktopZoomFactor,
} from '../../desktop';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 1.5; // matches webContents.setZoomFactor(1.5) in electron/src/main.ts

function readZoomBrowser(): number {
  // Browser-only fallback. In Electron we read via IPC (getDesktopZoomFactor).
  const raw = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ZOOM;
}

function clamp(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

/**
 * Bottom-right floating zoom controls (U14).
 *
 * In Electron: drives webContents.setZoomFactor via the desktop bridge so
 * DOM coordinate APIs stay consistent (event.clientX / getBoundingClientRect
 * remain in the same space, unlike CSS `zoom` which double-scales hit-
 * testing in Chromium 134+).
 *
 * In the browser: falls back to document.documentElement.style.zoom.
 */
export function ZoomControls() {
  const isDesktop = hasDesktopBridge();
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);

  // Initial read + periodic resync for external zoom (ctrl+scroll, etc.).
  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (isDesktop) {
        const native = await getDesktopZoomFactor();
        if (cancelled) return;
        if (native != null) {
          setZoom((prev) => (Math.abs(prev - native) > 0.005 ? native : prev));
        }
      } else {
        const current = readZoomBrowser();
        setZoom((prev) => (Math.abs(prev - current) > 0.005 ? current : prev));
      }
    };
    void read();
    const id = setInterval(() => void read(), 500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isDesktop]);

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = clamp(next);
      if (isDesktop) {
        void setDesktopZoomFactor(clamped);
      } else {
        document.documentElement.style.zoom = String(clamped);
      }
      setZoom(clamped);
    },
    [isDesktop],
  );

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
