import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Ask the main process whether it's safe to switch to this workspace.
   * Returns { action: 'proceed' } or { action: 'focus-other' }.
   * If 'focus-other', the main process has already focused the existing window
   * and the renderer should abort the workspace switch.
   */
  requestSetWorkDir: (workspacePath: string) =>
    ipcRenderer.invoke('request-set-work-dir', workspacePath),

  /** Commit a workspace switch after the sidecar accepted it. */
  commitSetWorkDir: (workspacePath: string) =>
    ipcRenderer.invoke('commit-set-work-dir', workspacePath),

  /** Open an additional editor window, optionally targeting a workspace. */
  openNewWindow: (workspacePath?: string) => ipcRenderer.invoke('open-new-window', workspacePath),

  // ── Custom window chrome ────────────────────────────────────────────────
  // The renderer paints its own title bar and min/max/close buttons; these
  // forward the button clicks into the main-process BrowserWindow.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onMaximizedChanged: (listener: (isMaximized: boolean) => void) => {
    const handler = (_: unknown, value: boolean) => listener(value);
    ipcRenderer.on('window:maximized-changed', handler);
    return () => {
      ipcRenderer.removeListener('window:maximized-changed', handler);
    };
  },

  // Native Chromium zoom factor (not CSS `zoom`). Transparent to DOM
  // coordinate APIs — used by ZoomControls so +/- doesn't re-introduce
  // click-offset bugs.
  setZoomFactor: (factor: number) => ipcRenderer.invoke('window:set-zoom-factor', factor),
  getZoomFactor: () => ipcRenderer.invoke('window:get-zoom-factor'),
  onZoomChanged: (listener: (factor: number) => void) => {
    const handler = (_: unknown, factor: number) => listener(factor);
    ipcRenderer.on('window:zoom-changed', handler);
    return () => {
      ipcRenderer.removeListener('window:zoom-changed', handler);
    };
  },

  // Cross-window theme sync. Each editor window runs on its own localhost
  // port, so BroadcastChannel can't reach siblings — the main process fans
  // out the change instead.
  setTheme: (theme: 'dark' | 'light') => ipcRenderer.invoke('window:set-theme', theme),
  getTheme: () => ipcRenderer.invoke('window:get-theme'),
  onThemeChanged: (listener: (theme: 'dark' | 'light') => void) => {
    const handler = (_: unknown, theme: 'dark' | 'light') => listener(theme);
    ipcRenderer.on('window:theme-changed', handler);
    return () => {
      ipcRenderer.removeListener('window:theme-changed', handler);
    };
  },

  // Open an http/https URL in the user's default browser. The main-process
  // handler validates the protocol — see main.ts.
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

  // Open a local file from the active workspace in the OS default app.
  openLocalPath: (path: string) => ipcRenderer.invoke('shell:open-local-path', path),
});
