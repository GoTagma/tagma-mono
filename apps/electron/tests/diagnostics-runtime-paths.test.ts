import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRuntimePaths } from '../src/runtime-paths';

describe('desktop diagnostics log handoff', () => {
  test('passes the Electron sidecar log path to packaged and development sidecars', () => {
    const desktopLogFile = 'C:/Users/alice/AppData/Roaming/Tagma/logs/sidecar.log';

    for (const isPackaged of [false, true]) {
      const paths = resolveRuntimePaths({
        isPackaged,
        compiledDir: 'D:/tagma/tagma-mono/apps/electron/dist',
        resourcesPath: 'C:/Program Files/Tagma/resources',
        userDataDir: 'C:/Users/alice/AppData/Roaming/Tagma',
        platform: 'win32',
        desktopLogFile,
      });

      expect(paths.env.TAGMA_DESKTOP_LOG_FILE).toBe(desktopLogFile);
    }
  });

  test('Electron supplies its durable sidecar log file to runtime path resolution', () => {
    const source = readFileSync(join(import.meta.dir, '../src/main.ts'), 'utf8');

    expect(source).toContain("desktopLogFile: path.join(app.getPath('logs'), 'sidecar.log')");
  });
});
