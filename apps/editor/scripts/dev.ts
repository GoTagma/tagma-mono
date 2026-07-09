import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(scriptDir, '..');

type Subprocess = ReturnType<typeof Bun.spawn>;
type EditorDevScript = 'ensure:opencode' | 'dev:server:watch' | 'dev:client';

export type WaitForTcpPortOptions = {
  host: string;
  port: number;
  timeoutMs?: number;
  intervalMs?: number;
  connectTimeoutMs?: number;
};

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function serverReadyHost(): string {
  const host = process.env.HOST ?? '127.0.0.1';
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

function connectOnce(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = connect({ host, port });
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) rejectConnect(err);
      else resolveConnect();
    };

    const timer = setTimeout(() => {
      finish(new Error(`connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => finish());
    socket.once('error', (err) => finish(err));
  });
}

export async function waitForTcpPort({
  host,
  port,
  timeoutMs = 60_000,
  intervalMs = 250,
  connectTimeoutMs = 1_000,
}: WaitForTcpPortOptions): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await connectOnce(host, port, connectTimeoutMs);
      return;
    } catch (err) {
      lastError = err;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }

  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${host}:${port}.${suffix}`);
}

function nodeExecPath(): string {
  return process.env.NODE ?? 'node';
}

export function viteCliPath(): string {
  return resolve(editorRoot, 'node_modules', 'vite', 'bin', 'vite.js');
}

export function editorDevScriptArgs(script: EditorDevScript): string[] {
  switch (script) {
    case 'ensure:opencode':
      return [process.execPath, '../electron/scripts/fetch-opencode.mjs'];
    case 'dev:server:watch':
      return [process.execPath, '--watch', 'server/index.ts'];
    case 'dev:client':
      return [nodeExecPath(), viteCliPath()];
  }
}

function spawnEditorDevScript(script: EditorDevScript): Subprocess {
  return Bun.spawn(editorDevScriptArgs(script), {
    cwd: editorRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  });
}

async function runEditorDevScript(script: EditorDevScript): Promise<void> {
  const child = spawnEditorDevScript(script);
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`[dev] ${script} exited with code ${code}`);
  }
}

export function windowsTaskkillArgs(pid: number, force: boolean): string[] {
  return [...(force ? ['/F'] : []), '/T', '/PID', String(pid)];
}

function killSubprocess(child: Subprocess, force: boolean): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      Bun.spawnSync(['taskkill', ...windowsTaskkillArgs(child.pid, force)], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    } catch {
      /* already exited */
    }
    return;
  }

  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* already exited */
  }
}

async function stopChildren(children: Set<Subprocess>): Promise<void> {
  const snapshot = [...children];
  for (const child of snapshot) {
    killSubprocess(child, false);
  }

  await Promise.race([Promise.allSettled(snapshot.map((child) => child.exited)), delay(5_000)]);

  for (const child of snapshot) {
    killSubprocess(child, true);
  }
}

function killTrackedChildrenSync(children: Set<Subprocess>): void {
  for (const child of [...children]) {
    killSubprocess(child, true);
  }
}

const DEV_EXIT_SIGNALS = new Map<NodeJS.Signals, number>([
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGBREAK', 131],
  ['SIGHUP', 129],
]);

function installDevExitHandlers(
  children: Set<Subprocess>,
  stopAndExit: (code: number) => Promise<void>,
): () => void {
  const onExit = () => {
    killTrackedChildrenSync(children);
  };
  process.once('exit', onExit);

  const signalHandlers = [...DEV_EXIT_SIGNALS].map(([signal, code]) => {
    const handler = () => void stopAndExit(code);
    process.once(signal, handler);
    return { signal, handler };
  });

  return () => {
    process.off('exit', onExit);
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
  };
}

export async function runDev(): Promise<void> {
  const host = serverReadyHost();
  const port = positiveIntFromEnv('PORT', 3001);
  const readyTimeoutMs = positiveIntFromEnv('TAGMA_DEV_READY_TIMEOUT_MS', 60_000);
  const children = new Set<Subprocess>();
  let stopping = false;

  const track = (child: Subprocess) => {
    children.add(child);
    child.exited.finally(() => children.delete(child));
    return child;
  };

  const stopAndExit = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await stopChildren(children);
    process.exit(code);
  };

  const uninstallExitHandlers = installDevExitHandlers(children, stopAndExit);

  try {
    await runEditorDevScript('ensure:opencode');

    const server = track(spawnEditorDevScript('dev:server:watch'));
    const serverExit = server.exited.then((code) => ({ name: 'server', code }));

    const readyOrExit = await Promise.race([
      waitForTcpPort({ host, port, timeoutMs: readyTimeoutMs }).then(() => ({
        name: 'ready',
        code: 0,
      })),
      serverExit,
    ]);

    if (readyOrExit.name !== 'ready') {
      throw new Error(
        `[dev] server exited before listening on ${host}:${port} with code ${readyOrExit.code}`,
      );
    }

    console.log(`[dev] server ready on http://${host}:${port}; starting Vite client`);

    const client = track(spawnEditorDevScript('dev:client'));
    const clientExit = client.exited.then((code) => ({ name: 'client', code }));
    const exit = await Promise.race([serverExit, clientExit]);
    if (stopping) return;

    if (exit.code !== 0) {
      throw new Error(`[dev] ${exit.name} exited with code ${exit.code}`);
    }
  } finally {
    uninstallExitHandlers();
    if (!stopping) {
      stopping = true;
      await stopChildren(children);
    }
  }
}

if (import.meta.main) {
  runDev().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
