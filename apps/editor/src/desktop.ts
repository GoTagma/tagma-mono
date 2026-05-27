export type DesktopWorkspaceAction = 'proceed' | 'focus-other';

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}

// All fields are optional because hot-updates only replace the editor bundle,
// not preload.ts. A new bundle running against an older Electron shell will
// see missing methods — every wrapper below must handle that by no-opping
// instead of throwing, or a single call into a missing method at module load
// (e.g. initThemeEarly → getTheme) blanks the whole window.
export interface DesktopBridge {
  requestSetWorkDir?: (workspacePath: string) => Promise<{ action: DesktopWorkspaceAction }>;
  openNewWindow?: (workspacePath?: string) => Promise<void>;
  minimizeWindow?: () => Promise<void>;
  toggleMaximizeWindow?: () => Promise<boolean>;
  closeWindow?: () => Promise<void>;
  isWindowMaximized?: () => Promise<boolean>;
  onMaximizedChanged?: (listener: (isMaximized: boolean) => void) => () => void;
  setZoomFactor?: (factor: number) => Promise<number>;
  getZoomFactor?: () => Promise<number>;
  onZoomChanged?: (listener: (factor: number) => void) => () => void;
  setTheme?: (theme: 'dark' | 'light') => Promise<void>;
  getTheme?: () => Promise<'dark' | 'light' | null>;
  onThemeChanged?: (listener: (theme: 'dark' | 'light') => void) => () => void;
  openExternal?: (url: string) => Promise<boolean>;
  openLocalPath?: (path: string) => Promise<boolean>;
}

function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI ?? null;
}

export function hasDesktopBridge(): boolean {
  return getDesktopBridge() !== null;
}

export async function requestWorkspaceSwitch(
  workspacePath: string,
): Promise<DesktopWorkspaceAction> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.requestSetWorkDir !== 'function') return 'proceed';
  const result = await bridge.requestSetWorkDir(workspacePath);
  return result?.action === 'focus-other' ? 'focus-other' : 'proceed';
}

export async function openDesktopWindow(workspacePath?: string): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.openNewWindow !== 'function') return false;
  await bridge.openNewWindow(workspacePath);
  return true;
}

export function minimizeDesktopWindow(): void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.minimizeWindow !== 'function') return;
  void bridge.minimizeWindow();
}

export async function toggleMaximizeDesktopWindow(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.toggleMaximizeWindow !== 'function') return false;
  return bridge.toggleMaximizeWindow();
}

export function closeDesktopWindow(): void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.closeWindow !== 'function') return;
  void bridge.closeWindow();
}

export async function isDesktopWindowMaximized(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.isWindowMaximized !== 'function') return false;
  return bridge.isWindowMaximized();
}

export function subscribeMaximizedChanged(listener: (isMaximized: boolean) => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onMaximizedChanged !== 'function') return () => {};
  return bridge.onMaximizedChanged(listener);
}

export async function setDesktopZoomFactor(factor: number): Promise<number | null> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.setZoomFactor !== 'function') return null;
  return bridge.setZoomFactor(factor);
}

export async function getDesktopZoomFactor(): Promise<number | null> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getZoomFactor !== 'function') return null;
  return bridge.getZoomFactor();
}

export function subscribeDesktopZoom(listener: (factor: number) => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onZoomChanged !== 'function') return () => {};
  return bridge.onZoomChanged(listener);
}

export function setDesktopTheme(theme: 'dark' | 'light'): void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.setTheme !== 'function') return;
  void bridge.setTheme(theme);
}

export async function getDesktopTheme(): Promise<'dark' | 'light' | null> {
  const bridge = getDesktopBridge();
  if (typeof bridge?.getTheme !== 'function') return null;
  return bridge.getTheme();
}

export function subscribeDesktopTheme(listener: (theme: 'dark' | 'light') => void): () => void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.onThemeChanged !== 'function') return () => {};
  return bridge.onThemeChanged(listener);
}

/**
 * Open `url` in the user's default browser. In a packaged desktop build this
 * routes through Electron's `shell.openExternal` (validated to http/https in
 * main.ts); in the browser dev harness it falls back to `window.open`.
 *
 * Used by the provider-connect dialog for OAuth sign-in URLs, which must not
 * open inside the Electron window — opencode's loopback callback expects a
 * real system-browser hit, and users' cookies/password managers live there.
 */
export function openExternalUrl(url: string): void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.openExternal === 'function') {
    void bridge.openExternal(url);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const encodeParts = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
  const driveMatch = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (driveMatch) {
    return `file:///${driveMatch[1]}:/${encodeParts(driveMatch[2] ?? '')}`;
  }
  if (normalized.startsWith('//')) {
    return `file:${encodeParts(normalized)}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${encodeParts(normalized)}`;
  }
  return `file:///${encodeParts(normalized)}`;
}

export function openLocalFilePath(path: string): void {
  const bridge = getDesktopBridge();
  if (typeof bridge?.openLocalPath === 'function') {
    void bridge.openLocalPath(path).then((opened) => {
      if (!opened) openLocalFilePathFallback(path);
    });
    return;
  }
  openLocalFilePathFallback(path);
}

function openLocalFilePathFallback(path: string): void {
  const url = fileUrlFromPath(path);
  const bridge = getDesktopBridge();
  if (typeof bridge?.openExternal === 'function') {
    void bridge.openExternal(url).then((opened) => {
      if (!opened && typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
