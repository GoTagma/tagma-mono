import { describe, expect, test } from 'bun:test';

import {
  ALLOWED_ORIGINS,
  addLoopbackAllowedOrigins,
  createAllowedOrigins,
  resetAllowedOrigins,
} from '../server/allowed-origins';

describe('allowed origins helpers', () => {
  test('createAllowedOrigins includes dev defaults only for dev sidecars', () => {
    const prodOrigins = createAllowedOrigins(
      3001,
      ' https://example.com , http://intranet.local ',
      { devOrigins: false },
    );

    expect(prodOrigins.has('http://localhost:5173')).toBe(false);
    expect(prodOrigins.has('http://127.0.0.1:5173')).toBe(false);
    expect(prodOrigins.has('http://localhost:3001')).toBe(true);
    expect(prodOrigins.has('http://127.0.0.1:3001')).toBe(true);
    expect(prodOrigins.has('https://example.com')).toBe(true);
    expect(prodOrigins.has('http://intranet.local')).toBe(true);

    const origins = createAllowedOrigins(3001, ' https://example.com , http://intranet.local ', {
      devOrigins: true,
    });

    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    expect(origins.has('http://localhost:5174')).toBe(true);
    expect(origins.has('http://127.0.0.1:5174')).toBe(true);
    expect(origins.has('http://localhost:3001')).toBe(true);
    expect(origins.has('http://127.0.0.1:3001')).toBe(true);
    expect(origins.has('https://example.com')).toBe(true);
    expect(origins.has('http://intranet.local')).toBe(true);
    expect(origins.has('http://localhost:5199')).toBe(false);
  });

  test('addLoopbackAllowedOrigins appends the actual bound loopback port', () => {
    const origins = createAllowedOrigins(0, '', { devOrigins: false });

    addLoopbackAllowedOrigins(origins, 43127);

    expect(origins.has('http://localhost:43127')).toBe(true);
    expect(origins.has('http://127.0.0.1:43127')).toBe(true);
  });

  test('shared origins can be reset after dev bootstrap updates env', () => {
    const previousSource = process.env.TAGMA_SIDECAR_ACTIVE_SOURCE;
    const previousExtra = process.env.TAGMA_ALLOWED_ORIGINS;
    const previousEntries = [...ALLOWED_ORIGINS];

    try {
      process.env.TAGMA_SIDECAR_ACTIVE_SOURCE = 'dev';
      delete process.env.TAGMA_ALLOWED_ORIGINS;

      const origins = resetAllowedOrigins(3001);

      expect(origins).toBe(ALLOWED_ORIGINS);
      expect(origins.has('http://localhost:5173')).toBe(true);
      expect(origins.has('http://127.0.0.1:5173')).toBe(true);
      expect(origins.has('http://localhost:3001')).toBe(true);
      expect(origins.has('http://127.0.0.1:3001')).toBe(true);
    } finally {
      if (previousSource === undefined) delete process.env.TAGMA_SIDECAR_ACTIVE_SOURCE;
      else process.env.TAGMA_SIDECAR_ACTIVE_SOURCE = previousSource;

      if (previousExtra === undefined) delete process.env.TAGMA_ALLOWED_ORIGINS;
      else process.env.TAGMA_ALLOWED_ORIGINS = previousExtra;

      ALLOWED_ORIGINS.clear();
      for (const origin of previousEntries) ALLOWED_ORIGINS.add(origin);
    }
  });
});
