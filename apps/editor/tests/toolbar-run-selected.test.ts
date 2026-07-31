import { describe, expect, test } from 'bun:test';
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
});
