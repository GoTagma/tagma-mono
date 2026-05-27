import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('edge delete affordances', () => {
  test('BoardCanvas selected edge delete icon has a visible tight square frame', () => {
    const source = readFileSync(join(root, 'src/components/board/BoardCanvas.tsx'), 'utf8');

    expect(source).toContain('data-board-edge-delete-frame');
    expect(source).toContain('width={12}');
    expect(source).toContain('height={12}');
    expect(source).toContain('style={{ stroke:');
  });
});
