import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as {
  scripts: Record<string, string>;
};

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
