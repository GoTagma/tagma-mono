import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
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

// Cross-variant compile (e.g. host=windows-x64-modern → target=windows-x64-baseline)
// requires Bun to download the target runtime into ~/.bun/install/cache. That
// download is occasionally truncated on CI runners, leaving an unzippable zip
// and a "Failed to extract executable for 'bun-...-vX.Y.Z'" error. Wipe the
// matching cache entry and retry a couple of times before giving up.
function purgeCachedTargetRuntime(target: string): void {
  const cacheDir = join(homedir(), '.bun', 'install', 'cache');
  if (!existsSync(cacheDir)) return;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(target)) continue;
    const fullPath = join(cacheDir, entry);
    try {
      rmSync(fullPath, { recursive: true, force: true });
      console.warn(`Cleared stale Bun runtime cache: ${fullPath}`);
    } catch (err) {
      console.warn(`Could not clear ${fullPath}:`, err);
    }
  }
}

async function buildWithRetry(maxAttempts: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await Bun.build({
        entrypoints: [join(packageDir, 'server', 'index.ts')],
        target: 'bun',
        compile: {
          outfile,
          ...(compileTarget ? { target: compileTarget as `bun-${string}` } : {}),
        },
      });
      if (result.success) {
        console.log(`Built desktop sidecar: ${outfile}`);
        return;
      }
      for (const log of result.logs) {
        console.error(log);
      }
      throw new Error('Bun.build returned success=false');
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isExtractFailure =
        msg.includes('Failed to extract executable') ||
        msg.includes('download may be incomplete');
      console.error(`Build attempt ${attempt}/${maxAttempts} failed: ${msg}`);
      if (attempt < maxAttempts && isExtractFailure && compileTarget) {
        purgeCachedTargetRuntime(compileTarget);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

await buildWithRetry(3);
