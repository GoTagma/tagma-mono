import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ActivityEvent } from '../src/api/opencode-chat';
import {
  advanceLiveActivityNow,
  formatRecentTurnHealthSummary,
  formatTurnHealthSummary,
  TurnActivityPanel,
} from '../src/components/chat/ActivityPanel';
import { useChatStore } from '../src/store/chat-store';

describe('turn health summary labels', () => {
  test('labels a successful backend probe as an OpenCode verification', () => {
    expect(formatTurnHealthSummary({ status: 'ok', checkedAt: 1_000 }, 4_200)).toEqual({
      label: 'OpenCode verified 3s ago',
      tone: 'normal',
    });
  });

  test('labels degraded probes as reconnecting', () => {
    expect(formatTurnHealthSummary({ status: 'degraded', checkedAt: 1_000 }, 61_500)).toEqual({
      label: 'OpenCode reconnecting · checked 1m00s ago',
      tone: 'warning',
    });
  });

  test('keeps stale ok probes out of local-only timers', () => {
    expect(formatRecentTurnHealthSummary({ status: 'ok', checkedAt: 1_000 }, 12_001)).toBeNull();
    expect(formatRecentTurnHealthSummary({ status: 'degraded', checkedAt: 1_000 }, 12_001)).toEqual(
      {
        label: 'OpenCode reconnecting · checked 11s ago',
        tone: 'warning',
      },
    );
  });
});

describe('activity panel live timer layout', () => {
  test('renders the live summary in a stable text slot', () => {
    const realNow = Date.now;
    const previous = {
      sessionStatus: useChatStore.getState().sessionStatus,
      lastActivityAt: useChatStore.getState().lastActivityAt,
      turnHealth: useChatStore.getState().turnHealth,
    };
    Date.now = () => 11_250;
    useChatStore.setState({ sessionStatus: null, lastActivityAt: null, turnHealth: null });

    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity: [
            { kind: 'request-sent', startedAt: 0, endedAt: 100, count: 1 },
            { kind: 'assistant-started', startedAt: 100, endedAt: 500, count: 1 },
            {
              kind: 'tool-running',
              startedAt: 1_000,
              endedAt: null,
              count: 1,
              detail: 'read',
            },
          ] satisfies ActivityEvent[],
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: false,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Running tool: read');
      expect(html).toContain('w-full max-w-full min-w-0');
      expect(html).not.toContain('w-[36ch]');
      expect(html).toContain('min-w-0 flex-1 truncate tabular-nums');
    } finally {
      Date.now = realNow;
      useChatStore.setState(previous);
    }
  });

  test('renders row durations in a fixed-width column', () => {
    const realNow = Date.now;
    const previous = {
      sessionStatus: useChatStore.getState().sessionStatus,
      lastActivityAt: useChatStore.getState().lastActivityAt,
      turnHealth: useChatStore.getState().turnHealth,
    };
    Date.now = () => 11_250;
    useChatStore.setState({ sessionStatus: null, lastActivityAt: null, turnHealth: null });

    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity: [
            { kind: 'request-sent', startedAt: 0, endedAt: 100, count: 1 },
            { kind: 'assistant-started', startedAt: 100, endedAt: 500, count: 1 },
            {
              kind: 'tool-running',
              startedAt: 1_000,
              endedAt: null,
              count: 1,
              detail: 'read',
            },
          ] satisfies ActivityEvent[],
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: true,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Tool running');
      expect(html).toMatch(/w-14[^"]*text-right[^"]*tabular-nums/);
    } finally {
      Date.now = realNow;
      useChatStore.setState(previous);
    }
  });

  test('surfaces live reasoning as the active turn summary', () => {
    const realNow = Date.now;
    const previous = {
      sessionStatus: useChatStore.getState().sessionStatus,
      lastActivityAt: useChatStore.getState().lastActivityAt,
      turnHealth: useChatStore.getState().turnHealth,
    };
    Date.now = () => 6_000;
    useChatStore.setState({ sessionStatus: null, lastActivityAt: 5_500, turnHealth: null });

    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity: [
            { kind: 'request-sent', startedAt: 0, endedAt: 100, count: 1 },
            { kind: 'assistant-started', startedAt: 100, endedAt: 500, count: 1 },
            {
              kind: 'thinking',
              startedAt: 1_000,
              endedAt: null,
              count: 3,
              bytes: 2048,
              key: 'part:p1',
            },
          ] satisfies ActivityEvent[],
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: false,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Thinking · 5s · 2.0k chars');
    } finally {
      Date.now = realNow;
      useChatStore.setState(previous);
    }
  });

  test('cosmetic live clock advances one visible second after a delayed tick', () => {
    expect(advanceLiveActivityNow(10_000, 12_150)).toBe(11_000);
  });
});
