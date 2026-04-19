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

  /** Open an additional editor window, optionally targeting a workspace. */
  openNewWindow: (workspacePath?: string) =>
    ipcRenderer.invoke('open-new-window', workspacePath),

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
  setZoomFactor: (factor: number) =>
    ipcRenderer.invoke('window:set-zoom-factor', factor),
  getZoomFactor: () => ipcRenderer.invoke('window:get-zoom-factor'),
});
