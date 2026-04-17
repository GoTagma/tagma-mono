import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { assertSafePluginName } from '../plugin-safety.js';
import { S, isPathWithin, pluginDirFor, fenceWithinNodeModules } from '../state.js';
import { readPluginManifest as parsePluginManifestField } from '@tagma/sdk';

export const NPM_REGISTRY = 'https://registry.npmjs.org';

// ── Registry preflight + Bun-backed workspace install ──

/** Encode a package name for the npm registry URL */
export function registryUrl(name: string): string {
  // Scoped: @scope/pkg → @scope%2fpkg
  if (name.startsWith('@')) {
    return `${NPM_REGISTRY}/${name.replace('/', '%2f')}`;
  }
  return `${NPM_REGISTRY}/${encodeURIComponent(name)}`;
}

// C3 hardening: bound every registry/tarball fetch so a slow or malicious
// mirror can't hang the server forever, and verify content integrity so a
// MITM or compromised mirror can't substitute the tarball.
export const REGISTRY_FETCH_TIMEOUT_MS = 30_000;
export const TARBALL_FETCH_TIMEOUT_MS = 60_000;
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MB hard cap

export interface PackageMeta {
  version: string;
  description: string | null;
  tarball: string;
  /** SRI integrity string (e.g. "sha512-...") if the registry provides one. */
  integrity: string | null;
  /** Legacy SHA-1 from `dist.shasum`, used as a fallback when integrity is missing. */
  shasum: string | null;
}

type PackageJson = Record<string, unknown> & {
  dependencies?: Record<string, string>;
};

/** Fetch package metadata from the npm registry (uses Bun's built-in fetch) */
export async function registryMeta(name: string): Promise<PackageMeta> {
  const res = await fetch(registryUrl(name), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Package "${name}" not found on registry (${res.status})`);
  const meta = (await res.json()) as Record<string, unknown>;
  const distTags = meta['dist-tags'] as Record<string, string> | undefined;
  const versions = meta.versions as Record<string, Record<string, unknown>> | undefined;
  const latest = distTags?.latest;
  if (!latest) throw new Error(`No published version for "${name}"`);
  const info = versions?.[latest] as Record<string, unknown> | undefined;
  const dist = info?.dist as Record<string, unknown> | undefined;
  if (!dist?.tarball) throw new Error(`No tarball for ${name}@${latest}`);
  return {
    version: latest,
    description: (info?.description as string) ?? null,
    tarball: dist.tarball as string,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
  };
}

/**
 * Streaming tarball download with hard size cap. Reads the response body
 * incrementally so we can fail fast on oversized payloads instead of buffering
 * everything in memory and OOMing the server.
 */
export async function downloadTarball(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Tarball download failed (${res.status})`);

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new Error(
      `Tarball too large: declared ${declared} bytes exceeds cap of ${MAX_TARBALL_BYTES} bytes`,
    );
  }
  if (!res.body) throw new Error('Tarball response has no body');

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_TARBALL_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(
        `Tarball exceeds size cap of ${MAX_TARBALL_BYTES} bytes (received ${total}+)`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );
}

/**
 * Verify a tarball against the registry-provided integrity field. Prefers
 * SRI (sha512), falls back to SHA-1 shasum if that's all the registry has.
 * Throws on mismatch.
 */
export function verifyIntegrity(buffer: Buffer, meta: PackageMeta, name: string): void {
  if (meta.integrity) {
    const m = meta.integrity.match(/^(sha\d+)-(.+)$/);
    if (!m) {
      throw new Error(`Unrecognized integrity format for "${name}": ${meta.integrity}`);
    }
    const [, algo, expectedB64] = m;
    const actual = createHash(algo).update(buffer).digest('base64');
    if (actual !== expectedB64) {
      throw new Error(
        `Tarball integrity mismatch for "${name}": ` +
          `expected ${meta.integrity}, got ${algo}-${actual}`,
      );
    }
    return;
  }
  if (meta.shasum) {
    const actual = createHash('sha1').update(buffer).digest('hex');
    if (actual !== meta.shasum) {
      throw new Error(
        `Tarball shasum mismatch for "${name}": expected ${meta.shasum}, got ${actual}`,
      );
    }
    return;
  }
  throw new Error(
    `Registry returned no integrity or shasum for "${name}". Refusing to install ` +
      `unverified tarball.`,
  );
}

