import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('board modify chat buttons', () => {
  test('TaskCard exposes an icon-only modify button without starting canvas drag', () => {
    const source = readFileSync(join(root, 'src/components/board/TaskCard.tsx'), 'utf8');

    expect(source).toContain('Wrench');
    expect(source).toContain('onModifyClick?:');
    expect(source).toContain('data-task-modify-button="true"');
    expect(source).toContain('Modify this task with AI');
    expect(source).toContain('e.stopPropagation()');
  });

  test('TrackLane exposes an icon-only modify button without starting track drag', () => {
    const source = readFileSync(join(root, 'src/components/board/TrackLane.tsx'), 'utf8');

    expect(source).toContain('Wrench');
    expect(source).toContain('onModifyClick?:');
    expect(source).toContain('data-track-modify-button="true"');
    expect(source).toContain('Modify this track with AI');
    expect(source).toContain('e.stopPropagation()');
  });

  test('BoardCanvas routes task and track modify clicks into chat context attachments', () => {
    const source = readFileSync(join(root, 'src/components/board/BoardCanvas.tsx'), 'utf8');

    expect(source).toContain('buildModifyTargetAttachment');
    expect(source).toContain('attachComposerContext');
    expect(source).toContain('handleTaskModifyClick');
    expect(source).toContain('handleTrackModifyClick');
    expect(source).toContain('onModifyClick={handleTaskModifyClick}');
    expect(source).toContain('onModifyClick={handleTrackModifyClick}');
  });
});
