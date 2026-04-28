import { describe, expect, test } from 'bun:test';
import { parseOptionalPluginTimeout } from './duration';

describe('parseOptionalPluginTimeout', () => {
  test('uses fallback when timeout is omitted', () => {
    expect(parseOptionalPluginTimeout(undefined, 123)).toBe(123);
    expect(parseOptionalPluginTimeout(null, 123)).toBe(123);
  });

  test('treats explicit zero as no timeout', () => {
    expect(parseOptionalPluginTimeout(0, 123)).toBe(0);
    expect(parseOptionalPluginTimeout('0', 123)).toBe(0);
  });

  test('parses duration strings and rejects unitless non-zero numbers clearly', () => {
    expect(parseOptionalPluginTimeout('5s', 123)).toBe(5_000);
    expect(() => parseOptionalPluginTimeout(5, 123)).toThrow(/Invalid duration format: "5"/);
  });
});
