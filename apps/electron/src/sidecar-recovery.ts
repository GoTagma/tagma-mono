export interface ReloadableWindow {
  isDestroyed(): boolean;
  loadURL(url: string): void;
}

export interface ReloadableWindowSession {
  workspacePath: string | null;
  port: number;
  win: ReloadableWindow;
}

export function buildEditorRenderUrl(
  port: number,
  workspacePath: string | null,
  authToken: string | null,
): string {
  const renderParams = new URLSearchParams();
  if (workspacePath) renderParams.set('ws', workspacePath);
  const query = renderParams.toString();
  const hash = authToken ? `#auth=${encodeURIComponent(authToken)}` : '';
  return query ? `http://127.0.0.1:${port}/?${query}${hash}` : `http://127.0.0.1:${port}/${hash}`;
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
    session.win.loadURL(buildEditorRenderUrl(actualPort, session.workspacePath, authToken));
  }
}
