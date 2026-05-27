// Bundle-time fetcher for the Bun package-manager binary.
//
// The packaged editor sidecar is a single-file executable, so its
// process.execPath is not a reusable `bun` binary. Plugin installation needs a
// real Bun to run `bun install --ignore-scripts` inside the isolated plugin
// store. This script stages one platform-specific Bun binary for
// electron-builder's extraResources.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '..', '..');
const buildDir = join(packageDir, 'build');
const pkgJsonPath = join(packageDir, 'package.json');
const rootPkgJsonPath = join(repoRoot, 'package.json');

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

function readBundledVersion() {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const explicit = pkg?.tagma?.bundledBunVersion;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  const rootPkg = JSON.parse(readFileSync(rootPkgJsonPath, 'utf-8'));
  const packageManager = rootPkg?.packageManager;
  const match = typeof packageManager === 'string' ? packageManager.match(/^bun@(.+)$/) : null;
  if (match) return match[1];

  throw new Error(
    'Cannot determine bundled Bun version. Set apps/electron package.json tagma.bundledBunVersion or root packageManager.',
  );
}

function resolvePackageName(platform, arch) {
  if (platform === 'darwin') {
    if (arch === 'arm64') return '@oven/bun-darwin-aarch64';
    if (arch === 'x64') return '@oven/bun-darwin-x64-baseline';
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return '@oven/bun-linux-aarch64';
    if (arch === 'x64') return '@oven/bun-linux-x64-baseline';
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return '@oven/bun-windows-aarch64';
    if (arch === 'x64') return '@oven/bun-windows-x64-baseline';
  }
  throw new Error(`Unsupported Bun target: ${platform}/${arch}`);
}

function registryPackageUrl(pkgName, version) {
  return `https://registry.npmjs.org/${pkgName.replace('/', '%2f')}/${version}`;
}

async function fetchRegistryMeta(pkgName, version) {
  const res = await fetch(registryPackageUrl(pkgName, version), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`Registry fetch failed for ${pkgName}@${version}: HTTP ${res.status}`);
  const meta = await res.json();
  const dist = meta?.dist ?? {};
  if (!dist.tarball) throw new Error(`No tarball URL in registry meta for ${pkgName}@${version}`);
  return {
    tarball: dist.tarball,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
  };
}

async function downloadToBuffer(url, maxBytes = 250 * 1024 * 1024) {
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
      throw new Error(
        `Integrity mismatch for ${pkgName}: expected ${meta.integrity}, got ${algo}-${actual}`,
      );
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
  throw new Error(`Registry returned no integrity or shasum for ${pkgName}.`);
}

function extractBinary(tgzPath, destFile, isWindows) {
  const wantName = isWindows ? 'bun.exe' : 'bun';
  let written = false;
  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      if (written || (entry.type !== 'File' && entry.type !== 'OldFile')) {
        entry.resume();
        return;
      }
      const rel = String(entry.path).split('/').slice(1).join('/');
      const base = rel.split('/').at(-1);
      if (base !== wantName) {
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
  if (!written) throw new Error(`Did not find ${wantName} inside the tarball.`);
}

async function main() {
  const { platform, arch } = parseArgs();
  const version = readBundledVersion();
  const pkgName = resolvePackageName(platform, arch);
  const isWindows = platform === 'win32';
  const targetDir = join(buildDir, 'bun', `${platform}-${arch}`);
  const binDir = join(targetDir, 'bin');
  const destBinary = join(binDir, isWindows ? 'bun.exe' : 'bun');
  const versionFile = join(targetDir, 'version.txt');

  if (existsSync(destBinary) && existsSync(versionFile)) {
    const existingVersion = readFileSync(versionFile, 'utf-8').trim();
    if (existingVersion === version) {
      console.log(`[fetch-bun] ${platform}/${arch} already at ${version} - skipping`);
      return;
    }
  }

  console.log(`[fetch-bun] ${platform}/${arch} -> ${pkgName}@${version}`);
  const meta = await fetchRegistryMeta(pkgName, version);
  console.log(`[fetch-bun] downloading ${meta.tarball}`);
  const buf = await downloadToBuffer(meta.tarball);
  verifyIntegrity(buf, meta, pkgName);

  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-bun-'));
  const tgzPath = join(tempRoot, 'pkg.tgz');
  writeFileSync(tgzPath, buf);
  try {
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
    extractBinary(tgzPath, destBinary, isWindows);
    writeFileSync(versionFile, version + '\n', 'utf-8');
    console.log(`[fetch-bun] wrote ${destBinary}`);
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main().catch((err) => {
  console.error('[fetch-bun] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
