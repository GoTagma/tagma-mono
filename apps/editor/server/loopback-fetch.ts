/**
 * Streaming raw-socket loopback fetch.
 *
 * `@opencode-ai/sdk`'s `createOpencodeClient` falls back to `globalThis.fetch`
 * when no `fetch` is supplied. Bun's global fetch honors `HTTP_PROXY` /
 * `HTTPS_PROXY` / `ALL_PROXY` and only bypasses hosts listed in `NO_PROXY`.
 * On machines running a local proxy (Clash/V2Ray etc.) with no loopback
 * exclusion, every server-side SDK call to the spawned `opencode serve`
 * (`http://127.0.0.1:<port>`) is tunneled through that proxy, which answers
 * 502 for an arbitrary loopback port — surfacing in the Telegram bridge as
 * `⚠️ aborted: opencode request failed (502)`.
 *
 * `opencode-lifecycle.ts` (health probe) and `platform-export.ts`
 * (`createLoopbackFetch`) already dodge this by talking to loopback over a raw
 * `Bun.connect` socket instead of proxied fetch. This module is the same idea
 * but **streaming**: the response resolves as soon as the headers are parsed
 * and the body is delivered incrementally via a `ReadableStream`, so the
 * driver's long-lived `client.event.subscribe()` SSE (`GET /event`) works.
 * The `platform-export.ts` variant resolves only on socket close and would
 * hang an SSE turn forever.
 *
 * Connecting straight to 127.0.0.1 never consults proxy settings at all, so it
 * behaves identically whether or not a proxy (of any kind) is configured.
 */

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'http:' ? '80' : '443');
}

function toAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error('OpenCode loopback request was canceled.');
}

interface ParsedHead {
  status: number;
  statusText: string;
  headers: Headers;
  /** Bytes after the header terminator that already belong to the body. */
  rest: Buffer;
}

/** Parse the status line + headers once `\r\n\r\n` has been seen. */
function parseHead(raw: Buffer): ParsedHead | null {
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) return null;
  const headerText = raw.subarray(0, sep).toString('latin1');
  const lines = headerText.split('\r\n');
  const statusLine = lines.shift() ?? '';
  const m = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  if (!m) throw new Error(`OpenCode loopback response has invalid status: ${statusLine}`);
  const headers = new Headers();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return {
    status: Number(m[1]),
    statusText: m[2] ?? '',
    headers,
    rest: raw.subarray(sep + 4),
  };
}

type BodyMode =
  | { kind: 'length'; remaining: number }
  | { kind: 'chunked' }
  | { kind: 'until-close' };

/**
 * Incremental dechunker for `Transfer-Encoding: chunked`. Fed arbitrary byte
 * slices (chunk frames can straddle socket packets); yields decoded payload
 * bytes and flips `done` after the terminating zero-length chunk.
 */
class ChunkedDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'data-crlf' = 'size';
  private need = 0;
  done = false;

  push(input: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, input]) : input;
    const out: Buffer[] = [];
    for (;;) {
      if (this.state === 'size') {
        const nl = this.buf.indexOf('\r\n');
        if (nl < 0) return out;
        const sizeLine = this.buf.subarray(0, nl).toString('ascii').split(';', 1)[0].trim();
        const size = Number.parseInt(sizeLine, 16);
        if (!Number.isFinite(size) || size < 0) {
          throw new Error('OpenCode loopback response has invalid chunk size');
        }
        this.buf = this.buf.subarray(nl + 2);
        if (size === 0) {
          this.done = true;
          return out;
        }
        this.need = size;
        this.state = 'data';
      } else if (this.state === 'data') {
        if (this.buf.length === 0) return out;
        const take = Math.min(this.need, this.buf.length);
        out.push(Buffer.from(this.buf.subarray(0, take)));
        this.buf = this.buf.subarray(take);
        this.need -= take;
        if (this.need === 0) this.state = 'data-crlf';
      } else {
        // Consume the CRLF that trails each chunk's data.
        if (this.buf.length < 2) return out;
        this.buf = this.buf.subarray(2);
        this.state = 'size';
      }
    }
  }
}

function buildRequestPayload(request: Request, url: URL, port: string, body: Buffer): Buffer {
  const headerLines = [
    `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Connection: close',
  ];
  const headers = new Headers(request.headers);
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('host');
  if (body.length > 0) headers.set('content-length', String(body.length));
  if (!headers.has('accept')) headers.set('accept', '*/*');
  headers.forEach((value, key) => {
    headerLines.push(`${key}: ${value}`);
  });
  return Buffer.concat([Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`), body]);
}

