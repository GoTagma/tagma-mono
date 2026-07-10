export interface ReloadableWindow {
  isDestroyed(): boolean;
  loadURL(url: string): void;
}

export interface ReloadableWindowSession {
  workspacePath: string | null;
  port: number;
  rendererBaseUrl?: string | null;
  win: ReloadableWindow;
}

const LOOPBACK_RENDERER_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class SidecarRestartGuard {
  private restartTimestamps: number[] = [];

  constructor(
    private readonly maxRestarts: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isSafeInteger(maxRestarts) || maxRestarts < 1) {
      throw new Error('maxRestarts must be a positive safe integer');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('windowMs must be a positive finite number');
    }
  }

  tryAcquire(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => timestamp > cutoff && timestamp <= now,
    );
    if (this.restartTimestamps.length >= this.maxRestarts) return false;
    this.restartTimestamps.push(now);
    return true;
  }

  reset(): void {
    this.restartTimestamps = [];
  }
}

export function normalizeDevRendererUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl?.trim()) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:') return null;
    if (!LOOPBACK_RENDERER_HOSTS.has(parsed.hostname)) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildEditorRenderUrl(
  port: number,
  workspacePath: string | null,
  authToken: string | null,
  rendererBaseUrl?: string | null,
): string {
  const baseUrl = normalizeDevRendererUrl(rendererBaseUrl) ?? `http://127.0.0.1:${port}/`;
  const url = new URL(baseUrl);
  if (workspacePath) url.searchParams.set('ws', workspacePath);
  if (authToken) url.hash = `auth=${encodeURIComponent(authToken)}`;
  return url.toString();
}

export function isAllowedEditorUrl(
  rawUrl: string,
  sidecarPort: number,
  rendererBaseUrl?: string | null,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.port === String(sidecarPort)
    ) {
      return true;
    }

    const rendererUrl = normalizeDevRendererUrl(rendererBaseUrl);
    if (!rendererUrl) return false;
    const renderer = new URL(rendererUrl);
    return (
      parsed.protocol === renderer.protocol &&
      parsed.hostname === renderer.hostname &&
      parsed.port === renderer.port
    );
  } catch {
    return false;
  }
}

export function reloadSessionsForRecoveredSidecar<T extends ReloadableWindowSession>(
  sessions: Iterable<T>,
  actualPort: number,
  authToken: string | null,
  installContentSecurityPolicy: (win: T['win'], port: number) => void,
): void {
  for (const session of sessions) {
    if (session.win.isDestroyed()) continue;
    session.port = actualPort;
    installContentSecurityPolicy(session.win, actualPort);
    session.win.loadURL(
      buildEditorRenderUrl(actualPort, session.workspacePath, authToken, session.rendererBaseUrl),
    );
  }
}
