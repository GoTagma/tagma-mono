import { afterEach, describe, expect, test } from 'bun:test';
import {
  createPairCode,
  consumePairCode,
  consumePairCodeAttempt,
  pendingCount,
  _resetForTests,
} from '../server/chat-bridge/pair-code';

afterEach(() => {
  _resetForTests();
});

describe('pair-code', () => {
  test('createPairCode mints a 6-digit numeric code bound to a workspace', () => {
    const entry = createPairCode('/ws/alpha', 'alice');
    expect(entry.code).toMatch(/^\d{6}$/);
    expect(entry.workspaceKey).toBe('/ws/alpha');
    expect(entry.label).toBe('alice');
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
    expect(pendingCount()).toBe(1);
  });

  test('consumePairCode returns the entry on exact match and is single-use', () => {
    const entry = createPairCode('/ws/beta', null);
    const hit = consumePairCode(entry.code);
    expect(hit).not.toBeNull();
    expect(hit?.workspaceKey).toBe('/ws/beta');
    // Second consume of the same code misses — codes are single-use.
    expect(consumePairCode(entry.code)).toBeNull();
    expect(pendingCount()).toBe(0);
  });

  test('a wrong guess does not consume any pending code', () => {
    const entry = createPairCode('/ws/gamma', null);
    expect(consumePairCode('000000')).toBeNull();
    // The real code still works afterward — a miss must not burn it.
    expect(consumePairCode(entry.code)?.workspaceKey).toBe('/ws/gamma');
  });

  test('rejects malformed input without throwing', () => {
    createPairCode('/ws/delta', null);
    expect(consumePairCode('')).toBeNull();
    expect(consumePairCode('12345')).toBeNull(); // too short
    expect(consumePairCode('1234567')).toBeNull(); // too long
    expect(consumePairCode('abcdef')).toBeNull(); // non-numeric
    expect(consumePairCode(undefined as unknown as string)).toBeNull();
  });

  test('expired codes are evicted and no longer match', async () => {
    const entry = createPairCode('/ws/eps', null);
    // Force-expire by rewinding nothing — instead assert TTL window then
    // simulate passage by mutating Date.now via a short real wait would be
    // flaky; instead verify the entry is live now and that a fresh code
    // with a manually-passed expiry is rejected.
    expect(consumePairCode(entry.code)).not.toBeNull();
    _resetForTests();
    // Mint, then monkeypatch Date.now to jump past the 120 s TTL.
    const e2 = createPairCode('/ws/eps2', null);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 121_000;
      expect(consumePairCode(e2.code)).toBeNull();
      expect(pendingCount()).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  test('codes are unique while pending', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const e = createPairCode(`/ws/${i}`, null);
      expect(seen.has(e.code)).toBe(false);
      seen.add(e.code);
    }
    expect(pendingCount()).toBe(200);
  });

  test('repeated wrong guesses lock a caller without consuming the real code', () => {
    const entry = createPairCode('/ws/zeta', null);
    for (let i = 0; i < 4; i++) {
      const result = consumePairCodeAttempt('000000', 'telegram:chat:attacker');
      expect(result.status).toBe('miss');
    }
    const locked = consumePairCodeAttempt('111111', 'telegram:chat:attacker');
    expect(locked.status).toBe('locked');
    expect(consumePairCodeAttempt(entry.code, 'telegram:chat:attacker').status).toBe('locked');
    expect(consumePairCode(entry.code)?.workspaceKey).toBe('/ws/zeta');
  });
});
