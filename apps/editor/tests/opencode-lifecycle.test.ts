import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureOpencode,
  resolveOpencodePathFallback,
  restartOpencode,
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

function mockOpencodeProcess(onKill?: () => void): ReturnType<typeof Bun.spawn> {
  let resolveExit!: (code: number) => void;
  return {
    pid: undefined,
    stdout: closedStream(),
    stderr: closedStream(),
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
    kill() {
      onKill?.();
      resolveExit(143);
    },
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function respondToHealthyProbe(options: Parameters<typeof Bun.connect>[0]): void {
  const socket = {
    write() {
      options.socket.data?.(
        socket as never,
        Buffer.from(
          'HTTP/1.1 200 OK\r\nContent-Length: 36\r\nConnection: keep-alive\r\n\r\n123456789012345678901234567890123456',
        ),
      );
    },
    end() {},
  };
  options.socket.open?.(socket as never);
}

function respondToFailedProbe(options: Parameters<typeof Bun.connect>[0]): void {
  const socket = {
    write() {
      options.socket.data?.(
        socket as never,
        Buffer.from(
          'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        ),
      );
    },
    end() {},
  };
  options.socket.open?.(socket as never);
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

  test('restart redirects an in-flight health startup to its replacement', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let nextPort = 45124;
    let spawnCount = 0;
    let firstProcessKilled = false;
    const killedSpawns = new Set<number>();
    Date.now = () => (firstProcessKilled ? 300_001 : 0);
    let releaseFirstHealth!: () => void;
    let markFirstProbeReady!: () => void;
    const firstProbeReady = new Promise<void>((resolve) => {
      markFirstProbeReady = resolve;
    });
    let releaseSecondHealth!: () => void;
    let markSecondProbeReady!: () => void;
    const secondProbeReady = new Promise<void>((resolve) => {
      markSecondProbeReady = resolve;
    });

    (Bun as BunLike).listen = (() =>
      ({
        port: nextPort++,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    (Bun as BunLike).spawn = (() => {
      spawnCount += 1;
      const spawnIndex = spawnCount;
      return mockOpencodeProcess(() => {
        killedSpawns.add(spawnIndex);
        if (spawnIndex === 1) firstProcessKilled = true;
      });
    }) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      const port = 'port' in options ? Number(options.port) : Number.NaN;
      const respond = () => {
        if (port === 45124 && firstProcessKilled) {
          respondToFailedProbe(options);
        } else {
          respondToHealthyProbe(options);
        }
      };
      if (port === 45124 && !releaseFirstHealth) {
        releaseFirstHealth = () => queueMicrotask(respond);
        markFirstProbeReady();
      } else if (port === 45125 && !releaseSecondHealth) {
        releaseSecondHealth = () => queueMicrotask(respond);
        markSecondProbeReady();
      } else {
        queueMicrotask(respond);
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const initialStart = ensureOpencode(cwd);
    await firstProbeReady;
    const restart = restartOpencode(cwd);
    releaseFirstHealth();
    await secondProbeReady;
    releaseSecondHealth();

    const [initialResult, restartResult] = await Promise.allSettled([initialStart, restart]);
    expect(initialResult.status).toBe('fulfilled');
    expect(restartResult.status).toBe('fulfilled');
    if (initialResult.status !== 'fulfilled' || restartResult.status !== 'fulfilled') {
      throw new Error('expected both lifecycle requests to resolve to the replacement');
    }
    expect(initialResult.value.baseUrl).toBe('http://127.0.0.1:45125');
    expect(initialResult.value).toBe(restartResult.value);
    expect(await ensureOpencode(cwd)).toBe(restartResult.value);
    expect(spawnCount).toBe(2);
    expect([...killedSpawns]).toEqual([1]);
  });

  test('restart supersedes an ensure that is still selecting its port', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let nextPort = 45126;
    let spawnCount = 0;

    (Bun as BunLike).listen = (() =>
      ({
        port: nextPort++,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    (Bun as BunLike).spawn = (() => {
      spawnCount += 1;
      return mockOpencodeProcess();
    }) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => respondToHealthyProbe(options));
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const initialStart = ensureOpencode(cwd);
    const restart = restartOpencode(cwd);
    const [initialResult, restartResult] = await Promise.allSettled([initialStart, restart]);

    expect(initialResult.status).toBe('fulfilled');
    expect(restartResult.status).toBe('fulfilled');
    if (initialResult.status !== 'fulfilled' || restartResult.status !== 'fulfilled') {
      throw new Error('expected the canceled startup to share the replacement');
    }
    expect(initialResult.value.baseUrl).toBe('http://127.0.0.1:45127');
    expect(initialResult.value).toBe(restartResult.value);
    expect(await ensureOpencode(cwd)).toBe(restartResult.value);
    expect(spawnCount).toBe(1);
  });

  test('ensure and concurrent restarts share the replacement for a healthy process', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let nextPort = 45128;
    let spawnCount = 0;
    const killedSpawns = new Set<number>();
    let releaseReplacementHealth!: () => void;
    let markReplacementProbeReady!: () => void;
    const replacementProbeReady = new Promise<void>((resolve) => {
      markReplacementProbeReady = resolve;
    });

    (Bun as BunLike).listen = (() =>
      ({
        port: nextPort++,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    (Bun as BunLike).spawn = (() => {
      spawnCount += 1;
      const spawnIndex = spawnCount;
      return mockOpencodeProcess(() => killedSpawns.add(spawnIndex));
    }) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      if (spawnCount === 2 && !releaseReplacementHealth) {
        releaseReplacementHealth = () => queueMicrotask(() => respondToHealthyProbe(options));
        markReplacementProbeReady();
      } else {
        queueMicrotask(() => respondToHealthyProbe(options));
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const original = await ensureOpencode(cwd);
    expect(original.baseUrl).toBe('http://127.0.0.1:45128');

    const firstRestart = restartOpencode(cwd);
    const secondRestart = restartOpencode(cwd);
    expect(secondRestart).toBe(firstRestart);
    const concurrentEnsure = ensureOpencode(cwd);
    await replacementProbeReady;
    releaseReplacementHealth();

    const [firstResult, secondResult, ensureResult] = await Promise.all([
      firstRestart,
      secondRestart,
      concurrentEnsure,
    ]);
    expect(firstResult.baseUrl).toBe('http://127.0.0.1:45129');
    expect(secondResult).toBe(firstResult);
    expect(ensureResult).toBe(firstResult);
    expect(await ensureOpencode(cwd)).toBe(firstResult);
    expect(spawnCount).toBe(2);
    expect([...killedSpawns]).toEqual([1]);
  });

  test('a restart queued after replacement spawn advances every caller to the final handle', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let nextPort = 45140;
    let spawnCount = 0;
    const killedSpawns = new Set<number>();
    let releaseIntermediateHealth!: () => void;
    let markIntermediateProbeReady!: () => void;
    const intermediateProbeReady = new Promise<void>((resolve) => {
      markIntermediateProbeReady = resolve;
    });
    let releaseFinalHealth!: () => void;
    let markFinalProbeReady!: () => void;
    const finalProbeReady = new Promise<void>((resolve) => {
      markFinalProbeReady = resolve;
    });

    (Bun as BunLike).listen = (() =>
      ({
        port: nextPort++,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    (Bun as BunLike).spawn = (() => {
      spawnCount += 1;
      const spawnIndex = spawnCount;
      return mockOpencodeProcess(() => killedSpawns.add(spawnIndex));
    }) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      const port = 'port' in options ? Number(options.port) : Number.NaN;
      const respond = () => {
        if (port === 45141 && killedSpawns.has(2)) {
          respondToFailedProbe(options);
        } else {
          respondToHealthyProbe(options);
        }
      };
      if (port === 45141 && !releaseIntermediateHealth) {
        releaseIntermediateHealth = () => queueMicrotask(respond);
        markIntermediateProbeReady();
      } else if (port === 45142 && !releaseFinalHealth) {
        releaseFinalHealth = () => queueMicrotask(respond);
        markFinalProbeReady();
      } else {
        queueMicrotask(respond);
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await ensureOpencode(cwd);
    const firstRestart = restartOpencode(cwd);
    await intermediateProbeReady;

    const secondRestart = restartOpencode(cwd);
    expect(secondRestart).toBe(firstRestart);
    const concurrentEnsure = ensureOpencode(cwd);
    await Promise.resolve();
    releaseIntermediateHealth();

    const nextEvent = await Promise.race([
      finalProbeReady.then(() => 'final-spawned' as const),
      firstRestart.then(() => 'restart-settled' as const),
    ]);
    expect(nextEvent).toBe('final-spawned');
    releaseFinalHealth();

    const [firstResult, secondResult, ensureResult] = await Promise.all([
      firstRestart,
      secondRestart,
      concurrentEnsure,
    ]);
    expect(firstResult.baseUrl).toBe('http://127.0.0.1:45142');
    expect(secondResult).toBe(firstResult);
    expect(ensureResult).toBe(firstResult);
    expect(await ensureOpencode(cwd)).toBe(firstResult);
    expect(spawnCount).toBe(3);
    expect([...killedSpawns]).toEqual([1, 2]);
  });

  test('a stale exit callback cannot detach a newly restarted process', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let nextPort = 45130;
    let spawnCount = 0;
    const onExitCallbacks: Array<() => void> = [];
    let releaseSecondHealth!: () => void;
    let markSecondProbeReady!: () => void;
    const secondProbeReady = new Promise<void>((resolve) => {
      markSecondProbeReady = resolve;
    });

    (Bun as BunLike).listen = (() =>
      ({
        port: nextPort++,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

    (Bun as BunLike).spawn = ((
      _command: unknown,
      options: { onExit?: (...args: unknown[]) => void },
    ) => {
      spawnCount += 1;
      let resolveExit!: (code: number) => void;
      const proc = {
        // Omit a fake Windows pid so lifecycle termination uses this mock's
        // kill() instead of invoking the real taskkill executable.
        pid: undefined,
        stdout: closedStream(),
        stderr: closedStream(),
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
        kill() {
          resolveExit(143);
        },
      } as unknown as ReturnType<typeof Bun.spawn>;
      onExitCallbacks.push(() => options.onExit?.(proc, 143, null, undefined));
      return proc;
    }) as typeof Bun.spawn;

    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      const respond = () => {
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
      };
      if (spawnCount === 2 && !releaseSecondHealth) {
        releaseSecondHealth = () => queueMicrotask(respond);
        markSecondProbeReady();
      } else {
        queueMicrotask(respond);
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await ensureOpencode(cwd);
    const firstRestart = restartOpencode(cwd);
    await secondProbeReady;
    onExitCallbacks[0]();
    releaseSecondHealth();
    await firstRestart;

    await restartOpencode(cwd);
    expect(spawnCount).toBe(3);
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
