import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';

async function readWire(packets: readonly string[], method = 'GET'): Promise<string> {
  const sockets = new Set<Socket>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', () => {
      const send = (index: number) => {
        if (socket.destroyed) return;
        if (index === packets.length - 1) socket.end(packets[index]);
        else {
          socket.write(packets[index]!);
          timers.push(setTimeout(() => send(index + 1), 5));
        }
      };
      send(0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback port');
    const url = `http://127.0.0.1:${address.port}`;
    const response = await createStreamingLoopbackFetch(url)(url, {
      method,
      signal: AbortSignal.timeout(2000),
    });
    return await response.text();
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const head = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n';

test('loopback accepts complete length chunked trailers and close delimited responses', async () => {
  expect(await readWire([head + 'Content-Length: 2\r\n\r\n{}'])).toBe('{}');
  expect(await readWire([head + '\r\n{}'])).toBe('{}');
  expect(
    await readWire([
      head + 'Transfer-Encoding: chunked\r\n\r\n1\r\n{',
      '\r\n1\r\n}',
      '\r\n0\r\nX-Unit: trailer\r\n',
      '\r\n',
    ]),
  ).toBe('{}');
  expect(await readWire([head + 'Content-Length: 500\r\n\r\n'], 'HEAD')).toBe('');
});

test('loopback rejects incomplete content length even with a valid JSON prefix', async () => {
  await expect(readWire([head + 'Content-Length: 12\r\n\r\n{}'])).rejects.toThrow();
});

test('loopback rejects chunked bodies missing the final zero chunk', async () => {
  await expect(
    readWire([head + 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n']),
  ).rejects.toThrow();
});

test('loopback rejects chunked bodies missing the trailer section terminator', async () => {
  await expect(
    readWire([head + 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n']),
  ).rejects.toThrow();
});

test('loopback rejects a malformed chunk data terminator', async () => {
  await expect(
    readWire([head + 'Transfer-Encoding: chunked\r\n\r\n2\r\n{}XX0\r\n\r\n']),
  ).rejects.toThrow();
});

async function slowPost(size: number, cancel: boolean) {
  const body = Buffer.alloc(size);
  for (let index = 0; index < body.length; index++)
    body[index] = ((index >>> 16) ^ (index * 131)) & 255;
  const expectedHash = createHash('sha256').update(body).digest('hex');
  const digest = createHash('sha256');
  const timers: ReturnType<typeof setTimeout>[] = [];
  const abort = new AbortController();
  let received = 0;
  let peerClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let headers: Buffer = Buffer.alloc(0);
  let expected: number | undefined;
  let replied = false;
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        // Pause the actual TCP reader, not the Node compatibility stream.
        socket.pause();
        timers.push(setTimeout(() => socket.resume(), 100));
        if (cancel) timers.push(setTimeout(() => abort.abort(), 30));
      },
      data(socket, chunk) {
        let bytes: Buffer = Buffer.from(chunk);
        if (expected === undefined) {
          headers = Buffer.concat([headers, bytes]);
          const end = headers.indexOf('\r\n\r\n');
          if (end < 0) return;
          expected = Number(
            headers
              .subarray(0, end)
              .toString()
              .match(/content-length:\s*(\d+)/i)?.[1],
          );
          bytes = headers.subarray(end + 4);
        }
        received += bytes.length;
        digest.update(bytes);
        if (!cancel && !replied && received >= expected!) {
          replied = true;
          socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK');
        }
      },
      close() {
        peerClosed = true;
        resolveClosed();
      },
      error() {},
    },
  });
  timers.push(setTimeout(() => abort.abort(), 2000));
  let error: unknown;
  let responseBody: string | undefined;
  try {
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const response = await createStreamingLoopbackFetch(url)(url, {
        method: 'POST',
        body,
        signal: abort.signal,
      });
      responseBody = await response.text();
    } catch (caught) {
      error = caught;
    }
    await Promise.race([
      closed,
      new Promise<void>((resolve) => timers.push(setTimeout(resolve, 1000))),
    ]);
    return {
      received,
      expectedHash,
      receivedHash: digest.digest('hex'),
      error,
      responseBody,
      peerClosed,
    };
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.stop(true);
  }
}

test('loopback sends complete small and large request bodies through real socket backpressure', async () => {
  for (const size of [64 * 1024, 8 * 1024 * 1024]) {
    const result = await slowPost(size, false);
    expect(result.received).toBe(size);
    expect(result.error).toBeUndefined();
    expect(result.receivedHash).toBe(result.expectedHash);
    expect(result.responseBody).toBe('OK');
    expect(result.peerClosed).toBe(true);
  }
}, 10_000);

test('loopback abort disposes a request blocked on socket backpressure', async () => {
  const result = await slowPost(8 * 1024 * 1024, true);
  expect(result.error).toBeDefined();
  expect(result.received).toBeLessThan(8 * 1024 * 1024);
  expect(result.peerClosed).toBe(true);
}, 10_000);
