import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureOpencode,
  resolveOpencodePathFallback,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';

type BunLike = typeof Bun & {
  listen: typeof Bun.listen;
  connect: typeof Bun.connect;
  spawn: typeof Bun.spawn;
  which: typeof Bun.which;
};

const realBun = {
  listen: Bun.listen,
  connect: Bun.connect,
  spawn: Bun.spawn,
  which: Bun.which,
};
const realDateNow = Date.now;

let tempRoot: string;

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'tagma-opencode-lifecycle-'));
});

afterEach(async () => {
  await stopOpencodeProcesses(10);
  (Bun as BunLike).listen = realBun.listen;
  (Bun as BunLike).connect = realBun.connect;
  (Bun as BunLike).spawn = realBun.spawn;
  (Bun as BunLike).which = realBun.which;
  Date.now = realDateNow;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('ensureOpencode health probing', () => {
  test('accepts a complete HTTP health response before the socket closes', async () => {
    mkdirSync(join(tempRoot, '.tagma'), { recursive: true });
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls <= 2 ? 0 : 300_001;
    };

    (Bun as BunLike).listen = (() =>
      ({
        port: 45123,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    let resolveExit!: (code: number) => void;
    (Bun as BunLike).spawn = (() =>
      ({
        stdout: closedStream(),
        stderr: closedStream(),
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill() {
          resolveExit(143);
        },
      }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => {
        const socket = {
          write() {
            options.socket.data?.(
              socket as never,
              Buffer.from(
                'HTTP/1.1 200 OK\r\nContent-Length: 36\r\nConnection: keep-alive\r\n\r\n{"healthy":true,"version":"1.14.41"}',
              ),
            );
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await expect(ensureOpencode(join(tempRoot, '.tagma'))).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:45123',
    });
  });
});

describe('OpenCode PATH fallback', () => {
  test('resolves a Windows command shim before passing it to Bun.spawn', () => {
    const shim = 'D:\\tools\\opencode.cmd';
    (Bun as BunLike).which = ((command: string) =>
      command === 'opencode' ? shim : null) as typeof Bun.which;

    expect(resolveOpencodePathFallback()).toBe(shim);
  });
});
