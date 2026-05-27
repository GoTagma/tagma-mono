import { describe, expect, test } from 'bun:test';
import {
  formatRecentTurnHealthSummary,
  formatTurnHealthSummary,
} from '../src/components/chat/ActivityPanel';

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
