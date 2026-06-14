import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeWorkspaceKey } from '@tagma/types/workspace-key';
import {
  discardUserReleaseOverride,
  resolveRuntimePaths,
  type RuntimePaths,
} from './runtime-paths';
import { resolveTrustedLocalOpenPath } from './local-paths';
import {
  buildEditorRenderUrl,
  isAllowedEditorUrl,
  normalizeDevRendererUrl,
  reloadSessionsForRecoveredSidecar,
} from './sidecar-recovery';
import { createSidecarReadyParser } from './sidecar-stdout';

/**
 * Generate a per-session bearer token for the sidecar. The renderer receives
 * it through the URL fragment (which the editor's client.ts strips out of
 * the address bar before persisting to sessionStorage), and every
 * subsequent /api/* request from the renderer carries `Authorization: Bearer
 * <token>`. A random 32-byte hex token is enough to make brute-force not a
 * realistic concern over a loopback bind.
 *
 * In packaged release builds this is on by default — without it, any local
 * process that can reach 127.0.0.1:<port> could hit the editor's filesystem
 * APIs because the existing CORS/Origin checks only protect against browser-
 * driven CSRF, not native processes that can omit the Origin header.
 *
 * In dev (`electron .` without packaging) we leave `TAGMA_AUTH_TOKEN` alone
 * so existing curl-against-loopback workflows keep working unchanged. An
 * operator can still opt in by exporting `TAGMA_AUTH_TOKEN` themselves.
 */
function generateSidecarAuthToken(): string {
  return randomBytes(32).toString('hex');
}

// Pinned release metadata from apps/electron/package.json. Read once at
// startup and forwarded to the sidecar so the Settings panels can show
// "shipped vX / running vY" without the sidecar having to re-read this file
// from a path that changes between dev and packaged layouts.
//
// We forward the entire `tagma` object as a JSON blob so the sidecar (and
// future sidecar versions) can pick up new fields without touching the
// Electron shell. This keeps the main process frozen: adding a new config
// key only requires a sidecar or editor-dist update, not a full installer
// rebuild.
function readTagmaMetadata(): Record<string, unknown> {
  try {
    const pkgPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'package.json')
      : path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { tagma?: Record<string, unknown> };
    return pkg.tagma ?? {};
  } catch {
    return {};
  }
}
const TAGMA_META = readTagmaMetadata();
const DEV_RENDERER_URL = normalizeDevRendererUrl(process.env.TAGMA_DESKTOP_RENDERER_URL);

function applyDevHardwareAccelerationFlag(): void {
  if (app.isPackaged || process.env.TAGMA_DESKTOP_DISABLE_GPU !== '1') return;
  app.disableHardwareAcceleration();
}

function applyDevUserDataDir(): void {
  const userDataDir = process.env.TAGMA_DESKTOP_USER_DATA_DIR?.trim();
  if (app.isPackaged || !userDataDir) return;

  const resolved = path.resolve(userDataDir);
  fs.mkdirSync(resolved, { recursive: true });
  app.setPath('userData', resolved);
}

applyDevHardwareAccelerationFlag();
applyDevUserDataDir();

