import { describe, expect, test } from 'bun:test';
import { formatRelative } from '../src/utils/format-relative';

describe('formatRelative', () => {
  const NOW = 1_700_000_000_000;

  test('returns "just now" under one minute', () => {
    expect(formatRelative(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelative(NOW - 59_000, NOW)).toBe('just now');
  });

  test('returns "Xm ago" within the hour', () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatRelative(NOW - 45 * 60_000, NOW)).toBe('45m ago');
  });

  test('returns "Xh ago" within the day', () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatRelative(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });

  test('returns "Xd ago" within 30 days', () => {
    expect(formatRelative(NOW - 24 * 60 * 60_000, NOW)).toBe('1d ago');
    expect(formatRelative(NOW - 29 * 24 * 60 * 60_000, NOW)).toBe('29d ago');
  });

  test('falls back to a locale date string beyond 30 days', () => {
    const result = formatRelative(NOW - 31 * 24 * 60 * 60_000, NOW);
    expect(result).not.toMatch(/ago|just now/);
    expect(result.length).toBeGreaterThan(0);
  });
});
