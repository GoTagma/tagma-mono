import { afterEach, describe, expect, test } from 'bun:test';

import { createStreamingLoopbackFetch } from '../server/loopback-fetch';

/**
 * These tests pin Option B: a raw-socket loopback fetch the chat-bridge driver
 * injects into `createOpencodeClient`. It must (1) never consult proxy env so it
 * works identically whether or not the user has a proxy, and (2) stream the
 * response body incrementally so opencode's long-lived `GET /event` SSE works
 * (the existing buffering `createLoopbackFetch` resolves only on socket close,
 * which would hang the Telegram turn forever).
 */

const PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

const savedEnv = new Map<string, string | undefined>();
function setProxyEnv(): void {
  for (const k of PROXY_KEYS) savedEnv.set(k, process.env[k]);
  // Point every proxy var at the discard port (nothing listens there). A
  // global-fetch implementation would route loopback through here and fail;
  // the raw-socket implementation ignores these entirely.
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  process.env.http_proxy = 'http://127.0.0.1:9';
  process.env.https_proxy = 'http://127.0.0.1:9';
  process.env.ALL_PROXY = 'socks5://127.0.0.1:9';
  process.env.all_proxy = 'socks5://127.0.0.1:9';
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
}

afterEach(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

describe('createStreamingLoopbackFetch', () => {
  test('reaches a loopback server even with HTTP/HTTPS/ALL proxies set (proxy present)', async () => {
    setProxyEnv();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      const res = await lf(server.url.href);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      server.stop(true);
    }
  });

  test('works with no proxy configured (proxy absent)', async () => {
    for (const k of PROXY_KEYS) {
      savedEnv.set(k, process.env[k]);
      delete process.env[k];
    }
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      const res = await lf(server.url.href);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      server.stop(true);
    }
  });

  test('streams the body incrementally before the connection closes (SSE)', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
            await gate; // hold the connection open like opencode's /event
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      // Must resolve WITHOUT waiting for the socket to close.
      const res = (await Promise.race([
        lf(new URL('/event', server.url).href),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('fetch did not resolve before socket close')), 4000),
        ),
      ])) as Response;
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = (await Promise.race([
        reader.read(),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('first chunk not delivered while open')), 4000),
        ),
      ])) as ReadableStreamReadResult<Uint8Array>;
      expect(new TextDecoder().decode(first.value)).toContain('data: first');
      await reader.cancel();
    } finally {
      release();
      server.stop(true);
    }
  });

  test('sends a request body and returns the JSON response', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = await req.json();
        return Response.json({ echo: body });
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      const res = await lf(server.url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      });
      expect(await res.json()).toEqual({ echo: { a: 1 } });
    } finally {
      server.stop(true);
    }
  });

  test('refuses a non-loopback baseUrl', () => {
    expect(() => createStreamingLoopbackFetch('http://example.com')).toThrow();
  });

  test('refuses a request that escapes the loopback origin', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return new Response('ok');
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      const otherPort = String((Number(new URL(server.url.href).port) % 65000) + 1);
      await expect(lf(`http://127.0.0.1:${otherPort}/`)).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });

  test('rejects when the abort signal fires before the response', async () => {
    const gate = new Promise<void>(() => {}); // never resolves
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        await gate;
        return new Response('never');
      },
    });
    try {
      const lf = createStreamingLoopbackFetch(server.url.href);
      const ctrl = new AbortController();
      const p = lf(server.url.href, { signal: ctrl.signal });
      ctrl.abort();
      await expect(p).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });
});