// Windows GUI apps don't attach a console, so process.stdout writes from the
// Electron main process are invisible to the user. Mirror sidecar stdout and
// stderr to a log file under app.getPath('logs') so a startup crash leaves a
// trace the user (or support) can actually find.
let sidecarLogStream: fs.WriteStream | null = null;
function getSidecarLogStream(): fs.WriteStream | null {
  if (sidecarLogStream) return sidecarLogStream;
  try {
    const logsDir = app.getPath('logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, 'sidecar.log');
    sidecarLogStream = fs.createWriteStream(logPath, { flags: 'a' });
    sidecarLogStream.write(`\n── sidecar session started at ${new Date().toISOString()} ──\n`);
    return sidecarLogStream;
  } catch {
    return null;
  }
}
function logSidecar(prefix: 'stdout' | 'stderr', chunk: Buffer): void {
  const stream = getSidecarLogStream();
  if (!stream) return;
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    stream.write(`${new Date().toISOString()} ${prefix}: ${line}\n`);
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface WindowSession {
  workspacePath: string | null;
  port: number;
  rendererBaseUrl?: string | null;
  win: BrowserWindow;
}

interface SidecarHandle {
  proc: ChildProcess;
  actualPort: number;
  authToken: string | null;
}

// ── State ──────────────────────────────────────────────────────────────────

/** workspace absolute path → session (for dedup) */
const byWorkspace = new Map<string, WindowSession>();

/** BrowserWindow id → session */
const byWindow = new Map<number, WindowSession>();

/**
 * Shared sidecar — one process serves every window via the multi-workspace
 * sidecar (see server/require-workspace.ts). Lazily started on the first
 * `createEditorWindow()` call. Killed once on `before-quit`. The previous
 * one-sidecar-per-window design was the root cause of version/manifest
 * drift across windows; sharing state in a single process eliminates it.
 */
let sharedSidecar: SidecarHandle | null = null;
let sharedSidecarPromise: Promise<SidecarHandle> | null = null;
let recoveringSidecarPromise: Promise<void> | null = null;
let isAppQuitting = false;

function ensureSidecar(): Promise<SidecarHandle> {
  if (sharedSidecar) return Promise.resolve(sharedSidecar);
  if (sharedSidecarPromise) return sharedSidecarPromise;
  sharedSidecarPromise = spawnSidecar()
    .then((handle) => {
      sharedSidecar = handle;
      // If the process dies unexpectedly, drop the cached handle so the next
      // createEditorWindow() call will respawn rather than reusing a dead one.
      handle.proc.on('exit', (code, signal) => handleSharedSidecarExit(handle, code, signal));
      return handle;
    })
    .catch((err) => {
      sharedSidecarPromise = null;
      throw err;
    });
  return sharedSidecarPromise;
}

function sidecarExitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `code ${code}`;
}

function handleSharedSidecarExit(
  handle: SidecarHandle,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const wasShared = sharedSidecar === handle;
  if (wasShared) {
    sharedSidecar = null;
    sharedSidecarPromise = null;
  }
  if (!wasShared || isAppQuitting || byWindow.size === 0) return;

  const detail = `[sidecar] exited after ready (${sidecarExitDetail(
    code,
    signal,
  )}); restarting for ${byWindow.size} open window(s)\n`;
  process.stderr.write(detail);
  logSidecar('stderr', Buffer.from(detail));
  void recoverSidecarForOpenWindows();
}

function recoverSidecarForOpenWindows(): Promise<void> {
  if (recoveringSidecarPromise) return recoveringSidecarPromise;
  recoveringSidecarPromise = ensureSidecar()
    .then((handle) => {
      reloadSessionsForRecoveredSidecar(
        byWindow.values(),
        handle.actualPort,
        handle.authToken,
        (win, port) => installContentSecurityPolicy(win, port),
      );
    })
    .catch((err) => {
      const message = sidecarErrorMessage(err);
      logSidecar('stderr', Buffer.from(`[sidecar] restart failed: ${message}\n`));
      dialog.showErrorBox(
        'Tagma backend stopped',
        `${message}\n\nThe embedded editor backend exited and could not be restarted. ` +
          'Close and reopen Tagma to try again.',
      );
    })
    .finally(() => {
      recoveringSidecarPromise = null;
    });
  return recoveringSidecarPromise;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.focus();
}

function sidecarErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isProcessAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function forceKillProcessTree(proc: ChildProcess): void {
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  if (!isProcessAlive(proc)) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    /* best-effort */
  }
}

function requestSidecarShutdown(handle: SidecarHandle): void {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const headers: Record<string, string> = {};
  if (handle.authToken) headers.Authorization = `Bearer ${handle.authToken}`;
  fetch(`http://127.0.0.1:${handle.actualPort}/api/shutdown`, {
    method: 'POST',
    headers,
    signal: controller.signal,
  })
    .catch(() => {
      /* fallback timer will kill if the sidecar does not exit */
    })
    .finally(() => clearTimeout(timer));
}

function terminateSidecar(handle: SidecarHandle): void {
  requestSidecarShutdown(handle);
  if (process.platform !== 'win32') {
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      /* best-effort */
    }
  }
  const forceTimer = setTimeout(() => forceKillProcessTree(handle.proc), 3000);
  forceTimer.unref?.();
}

