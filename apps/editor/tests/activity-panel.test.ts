import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEvent } from '../src/api/opencode-chat';
import { advanceLiveActivityNow, TurnActivityPanel } from '../src/components/chat/ActivityPanel';
import { RetryableOperationNoticeView } from '../src/components/chat/ChatPanel';

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
  test('returns a failed request to the normal composer without technical recovery controls', () => {
    const html = renderToStaticMarkup(createElement(RetryableOperationNoticeView));

    expect(html).toContain('Your message is ready to send again');
    expect(html).not.toContain('Provider unavailable');
    expect(html).not.toContain('classification');
    expect(html).not.toContain('outbox');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('animate-spin');
  });

  test('uses the existing model picker as the only action for a definitive model failure', () => {
    const html = renderToStaticMarkup(
      createElement(RetryableOperationNoticeView, { needsModelChange: true }),
    );

    expect(html).toContain('Choose another model to continue');
    expect(html).toContain('Your message is preserved below');
    expect(html).toContain('aria-label="Chat model change required"');
    expect(html).not.toContain('<button');
  });

  test('renders a user-input wait with a static warning instead of a generation spinner', () => {
    const html = renderToStaticMarkup(
      createElement(TurnActivityPanel, {
        activity: [
          {
            kind: 'operation-waiting',
            startedAt: 10_000,
            endedAt: null,
            count: 1,
            detail: 'Host phase: awaiting input',
          },
        ],
        isCurrentTurn: true,
        surfaceSummary: true,
        expanded: false,
        onToggle: () => {},
      }),
    );

    expect(html).toContain('Waiting for input');
    expect(html).not.toContain('animate-spin');
  });

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
