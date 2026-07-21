import { describe, expect, test } from 'bun:test';
import {
  resolveCanvasBottomSpacer,
  resolveCanvasContentHeight,
  resolveCanvasPan,
} from '../src/components/board/canvas-pan';
import { CANVAS_MIN_HEIGHT, CANVAS_PAD_BOTTOM } from '../src/components/board/layout-constants';

describe('canvas background panning', () => {
  test('keeps a click stationary until the drag threshold is reached', () => {
    expect(
      resolveCanvasPan(
        { clientX: 400, clientY: 200, scrollLeft: 320, scrollTop: 80 },
        { clientX: 403, clientY: 203 },
        1,
      ),
    ).toEqual({ didDrag: false, scrollLeft: 320, scrollTop: 80 });
  });

  test('moves the visible region opposite to a zoom-adjusted mouse drag', () => {
    expect(
      resolveCanvasPan(
        { clientX: 400, clientY: 200, scrollLeft: 320, scrollTop: 80 },
        { clientX: 360, clientY: 180 },
        0.5,
      ),
    ).toEqual({ didDrag: true, scrollLeft: 400, scrollTop: 120 });
  });

  test('clamps panning at the top-left canvas boundary', () => {
    expect(
      resolveCanvasPan(
        { clientX: 100, clientY: 100, scrollLeft: 5, scrollTop: 10 },
        { clientX: 140, clientY: 140 },
        1,
      ),
    ).toEqual({ didDrag: true, scrollLeft: 0, scrollTop: 0 });
  });

  test('adds enough bottom scroll range to move the last row clear of the minimap', () => {
    expect(resolveCanvasContentHeight(0)).toBe(CANVAS_MIN_HEIGHT);
    expect(resolveCanvasContentHeight(64)).toBe(64 + CANVAS_PAD_BOTTOM);
    expect(resolveCanvasContentHeight(640)).toBe(640 + CANVAS_PAD_BOTTOM);
    expect(resolveCanvasBottomSpacer(64)).toBe(CANVAS_PAD_BOTTOM);
  });

  test('cleans up the shared drag session on mouseup, window blur, and unmount', async () => {
    const source = await Bun.file(
      new URL('../src/components/board/use-canvas-pan.ts', import.meta.url),
    ).text();

    expect(source).toContain(`document.addEventListener('mouseup', cleanup)`);
    expect(source).toContain(`window.addEventListener('blur', cleanup)`);
    expect(source).toContain(`window.removeEventListener('blur', cleanup)`);
    expect(source).toContain('useEffect(() => () => cleanupRef.current?.(), [])');
  });
});