async function streamingLoopbackRequest(request: Request, url: URL): Promise<Response> {
  const portStr = effectivePort(url);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid OpenCode loopback port: ${url.port}`);
  }
  if (request.signal.aborted) throw toAbortError(request.signal);

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? Buffer.alloc(0)
      : Buffer.from(await request.arrayBuffer());
  const payload = buildRequestPayload(request, url, portStr, body);

  return new Promise<Response>((resolve, reject) => {
    let headBuf: Buffer = Buffer.alloc(0);
    let headParsed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let decoder: ChunkedDecoder | null = null;
    let mode: BodyMode = { kind: 'until-close' };
    let bodyClosed = false;
    let socketRef: { end: () => void } | null = null;
    let onAbort: (() => void) | null = null;

    const detachAbort = () => {
      if (onAbort) {
        request.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };
    const closeBody = () => {
      if (bodyClosed) return;
      bodyClosed = true;
      detachAbort();
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
    };
    const failBody = (err: unknown) => {
      if (bodyClosed) return;
      bodyClosed = true;
      detachAbort();
      try {
        controller?.error(err);
      } catch {
        /* already errored */
      }
    };

    const feedBody = (data: Buffer) => {
      if (bodyClosed || data.length === 0) return;
      if (mode.kind === 'chunked') {
        if (!decoder) decoder = new ChunkedDecoder();
        let pieces: Buffer[];
        try {
          pieces = decoder.push(data);
        } catch (err) {
          failBody(err);
          socketRef?.end();
          return;
        }
        for (const p of pieces) controller?.enqueue(new Uint8Array(p));
        if (decoder.done) {
          closeBody();
          socketRef?.end();
        }
      } else if (mode.kind === 'length') {
        const take = Math.min(mode.remaining, data.length);
        if (take > 0) controller?.enqueue(new Uint8Array(data.subarray(0, take)));
        mode.remaining -= take;
        if (mode.remaining <= 0) {
          closeBody();
          socketRef?.end();
        }
      } else {
        controller?.enqueue(new Uint8Array(data));
      }
    };

    const onHeadComplete = (parsed: ParsedHead) => {
      headParsed = true;
      const te = (parsed.headers.get('transfer-encoding') ?? '').toLowerCase();
      const cl = parsed.headers.get('content-length');
      if (te.includes('chunked')) {
        mode = { kind: 'chunked' };
      } else if (cl !== null && cl !== '') {
        mode = { kind: 'length', remaining: Number(cl) };
      } else {
        mode = { kind: 'until-close' };
      }
      // Hop-by-hop / framing headers are meaningless to the consumer once we
      // re-frame the body as a ReadableStream — strip them.
      const outHeaders = new Headers(parsed.headers);
      outHeaders.delete('transfer-encoding');
      outHeaders.delete('content-length');
      outHeaders.delete('connection');

      const empty = mode.kind === 'length' && (mode as { remaining: number }).remaining <= 0;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          if (empty) closeBody();
        },
        cancel() {
          closeBody();
          socketRef?.end();
        },
      });
      detachAbort();
      onAbort = () => failBody(toAbortError(request.signal));
      request.signal.addEventListener('abort', onAbort, { once: true });
      resolve(
        new Response(empty ? null : stream, {
          status: parsed.status,
          statusText: parsed.statusText,
          headers: outHeaders,
        }),
      );
      if (parsed.rest.length > 0) feedBody(parsed.rest);
    };

    const abortPreHead = () => {
      detachAbort();
      socketRef?.end();
      reject(toAbortError(request.signal));
    };
    onAbort = abortPreHead;
    request.signal.addEventListener('abort', onAbort, { once: true });

    Bun.connect({
      hostname: url.hostname,
      port,
      socket: {
        open(socket) {
          socketRef = { end: () => socket.end() };
          socket.write(payload);
        },
        data(_socket, chunk) {
          const data = Buffer.from(chunk);
          if (headParsed) {
            feedBody(data);
            return;
          }
          headBuf = headBuf.length ? Buffer.concat([headBuf, data]) : data;
          let parsed: ParsedHead | null;
          try {
            parsed = parseHead(headBuf);
          } catch (err) {
            detachAbort();
            socketRef?.end();
            reject(err);
            return;
          }
          if (parsed) onHeadComplete(parsed);
        },
        close() {
          if (!headParsed) {
            detachAbort();
            reject(new Error('OpenCode loopback connection closed before any response'));
            return;
          }
          // `until-close` bodies end here; chunked/length already closed on
          // their terminator but a premature close still needs to unblock the
          // reader.
          closeBody();
        },
        error(_socket, err) {
          if (!headParsed) {
            detachAbort();
            reject(err);
          } else {
            failBody(err);
          }
        },
      },
    }).catch((err) => {
      detachAbort();
      reject(err);
    });
  });
}

/**
 * Build a `fetch`-shaped function bound to `baseUrl` that talks to loopback
 * over a raw socket (never proxied) and streams the response body. Pass it to
 * `createOpencodeClient({ baseUrl, fetch: createStreamingLoopbackFetch(baseUrl) })`.
 */
export function createStreamingLoopbackFetch(baseUrl: string): typeof fetch {
  const expected = new URL(baseUrl);
  if (expected.protocol !== 'http:' || !isLoopbackHost(expected.hostname)) {
    throw new Error(`OpenCode baseUrl must be loopback http, got ${baseUrl}`);
  }
  const loopbackFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== expected.protocol ||
      url.hostname !== expected.hostname ||
      effectivePort(url) !== effectivePort(expected)
    ) {
      throw new Error(`Refusing non-loopback OpenCode request: ${url.toString()}`);
    }
    return streamingLoopbackRequest(request, url);
  }) as typeof fetch;
  loopbackFetch.preconnect = fetch.preconnect.bind(fetch);
  return loopbackFetch;
}
