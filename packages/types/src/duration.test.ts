import { describe, expect, test } from 'bun:test';
import { parseDurationSafe, parseOptionalPluginTimeout } from './duration.js';

const MAX_TIMER = 2_147_483_647;

describe('parseDurationSafe', () => {
  test('returns fallback on null/undefined/empty', () => {
    expect(parseDurationSafe(null, 42)).toBe(42);
    expect(parseDurationSafe(undefined, 42)).toBe(42);
    expect(parseDurationSafe('', 42)).toBe(42);
  });

  test('parses ms/s/m/h units', () => {
    expect(parseDurationSafe('500ms', 0)).toBe(500);
    expect(parseDurationSafe('5s', 0)).toBe(5_000);
    expect(parseDurationSafe('2m', 0)).toBe(120_000);
    expect(parseDurationSafe('1h', 0)).toBe(3_600_000);
  });

  test('treats unitless number as seconds', () => {
    expect(parseDurationSafe('30', 0)).toBe(30_000);
    expect(parseDurationSafe('1.5', 0)).toBe(1_500);
  });

  test('rejects malformed input by returning fallback', () => {
    expect(parseDurationSafe('garbage', 99)).toBe(99);
    expect(parseDurationSafe('5d', 99)).toBe(99); // d not supported here
    expect(parseDurationSafe('5x', 99)).toBe(99);
  });

  test('rejects out-of-range duration by returning fallback', () => {
    expect(parseDurationSafe(`${MAX_TIMER + 1}ms`, 99)).toBe(99);
  });
});

describe('parseOptionalPluginTimeout', () => {
  test('returns fallback when omitted', () => {
    expect(parseOptionalPluginTimeout(undefined, 100)).toBe(100);
    expect(parseOptionalPluginTimeout(null, 100)).toBe(100);
  });

  test('treats explicit zero as no timeout', () => {
    expect(parseOptionalPluginTimeout(0, 100)).toBe(0);
    expect(parseOptionalPluginTimeout('0', 100)).toBe(0);
  });

  test('parses s|m|h|d strict vocabulary', () => {
    expect(parseOptionalPluginTimeout('30s', 100)).toBe(30_000);
    expect(parseOptionalPluginTimeout('5m', 100)).toBe(300_000);
    expect(parseOptionalPluginTimeout('2h', 100)).toBe(7_200_000);
    expect(parseOptionalPluginTimeout('1d', 100)).toBe(86_400_000);
  });

  test('throws on malformed input — never silently disables timeout', () => {
    expect(() => parseOptionalPluginTimeout('garbage', 100)).toThrow(/Invalid duration format/);
    expect(() => parseOptionalPluginTimeout('500ms', 100)).toThrow(/Invalid duration format/);
    expect(() => parseOptionalPluginTimeout(5, 100)).toThrow(/Invalid duration format/);
  });

  test('throws on out-of-range duration', () => {
    expect(() => parseOptionalPluginTimeout(`${MAX_TIMER + 1}s`, 100)).toThrow(
      /exceeds maximum supported timer/,
    );
  });
});
