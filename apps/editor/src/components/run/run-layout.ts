export const RUN_INSPECTOR_PANEL_CLASSES =
  'absolute inset-y-0 right-0 z-30 flex h-full w-[calc(100%-1rem)] max-w-[20rem] flex-col border-l border-tagma-border bg-tagma-surface shadow-panel animate-slide-in-right md:relative md:inset-auto md:z-auto md:w-80 md:max-w-none md:shrink-0 md:shadow-none';

export const RUN_HISTORY_INSPECTOR_WIDTH_MIN = 320;
export const RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT = RUN_HISTORY_INSPECTOR_WIDTH_MIN;
export const RUN_HISTORY_INSPECTOR_WIDTH_MAX = 640;
export const RUN_HISTORY_INSPECTOR_VIEWPORT_GUTTER = 16;
const RUN_HISTORY_INSPECTOR_KEYBOARD_STEP = 16;

export interface RunHistoryInspectorWidthBounds {
  min: number;
  max: number;
}

function clampWidthToBounds(width: number, bounds: RunHistoryInspectorWidthBounds): number {
  const max = Math.max(0, Math.round(bounds.max));
  const min = Math.min(max, Math.max(0, Math.round(bounds.min)));
  return Math.max(min, Math.min(max, Math.round(width)));
}

export function clampRunHistoryInspectorWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT;
  }
  return Math.max(
    RUN_HISTORY_INSPECTOR_WIDTH_MIN,
    Math.min(RUN_HISTORY_INSPECTOR_WIDTH_MAX, Math.round(width)),
  );
}

export function resizeRunHistoryInspectorWidth(
  startWidth: number,
  startClientX: number,
  currentClientX: number,
  bounds: RunHistoryInspectorWidthBounds = {
    min: RUN_HISTORY_INSPECTOR_WIDTH_MIN,
    max: RUN_HISTORY_INSPECTOR_WIDTH_MAX,
  },
): number {
  return clampWidthToBounds(startWidth + startClientX - currentClientX, bounds);
}

export function resizeRunHistoryInspectorWidthFromKey(
  currentWidth: number,
  key: string,
  accelerated = false,
  bounds: RunHistoryInspectorWidthBounds = {
    min: RUN_HISTORY_INSPECTOR_WIDTH_MIN,
    max: RUN_HISTORY_INSPECTOR_WIDTH_MAX,
  },
): number | null {
  if (bounds.min === bounds.max) return null;
  const step = RUN_HISTORY_INSPECTOR_KEYBOARD_STEP * (accelerated ? 4 : 1);
  if (key === 'ArrowRight' || key === 'ArrowUp') {
    return clampWidthToBounds(currentWidth + step, bounds);
  }
  if (key === 'ArrowLeft' || key === 'ArrowDown') {
    return clampWidthToBounds(currentWidth - step, bounds);
  }
  if (key === 'Home') return clampWidthToBounds(bounds.min, bounds);
  if (key === 'End') return clampWidthToBounds(bounds.max, bounds);
  return null;
}

export function storedRunHistoryInspectorWidth(stored: string | null): number {
  if (stored === null || stored.trim() === '') return RUN_HISTORY_INSPECTOR_WIDTH_DEFAULT;
  return clampRunHistoryInspectorWidth(Number(stored));
}

export function resolveRunHistoryInspectorWidth(
  preferredWidth: number,
  containerWidth: number | null,
): { width: number; min: number; max: number } {
  const availableWidth =
    typeof containerWidth === 'number' && Number.isFinite(containerWidth)
      ? Math.max(0, Math.floor(containerWidth) - RUN_HISTORY_INSPECTOR_VIEWPORT_GUTTER)
      : RUN_HISTORY_INSPECTOR_WIDTH_MAX;
  const max = Math.min(RUN_HISTORY_INSPECTOR_WIDTH_MAX, availableWidth);
  const min = Math.min(RUN_HISTORY_INSPECTOR_WIDTH_MIN, max);
  return {
    width: clampWidthToBounds(clampRunHistoryInspectorWidth(preferredWidth), { min, max }),
    min,
    max,
  };
}

// History detail-pane variant: always an absolute overlay (never docks), so
// opening/closing or resizing a panel never reflows the flow canvas and
// invalidates its scrollLeft/Top mid-scroll. Width is applied inline so narrow
// detail panes can cap it to their available space.
export const RUN_HISTORY_INSPECTOR_PANEL_CLASSES =
  'absolute inset-y-0 right-0 z-20 flex h-full flex-col border-l border-tagma-border bg-tagma-surface shadow-panel animate-slide-in-right';
