import { afterEach, describe, expect, test } from 'bun:test';
import { downloadUrlToBuffer } from '../server/release/download';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('hot-update download helper', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('downloads a response body into a buffer', async () => {
    globalThis.fetch = (async () =>
      new Response(Buffer.from('asset-body'), {
        status: 200,
        headers: { 'content-length': '10' },
      })) as unknown as typeof fetch;

    const result = await downloadUrlToBuffer({
      url: 'https://example.test/asset.bin',
      label: 'Test asset',
      maxBytes: 100,
      idleTimeoutMs: 1_000,
      expectedBytes: 10,
    });

    expect(result.bytesReceived).toBe(10);
    expect(result.buffer.toString('utf-8')).toBe('asset-body');
  });

  test('allows slow downloads that keep making progress', async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            void (async () => {
              for (const chunk of ['a', 'b', 'c', 'd']) {
                await sleep(20);
                controller.enqueue(Buffer.from(chunk));
              }
              controller.close();
            })();
          },
        }),
        {
          status: 200,
          headers: { 'content-length': '4' },
        },
      )) as unknown as typeof fetch;

    const result = await downloadUrlToBuffer({
      url: 'https://example.test/slow-but-progressing.bin',
      label: 'Sidecar binary',
      maxBytes: 100,
      idleTimeoutMs: 50,
      expectedBytes: 4,
    });

    expect(result.bytesReceived).toBe(4);
    expect(result.buffer.toString('utf-8')).toBe('abcd');
  });

  test('retries transient idle timeouts and succeeds on a later attempt', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* keep the stream open until the helper's idle timeout owns the retry */
            },
          }),
          { status: 200 },
        );
      }
      return new Response(Buffer.from('ok'), {
        status: 200,
        headers: { 'content-length': '2' },
      });
    }) as unknown as typeof fetch;

    const result = await downloadUrlToBuffer({
      url: 'https://example.test/flaky-sidecar.bin',
      label: 'Sidecar binary',
      maxBytes: 100,
      idleTimeoutMs: 10,
      retryDelayMs: 0,
    });

    expect(calls).toBe(3);
    expect(result.buffer.toString('utf-8')).toBe('ok');
  });

  test('rejects a manifest size mismatch before reading the body', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* left open; the header mismatch should reject without waiting for body completion */
          },
        }),
        {
          status: 200,
          headers: { 'content-length': '5' },
        },
      );
    }) as unknown as typeof fetch;

    await expect(
      downloadUrlToBuffer({
        url: 'https://example.test/wrong-size.bin',
        label: 'Sidecar binary',
        maxBytes: 100,
        idleTimeoutMs: 10,
        expectedBytes: 4,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/declared size 5 B .* does not match manifest size 4 B/);
    expect(calls).toBe(1);
  });

  test('does not wait for stream cancel after exceeding the byte cap', async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.alloc(101));
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      downloadUrlToBuffer({
        url: 'https://example.test/oversized.bin',
        label: 'Sidecar binary',
        maxBytes: 100,
        idleTimeoutMs: 1_000,
      }),
    ).rejects.toThrow(/exceeds 100 B cap/);
  });

  test('reports idle timeout with received byte count', async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('abc'));
          },
        }),
        {
          status: 200,
          headers: { 'content-length': '4' },
        },
      )) as unknown as typeof fetch;

    await expect(
      downloadUrlToBuffer({
        url: 'https://example.test/slow-sidecar.bin',
        label: 'Sidecar binary',
        maxBytes: 100,
        idleTimeoutMs: 10,
        expectedBytes: 4,
        maxAttempts: 1,
      }),
    ).rejects.toThrow(
      /Sidecar binary download failed: timed out after .* with no new data .*received 3 B of 4 B/,
    );
  });
});
