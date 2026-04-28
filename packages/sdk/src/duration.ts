import { parseDuration } from '@tagma/core';

/**
 * Plugin schemas use `timeout` as an optional duration field. Omitted values
 * use the caller's fallback; explicit 0 disables the timer.
 */
export function parseOptionalPluginTimeout(value: unknown, fallbackMs: number): number {
  if (value == null) return fallbackMs;
  if (value === 0 || value === '0') return 0;
  return parseDuration(String(value));
}
