import { describe, expect, test } from 'bun:test';

import { addLoopbackAllowedOrigins, createAllowedOrigins } from '../server/allowed-origins';

describe('allowed origins helpers', () => {
  test('createAllowedOrigins includes dev defaults, configured port, and trimmed extras', () => {
    const origins = createAllowedOrigins(3001, ' https://example.com , http://intranet.local ');

    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    expect(origins.has('http://localhost:3001')).toBe(true);
    expect(origins.has('http://127.0.0.1:3001')).toBe(true);
    expect(origins.has('https://example.com')).toBe(true);
    expect(origins.has('http://intranet.local')).toBe(true);
  });

  test('addLoopbackAllowedOrigins appends the actual bound loopback port', () => {
    const origins = createAllowedOrigins(0, '');

    addLoopbackAllowedOrigins(origins, 43127);

    expect(origins.has('http://localhost:43127')).toBe(true);
    expect(origins.has('http://127.0.0.1:43127')).toBe(true);
  });
});
