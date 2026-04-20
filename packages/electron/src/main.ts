import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveRuntimePaths } from './runtime-paths';

// Pinned release metadata from packages/electron/package.json. Read once at
// startup and forwarded to the sidecar so the Settings panels can show
// "shipped vX / running vY" without the sidecar having to re-read this file
// from a path that changes between dev and packaged layouts. Returned fields:
//   - bundledOpencodeVersion → OpenCode CLI section
//   - channel + updateManifestBaseUrl → Editor hot-update section. Both come
//     from `tagma.*` in package.json; channel is bumped by CI during the
//     cut-tag job, base URL is a static config pointing at tagma-web.
interface PackagedTagmaMetadata {
  bundledOpencodeVersion?: string;
  channel?: string;
  updateManifestBaseUrl?: string;
}
function readTagmaMetadata(): PackagedTagmaMetadata {
  try {
    const pkgPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar', 'package.json')
      : path.join(__dirname, '..', 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as {
      tagma?: {
        bundledOpencodeVersion?: unknown;
        channel?: unknown;
        updateManifestBaseUrl?: unknown;
      };
    };
    const t = pkg.tagma ?? {};
    return {
      bundledOpencodeVersion:
        typeof t.bundledOpencodeVersion === 'string' && t.bundledOpencodeVersion
          ? t.bundledOpencodeVersion
          : undefined,
      channel: typeof t.channel === 'string' && t.channel ? t.channel : undefined,
      updateManifestBaseUrl:
        typeof t.updateManifestBaseUrl === 'string' && t.updateManifestBaseUrl
          ? t.updateManifestBaseUrl
          : undefined,
    };
  } catch {
    return {};
  }
}
const TAGMA_META = readTagmaMetadata();
const BUNDLED_OPENCODE_VERSION = TAGMA_META.bundledOpencodeVersion;
const EDITOR_UPDATE_CHANNEL = TAGMA_META.channel;
const EDITOR_UPDATE_MANIFEST_BASE_URL = TAGMA_META.updateManifestBaseUrl;

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
    sidecarLogStream.write(
      `\n── sidecar session started at ${new Date().toISOString()} ──\n`,
    );
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
  serverProcess: ChildProcess;
  win: BrowserWindow;
}

// ── State ──────────────────────────────────────────────────────────────────

/** workspace absolute path → session (for dedup) */
const byWorkspace = new Map<string, WindowSession>();

/** BrowserWindow id → session */
const byWindow = new Map<number, WindowSession>();

// ── Helpers ────────────────────────────────────────────────────────────────

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.focus();
}

function spawnSidecar(): Promise<{ proc: ChildProcess; actualPort: number }> {
  return new Promise((resolve, reject) => {
    const runtime = resolveRuntimePaths({
      isPackaged: app.isPackaged,
      compiledDir: __dirname,
      resourcesPath: process.resourcesPath,
      userDataDir: app.getPath('userData'),
      bundledOpencodeVersion: BUNDLED_OPENCODE_VERSION,
      // Editor hot-update context: the installer's own version is the
      // baseline editor-dist version (tier A: desktop release = editor
      // release), plus the channel + manifest base URL the sidecar polls.
      editorVersion: app.getVersion(),
      editorUpdateChannel: EDITOR_UPDATE_CHANNEL,
      editorUpdateManifestBaseUrl: EDITOR_UPDATE_MANIFEST_BASE_URL,
    });

    const proc = spawn(runtime.command, runtime.args, {
      cwd: runtime.cwd,
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) reject(new Error('Sidecar startup timeout (20s)'));
    }, 20_000);

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[sidecar] ${text}`);
      logSidecar('stdout', chunk);
      if (!ready) {
        const m = text.match(/TAGMA_READY port=(\d+)/);
        if (m) {
          ready = true;
          clearTimeout(timeout);
          resolve({ proc, actualPort: parseInt(m[1], 10) });
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`[sidecar:err] ${chunk}`);
      logSidecar('stderr', chunk);
    });

    proc.on('error', (err) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    proc.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timeout);
        reject(new Error(`Sidecar exited before ready (code ${code})`));
      }
    });
  });
}

function reportFatalStartupError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : null;
  const logStream = getSidecarLogStream();
  if (logStream) {
    logStream.write(
      `${new Date().toISOString()} fatal: ${stack ?? message}\n`,
    );
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

// ── Window creation ────────────────────────────────────────────────────────

async function createEditorWindow(workspacePath: string | null = null): Promise<WindowSession> {
  if (workspacePath) {
    const existing = byWorkspace.get(workspacePath);
    if (existing) {
      focusWindow(existing.win);
      return existing;
    }
  }

  const { proc, actualPort } = await spawnSidecar();

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
    ...(app.isPackaged
      ? {}
      : { icon: path.join(__dirname, '..', 'build', 'icon.png') }),
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
    },
  });

  // Use Chromium's native zoom factor instead of CSS `html { zoom: 1.5 }`.
  // Newer Chromium reports getBoundingClientRect and event coordinates in the
  // same (zoomed) space, so any manual `/ zoom` division in the renderer
  // double-scales clicks and the hit targets drift ~33% off. Native zoom
  // is transparent to the DOM APIs and fixes the misalignment.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1.5);
  });

  // Keep the maximized / unmaximized icon in the custom title bar in sync.
  const sendMaximized = (value: boolean) => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized-changed', value);
  };
  win.on('maximize', () => sendMaximized(true));
  win.on('unmaximize', () => sendMaximized(false));

  const session: WindowSession = { workspacePath, port: actualPort, serverProcess: proc, win };

  if (workspacePath) byWorkspace.set(workspacePath, session);
  byWindow.set(win.id, session);

  win.loadURL(`http://127.0.0.1:${actualPort}/`);

  win.on('closed', () => {
    byWindow.delete(win.id);
    if (session.workspacePath) byWorkspace.delete(session.workspacePath);
    proc.kill('SIGTERM');
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const { serverProcess } of byWindow.values()) {
    serverProcess.kill('SIGTERM');
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
  const normalized = path.resolve(rawPath);
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

ipcMain.handle('open-new-window', async (_event, workspacePath?: string) => {
  await createEditorWindow(workspacePath ? path.resolve(workspacePath) : null);
});

// ── Custom window chrome ──────────────────────────────────────────────────
// The renderer paints its own title bar and min/max/close buttons, so these
// IPCs are how those buttons actually drive the native window.

function callerWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

ipcMain.handle('window:minimize', (event) => {
  callerWindow(event)?.minimize();
});

ipcMain.handle('window:toggle-maximize', (event) => {
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
  callerWindow(event)?.close();
});

ipcMain.handle('window:is-maximized', (event) => {
  return callerWindow(event)?.isMaximized() ?? false;
});

// Native zoom factor control. Drives Chromium's real zoom (same channel as
// Ctrl+= in a browser) instead of CSS `zoom`, so DOM coordinate APIs stay
// consistent and click hit-testing doesn't drift.
ipcMain.handle('window:set-zoom-factor', (event, factor: number) => {
  const win = callerWindow(event);
  if (!win) return 1;
  const clamped = Math.max(0.5, Math.min(3, Number.isFinite(factor) ? factor : 1));
  win.webContents.setZoomFactor(clamped);
  return clamped;
});

ipcMain.handle('window:get-zoom-factor', (event) => {
  return callerWindow(event)?.webContents.getZoomFactor() ?? 1;
});