function launchSidecar(runtime: RuntimePaths): Promise<SidecarHandle> {
  return new Promise((resolve, reject) => {
    const proc = spawn(runtime.command, runtime.args, {
      cwd: runtime.cwd,
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const killSidecar = () => {
      if (!isProcessAlive(proc)) return;
      if (process.platform === 'win32') {
        forceKillProcessTree(proc);
        return;
      }
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
      forceKillTimer = setTimeout(() => {
        forceKillProcessTree(proc);
      }, 3000);
      forceKillTimer.unref?.();
    };
    const cleanupStartupListeners = (keepOutputLoggers: boolean) => {
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        forceKillTimer = null;
      }
      proc.off('error', onError);
      proc.off('exit', onExit);
      if (!keepOutputLoggers) {
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
      }
    };
    const fail = (err: Error, shouldKill: boolean) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners(false);
      if (shouldKill) killSidecar();
      reject(err);
    };
    const succeed = (actualPort: number) => {
      if (settled) return;
      settled = true;
      cleanupStartupListeners(true);
      const authToken =
        typeof runtime.env.TAGMA_AUTH_TOKEN === 'string' && runtime.env.TAGMA_AUTH_TOKEN.length > 0
          ? runtime.env.TAGMA_AUTH_TOKEN
          : null;
      resolve({ proc, actualPort, authToken });
    };
    const timeout = setTimeout(() => {
      fail(new Error('Sidecar startup timeout (20s)'), true);
    }, 20_000);
    const readyParser = createSidecarReadyParser();

    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[sidecar] ${text}`);
      logSidecar('stdout', chunk);
      const readyPort = readyParser.push(chunk);
      if (!settled && readyPort !== null) {
        succeed(readyPort);
      }
    };

    const onStderr = (chunk: Buffer) => {
      process.stderr.write(`[sidecar:err] ${chunk}`);
      logSidecar('stderr', chunk);
    };

    const onError = (err: Error) => {
      fail(err, false);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      fail(new Error(`Sidecar exited before ready (${detail})`), false);
    };

    proc.stdout!.on('data', onStdout);
    proc.stderr!.on('data', onStderr);
    proc.on('error', onError);
    proc.on('exit', onExit);
  });
}

async function spawnSidecar(): Promise<SidecarHandle> {
  const baseOptions = {
    isPackaged: app.isPackaged,
    compiledDir: __dirname,
    resourcesPath: process.resourcesPath,
    userDataDir: app.getPath('userData'),
    tagmaMetadataJson: JSON.stringify(TAGMA_META),
    appVersion: app.getVersion(),
  } as const;

  // Mint a per-launch bearer token in packaged mode so the sidecar's /api
  // is gated behind something stronger than "the request reached
  // 127.0.0.1". Operators can override by setting TAGMA_AUTH_TOKEN before
  // launch (e.g. when they want the same token across restarts for an
  // automated test harness). Dev mode keeps the previous "no token unless
  // explicitly set" behaviour so curl flows for contributors stay easy.
  const operatorAuthToken =
    typeof process.env.TAGMA_AUTH_TOKEN === 'string' && process.env.TAGMA_AUTH_TOKEN.length > 0
      ? process.env.TAGMA_AUTH_TOKEN
      : null;
  const sessionAuthToken =
    operatorAuthToken ?? (app.isPackaged ? generateSidecarAuthToken() : null);

  const applyAuthToken = (paths: RuntimePaths): RuntimePaths => {
    if (!sessionAuthToken) return paths;
    return {
      ...paths,
      env: { ...paths.env, TAGMA_AUTH_TOKEN: sessionAuthToken },
    };
  };

  const primary = applyAuthToken(resolveRuntimePaths(baseOptions));
  try {
    return await launchSidecar(primary);
  } catch (primaryErr) {
    if (!app.isPackaged || primary.sidecarSource !== 'user' || !baseOptions.userDataDir) {
      throw primaryErr;
    }

    const detail =
      `[sidecar] user-installed override ${primary.sidecarVersion ?? '<unknown>'} failed before ready; ` +
      `falling back to bundled copy. Reason: ${sidecarErrorMessage(primaryErr)}\n`;
    process.stderr.write(detail);
    logSidecar('stderr', Buffer.from(detail));
    discardUserReleaseOverride(baseOptions.userDataDir);

    const fallback = applyAuthToken(
      resolveRuntimePaths({
        ...baseOptions,
        sidecarPreference: 'bundled',
      }),
    );
    try {
      return await launchSidecar(fallback);
    } catch (fallbackErr) {
      throw new Error(
        `User-installed sidecar failed (${sidecarErrorMessage(primaryErr)}); ` +
          `bundled fallback also failed (${sidecarErrorMessage(fallbackErr)})`,
      );
    }
  }
}

/**
 * Fire-and-forget POST to the sidecar telling it the last window bound to
 * `workspacePath` has closed so it can release the associated
 * WorkspaceState. Never throws — if the sidecar is already dead the next
 * ensureSidecar() will spawn a fresh one without the dropped key anyway.
 *
 * When the sidecar is running with bearer auth, every mutating API request
 * (including this one) needs `Authorization: Bearer <token>` — without it
 * the sidecar 401s and never frees the WorkspaceState, leaking the
 * PluginRegistry / file watcher / SSE subscribers for the lifetime of the
 * sidecar process. Pass the token from the SidecarHandle here so the auth-
 * enabled and auth-disabled paths converge on a clean teardown.
 */
function requestWorkspaceDrop(handle: SidecarHandle, workspacePath: string): void {
  const body = JSON.stringify({ workDir: workspacePath });
  // Use the global fetch shipped with Node 18+/Electron 28+. AbortController
  // caps the wait so a stalled sidecar can't pin the window-close callback.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (handle.authToken) headers.Authorization = `Bearer ${handle.authToken}`;
  fetch(`http://127.0.0.1:${handle.actualPort}/api/workspace/drop`, {
    method: 'POST',
    headers,
    body,
    signal: controller.signal,
  })
    .catch(() => {
      /* best-effort */
    })
    .finally(() => clearTimeout(timer));
}

