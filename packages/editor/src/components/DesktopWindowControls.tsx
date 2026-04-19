import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy as CopyIcon } from 'lucide-react';
import {
  hasDesktopBridge,
  minimizeDesktopWindow,
  toggleMaximizeDesktopWindow,
  closeDesktopWindow,
  isDesktopWindowMaximized,
  subscribeMaximizedChanged,
} from '../desktop';

// Tracks the native window's maximized state so the custom glyph toggles
// between "maximize" (hollow square) and "restore" (two overlapping squares).
// No-op in non-Electron environments.
export function useMaximizedState(): boolean {
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    if (!hasDesktopBridge()) return;
    let cancelled = false;
    void isDesktopWindowMaximized().then((v) => {
      if (!cancelled) setIsMaximized(v);
    });
    const unsubscribe = subscribeMaximizedChanged(setIsMaximized);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return isMaximized;
}

// Self-drawn minimize / maximize / close buttons. Rendered only when the
// desktop bridge is present. Must live inside an `.app-drag-region` parent;
// the shared CSS rule auto-tags them `no-drag` so they stay clickable.
// A thin vertical divider sits right before the minimize button so the
// window controls visually separate from adjacent toolbar items.
export function DesktopWindowControls() {
  const isMaximized = useMaximizedState();
  if (!hasDesktopBridge()) return null;
  return (
    <div className="flex items-center shrink-0 h-full">
      <span className="w-px h-4 bg-tagma-border/70 mr-1 shrink-0" aria-hidden="true" />
      <button
        type="button"
        onClick={() => minimizeDesktopWindow()}
        className="flex items-center justify-center w-11 h-full text-tagma-muted hover:text-tagma-text hover:bg-white/5 transition-colors"
        title="Minimize"
        aria-label="Minimize window"
      >
        <Minus size={12} />
      </button>
      <button
        type="button"
        onClick={() => void toggleMaximizeDesktopWindow()}
        className="flex items-center justify-center w-11 h-full text-tagma-muted hover:text-tagma-text hover:bg-white/5 transition-colors"
        title={isMaximized ? 'Restore' : 'Maximize'}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
      >
        {isMaximized ? <CopyIcon size={10} /> : <Square size={10} />}
      </button>
      <button
        type="button"
        onClick={() => closeDesktopWindow()}
        className="flex items-center justify-center w-11 h-full text-tagma-muted hover:text-white hover:bg-tagma-error/80 transition-colors"
        title="Close"
        aria-label="Close window"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// Thin drag strip for views that don't have their own header (eg. Welcome).
// Empty on the left, window controls on the right. Same editor-bg color so
// it blends into whatever panel sits below.
export function DesktopTitleStrip() {
  if (!hasDesktopBridge()) return null;
  return (
    <div
      className="h-8 shrink-0 bg-tagma-bg flex items-center justify-end app-drag-region"
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
      }}
    >
      <DesktopWindowControls />
    </div>
  );
}
