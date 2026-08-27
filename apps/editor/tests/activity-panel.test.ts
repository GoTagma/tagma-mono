import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEvent } from '../src/api/opencode-chat';
import { advanceLiveActivityNow, TurnActivityPanel } from '../src/components/chat/ActivityPanel';

const activity = [
  { kind: 'request-sent', startedAt: 0, endedAt: 100, count: 1 },
  { kind: 'assistant-started', startedAt: 100, endedAt: 500, count: 1 },
  {
    kind: 'tool-running',
    startedAt: 1_000,
    endedAt: null,
    count: 1,
    detail: 'read',
  },
] satisfies ActivityEvent[];

describe('Chat Operation V2 activity panel', () => {
  test('renders Host-projected activity in a stable summary slot', () => {
    const realNow = Date.now;
    Date.now = () => 11_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity,
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: false,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Host action · read');
      expect(html).toContain('w-full max-w-full min-w-0');
      expect(html).toContain('min-w-0 flex-1 truncate tabular-nums');
    } finally {
      Date.now = realNow;
    }
  });

  test('renders projected row durations in a fixed-width column', () => {
    const realNow = Date.now;
    Date.now = () => 11_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity,
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: true,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Host action');
      expect(html).toMatch(/w-14[^"]*text-right[^"]*tabular-nums/);
    } finally {
      Date.now = realNow;
    }
  });

  test('advances the cosmetic live clock by one visible second', () => {
    expect(advanceLiveActivityNow(10_000, 12_150)).toBe(11_000);
  });
});
