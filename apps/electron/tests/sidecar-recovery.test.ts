import { describe, expect, test } from 'bun:test';
import {
  buildEditorRenderUrl,
  reloadSessionsForRecoveredSidecar,
  type ReloadableWindowSession,
} from '../src/sidecar-recovery';

function session(
  workspacePath: string | null,
  port: number,
  destroyed = false,
): ReloadableWindowSession & { loadedUrls: string[] } {
  const loadedUrls: string[] = [];
  return {
    workspacePath,
    port,
    loadedUrls,
    win: {
      isDestroyed: () => destroyed,
      loadURL: (url: string) => {
        loadedUrls.push(url);
      },
    },
  };
}

describe('sidecar recovery helpers', () => {
  test('builds renderer URLs with workspace query and auth fragment', () => {
    expect(buildEditorRenderUrl(8123, 'C:/Work Space', 'secret token')).toBe(
      'http://127.0.0.1:8123/?ws=C%3A%2FWork+Space#auth=secret%20token',
    );
    expect(buildEditorRenderUrl(8123, null, null)).toBe('http://127.0.0.1:8123/');
  });

  test('reloads live sessions onto the recovered sidecar port', () => {
    const first = session('C:/a', 7001);
    const second = session(null, 7001);
    const destroyed = session('C:/dead', 7001, true);
    const cspPorts: number[] = [];

    reloadSessionsForRecoveredSidecar([first, second, destroyed], 8123, 'token', (_win, port) => {
      cspPorts.push(port);
    });

    expect(first.port).toBe(8123);
    expect(second.port).toBe(8123);
    expect(destroyed.port).toBe(7001);
    expect(first.loadedUrls).toEqual(['http://127.0.0.1:8123/?ws=C%3A%2Fa#auth=token']);
    expect(second.loadedUrls).toEqual(['http://127.0.0.1:8123/#auth=token']);
    expect(destroyed.loadedUrls).toEqual([]);
    expect(cspPorts).toEqual([8123, 8123]);
  });
});
