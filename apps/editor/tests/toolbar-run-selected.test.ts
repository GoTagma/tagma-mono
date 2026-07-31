import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleToolbarRunClick } from '../src/components/board/Toolbar';

describe('Toolbar Run Selected control', () => {
  test('stops selection-clearing parent clicks before starting the run', () => {
    const calls: string[] = [];

    handleToolbarRunClick(
      {
        stopPropagation: () => {
          calls.push('stop propagation');
        },
      },
      () => {
        calls.push('start run');
      },
    );

    expect(calls).toEqual(['stop propagation', 'start run']);
  });

  test('wires the visible Run control through the non-bubbling handler', () => {
    const source = readFileSync(
      join(import.meta.dir, '../src/components/board/Toolbar.tsx'),
      'utf8',
    );

    expect(source).toContain('onClick={(event) => handleToolbarRunClick(event, onRun)}');
  });
});
