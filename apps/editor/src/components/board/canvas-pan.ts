import { CANVAS_MIN_HEIGHT, CANVAS_PAD_BOTTOM } from './layout-constants';

const CANVAS_PAN_THRESHOLD = 4;

export interface CanvasPanStart {
  clientX: number;
  clientY: number;
  scrollLeft: number;
  scrollTop: number;
}

export interface CanvasPanPointer {
  clientX: number;
  clientY: number;
}

export interface CanvasPanResult {
  didDrag: boolean;
  scrollLeft: number;
  scrollTop: number;
}

export function resolveCanvasPan(
  start: CanvasPanStart,
  pointer: CanvasPanPointer,
  zoom: number,
  dragStarted = false,
): CanvasPanResult {
  const deltaX = pointer.clientX - start.clientX;
  const deltaY = pointer.clientY - start.clientY;
  if (
    !dragStarted &&
    Math.abs(deltaX) < CANVAS_PAN_THRESHOLD &&
    Math.abs(deltaY) < CANVAS_PAN_THRESHOLD
  ) {
    return {
      didDrag: false,
      scrollLeft: start.scrollLeft,
      scrollTop: start.scrollTop,
    };
  }

  const safeZoom = zoom > 0 ? zoom : 1;
  return {
    didDrag: true,
    scrollLeft: Math.max(0, start.scrollLeft - deltaX / safeZoom),
    scrollTop: Math.max(0, start.scrollTop - deltaY / safeZoom),
  };
}

export function resolveCanvasContentHeight(planHeight: number): number {
  return Math.max(planHeight + CANVAS_PAD_BOTTOM, CANVAS_MIN_HEIGHT);
}

export function resolveCanvasBottomSpacer(planHeight: number): number {
  return Math.max(0, resolveCanvasContentHeight(planHeight) - planHeight);
}

/**
 * A short pipeline still needs room below the visible viewport or a vertical
 * background drag has nowhere to scroll. Keep the content at least one
 * viewport plus the normal bottom clearance while retaining the fixed height
 * used for taller pipelines.
 */
export function resolveCanvasScrollableMinHeight(planHeight: number): string {
  return `max(${resolveCanvasContentHeight(planHeight)}px, calc(100% + ${CANVAS_PAD_BOTTOM}px))`;
}

/** Keep the header column's scroll extent identical to the task canvas. */
export function resolveCanvasBottomSpacerHeight(planHeight: number): string {
  return `max(${resolveCanvasBottomSpacer(planHeight)}px, calc(100% + ${CANVAS_PAD_BOTTOM}px - ${planHeight}px))`;
}
