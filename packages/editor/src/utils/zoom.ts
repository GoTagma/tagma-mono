/**
 * CSS `zoom` factor on <html>. In Electron we use Chromium's native zoom
 * (`webContents.setZoomFactor`) instead of CSS zoom — native zoom is
 * transparent to DOM coordinate APIs, so this returns 1 in Electron and
 * the callers' `/ z` becomes a no-op (correct: events and rects are
 * already in the same space). In the browser, CSS `zoom` may still be
 * applied via ZoomControls and this returns that value.
 */
export function getZoom(): number {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

/** Viewport width in logical (zoomed) pixels. */
export function viewportW(): number {
  return window.innerWidth / getZoom();
}

/** Viewport height in logical (zoomed) pixels. */
export function viewportH(): number {
  return window.innerHeight / getZoom();
}

/**
 * Convert screen-space clientX/clientY to logical (zoomed) coordinates
 * suitable for `position: fixed` elements inside a zoomed document.
 */
export function screenToLogical(screenX: number, screenY: number): { x: number; y: number } {
  const z = getZoom();
  return { x: screenX / z, y: screenY / z };
}
