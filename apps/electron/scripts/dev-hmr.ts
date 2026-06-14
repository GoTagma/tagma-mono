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
const SIDECAR_PORT = 3001;

type Subprocess = ReturnType<typeof Bun.spawn>;

export function desktopHmrRendererUrl(): string {
  return `http://${RENDERER_HOST}:${RENDERER_PORT}/`;
}

export function desktopHmrSidecarPort(base: NodeJS.ProcessEnv = process.env): number {
  const configured = base.TAGMA_DESKTOP_SIDECAR_PORT?.trim();
  const port = configured ? Number(configured) : SIDECAR_PORT;
  return Number.isInteger(port) && port > 0 ? port : SIDECAR_PORT;
}

export function desktopHmrUserDataDir(): string {
  return resolve(electronRoot, '.tmp', 'desktop-hmr-user-data');
}

export function buildDesktopHmrEnv(
  base: NodeJS.ProcessEnv = process.env,
  sidecarPort: number = desktopHmrSidecarPort(base),
): NodeJS.ProcessEnv {
  return {
    ...base,
    TAGMA_DESKTOP_RENDERER_URL: desktopHmrRendererUrl(),
    TAGMA_DESKTOP_SIDECAR_PORT: String(sidecarPort),
    TAGMA_DESKTOP_USER_DATA_DIR: desktopHmrUserDataDir(),
    TAGMA_DESKTOP_DISABLE_GPU: '1',
  };
}

export type AssertTcpPortAvailableOptions = {
  host: string;
  port: number;
  label: string;
};

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

export async function assertTcpPortAvailable({
  host,
  port,
  label,
}: AssertTcpPortAvailableOptions): Promise<void> {
  try {
    const server = await listenOnTcpPort(host, port);
    await closeServer(server);
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'code' in err ? ` (${String(err.code)})` : '';
    throw new Error(
      `[desktop:hmr] ${label} port ${host}:${port} is already unavailable${message}. Stop the existing dev process and retry.`,
    );
  }
}

export type SelectAvailableTcpPortOptions = {
  host: string;
  preferredPort: number;
};

export async function selectAvailableTcpPort({
  host,
  preferredPort,
}: SelectAvailableTcpPortOptions): Promise<number> {
  try {
    const preferred = await listenOnTcpPort(host, preferredPort);
    await closeServer(preferred);
    return preferredPort;
  } catch {
    const fallback = await listenOnTcpPort(host, 0);
    const address = fallback.address();
    await closeServer(fallback);

    if (!address || typeof address === 'string') {
      throw new Error('[desktop:hmr] Failed to allocate a fallback sidecar port.');
    }

    return address.port;
  }
}

async function stopChildren(children: Set<Subprocess>): Promise<void> {
  const snapshot = [...children];
  for (const child of snapshot) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }

  await Promise.race([Promise.allSettled(snapshot.map((child) => child.exited)), delay(5_000)]);

  for (const child of snapshot) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
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
    await assertTcpPortAvailable({
      host: RENDERER_HOST,
      port: RENDERER_PORT,
      label: 'Vite renderer',
    });
    const preferredSidecarPort = desktopHmrSidecarPort();
    const sidecarPort = await selectAvailableTcpPort({
      host: RENDERER_HOST,
      preferredPort: preferredSidecarPort,
    });
    if (sidecarPort !== preferredSidecarPort) {
      console.warn(
        `[desktop:hmr] editor sidecar port ${preferredSidecarPort} is unavailable; using ${sidecarPort}.`,
      );
    }
    const hmrEnv = buildDesktopHmrEnv(process.env, sidecarPort);

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
        port: RENDERER_PORT,
        timeoutMs: 60_000,
        intervalMs: 250,
        connectTimeoutMs: 1_000,
      }).then(() => ({ name: 'ready', code: 0 })),
      viteExit,
    ]);

    if (readyOrExit.name !== 'ready') {
      throw new Error(
        `[desktop:hmr] Vite exited before listening on ${desktopHmrRendererUrl()} with code ${readyOrExit.code}`,
      );
    }

    console.log(
      `[desktop:hmr] Vite ready at ${desktopHmrRendererUrl()}; starting Electron with sidecar port ${sidecarPort}`,
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
