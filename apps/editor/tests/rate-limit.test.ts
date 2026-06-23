import { afterEach, describe, expect, test } from 'bun:test';
import { _resetRateLimits, takeRateLimitToken } from '../server/rate-limit';

const realDateNow = Date.now;

function setNow(now: number): void {
  Date.now = () => now;
}

afterEach(() => {
  Date.now = realDateNow;
  _resetRateLimits();
});

describe('rate limiter', () => {
  test('enforces a fixed window per key and reports retry timing', () => {
    setNow(1_000);
    const limit = { windowMs: 500, max: 2 };

    expect(takeRateLimitToken('workspace-a', limit)).toEqual({
      ok: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(takeRateLimitToken('workspace-a', limit)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    expect(takeRateLimitToken('workspace-a', limit)).toEqual({
      ok: false,
      remaining: 0,
      retryAfterMs: 500,
    });
  });

  test('keeps buckets isolated and resets after the window expires', () => {
    const limit = { windowMs: 250, max: 1 };
    setNow(2_000);

    expect(takeRateLimitToken('workspace-a', limit).ok).toBe(true);
    expect(takeRateLimitToken('workspace-b', limit).ok).toBe(true);
    expect(takeRateLimitToken('workspace-a', limit).ok).toBe(false);

    setNow(2_251);
    expect(takeRateLimitToken('workspace-a', limit)).toEqual({
      ok: true,
      remaining: 0,
      retryAfterMs: 0,
    });
  });
});
