// Bundle-time fetcher for the opencode CLI binary.
//
// Electron installers ship a single platform-specific opencode executable via
// electron-builder's extraResources, then runtime-paths.ts prepends that
// directory to the sidecar's PATH. This script produces the staged binary
// tree the installer packs.
//
// Why download it ourselves instead of `bun install -g opencode-ai`?
//   1. End users don't have bun installed — see opencode.ts:90.
//   2. opencode-ai ships per-platform bins via optionalDependencies; we want
//      to ship exactly ONE arch in each installer, not all 12.
//   3. We want deterministic, offline-reproducible desktop builds — pin the
//      version in package.json and verify the tarball sha512 before extract.
//
// Each platform package tarball contains `package/bin/opencode(.exe)` which
// is itself a self-contained Bun single-file executable — no Node shim or
// runtime dependencies. We just extract that one file and ship it.

import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readFileSync,
  mkdtempSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';

const scriptDir = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const packageDir = resolve(scriptDir, '..');
const buildDir = join(packageDir, 'build');
const pkgJsonPath = join(packageDir, 'package.json');

function parseArgs() {
  const args = { platform: process.platform, arch: process.arch };
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'platform') args.platform = m[2];
    else if (m[1] === 'arch') args.arch = m[2];
  }
  return args;
}

// opencode publishes baseline variants (built for older CPUs without AVX2)
// only for x64. arm64 targets always use the single variant.
// We mirror build-desktop-sidecar.ts's policy: always prefer baseline on x64
// so installers never crash on VMs / older chips with STATUS_ILLEGAL_INSTRUCTION.
function resolvePackageName(platform, arch) {
  const osSegment = platform === 'win32' ? 'windows' : platform;
  if (arch === 'x64') return `opencode-${osSegment}-x64-baseline`;
  if (arch === 'arm64') return `opencode-${osSegment}-arm64`;
  throw new Error(`Unsupported opencode target: ${platform}/${arch}`);
}

function readBundledVersion() {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const v = pkg?.tagma?.bundledOpencodeVersion;
  if (typeof v !== 'string' || !v) {
    throw new Error(
      `packages/electron/package.json is missing "tagma.bundledOpencodeVersion" — set it to a concrete opencode-ai version (e.g. "1.4.4").`,
    );
  }
  return v;
}

async function fetchRegistryMeta(pkgName, version) {
  const url = `https://registry.npmjs.org/${pkgName}/${version}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Registry fetch failed for ${pkgName}@${version}: HTTP ${res.status}`);
  }
  const meta = await res.json();
  const dist = meta?.dist ?? {};
  if (!dist.tarball) throw new Error(`No tarball URL in registry meta for ${pkgName}@${version}`);
  return {
    tarball: dist.tarball,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
  };
}

async function downloadToBuffer(url, maxBytes = 200 * 1024 * 1024) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Tarball download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error('Tarball response has no body');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`Tarball exceeds ${maxBytes} byte cap (received ${total}+)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

function verifyIntegrity(buf, meta, pkgName) {
  if (meta.integrity) {
    const m = meta.integrity.match(/^(sha\d+)-(.+)$/);
    if (!m) throw new Error(`Bad integrity format for ${pkgName}: ${meta.integrity}`);
    const [, algo, expected] = m;
    const actual = createHash(algo).update(buf).digest('base64');
    if (actual !== expected) {
      throw new Error(`Integrity mismatch for ${pkgName}: expected ${meta.integrity}, got ${algo}-${actual}`);
    }
    return;
  }
  if (meta.shasum) {
    const actual = createHash('sha1').update(buf).digest('hex');
    if (actual !== meta.shasum) {
      throw new Error(`shasum mismatch for ${pkgName}: expected ${meta.shasum}, got ${actual}`);
    }
    return;
  }
  throw new Error(`Registry returned no integrity or shasum for ${pkgName} — refusing to bundle an unverified tarball.`);
}

function extractBinary(tgzPath, destFile, isWindows) {
  // Each opencode-<platform>-<arch> tarball contains just:
  //   package/package.json
  //   package/bin/opencode          (or opencode.exe on windows)
  // We only extract the binary. tar.t with sync+onentry is the same pattern
  // used by server/plugins/install.ts to work around a Bun+tar v7 corruption
  // bug in tar.x's streaming writer.
  const wantRelPath = isWindows ? 'bin/opencode.exe' : 'bin/opencode';
  let written = false;
  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        entry.resume();
        return;
      }
      const segs = String(entry.path).split('/');
      segs.shift(); // strip: 1 → drop leading "package/"
      const rel = segs.join('/');
      if (rel !== wantRelPath) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on('data', (c) => chunks.push(c));
      entry.on('end', () => {
        mkdirSync(dirname(destFile), { recursive: true });
        writeFileSync(destFile, Buffer.concat(chunks));
        if (!isWindows) chmodSync(destFile, 0o755);
        written = true;
      });
    },
  });
  if (!written) {
    throw new Error(`Did not find ${wantRelPath} inside the tarball — opencode layout may have changed.`);
  }
}

async function main() {
  const { platform, arch } = parseArgs();
  const version = readBundledVersion();
  const pkgName = resolvePackageName(platform, arch);
  const isWindows = platform === 'win32';

  // Target layout: build/opencode/<platform>-<arch>/bin/opencode(.exe)
  // runtime-paths.ts looks for resources/opencode/<platform>-<arch>/bin. One
  // directory per target so multi-arch mac builds can pre-stage both arches
  // and electron-builder picks the matching one via a per-target extraResources
  // glob (see package.json `build.extraResources`).
  const targetDir = join(buildDir, 'opencode', `${platform}-${arch}`);
  const binDir = join(targetDir, 'bin');
  const destBinary = join(binDir, isWindows ? 'opencode.exe' : 'opencode');
  const versionFile = join(targetDir, 'version.txt');

  if (existsSync(destBinary) && existsSync(versionFile)) {
    const existingVersion = readFileSync(versionFile, 'utf-8').trim();
    if (existingVersion === version) {
      console.log(`[fetch-opencode] ${platform}/${arch} already at ${version} — skipping`);
      return;
    }
  }

  console.log(`[fetch-opencode] ${platform}/${arch} → ${pkgName}@${version}`);
  const meta = await fetchRegistryMeta(pkgName, version);
  console.log(`[fetch-opencode] downloading ${meta.tarball}`);
  // ~150MB downloads over residential links occasionally get half-closed by
  // a CDN edge or a flaky local link; retry with exponential backoff so a
  // transient failure doesn't abort the whole desktop build.
  let buf;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      buf = await downloadToBuffer(meta.tarball);
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fetch-opencode] download attempt ${attempt}/3 failed: ${msg}`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  if (!buf) throw lastErr ?? new Error('download failed after 3 attempts');
  verifyIntegrity(buf, meta, pkgName);

  // Stage tarball to a temp file so tar.t has a file handle. Writing
  // fs.mkdtempSync under the OS temp dir means we never leave orphans in
  // the repo if the build is aborted.
  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-opencode-'));
  const tgzPath = join(tempRoot, 'pkg.tgz');
  writeFileSync(tgzPath, buf);
  try {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
    mkdirSync(binDir, { recursive: true });
    extractBinary(tgzPath, destBinary, isWindows);
    writeFileSync(versionFile, version + '\n', 'utf-8');
    console.log(`[fetch-opencode] wrote ${destBinary}`);
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main().catch((err) => {
  console.error('[fetch-opencode] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
