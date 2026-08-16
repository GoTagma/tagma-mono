// Test-only staging entry point for the last OpenCode runtime shipped before
// the 1.18.18 database migration. Keeping this pin in source makes the native
// old -> new -> old contract reproducible without weakening the production
// fetcher's package.json authority.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOpencodeTargetArgs, stageOpencodeVersion } from './fetch-opencode.mjs';

export const UPGRADE_FROM_OPENCODE_VERSION = '1.17.8';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(scriptDir, '..', 'build', 'opencode-upgrade-fixture');

async function main() {
  const { platform, arch } = parseOpencodeTargetArgs();
  await stageOpencodeVersion({
    version: UPGRADE_FROM_OPENCODE_VERSION,
    platform,
    arch,
    targetRoot: fixtureRoot,
    logPrefix: 'fetch-opencode-upgrade-fixture',
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(
      '[fetch-opencode-upgrade-fixture] failed:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
