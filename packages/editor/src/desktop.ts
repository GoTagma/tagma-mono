export type DesktopWorkspaceAction = 'proceed' | 'focus-other';

declare global {
  interface Window {
    electronAPI?: DesktopBridge;
  }
}

export interface DesktopBridge {
  requestSetWorkDir: (
    workspacePath: string,
  ) => Promise<{ action: DesktopWorkspaceAction }>;
  openNewWindow: (workspacePath?: string) => Promise<void>;
  // Self-drawn title bar controls (see electron/src/preload.ts).
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onMaximizedChanged: (listener: (isMaximized: boolean) => void) => () => void;
  setZoomFactor: (factor: number) => Promise<number>;
  getZoomFactor: () => Promise<number>;
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
  if (!bridge) return 'proceed';
  const result = await bridge.requestSetWorkDir(workspacePath);
  return result?.action === 'focus-other' ? 'focus-other' : 'proceed';
}

export async function openDesktopWindow(workspacePath?: string): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge) return false;
  await bridge.openNewWindow(workspacePath);
  return true;
}

export function minimizeDesktopWindow(): void {
  getDesktopBridge()?.minimizeWindow();
}

export async function toggleMaximizeDesktopWindow(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge) return false;
  return bridge.toggleMaximizeWindow();
}

export function closeDesktopWindow(): void {
  getDesktopBridge()?.closeWindow();
}

export async function isDesktopWindowMaximized(): Promise<boolean> {
  const bridge = getDesktopBridge();
  if (!bridge) return false;
  return bridge.isWindowMaximized();
}

export function subscribeMaximizedChanged(
  listener: (isMaximized: boolean) => void,
): () => void {
  const bridge = getDesktopBridge();
  if (!bridge) return () => {};
  return bridge.onMaximizedChanged(listener);
}

export async function setDesktopZoomFactor(factor: number): Promise<number | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  return bridge.setZoomFactor(factor);
}

export async function getDesktopZoomFactor(): Promise<number | null> {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  return bridge.getZoomFactor();
}