function reportFatalStartupError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  const logStream = getSidecarLogStream();
  if (logStream) {
    logStream.write(`${new Date().toISOString()} fatal: ${stack ?? message}\n`);
  }
  const logsDir = (() => {
    try {
      return app.getPath('logs');
    } catch {
      return '<unknown>';
    }
  })();
  dialog.showErrorBox(
    'Tagma failed to start',
    `${message}\n\nThe embedded editor backend did not come online in time.\n` +
      `Check the sidecar log for details:\n${path.join(logsDir, 'sidecar.log')}`,
  );
}

const cspPorts = new Set<number>();
let cspHandlerInstalled = false;

function isKnownEditorUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      cspPorts.has(Number(parsed.port))
    );
  } catch {
    return false;
  }
}

function editorContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function installContentSecurityPolicy(win: BrowserWindow, port: number): void {
  cspPorts.add(port);
  if (cspHandlerInstalled) return;
  cspHandlerInstalled = true;
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!isKnownEditorUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders ?? {}) };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key];
    }
    responseHeaders['Content-Security-Policy'] = [editorContentSecurityPolicy()];
    callback({ responseHeaders });
  });
}

async function confirmOpenExternal(parent: BrowserWindow | null, parsed: URL): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: ['Open', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Open External Link',
    message: 'Open this link in your browser?',
    detail: parsed.toString(),
  };
  const { response } = await (parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options));
  if (response !== 0) return false;
  await shell.openExternal(parsed.toString());
  return true;
}

function installNavigationGuards(session: WindowSession): void {
  const openExternalFromNavigation = (rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    void confirmOpenExternal(session.win, parsed).catch(() => {
      /* best-effort */
    });
  };

  session.win.webContents.on('will-navigate', (event, rawUrl) => {
    if (isAllowedEditorUrl(rawUrl, session.port, session.rendererBaseUrl)) return;
    event.preventDefault();
    openExternalFromNavigation(rawUrl);
  });
  session.win.webContents.on('will-redirect', (event, rawUrl) => {
    if (isAllowedEditorUrl(rawUrl, session.port, session.rendererBaseUrl)) return;
    event.preventDefault();
  });
  session.win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedEditorUrl(url, session.port, session.rendererBaseUrl)) {
      openExternalFromNavigation(url);
    }
    return { action: 'deny' };
  });
}