/**
 * Extract a tarball into `destDir` with `strip: 1` semantics.
 *
 * Workaround for a Bun + `tar` v7 incompatibility: `tar.x()` / `tar.extract()`
 * silently drop file contents during extraction under Bun (creates directory
 * entries but never writes file data, *without throwing*), leaving broken
 * installs like a lone empty `src/` directory. `tar.t()` list mode still
 * works, so we iterate entries manually and write each file ourselves.
 *
 * Security: resolved targets are fenced within `destDir`, and non-regular
 * entry types (symlinks, hardlinks, char/block devices) are skipped so a
 * malicious tarball can't plant links outside the plugin directory.
 */
export function extractTarballStrip1(tgzPath: string, destDir: string): void {
  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      const type = entry.type;
      if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') {
        entry.resume();
        return;
      }
      // tar entry paths are POSIX — split on '/' regardless of host OS.
      const segs = String(entry.path).split('/');
      segs.shift(); // strip: 1
      const rel = segs.join('/');
      if (!rel) {
        entry.resume();
        return;
      }
      const outPath = resolve(destDir, rel);
      if (!isPathWithin(outPath, destDir)) {
        entry.resume();
        return;
      }
      if (type === 'Directory') {
        mkdirSync(outPath, { recursive: true });
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, Buffer.concat(chunks));
      });
    },
  });
}

/** Ensure workDir has a package.json so the installer has somewhere to record dependencies. */
export function ensureWorkDirPackageJson(): void {
  const pkgPath = resolve(S.workDir, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: 'tagma-workspace', private: true, dependencies: {} }, null, 2),
      'utf-8',
    );
  }
}

function readPackageJson(pkgPath: string): PackageJson {
  return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
}

function ensureDependencyMap(pkg: PackageJson): Record<string, string> {
  if (
    !pkg.dependencies ||
    typeof pkg.dependencies !== 'object' ||
    Array.isArray(pkg.dependencies)
  ) {
    pkg.dependencies = {};
  }
  return pkg.dependencies;
}

function assertTagmaPluginPackage(pkgJson: PackageJson, name: string): void {
  const manifest = parsePluginManifestField(pkgJson);
  if (!manifest) {
    throw new Error(
      `Package "${name}" is not a tagma plugin (missing tagmaPlugin manifest in package.json)`,
    );
  }
}

