import { describe, expect, test } from 'bun:test';
import { resolveMinimapViewport } from '../src/components/board/Minimap';

describe('minimap compact layout', () => {
  test('hides when the canvas cannot leave useful interaction space', () => {
    expect(resolveMinimapViewport(110, 240)).toEqual({ hidden: true, width: 0, height: 0 });
    expect(resolveMinimapViewport(500, 100)).toEqual({ hidden: true, width: 0, height: 0 });
  });

  test('shrinks between its usable floor and desktop cap', () => {
    expect(resolveMinimapViewport(190, 240)).toEqual({ hidden: false, width: 152, height: 140 });
    expect(resolveMinimapViewport(170, 130)).toEqual({ hidden: false, width: 136, height: 80 });
    expect(resolveMinimapViewport(1_000, 1_000)).toEqual({
      hidden: false,
      width: 240,
      height: 140,
    });
  });
});
