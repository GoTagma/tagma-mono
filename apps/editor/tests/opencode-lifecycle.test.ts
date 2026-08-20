import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPENCODE_STARTUP_READINESS_TIMEOUT_MS,
  ensureOpencode,
  ensureRealTagmaDirectory,
  resolveOpencodePathFallback,
  restartOpencode,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';
import { TAGMA_MANAGED_OPENCODE_TOOL_IDS } from '../server/opencode-managed-tools';

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
const realSetTimeout = globalThis.setTimeout;
const MANAGED_TOOL_IDS_BODY = JSON.stringify(TAGMA_MANAGED_OPENCODE_TOOL_IDS);

let tempRoot: string;
const originalDatabaseStateDir = process.env.TAGMA_OPENCODE_DB_STATE_DIR;
const originalDatabaseSchemaVersion = process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION;

function accelerateHealthProbeTimeouts(): void {
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) => realSetTimeout(handler, timeout === 2_000 ? 10 : timeout, ...args)) as typeof setTimeout;
}

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

function successfulProbeBody(request: string | Uint8Array): string {
  const path = String(request).split(' ')[1] ?? '';
  return path.startsWith('/experimental/tool/ids?')
    ? MANAGED_TOOL_IDS_BODY
    : '{"healthy":true,"version":"1.17.8"}';
}

