import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDir = resolve(import.meta.dir, '..');
const outDir = join(packageDir, 'desktop-dist');
const outfile = join(
  outDir,
  `tagma-editor-server${process.platform === 'win32' ? '.exe' : ''}`,
);

// Only remove the target binary, not the whole directory. Wiping the entire
// directory used to EACCES on Windows when a previous sidecar instance (or
// AV / file-indexer) still held a handle on a file inside — aborting the
// whole build for what is recoverable by overwriting a single file.
mkdirSync(outDir, { recursive: true });
if (existsSync(outfile)) {
  try {
    rmSync(outfile, { force: true });
  } catch (err) {
    console.error(
      `Failed to remove existing sidecar at ${outfile}.\n` +
        `A previous instance may still be running; close it and retry.\n`,
      err,
    );
    process.exit(1);
  }
}

const result = await Bun.build({
  entrypoints: [join(packageDir, 'server', 'index.ts')],
  target: 'bun',
  compile: {
    outfile,
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built desktop sidecar: ${outfile}`);
