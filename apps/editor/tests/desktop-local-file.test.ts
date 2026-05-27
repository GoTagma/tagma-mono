import { afterEach, describe, expect, test } from 'bun:test';
import { openLocalFilePath } from '../src/desktop';

function setWindow(value: unknown): void {
  (globalThis as { window?: unknown }).window = value;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('desktop local file opening', () => {
  test('uses the desktop local-path bridge with the raw path when available', async () => {
    const path = 'D:\\repo\\.tagma\\demo\\demo.requirements.md';
    const localPaths: string[] = [];
    const externalUrls: string[] = [];
    const windowUrls: string[] = [];

    setWindow({
      electronAPI: {
        openLocalPath: async (value: string) => {
          localPaths.push(value);
          return true;
        },
        openExternal: async (value: string) => {
          externalUrls.push(value);
          return true;
        },
      },
      open: (value: string) => {
        windowUrls.push(value);
        return null;
      },
    });

    openLocalFilePath(path);
    await Promise.resolve();

    expect(localPaths).toEqual([path]);
    expect(externalUrls).toEqual([]);
    expect(windowUrls).toEqual([]);
  });
});