async function syncWorkspaceDependencies(): Promise<void> {
  if (!S.workDir) {
    throw new Error('Cannot install plugin dependencies before setting a working directory');
  }
  const proc = Bun.spawn([process.execPath, 'install'], {
    cwd: S.workDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || 'unknown error';
    throw new Error(`bun install failed while resolving plugin dependencies: ${detail}`);
  }
}

/**
 * Preflight a registry package by downloading its tarball, verifying
 * integrity, and validating its package.json before we mutate the workspace.
 * The actual install is delegated to `bun install` afterward so the full
 * dependency tree is resolved by the package manager.
 */
export async function directRegistryInstall(
  name: string,
): Promise<{ meta: PackageMeta; packageJson: PackageJson }> {
  // Caller (route handler) MUST have already validated `name` via
  // assertSafePluginName. We still fence against escape for defense in depth.
  assertSafePluginName(name);

  const meta = await registryMeta(name);
  const tarBuffer = await downloadTarball(meta.tarball);
  verifyIntegrity(tarBuffer, meta, name);

  const tmpDir = mkdtempSync(join(tmpdir(), 'tagma-pkg-'));
  const tgzPath = join(tmpDir, 'package.tgz');
  writeFileSync(tgzPath, tarBuffer);

  try {
    extractTarballStrip1(tgzPath, tmpDir);

    const installedPkgPath = resolve(tmpDir, 'package.json');
    if (!existsSync(installedPkgPath)) {
      throw new Error(`Installed package "${name}" did not contain a package.json`);
    }
    const installedPkg = readPackageJson(installedPkgPath);
    assertTagmaPluginPackage(installedPkg, name);

    ensureWorkDirPackageJson();
    const pkgPath = resolve(S.workDir, 'package.json');
    const pkg = readPackageJson(pkgPath);
    const dependencies = ensureDependencyMap(pkg);
    dependencies[name] = `^${meta.version}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    return { meta, packageJson: installedPkg };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Install a registry plugin after tarball-level preflight.
 */
export async function installPackage(name: string): Promise<void> {
  ensureWorkDirPackageJson();
  await directRegistryInstall(name);
  await syncWorkspaceDependencies();
}

/**
 * Install a plugin from a local directory or `.tgz`. We validate the source
 * package metadata locally first, then hand the actual dependency graph
 * materialization to `bun install`.
 */
export async function installFromLocalPath(absPath: string): Promise<string> {
  ensureWorkDirPackageJson();
  const stat = statSync(absPath);

  // Stage the package contents in a temp dir (for tarballs) or point at the
  // directory directly. `sourceDir` always contains a top-level package.json.
  let sourceDir: string;
  let cleanupTmp: string | null = null;

  if (stat.isDirectory()) {
    sourceDir = absPath;
  } else {
    cleanupTmp = mkdtempSync(join(tmpdir(), 'tagma-local-'));
    extractTarballStrip1(absPath, cleanupTmp);
    sourceDir = cleanupTmp;
  }

  try {
    const srcPkgPath = resolve(sourceDir, 'package.json');
    if (!existsSync(srcPkgPath)) {
      throw new Error('Source does not contain a package.json');
    }
    const srcPkg = readPackageJson(srcPkgPath);
    const pkgName: unknown = srcPkg.name;
    if (typeof pkgName !== 'string' || !pkgName) {
      throw new Error('Source package.json has no "name" field');
    }
    assertSafePluginName(pkgName);
    assertTagmaPluginPackage(srcPkg, pkgName);

    // Record the dependency in the workspace package.json using a file: spec.
    const pkgPath = resolve(S.workDir, 'package.json');
    const pkg = readPackageJson(pkgPath);
    const dependencies = ensureDependencyMap(pkg);
    dependencies[pkgName] = `file:${absPath}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    await syncWorkspaceDependencies();

    return pkgName;
  } finally {
    if (cleanupTmp) {
      rmSync(cleanupTmp, { recursive: true, force: true });
    }
  }
}

/**
 * Uninstall a package: remove from node_modules + package.json.
 * Done via direct filesystem ops — no package manager CLI required.
 *
 * Caller MUST have validated `name` via assertSafePluginName before reaching
 * this function. We re-fence here so any future caller path that forgets the
 * validation still can't escape workDir/node_modules.
 */
export function uninstallPackage(name: string): void {
  assertSafePluginName(name);
  const pkgDir = pluginDirFor(name);
  fenceWithinNodeModules(pkgDir);

  if (existsSync(pkgDir)) {
    rmSync(pkgDir, { recursive: true, force: true });
  }

  // Clean up empty scope directory
  if (name.startsWith('@')) {
    const scopeDir = resolve(S.workDir, 'node_modules', name.split('/')[0]);
    try {
      if (
        isPathWithin(scopeDir, resolve(S.workDir, 'node_modules')) &&
        existsSync(scopeDir) &&
        readdirSync(scopeDir).length === 0
      ) {
        rmSync(scopeDir, { recursive: true, force: true });
      }
    } catch (_err) {
      /* ignore — scope dir may be non-empty or already removed */
    }
  }

  // Remove from package.json
  const pkgPath = resolve(S.workDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (pkg.dependencies?.[name]) {
      delete pkg.dependencies[name];
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
    }
  }
}
