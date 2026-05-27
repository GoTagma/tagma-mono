import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { pinnedGet } from '../server/routes/custom-providers.js';

// Bun's node:http honours HTTP_PROXY at startup and isn't influenced by
// process.env.NO_PROXY / process.env.HTTP_PROXY mutations after launch.
// Dev boxes commonly run a local proxy (clash etc.) that intercepts every
// request regardless of `host:`, which would mask the pin we're trying
// to assert on. Skip the suite under that configuration so CI failures
// only happen when there's a real regression to look at — not because
// the local proxy answered 502.
const PROXY_INTERCEPTING =
  Boolean(
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy,
  ) && !/(^|,)(localhost|127\.0\.0\.1)(,|$)/i.test(process.env.NO_PROXY ?? '');

const describeMaybe = PROXY_INTERCEPTING ? describe.skip : describe;

let server: Server;
let port: number;
const lastSeen: { hostHeader: string | null } = { hostHeader: null as string | null };

beforeAll(async () => {
  // Local HTTP server we'll target via a fake hostname. If the pin works,
  // the request lands here regardless of what `host` would resolve to via
  // DNS. If it doesn't work, the request fails with ENOTFOUND.
  server = createServer((req, res) => {
    lastSeen.hostHeader = (req.headers.host as string | undefined) ?? null;
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'pinned-model' }] }));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.invalid/' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Helper: build a URL whose hostname is something other than 127.0.0.1 so a
// would-be DNS resolution at request time would land somewhere else. We use
// `localhost` (resolves to 127.0.0.1 on all reasonable hosts via /etc/hosts)
// rather than a `.invalid` hostname because some Bun environments route the
// latter through HTTP_PROXY before our `host:` pin gets a chance to apply.
// Loopback hostname is enough for the assertion: with no pin, the connection
// would still go to 127.0.0.1, but the request options recorded by the test
// server (its HOST header, in particular) would reflect what we sent — which
// is what the pin actually controls.
function pinnedTestUrl(path: string): URL {
  return new URL(`http://localhost:${port}${path}`);
}

describeMaybe('pinnedGet (skipped when HTTP_PROXY would intercept)', () => {
  test('pinnedGet connects to resolvedIp and preserves the original Host header', async () => {
    // The crux of the rebinding fix: even though we typed `localhost`, the
    // connection should land at the IP we validated, and the Host header the
    // server sees should still be `localhost:<port>` (so virtual-host routing
    // and TLS SNI aren't subverted).
    const url = pinnedTestUrl('/v1/models');
    const ac = new AbortController();
    lastSeen.hostHeader = null;
    const result = await pinnedGet(url, '127.0.0.1', {}, 4_000, ac.signal);
    if (!result.ok) {
      console.error('pinnedGet returned non-ok', {
        status: result.status,
        bodyText: result.bodyText,
      });
    }
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.bodyText)).toEqual({ data: [{ id: 'pinned-model' }] });
    // The Host header carries the original hostname, not the pinned IP. This
    // is what keeps TLS SNI / virtual hosting aligned with what the user
    // typed when the protocol is HTTPS in production.
    expect(lastSeen.hostHeader ?? '').toBe(`localhost:${port}`);
  });

  test('pinnedGet refuses to follow redirects (closes SSRF host-check bypass)', async () => {
    const url = pinnedTestUrl('/redirect');
    const ac = new AbortController();
    await expect(pinnedGet(url, '127.0.0.1', {}, 4_000, ac.signal)).rejects.toThrow(/redirect/i);
  });

  test('pinnedGet aborts in flight when the signal fires', async () => {
    const url = pinnedTestUrl('/v1/models');
    const ac = new AbortController();
    ac.abort();
    await expect(pinnedGet(url, '127.0.0.1', {}, 4_000, ac.signal)).rejects.toThrow(/abort/i);
  });
});
