import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const repoPackageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
};

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
};

test('desktop dev startup ensures the Electron runtime before building', () => {
  expect(repoPackageJson.scripts['dev:desktop']).toStartWith(
    'bun run --filter tagma-desktop ensure:electron && bun run build:desktop',
  );
});

test('local Electron launch scripts use the runtime guard instead of lazy CLI download', () => {
  expect(packageJson.scripts['ensure:electron']).toBe('node ./scripts/electron-runtime.mjs ensure');
  expect(packageJson.scripts['start']).toBe('node ./scripts/electron-runtime.mjs start .');
  expect(packageJson.scripts['dev']).toBe(
    'bun run build && node ./scripts/electron-runtime.mjs start .',
  );
});

test('local desktop dist scripts build portable sidecars before staging', () => {
  expect(packageJson.scripts['dist:win']).toContain(
    'TAGMA_BUN_COMPILE_TARGET=bun-windows-x64-baseline bun run build:all',
  );
  expect(packageJson.scripts['dist:win']).toContain('node ./scripts/stage-sidecar.mjs x64');
  expect(packageJson.scripts['dist:linux']).toContain(
    'TAGMA_BUN_COMPILE_TARGET=bun-linux-x64-baseline bun run build:all',
  );
  expect(packageJson.scripts['dist:linux']).toContain('node ./scripts/stage-sidecar.mjs x64');
});
