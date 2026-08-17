import { useState, useEffect, useCallback } from 'react';
import { Plus, Minus } from 'lucide-react';
import {
  hasDesktopBridge,
  setDesktopZoomFactor,
  getDesktopZoomFactor,
  subscribeDesktopZoom,
} from '../../desktop';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const ZOOM_STEP = 0.1;
const DEFAULT_ZOOM = 1.2; // matches webContents.setZoomFactor(1.2) in electron/src/main.ts

function readZoomBrowser(): number {
  // Browser-only fallback. In Electron we read via IPC (getDesktopZoomFactor).
  const raw = parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ZOOM;
}

function clamp(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(value * 100) / 100));
}

/**
 * Inline zoom control for the bottom status bar.
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

  // Initial read + subscription to cross-window zoom changes fanned out by
  // the Electron main process so sibling windows stay in sync the moment the
  // user adjusts zoom anywhere. The browser fallback has no such channel, so
  // it additionally polls (slowly) for external zoom (ctrl+scroll, etc.).
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
    // Desktop zoom changes arrive via the main-process fan-out subscription
    // below, so no poll is needed there; the browser fallback keeps a slower
    // poll for external zoom changes (ctrl+scroll, etc.).
    const id = isDesktop ? null : setInterval(() => void read(), 2000);
    const unsubscribe = isDesktop
      ? subscribeDesktopZoom((factor) => {
          setZoom((prev) => (Math.abs(prev - factor) > 0.005 ? factor : prev));
        })
      : () => {};
    return () => {
      cancelled = true;
      if (id !== null) clearInterval(id);
      unsubscribe();
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
      className="flex items-center h-full"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        onClick={zoomOut}
        disabled={zoom <= MIN_ZOOM + 0.001}
        className="flex items-center justify-center w-5 h-full text-tagma-muted hover:text-tagma-text disabled:opacity-30 disabled:cursor-not-allowed"
        title="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={10} />
      </button>
      <button
        type="button"
        onClick={zoomReset}
        className="px-1.5 h-full text-caption font-mono text-tagma-muted hover:text-tagma-text tabular-nums"
        title="Reset zoom"
        style={{ minWidth: 34 }}
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={zoomIn}
        disabled={zoom >= MAX_ZOOM - 0.001}
        className="flex items-center justify-center w-5 h-full text-tagma-muted hover:text-tagma-text disabled:opacity-30 disabled:cursor-not-allowed"
        title="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={10} />
      </button>
    </div>
  );
}