function isTrustedIpcSender(event: Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  const session = byWindow.get(win.id);
  if (!session) return false;
  const frameUrl = event.senderFrame?.url;
  return (
    typeof frameUrl === 'string' &&
    isAllowedEditorUrl(frameUrl, session.port, session.rendererBaseUrl)
  );
}

// ── Window creation ────────────────────────────────────────────────────────

async function createEditorWindow(rawWorkspacePath: string | null = null): Promise<WindowSession> {
  // Normalize at the edge so every byWorkspace / session write below uses
  // the same key shape as the server's registry — critical for Windows
  // drive-letter case symmetry (see normalizeWorkspaceKey JSDoc).
  const workspacePath = rawWorkspacePath ? normalizeWorkspaceKey(rawWorkspacePath) : null;

  if (workspacePath) {
    const existing = byWorkspace.get(workspacePath);
    if (existing) {
      focusWindow(existing.win);
      return existing;
    }
  }

  const { actualPort, authToken } = await ensureSidecar();

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: workspacePath ? `Tagma — ${path.basename(workspacePath)}` : 'Tagma',
    // In dev (`electron .`) the host is electron.exe, so the window inherits
    // Electron's default icon. In packaged builds the .exe icon (patched by
    // electron-builder's rcedit pass) is used automatically, so only the dev
    // case needs an explicit override.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '..', 'build', 'icon.png') }),
    // Fully self-drawn chrome: no native title bar, no OS min/max/close buttons,
    // no menu bar. The renderer paints its own title strip + window controls.
    // Same config on every platform by design — the app should look identical
    // on Windows, Linux, and macOS rather than inheriting each OS's widgets.
    frame: false,
    // Avoid the brief white flash before the renderer paints its dark UI.
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles hidden/minimized renderers — timers slow down,
      // network task queues get deferred, and after ~5 minutes the page can
      // freeze entirely. The opencode chat event stream and the editor's
      // /state/events SSE both pump JS callbacks through those queues, so
      // a chat turn that lands while the window is minimized never advances
      // the renderer's `lastSendingEndedAt` and the canvas / sidebar stay
      // stale until the user manually re-triggers a refresh. Disable the
      // throttle so the renderer keeps draining events in the background.
      backgroundThrottling: false,
    },
  });

  // Use Chromium's native zoom factor instead of CSS `html { zoom: 1.5 }`.
  // Newer Chromium reports getBoundingClientRect and event coordinates in the
  // same (zoomed) space, so any manual `/ zoom` division in the renderer
  // double-scales clicks and the hit targets drift ~33% off. Native zoom
  // is transparent to the DOM APIs and fixes the misalignment.
  //
  // Apply the last-known zoom (not a hardcoded 1.2) so a new window inherits
  // whatever the user has set globally. Otherwise "New Window" visually
  // reverts the user's choice.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(lastKnownZoom);
  });

  // Keep the maximized / unmaximized icon in the custom title bar in sync.
  const sendMaximized = (value: boolean) => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized-changed', value);
  };
  win.on('maximize', () => sendMaximized(true));
  win.on('unmaximize', () => sendMaximized(false));

  const session: WindowSession = {
    workspacePath,
    port: actualPort,
    rendererBaseUrl: DEV_RENDERER_URL,
    win,
  };

  if (workspacePath) byWorkspace.set(workspacePath, session);
  byWindow.set(win.id, session);
  installNavigationGuards(session);
  installContentSecurityPolicy(win, actualPort);

  // Thread the pinned workspace to the renderer via a URL query param. The
  // editor store's init() parses `?ws=` and calls setWorkDir(path) on boot
  // so a window opened for a specific workspace lands in it instead of the
  // welcome page. Without this, the workspacePath argument was silently
  // dropped: the dedup branch in byWorkspace.get could only ever fire for
  // calls coming from an already-bound window, which is exactly the
  // scenario that never hits this code path.
  //
  // When the sidecar is running with bearer auth (packaged release builds),
  // forward the token in the URL fragment rather than the query string. The
  // fragment is never sent to the sidecar in the HTTP request line, so it
  // avoids server logs and request history while still letting the SPA read
  // and immediately scrub it into sessionStorage + a SameSite=Strict cookie.
  win.loadURL(buildEditorRenderUrl(actualPort, workspacePath, authToken, DEV_RENDERER_URL));

  win.on('closed', () => {
    byWindow.delete(win.id);
    if (session.workspacePath) {
      const closedPath = session.workspacePath;
      byWorkspace.delete(closedPath);
      // byWorkspace is 1:1 keyed by absolute path (see request-set-work-dir
      // dedup), so a window closing is always the last one for that
      // workspace. Tell the sidecar to release the associated
      // WorkspaceState (PluginRegistry / FileWatcher / SSE subscribers)
      // instead of letting it accumulate for the lifetime of the process.
      if (sharedSidecar) {
        requestWorkspaceDrop(sharedSidecar, closedPath);
      }
    }
    // The sidecar is shared across all windows now — never killed here.
    // before-quit handles the single lifecycle teardown.
  });

  return session;
}

