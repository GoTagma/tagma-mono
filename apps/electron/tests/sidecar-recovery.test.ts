import { describe, expect, test } from 'bun:test';
import {
  buildEditorRenderUrl,
  isAllowedEditorUrl,
  normalizeDevRendererUrl,
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

  test('builds renderer URLs against a Vite dev server when provided', () => {
    const rendererUrl = normalizeDevRendererUrl(' http://127.0.0.1:5173/dev/?stale=1#old ');

    expect(rendererUrl).toBe('http://127.0.0.1:5173/dev/');
    expect(buildEditorRenderUrl(8123, 'C:/Work Space', null, rendererUrl)).toBe(
      'http://127.0.0.1:5173/dev/?ws=C%3A%2FWork+Space',
    );
  });

  test('allows sidecar and Vite renderer origins for trusted desktop navigation', () => {
    const rendererUrl = normalizeDevRendererUrl('http://localhost:5173/');

    expect(isAllowedEditorUrl('http://127.0.0.1:8123/?ws=C%3A%2Fa', 8123, rendererUrl)).toBe(
      true,
    );
    expect(isAllowedEditorUrl('http://localhost:5173/src/main.tsx', 8123, rendererUrl)).toBe(true);
    expect(isAllowedEditorUrl('http://localhost:5174/src/main.tsx', 8123, rendererUrl)).toBe(
      false,
    );
    expect(isAllowedEditorUrl('https://example.com/', 8123, rendererUrl)).toBe(false);
  });

  test('rejects non-loopback dev renderer URLs', () => {
    expect(normalizeDevRendererUrl('https://127.0.0.1:5173/')).toBeNull();
    expect(normalizeDevRendererUrl('http://192.168.1.20:5173/')).toBeNull();
    expect(normalizeDevRendererUrl('not a url')).toBeNull();
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

  test('reloads HMR sessions back onto the Vite renderer URL', () => {
    const first = session('C:/a', 7001);
    first.rendererBaseUrl = 'http://127.0.0.1:5173/';
    const cspPorts: number[] = [];

    reloadSessionsForRecoveredSidecar([first], 8123, null, (_win, port) => {
      cspPorts.push(port);
    });

    expect(first.port).toBe(8123);
    expect(first.loadedUrls).toEqual(['http://127.0.0.1:5173/?ws=C%3A%2Fa']);
    expect(cspPorts).toEqual([8123]);
  });
});
