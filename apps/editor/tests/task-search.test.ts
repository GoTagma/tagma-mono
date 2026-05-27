import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig } from '../src/api/client';
import {
  findTaskSearchMatches,
  shouldCloseTaskSearchOnFocusLeave,
  shouldCloseTaskSearchOnPointerDown,
} from '../src/utils/task-search';

const config: RawPipelineConfig = {
  name: 'Searchable pipeline',
  tracks: [
    {
      id: 'research',
      name: 'Research',
      tasks: [
        {
          id: 'collect',
          name: 'Collect sources',
          prompt: 'Find documents about vector search.',
        },
      ],
    },
    {
      id: 'write',
      name: 'Write',
      tasks: [
        {
          id: 'draft',
          name: 'Draft memo',
          prompt: 'Summarize the research findings for review.',
        },
      ],
    },
  ],
};

describe('findTaskSearchMatches', () => {
  test('matches tasks by name or prompt and includes selectable task ids', () => {
    expect(findTaskSearchMatches(config, 'sources')).toEqual([
      {
        trackId: 'research',
        taskId: 'collect',
        qid: 'research.collect',
        label: 'Collect sources',
        snippet: 'Find documents about vector search.',
      },
    ]);

    expect(findTaskSearchMatches(config, 'RESEARCH')).toEqual([
      {
        trackId: 'write',
        taskId: 'draft',
        qid: 'write.draft',
        label: 'Draft memo',
        snippet: 'Summarize the research findings for review.',
      },
    ]);
  });

  test('returns no matches for blank queries', () => {
    expect(findTaskSearchMatches(config, '   ')).toEqual([]);
  });

  test('id mode matches by task id and qualified id, ignoring name/prompt', () => {
    // 'sources' is in the name but not in any id — should not match in id mode
    expect(findTaskSearchMatches(config, 'sources', 'id')).toEqual([]);

    expect(findTaskSearchMatches(config, 'collect', 'id')).toEqual([
      {
        trackId: 'research',
        taskId: 'collect',
        qid: 'research.collect',
        label: 'Collect sources',
        snippet: 'research.collect',
      },
    ]);

    expect(findTaskSearchMatches(config, 'write.draft', 'id')).toEqual([
      {
        trackId: 'write',
        taskId: 'draft',
        qid: 'write.draft',
        label: 'Draft memo',
        snippet: 'write.draft',
      },
    ]);
  });

  test('keeps expanded search open while focus moves inside the search control', () => {
    const inside = {} as EventTarget;
    const outside = {} as EventTarget;
    const container = {
      contains: (target: Node | null) => target === inside,
    } as Pick<HTMLElement, 'contains'>;

    expect(shouldCloseTaskSearchOnFocusLeave(container, inside)).toBe(false);
    expect(shouldCloseTaskSearchOnFocusLeave(container, outside)).toBe(true);
    expect(shouldCloseTaskSearchOnFocusLeave(container, null)).toBe(true);
  });

  test('closes expanded search when pointer down starts outside the search control', () => {
    const inside = {} as EventTarget;
    const outside = {} as EventTarget;
    const container = {
      contains: (target: Node | null) => target === inside,
    } as Pick<HTMLElement, 'contains'>;

    expect(shouldCloseTaskSearchOnPointerDown(container, inside)).toBe(false);
    expect(shouldCloseTaskSearchOnPointerDown(container, outside)).toBe(true);
    expect(shouldCloseTaskSearchOnPointerDown(container, null)).toBe(true);
  });
});
