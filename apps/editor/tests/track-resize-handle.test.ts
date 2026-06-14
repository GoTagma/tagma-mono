import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('track resize handles', () => {
  test('BoardCanvas assigns shared track borders to the track above', () => {
    const source = readFileSync(join(root, 'src/components/board/BoardCanvas.tsx'), 'utf8');

    expect(source).toContain('data-track-resize-edge="bottom"');
    expect(source).not.toContain('data-track-resize-edge="top"');
    expect(source).not.toContain("handleTrackResizeStart(track.id, 'top'");
  });

  test('TrackLane pins header content to the top of tall tracks', () => {
    const source = readFileSync(join(root, 'src/components/board/TrackLane.tsx'), 'utf8');

    expect(source).toContain('flex flex-col justify-start');
    expect(source).not.toContain('flex flex-col justify-center');
  });
});
