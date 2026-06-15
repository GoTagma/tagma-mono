import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForTcpPort } from '../../editor/scripts/dev';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronRoot = resolve(scriptDir, '..');
const editorRoot = resolve(electronRoot, '..', 'editor');

const RENDERER_HOST = '127.0.0.1';
const RENDERER_PORT = 5173;
const RENDERER_PORT_FALLBACK_END = 5183;
const SIDECAR_PORT = 3001;

type Subprocess = ReturnType<typeof Bun.spawn>;

export function desktopHmrRendererUrl(port: number = RENDERER_PORT): string {
  return `http://${RENDERER_HOST}:${port}/`;
}

export function desktopHmrSidecarPort(base: NodeJS.ProcessEnv = process.env): number {
  const configured = base.TAGMA_DESKTOP_SIDECAR_PORT?.trim();
  const port = configured ? Number(configured) : SIDECAR_PORT;
  return Number.isInteger(port) && port > 0 ? port : SIDECAR_PORT;
}

export function desktopHmrUserDataDir(runId: string | number = process.pid): string {
  return resolve(electronRoot, '.tmp', 'desktop-hmr-user-data', String(runId));
}

export function buildDesktopHmrEnv(
  base: NodeJS.ProcessEnv = process.env,
  sidecarPort: number = desktopHmrSidecarPort(base),
  rendererPort: number = RENDERER_PORT,
): NodeJS.ProcessEnv {
  return {
    ...base,
    TAGMA_DESKTOP_RENDERER_URL: desktopHmrRendererUrl(rendererPort),
    TAGMA_DESKTOP_RENDERER_PORT: String(rendererPort),
    TAGMA_DESKTOP_SIDECAR_PORT: String(sidecarPort),
    TAGMA_DESKTOP_USER_DATA_DIR: desktopHmrUserDataDir(),
    TAGMA_DESKTOP_DISABLE_GPU: '1',
    TAGMA_DESKTOP_HMR: '1',
  };
}

function listenOnTcpPort(host: string, port: number): Promise<ReturnType<typeof createServer>> {
  const server = createServer();

  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen({ host, port }, () => resolveListen(server));
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
}

async function trySelectTcpPort(host: string, port: number): Promise<number | null> {
  try {
    const server = await listenOnTcpPort(host, port);
    const address = server.address();
    await closeServer(server);
    return !address || typeof address === 'string' ? port : address.port;
  } catch {
    return null;
  }
}

export type SelectAvailableTcpPortOptions = {
  host: string;
  preferredPort: number;
  fallbackPortEnd?: number;
  label?: string;
};

export async function selectAvailableTcpPort({
  host,
  preferredPort,
  fallbackPortEnd,
  label = 'TCP',
}: SelectAvailableTcpPortOptions): Promise<number> {
  const preferred = await trySelectTcpPort(host, preferredPort);
  if (preferred !== null) return preferred;

  if (fallbackPortEnd !== undefined) {
    for (let port = preferredPort + 1; port <= fallbackPortEnd; port += 1) {
      const selected = await trySelectTcpPort(host, port);
      if (selected !== null) return selected;
    }

    throw new Error(
      `[desktop:hmr] No available ${label} port from ${host}:${preferredPort} through ${host}:${fallbackPortEnd}.`,
    );
  }

  const fallback = await trySelectTcpPort(host, 0);
  if (fallback !== null) return fallback;

  throw new Error(`[desktop:hmr] Failed to allocate a fallback ${label} port.`);
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

export async function runDesktopHmr(): Promise<void> {
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

  process.once('SIGINT', () => void stopAndExit(130));
  process.once('SIGTERM', () => void stopAndExit(143));

  try {
    const rendererPort = await selectAvailableTcpPort({
      host: RENDERER_HOST,
      preferredPort: RENDERER_PORT,
      fallbackPortEnd: RENDERER_PORT_FALLBACK_END,
      label: 'Vite renderer',
    });
    if (rendererPort !== RENDERER_PORT) {
      console.warn(
        `[desktop:hmr] Vite renderer port ${RENDERER_PORT} is unavailable; using ${rendererPort}.`,
      );
    }
    const preferredSidecarPort = desktopHmrSidecarPort();
    const sidecarPort = await selectAvailableTcpPort({
      host: RENDERER_HOST,
      preferredPort: preferredSidecarPort,
      label: 'editor sidecar',
    });
    if (sidecarPort !== preferredSidecarPort) {
      console.warn(
        `[desktop:hmr] editor sidecar port ${preferredSidecarPort} is unavailable; using ${sidecarPort}.`,
      );
    }
    const rendererUrl = desktopHmrRendererUrl(rendererPort);
    const hmrEnv = buildDesktopHmrEnv(process.env, sidecarPort, rendererPort);

    const vite = track(
      Bun.spawn([process.execPath, 'run', 'dev:client:desktop'], {
        cwd: editorRoot,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: hmrEnv,
      }),
    );
    const viteExit = vite.exited.then((code) => ({ name: 'vite', code }));

    const readyOrExit = await Promise.race([
      waitForTcpPort({
        host: RENDERER_HOST,
        port: rendererPort,
        timeoutMs: 60_000,
        intervalMs: 250,
        connectTimeoutMs: 1_000,
      }).then(() => ({ name: 'ready', code: 0 })),
      viteExit,
    ]);

    if (readyOrExit.name !== 'ready') {
      throw new Error(
        `[desktop:hmr] Vite exited before listening on ${rendererUrl} with code ${readyOrExit.code}`,
      );
    }

    console.log(
      `[desktop:hmr] Vite ready at ${rendererUrl}; starting Electron with sidecar port ${sidecarPort}`,
    );

    const electron = track(
      Bun.spawn([process.execPath, 'run', 'start'], {
        cwd: electronRoot,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: hmrEnv,
      }),
    );
    const electronExit = electron.exited.then((code) => ({ name: 'electron', code }));
    const exit = await Promise.race([viteExit, electronExit]);

    if (exit.code !== 0) {
      throw new Error(`[desktop:hmr] ${exit.name} exited with code ${exit.code}`);
    }
  } finally {
    if (!stopping) {
      stopping = true;
      await stopChildren(children);
    }
  }
}

if (import.meta.main) {
  runDesktopHmr().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
