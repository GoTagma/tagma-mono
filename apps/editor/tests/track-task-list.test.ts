import { describe, expect, test } from 'bun:test';
import type { RawTrackConfig } from '../src/api/client';
import { buildTrackTaskListGroups } from '../src/utils/track-task-list';

const track: RawTrackConfig = {
  id: 'main',
  name: 'Main',
  tasks: [
    { id: 'zeta', name: 'Zeta prompt', prompt: 'last prompt' },
    { id: 'build', name: 'Build command', command: 'bun run build' },
    { id: 'alpha', name: 'Alpha prompt', prompt: 'first prompt' },
    { id: 'check', name: 'Check command', command: 'bun test' },
  ],
};

describe('track task list groups', () => {
  test('groups prompt and command tasks while preserving execution order within each group', () => {
    const groups = buildTrackTaskListGroups(track, 'execution');

    expect(groups.map((group) => group.kind)).toEqual(['prompt', 'command']);
    expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['zeta', 'alpha']);
    expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['build', 'check']);
  });

  test('sorts alphabetically inside each functional group without mixing groups', () => {
    const groups = buildTrackTaskListGroups(track, 'alphabetical');

    expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['alpha', 'zeta']);
    expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['build', 'check']);
    expect(groups[0]?.tasks[0]?.qualifiedId).toBe('main.alpha');
  });
});