// ── Single-instance lock ────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Double-launching Tagma.exe opens another window at the Welcome page.
    // Per-workspace dedup still applies once the user picks a workspace — see
    // the `request-set-work-dir` IPC handler.
    createEditorWindow().catch((err) => {
      reportFatalStartupError(err);
    });
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Remove the default OS application menu — the renderer paints its own.
  Menu.setApplicationMenu(null);

  createEditorWindow().catch((err) => {
    reportFatalStartupError(err);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createEditorWindow().catch((err) => {
        reportFatalStartupError(err);
      });
    }
  });
});

app.on('window-all-closed', () => {
  // The shared sidecar exists to serve renderer windows. Once the window
  // count hits zero it has no consumer, so kill it on every platform —
  // otherwise on macOS the app stays in the dock with a zero-window state
  // while a live Bun/Node sidecar keeps its file-watcher, manifest cache,
  // and whatever pipeline run session running indefinitely.
  //
  // Clearing the cached handle means a subsequent `activate` (Dock click →
  // createEditorWindow → ensureSidecar) will respawn a fresh sidecar,
  // which is what we want: a new window should see current on-disk state,
  // not a day-old in-memory snapshot.
  if (sharedSidecar) {
    terminateSidecar(sharedSidecar);
    sharedSidecar = null;
    sharedSidecarPromise = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isAppQuitting = true;
  if (sharedSidecar) {
    terminateSidecar(sharedSidecar);
    sharedSidecar = null;
    sharedSidecarPromise = null;
  }
  if (sidecarLogStream) {
    try {
      sidecarLogStream.end();
    } catch {
      /* best-effort */
    }
    sidecarLogStream = null;
  }
});

// ── IPC handlers ───────────────────────────────────────────────────────────

/**
 * Renderer calls this before switching workspace via the API.
 * Returns { action: 'proceed' } or { action: 'focus-other' }.
 */
ipcMain.handle('request-set-work-dir', (event, rawPath: string) => {
  if (!isTrustedIpcSender(event)) {
    throw new Error('IPC sender is not the Tagma editor origin');
  }
  const normalized = normalizeWorkspaceKey(rawPath);
  const existing = byWorkspace.get(normalized);
  const callerWin = BrowserWindow.fromWebContents(event.sender);

  if (existing && callerWin && existing.win.id !== callerWin.id) {
    focusWindow(existing.win);
    return { action: 'focus-other' };
  }

  if (callerWin) {
    const session = byWindow.get(callerWin.id);
    if (session) {
      if (session.workspacePath) byWorkspace.delete(session.workspacePath);
      session.workspacePath = normalized;
      byWorkspace.set(normalized, session);
      callerWin.setTitle(`Tagma — ${path.basename(normalized)}`);
    }
  }

  return { action: 'proceed' };
});

ipcMain.handle('open-new-window', async (event, workspacePath?: string) => {
  if (!isTrustedIpcSender(event)) return false;
  // Normalization happens inside createEditorWindow — pass the raw path
  // through so a single helper owns the case/drive rules.
  await createEditorWindow(workspacePath ?? null);
  return true;
});

// ── Custom window chrome ──────────────────────────────────────────────────
// The renderer paints its own title bar and min/max/close buttons, so these
// IPCs are how those buttons actually drive the native window.

function callerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle('window:minimize', (event) => {
  if (!isTrustedIpcSender(event)) return;
  callerWindow(event)?.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
  if (!isTrustedIpcSender(event)) return false;
  const win = callerWindow(event);
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
});

ipcMain.handle('window:close', (event) => {
  if (!isTrustedIpcSender(event)) return;
  callerWindow(event)?.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  if (!isTrustedIpcSender(event)) return false;
  return callerWindow(event)?.isMaximized() ?? false;
});

// Native zoom factor control. Drives Chromium's real zoom (same channel as
// Ctrl+= in a browser) instead of CSS `zoom`, so DOM coordinate APIs stay
// consistent and click hit-testing doesn't drift.
//
// Zoom is treated as a global preference, like theme: each window loads from
// its own localhost origin so Chromium's per-origin zoom persistence never
// crosses windows. The main process is the only shared context — it holds
// the last-known zoom and fans changes out to every other live window so
// New Window opens at the current zoom and concurrent windows stay in sync.
let lastKnownZoom = 1.2;

ipcMain.handle('window:set-zoom-factor', (event, factor: number) => {
  if (!isTrustedIpcSender(event)) return lastKnownZoom;
  const win = callerWindow(event);
  if (!win) return 1;
  const clamped = Math.max(0.5, Math.min(3, Number.isFinite(factor) ? factor : 1));
  lastKnownZoom = clamped;
  win.webContents.setZoomFactor(clamped);
  for (const { win: peer } of byWindow.values()) {
    if (peer === win) continue;
    if (!peer.isDestroyed()) {
      peer.webContents.setZoomFactor(clamped);
      peer.webContents.send('window:zoom-changed', clamped);
    }
  }
  return clamped;
});

ipcMain.handle('window:get-zoom-factor', (event) => {
  if (!isTrustedIpcSender(event)) return lastKnownZoom;
  return callerWindow(event)?.webContents.getZoomFactor() ?? lastKnownZoom;
});

// Theme sync across windows. Each editor window loads from its own
// http://127.0.0.1:${port} origin, so BroadcastChannel / localStorage never
// cross windows. The main process is the only shared context — it holds the
// last-known theme and fans changes out to every other live window.
type SharedTheme = 'dark' | 'light';
let lastKnownTheme: SharedTheme | null = null;

ipcMain.handle('window:set-theme', (event, theme: unknown) => {
  if (!isTrustedIpcSender(event)) return;
  if (theme !== 'dark' && theme !== 'light') return;
  lastKnownTheme = theme;
  const sender = callerWindow(event);
  for (const { win } of byWindow.values()) {
    if (win === sender) continue;
    if (!win.isDestroyed()) win.webContents.send('window:theme-changed', theme);
  }
});

ipcMain.handle('window:get-theme', (event) => {
  if (!isTrustedIpcSender(event)) return null;
  return lastKnownTheme;
});

// Open an http/https URL in the user's default browser. Used by the provider
// connect dialog for OAuth authorize URLs — a sign-in page must not open
// inside the Electron window (cookies/extensions/password managers live in
// the system browser, and opencode's loopback callback expects a real
// browser to hit it). We deliberately accept only http(s) so a compromised
// renderer can't invoke arbitrary shell handlers (file:, javascript:, …).
ipcMain.handle('shell:open-external', async (event, rawUrl: unknown) => {
  if (!isTrustedIpcSender(event)) return false;
  if (typeof rawUrl !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return confirmOpenExternal(callerWindow(event), parsed);
});

// Open a local file in the OS default app. This stays separate from
// shell:open-external so workspace files and internet URLs keep distinct
// validation rules.
ipcMain.handle('shell:open-local-path', async (event, rawPath: unknown) => {
  if (!isTrustedIpcSender(event)) return false;
  const win = callerWindow(event);
  const session = win ? byWindow.get(win.id) : null;
  const target = resolveTrustedLocalOpenPath(session?.workspacePath, rawPath);
  if (!target) return false;
  const error = await shell.openPath(target);
  return error.length === 0;
});
