import { describe, expect, test } from 'bun:test';
import { describeOpencodeError, toOpencodeError } from '../shared/opencode-errors';

describe('OpenCode error formatting', () => {
  test('extracts nested APIError data messages', () => {
    expect(
      describeOpencodeError({
        name: 'APIError',
        data: { statusCode: 429, message: 'rate limit exceeded' },
      }),
    ).toBe('HTTP 429: rate limit exceeded');
  });

  test('preserves SDK wrapped errors with status in cause', () => {
    const err = new Error('model unavailable');
    (err as { cause?: unknown }).cause = { status: 400 };
    expect(describeOpencodeError(err)).toBe('HTTP 400: model unavailable');
  });

  test('wraps plain object errors into Error instances', () => {
    const err = toOpencodeError({ message: 'busy session' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('busy session');
  });
});
