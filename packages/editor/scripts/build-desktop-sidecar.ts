import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageDir = resolve(import.meta.dir, '..');
const outDir = join(packageDir, 'desktop-dist');
const outfile = join(
  outDir,
  `tagma-editor-server${process.platform === 'win32' ? '.exe' : ''}`,
);

// Pick a Bun compile target that runs on the widest set of end-user CPUs.
// Without an explicit target Bun bakes in the host runner's "modern" runtime
// variant (CI uses a recent Azure VM with AVX2). End-user CPUs that lack AVX2
// — older Intel/AMD chips, many VMs, virtualized desktops — then crash on
// launch with STATUS_ILLEGAL_INSTRUCTION (0xC000001D = 3221225501), which
// surfaces in main.ts as "Sidecar exited before ready (code 3221225501)".
// Override via TAGMA_BUN_COMPILE_TARGET to test a specific variant.
function pickCompileTarget(): string | undefined {
  const override = process.env.TAGMA_BUN_COMPILE_TARGET;
  if (override && override.trim()) return override.trim();
  const arch = process.arch;
  if (process.platform === 'win32') {
    if (arch === 'x64') return 'bun-windows-x64-baseline';
    return undefined;
  }
  if (process.platform === 'linux') {
    if (arch === 'x64') return 'bun-linux-x64-baseline';
    if (arch === 'arm64') return 'bun-linux-arm64';
    return undefined;
  }
  if (process.platform === 'darwin') {
    // Apple silicon and Apple Intel chips both support AVX2 / the "modern"
    // baseline Bun targets, so no -baseline variant exists for darwin.
    if (arch === 'arm64') return 'bun-darwin-arm64';
    if (arch === 'x64') return 'bun-darwin-x64';
    return undefined;
  }
  return undefined;
}

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

const compileTarget = pickCompileTarget();
if (compileTarget) {
  console.log(`Using Bun compile target: ${compileTarget}`);
}

const result = await Bun.build({
  entrypoints: [join(packageDir, 'server', 'index.ts')],
  target: 'bun',
  compile: {
    outfile,
    ...(compileTarget ? { target: compileTarget as `bun-${string}` } : {}),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`Built desktop sidecar: ${outfile}`);