function successfulProbeResponse(request: string | Uint8Array): Buffer {
  const body = successfulProbeBody(request);
  return Buffer.from(
    `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
  );
}

function respondToHealthyProbe(options: Parameters<typeof Bun.connect>[0]): void {
  const socket = {
    write(request: string | Uint8Array) {
      options.socket.data?.(socket as never, successfulProbeResponse(request));
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
  process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(tempRoot, 'opencode-state');
  process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
});

afterEach(async () => {
  await stopOpencodeProcesses(10);
  (Bun as BunLike).listen = realBun.listen;
  (Bun as BunLike).connect = realBun.connect;
  (Bun as BunLike).spawn = realBun.spawn;
  (Bun as BunLike).which = realBun.which;
  Date.now = realDateNow;
  globalThis.setTimeout = realSetTimeout;
  if (originalDatabaseStateDir === undefined) delete process.env.TAGMA_OPENCODE_DB_STATE_DIR;
  else process.env.TAGMA_OPENCODE_DB_STATE_DIR = originalDatabaseStateDir;
  if (originalDatabaseSchemaVersion === undefined)
    delete process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION;
  else process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = originalDatabaseSchemaVersion;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('managed OpenCode directory coordinates', () => {
  test('returns the native real path when the workspace is opened through an alias', () => {
    const workspace = join(tempRoot, 'workspace');
    const workspaceAlias = join(tempRoot, 'workspace-alias');
    mkdirSync(workspace, { recursive: true });
    symlinkSync(workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');

    const tagmaDirectory = ensureRealTagmaDirectory(workspaceAlias);

    expect(tagmaDirectory).toBe(realpathSync.native(join(workspace, '.tagma')));
  });
});

describe('ensureOpencode health probing', () => {
  test('allows five minutes for first-workspace OpenCode database initialization', () => {
    expect(OPENCODE_STARTUP_READINESS_TIMEOUT_MS).toBe(300_000);
  });

  test('accepts a complete HTTP health response before the socket closes', async () => {
    const cwd = join(tempRoot, 'workspace with spaces 中文', '.tagma');
    mkdirSync(cwd, { recursive: true });
    const requestedPaths: string[] = [];
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
          write(request: string | Uint8Array) {
            requestedPaths.push(String(request).split(' ')[1] ?? '');
            options.socket.data?.(socket as never, successfulProbeResponse(request));
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const handle = await ensureOpencode(cwd);
    expect(handle.baseUrl).toBe('http://127.0.0.1:45123');
    expect(handle.database.schemaVersion).toBe(1);
    expect(
      handle.database.databasePath.startsWith(
        join(tempRoot, 'opencode-state', 'databases', 'schema-v1-'),
      ),
    ).toBe(true);
    expect(handle.database.generationId.startsWith('schema-v1-')).toBe(true);
    expect(requestedPaths).toContain('/global/health');
    expect(requestedPaths).toContain('/session?limit=1');
    const toolRegistryPath = requestedPaths.find((path) =>
      path.startsWith('/experimental/tool/ids?'),
    );
    expect(toolRegistryPath).toBeDefined();
    // ensureOpencode canonicalizes the cwd via realpathSync.native before use, so the
    // registry probe carries the native real path: macOS resolves /var to /private/var
    // and Windows CI expands 8.3 short temp names such as RUNNER~1.
    expect(new URL(toolRegistryPath!, 'http://127.0.0.1').searchParams.get('directory')).toBe(
      realpathSync.native(cwd),
    );
    const active = JSON.parse(
      readFileSync(join(tempRoot, 'opencode-state', 'current-head.json'), 'utf-8'),
    ) as { schemaVersion: number; generationId: string };
    expect(active.schemaVersion).toBe(1);
    expect(active.generationId).toBe(handle.database.generationId);
  });

  test('rejects startup unless the managed tool registry is complete and valid', async () => {
    const scenarios = [
      {
        name: 'module resolution failure',
        status: '500 Internal Server Error',
        body: "Cannot find module '@opencode-ai/plugin'",
        error: /tool registry did not become accessible.*Cannot find module '@opencode-ai\/plugin'/,
      },
      {
        name: 'incomplete registry',
        status: '200 OK',
        body: '["tagma_yaml_skeleton"]',
        error: /missing managed tool ids.*tagma_placement_plan, tagma_trial_plan/,
      },
      {
        name: 'malformed registry response',
        status: '200 OK',
        body: '{not-json',
        error: /tool registry returned invalid JSON/,
      },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const cwd = join(tempRoot, `${index}-${scenario.name} with spaces 中文`, '.tagma');
      mkdirSync(cwd, { recursive: true });
      let killed = false;
      const requestedPaths: string[] = [];

      (Bun as BunLike).listen = (() =>
        ({
          port: 45130 + index,
          stop() {},
        }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
      (Bun as BunLike).spawn = (() =>
        mockOpencodeProcess(() => {
          killed = true;
        })) as typeof Bun.spawn;
      (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
        queueMicrotask(() => {
          const socket = {
            write(request: string | Uint8Array) {
              const path = String(request).split(' ')[1] ?? '';
              requestedPaths.push(path);
              const isToolProbe = path.startsWith('/experimental/tool/ids?');
              const body = isToolProbe ? scenario.body : '[]';
              const status = isToolProbe ? scenario.status : '200 OK';
              options.socket.data?.(
                socket as never,
                Buffer.from(
                  `HTTP/1.1 ${status}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
                ),
              );
            },
            end() {},
          };
          options.socket.open?.(socket as never);
        });
        return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
      }) as typeof Bun.connect;

      await expect(ensureOpencode(cwd)).rejects.toThrow(scenario.error);
      expect(killed).toBe(true);
      expect(requestedPaths).toContain('/global/health');
      expect(requestedPaths).toContain('/session?limit=1');
      expect(requestedPaths.some((path) => path.startsWith('/experimental/tool/ids?'))).toBe(true);
      expect(existsSync(join(tempRoot, 'opencode-state', 'current-head.json'))).toBe(false);
    }
  });

  test('can retry the same cwd after a managed tool registry startup failure', async () => {
    const cwd = join(tempRoot, 'retry same cwd 中文', '.tagma');
    mkdirSync(cwd, { recursive: true });
    let toolRegistryHealthy = false;
    let killed = 0;

    (Bun as BunLike).listen = (() =>
      ({
        port: 45133,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() =>
      mockOpencodeProcess(() => {
        killed += 1;
      })) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => {
        const socket = {
          write(request: string | Uint8Array) {
            const path = String(request).split(' ')[1] ?? '';
            if (path.startsWith('/experimental/tool/ids?') && !toolRegistryHealthy) {
              const body = "Cannot find module '@opencode-ai/plugin'";
              options.socket.data?.(
                socket as never,
                Buffer.from(
                  `HTTP/1.1 500 Internal Server Error\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
                ),
              );
              return;
            }
            options.socket.data?.(socket as never, successfulProbeResponse(request));
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await expect(ensureOpencode(cwd)).rejects.toThrow(/tool registry did not become accessible/);
    expect(killed).toBe(1);
    expect(existsSync(join(tempRoot, 'opencode-state', 'current-head.json'))).toBe(false);

    toolRegistryHealthy = true;
    const handle = await ensureOpencode(cwd);
    expect(handle.cwd).toBe(realpathSync.native(cwd));
    expect(existsSync(join(tempRoot, 'opencode-state', 'current-head.json'))).toBe(true);
  });

  test('closes a timed-out socket before ignoring its late response', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let connectCount = 0;
    let timedOutSocketEndCount = 0;
    let resolveLateData!: () => void;
    const lateData = new Promise<void>((resolve) => {
      resolveLateData = resolve;
    });
    accelerateHealthProbeTimeouts();

    (Bun as BunLike).listen = (() =>
      ({
        port: 45124,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() => mockOpencodeProcess()) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      connectCount += 1;
      if (connectCount === 1) {
        queueMicrotask(() => {
          const socket = {
            write() {
              realSetTimeout(() => {
                options.socket.data?.(
                  socket as never,
                  Buffer.from(
                    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n[]',
                  ),
                );
                resolveLateData();
              }, 20);
            },
            end() {
              timedOutSocketEndCount += 1;
            },
          };
          options.socket.open?.(socket as never);
        });
      } else {
        queueMicrotask(() => respondToHealthyProbe(options));
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await ensureOpencode(cwd);
    await lateData;

    expect(timedOutSocketEndCount).toBe(1);
  });

  test('closes a socket that opens after timeout without sending a stale request', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let connectCount = 0;
    let lateSocketWriteCount = 0;
    let lateSocketEndCount = 0;
    let resolveLateOpen!: () => void;
    const lateOpen = new Promise<void>((resolve) => {
      resolveLateOpen = resolve;
    });
    accelerateHealthProbeTimeouts();

    (Bun as BunLike).listen = (() =>
      ({
        port: 45125,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() => mockOpencodeProcess()) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      connectCount += 1;
      if (connectCount === 1) {
        realSetTimeout(() => {
          const socket = {
            write() {
              lateSocketWriteCount += 1;
            },
            end() {
              lateSocketEndCount += 1;
            },
          };
          options.socket.open?.(socket as never);
          resolveLateOpen();
        }, 20);
      } else {
        queueMicrotask(() => respondToHealthyProbe(options));
      }
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await ensureOpencode(cwd);
    await lateOpen;

    expect(lateSocketWriteCount).toBe(0);
    expect(lateSocketEndCount).toBe(1);
  });

  test('awaits one slow database readiness response instead of abandoning and retrying it', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let databaseProbeCount = 0;

    (Bun as BunLike).listen = (() =>
      ({
        port: 45124,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() => mockOpencodeProcess()) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => {
        const socket = {
          write(request: string | Uint8Array) {
            const path = String(request).split(' ')[1] ?? '';
            const respond = () => {
              options.socket.data?.(socket as never, successfulProbeResponse(request));
            };
            if (path === '/session?limit=1') {
              databaseProbeCount += 1;
              if (databaseProbeCount === 1) {
                setTimeout(respond, 2_100);
                return;
              }
            }
            respond();
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const handle = await ensureOpencode(cwd);

    expect(handle.baseUrl).toBe('http://127.0.0.1:45124');
    expect(databaseProbeCount).toBe(1);
  });

  test('honors an explicit short budget for a hung database probe', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let databaseProbeStarted = false;
    let killed = false;
    Date.now = () => (databaseProbeStarted ? 31_000 : 0);
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        handler,
        timeout !== undefined && timeout >= 3_000 ? 10 : timeout,
        ...args,
      )) as typeof setTimeout;

    (Bun as BunLike).listen = (() =>
      ({
        port: 45124,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() =>
      mockOpencodeProcess(() => {
        killed = true;
      })) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => {
        const socket = {
          write(request: string | Uint8Array) {
            const path = String(request).split(' ')[1] ?? '';
            if (path === '/session?limit=1') {
              databaseProbeStarted = true;
              return;
            }
            options.socket.data?.(socket as never, successfulProbeResponse(request));
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    await expect(ensureOpencode(cwd, { readinessTimeoutMs: 30_000 })).rejects.toThrow(
      'workspace database did not become ready within 30 seconds',
    );
    expect(killed).toBe(true);
  });

  test('uses the five-minute default for a cold database response beyond thirty seconds', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let logicalNow = 0;
    let databaseProbeCount = 0;
    Date.now = () => logicalNow;
    globalThis.setTimeout = ((
      handler: Parameters<typeof setTimeout>[0],
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout !== undefined && timeout >= 60_000) {
        return realSetTimeout(handler, 100, ...args);
      }
      if (timeout !== undefined && timeout >= 30_000) {
        return realSetTimeout(() => {
          logicalNow = 31_000;
          if (typeof handler === 'function') {
            (handler as (...callbackArgs: unknown[]) => void)(...args);
          }
        }, 10);
      }
      return realSetTimeout(handler, timeout, ...args);
    }) as typeof setTimeout;

    (Bun as BunLike).listen = (() =>
      ({
        port: 45124,
        stop() {},
      }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;
    (Bun as BunLike).spawn = (() => mockOpencodeProcess()) as typeof Bun.spawn;
    (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
      queueMicrotask(() => {
        const socket = {
          write(request: string | Uint8Array) {
            const path = String(request).split(' ')[1] ?? '';
            const respond = () => {
              options.socket.data?.(socket as never, successfulProbeResponse(request));
            };
            if (path === '/session?limit=1') {
              databaseProbeCount += 1;
              realSetTimeout(respond, 20);
              return;
            }
            respond();
          },
          end() {},
        };
        options.socket.open?.(socket as never);
      });
      return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
    }) as typeof Bun.connect;

    const handle = await ensureOpencode(cwd);

    expect(handle.baseUrl).toBe('http://127.0.0.1:45124');
    expect(databaseProbeCount).toBe(1);
    expect(OPENCODE_STARTUP_READINESS_TIMEOUT_MS).toBe(300_000);
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
          write(request: string | Uint8Array) {
            options.socket.data?.(socket as never, successfulProbeResponse(request));
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

  test('a killed process aborts the database readiness poller without a stale timeout', async () => {
    const cwd = join(tempRoot, '.tagma');
    mkdirSync(cwd, { recursive: true });
    let databaseProbeCount = 0;
    let resolveExit!: (code: number) => void;
    const staleErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = ((...args: unknown[]) => {
      if (String(args[0]).includes('database readiness failed')) staleErrors.push(String(args[0]));
    }) as typeof console.error;

    try {
      (Bun as BunLike).listen = (() =>
        ({
          port: 45210,
          stop() {},
        }) as unknown as ReturnType<typeof Bun.listen>) as unknown as typeof Bun.listen;

      (Bun as BunLike).spawn = ((_command: unknown) => {
        const proc = {
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
        return proc;
      }) as typeof Bun.spawn;

      (Bun as BunLike).connect = ((options: Parameters<typeof Bun.connect>[0]) => {
        queueMicrotask(() => {
          const socket = {
            write(request: string | Uint8Array) {
              const path = String(request).split(' ')[1] ?? '';
              if (path === '/session?limit=1') {
                databaseProbeCount += 1;
                options.socket.data?.(
                  socket as never,
                  Buffer.from(
                    'HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
                  ),
                );
                return;
              }
              options.socket.data?.(socket as never, successfulProbeResponse(request));
            },
            end() {},
          };
          options.socket.open?.(socket as never);
        });
        return Promise.resolve({} as Awaited<ReturnType<typeof Bun.connect>>);
      }) as typeof Bun.connect;

      // Accelerate the readiness poll interval so post-kill loops are observable
      // quickly instead of waiting out the production 500ms sleep.
      const realSetTimeoutFn = globalThis.setTimeout;
      globalThis.setTimeout = ((
        handler: Parameters<typeof setTimeout>[0],
        timeout?: number,
        ...args: unknown[]
      ) => realSetTimeoutFn(handler, timeout === 500 ? 5 : timeout, ...args)) as typeof setTimeout;

      const start = ensureOpencode(cwd);
      const waitDeadline = Date.now() + 5_000;
      while (databaseProbeCount < 2 && Date.now() < waitDeadline) {
        await new Promise((resolve) => realSetTimeoutFn(resolve, 5));
      }
      expect(databaseProbeCount).toBeGreaterThanOrEqual(2);

      resolveExit(143);

      await expect(start).rejects.toThrow(/exited with code=143/);

      const probesAtExit = databaseProbeCount;
      await new Promise((resolve) => realSetTimeoutFn(resolve, 60));

      expect(databaseProbeCount).toBe(probesAtExit);
      expect(staleErrors).toHaveLength(0);
    } finally {
      console.error = originalConsoleError;
    }
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
