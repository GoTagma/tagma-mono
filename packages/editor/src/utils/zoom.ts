/** CSS zoom factor applied on <html>. Change the value in src/index.css `html { zoom: ... }`. */
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
