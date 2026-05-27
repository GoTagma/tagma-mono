import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as tar from 'tar';
import { readPluginManifest as parsePluginManifestField } from '@tagma/sdk/plugins';
import { assertSafePluginName } from '../plugin-safety.js';
import {
  isPathWithin,
  pluginStoreDirFor,
  pluginStorePackageDirFor,
  fenceWithinPluginStore,
} from '../state.js';
import { atomicWriteFileSync } from '../path-utils.js';
import type { WorkspaceState } from '../workspace-state.js';
import {
  addToPluginBlocklist,
  addToPluginManifest,
  assertNoSymlinksInDir,
  readPluginBlocklist,
  readPluginManifest,
  removeFromPluginBlocklist,
  removeFromPluginManifest,
} from './loader.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Hosts that the plugin installer is allowed to fetch tarballs from. Locked
 * to npmjs.org and its content distribution endpoint — even if the registry
 * metadata claims a tarball lives somewhere else (a corrupted mirror, a
 * compromised package's `dist.tarball` rewrite), we refuse to download it.
 */
const ALLOWED_TARBALL_HOSTS: ReadonlySet<string> = new Set([
  'registry.npmjs.org',
  'registry.npmjs.com',
]);

function assertHttpsTarballUrl(url: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Tarball URL for "${name}" is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing tarball for "${name}": URL must be https://, got ${parsed.protocol}//${parsed.host}`,
    );
  }
  if (!ALLOWED_TARBALL_HOSTS.has(parsed.host.toLowerCase())) {
    throw new Error(
      `Refusing tarball for "${name}": host "${parsed.host}" is not in the registry allowlist ` +
        `(${[...ALLOWED_TARBALL_HOSTS].join(', ')}).`,
    );
  }
  return parsed;
}

export function registryUrl(name: string): string {
  if (name.startsWith('@')) {
    return `${NPM_REGISTRY}/${name.replace('/', '%2f')}`;
  }
  return `${NPM_REGISTRY}/${encodeURIComponent(name)}`;
}

export const REGISTRY_FETCH_TIMEOUT_MS = 30_000;
export const TARBALL_FETCH_TIMEOUT_MS = 60_000;
export const MAX_TARBALL_REDIRECTS = 5;
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_EXTRACTED_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_EXTRACTED_FILE_COUNT = 10_000;

// Strict semver — `1.2.3`, `1.2.3-beta.1`, `1.2.3+build` and combinations.
// The previous loose `[A-Za-z0-9._+~-]+` accepted dist-tags ("latest"),
// arbitrary path-friendly characters, and tilde/caret ranges, all of which
// belong in spec parsing rather than the locked-version field. Pinning to
// proper semver here means the install target is unambiguous: the registry
// returns one specific version and the lockfile records the exact same
// string later code paths can compare against.
const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type PackageJson = Record<string, unknown> & {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export interface PackageMeta {
  name: string;
  version: string;
  description: string | null;
  tarball: string;
  integrity: string | null;
  shasum: string | null;
}

export interface PluginInstallSpec {
  name: string;
  version?: string;
}

export interface PluginVersionLockEntry {
  name: string;
  version: string;
  integrity: string | null;
  shasum: string | null;
  lockedAt: string;
}

export interface PluginVersionLockFile {
  plugins: PluginVersionLockEntry[];
}

export interface PluginInstallOutcome {
  pluginRoot: string;
}

export interface PluginInstallTransactionOutcome extends PluginInstallOutcome {
  snapshot: PluginStateSnapshot;
}

export interface LocalPluginInstallTransactionOutcome extends PluginInstallTransactionOutcome {
  name: string;
}

export interface PluginUpgradePlanEntry {
  name: string;
  fromVersion: string | null;
  toVersion: string;
  reason: 'target';
}

export interface PluginUpgradePlanReady {
  status: 'ready';
  target: string;
  upgrades: PluginUpgradePlanEntry[];
  warnings: string[];
}

export interface PluginUpgradePlanBlocked {
  status: 'blocked';
  target: string;
  upgrades: PluginUpgradePlanEntry[];
  blockers: Array<{
    name: string;
    currentVersion: string | null;
    latestVersion: string | null;
    reason: string;
  }>;
  message: string;
  warnings: string[];
}

export type PluginUpgradePlan = PluginUpgradePlanReady | PluginUpgradePlanBlocked;

export interface PluginBatchStateSnapshot {
  snapshots: PluginStateSnapshot[];
}

export interface PluginUpgradeBatchTransactionOutcome extends PluginInstallOutcome {
  plan: PluginUpgradePlanReady;
  snapshot: PluginBatchStateSnapshot;
}

interface RegistryPackagePreflight {
  meta: PackageMeta;
  packageJson: PackageJson;
  verifiedPackageDir: string;
  cleanup: () => void;
}

interface WorkspaceFileSnapshot {
  path: string;
  contents: Buffer | null;
}

export function parsePluginInstallSpec(name: unknown, version?: unknown): PluginInstallSpec {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('plugin name is required');
  }
  let rawName = name.trim();
  let parsedVersion = typeof version === 'string' && version.trim() ? version.trim() : undefined;
  if (!parsedVersion) {
    const slash = rawName.indexOf('/');
    const at = rawName.lastIndexOf('@');
    if (at > 0 && (rawName[0] !== '@' || at > slash)) {
      parsedVersion = rawName.slice(at + 1);
      rawName = rawName.slice(0, at);
    }
  }
  assertSafePluginName(rawName);
  if (parsedVersion !== undefined && !VERSION_RE.test(parsedVersion)) {
    throw new Error(
      `Invalid plugin version "${parsedVersion}". Install specs must pin a concrete npm version.`,
    );
  }
  return parsedVersion ? { name: rawName, version: parsedVersion } : { name: rawName };
}

/**
 * Look up the strict-semver version published as `dist-tags.latest` for a
 * plugin. Surfaces "resolve latest" as a separate, explicit step so install
 * paths never silently substitute latest for "no version specified" — the
 * concrete version flows through the rest of the pipeline (lockfile,
 * preflight, install) as if the caller had pinned it themselves.
 *
 * Throws when the registry returns no `latest` tag, or returns a non-semver
 * value (e.g. "next" or a malformed string) so an attacker controlling
 * registry metadata can't smuggle a non-version through the strict checks
 * downstream.
 */
export async function resolveLatestPluginVersion(name: string): Promise<string> {
  assertSafePluginName(name);
  const res = await fetch(registryUrl(name), {
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Registry lookup failed for "${name}" (${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  const distTags = body['dist-tags'] as Record<string, unknown> | undefined;
  const latest = typeof distTags?.latest === 'string' ? distTags.latest : null;
  if (!latest) {
    throw new Error(
      `No dist-tags.latest published for "${name}". Pin a concrete version when installing.`,
    );
  }
  if (!VERSION_RE.test(latest)) {
    throw new Error(`Registry returned non-semver dist-tags.latest for "${name}": "${latest}".`);
  }
  return latest;
}

/**
 * Registry metadata lookup for a SPECIFIC pinned version. The version is
 * required — callers that want "latest" must resolve it explicitly via
 * `resolveLatestPluginVersion` first. This split closes the previous
 * silent-fallback path where `registryMeta(name)` quietly grabbed
 * `dist-tags.latest`, so an install-without-version would race a malicious
 * publish into the workspace; the install spec now always carries a
 * concrete version that the lockfile and the audit trail can record.
 */
export async function registryMeta(name: string, version: string): Promise<PackageMeta> {
  assertSafePluginName(name);
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(
      `registryMeta requires a strict semver version. Got "${version}". ` +
        `Resolve dist-tags.latest explicitly via resolveLatestPluginVersion if needed.`,
    );
  }
  const res = await fetch(registryUrl(name), {
    signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Registry lookup failed for "${name}" (${res.status})`);
  const body = (await res.json()) as Record<string, unknown>;
  const versions = body.versions as Record<string, unknown> | undefined;
  const info = versions?.[version] as Record<string, unknown> | undefined;
  if (!info) throw new Error(`No registry metadata for ${name}@${version}`);
  const dist = info.dist as Record<string, unknown> | undefined;
  if (typeof dist?.tarball !== 'string') throw new Error(`No tarball for ${name}@${version}`);
  return {
    name,
    version,
    description: typeof info.description === 'string' ? info.description : null,
    tarball: dist.tarball,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
  };
}

export async function downloadTarball(
  url: string,
  name = 'plugin',
  redirectsLeft = MAX_TARBALL_REDIRECTS,
): Promise<Buffer> {
  // Validate the URL up-front so we never fire a request at a non-https /
  // non-allowlisted host even if the registry metadata returned one. Pin
  // `redirect: 'manual'` so a 30x to a host outside the allowlist surfaces
  // as a download failure here instead of silently following the redirect.
  assertHttpsTarballUrl(url, name);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TARBALL_FETCH_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') ?? '<missing>';
    if (location !== '<missing>') {
      // If the redirect target is itself https + allowlisted, follow it
      // explicitly. Anything else is rejected so we cannot be steered onto
      // an unknown host.
      try {
        const next = assertHttpsTarballUrl(location, name);
        if (redirectsLeft <= 0) {
          throw new Error(`too many redirects (>${MAX_TARBALL_REDIRECTS})`);
        }
        return downloadTarball(next.toString(), name, redirectsLeft - 1);
      } catch (err) {
        throw new Error(
          `Tarball redirect rejected for "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new Error(`Tarball download failed (${res.status}): redirect with no location`);
  }
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
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

const TRUSTED_SRI_ALGOS = new Set(['sha256', 'sha384', 'sha512']);

export function verifyIntegrity(buffer: Buffer, meta: PackageMeta, name: string): void {
  if (meta.integrity) {
    const tokens = meta.integrity
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0);
    if (tokens.length === 0) throw new Error(`Empty integrity field for "${name}"`);
    let trustedToken: { algo: string; expectedB64: string } | null = null;
    for (const token of tokens) {
      const match = token.match(/^([a-z0-9]+)-([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error(`Unrecognized integrity token for "${name}": ${token}`);
      const [, algo, expectedB64] = match;
      if (TRUSTED_SRI_ALGOS.has(algo)) {
        trustedToken = { algo, expectedB64 };
        break;
      }
    }
    if (!trustedToken) {
      throw new Error(
        `Integrity field for "${name}" lacks a trusted algorithm ` +
          `(want sha256/sha384/sha512): ${meta.integrity}`,
      );
    }
    const actual = createHash(trustedToken.algo).update(buffer).digest('base64');
    if (actual !== trustedToken.expectedB64) {
      throw new Error(
        `Tarball integrity mismatch for "${name}": ` +
          `expected ${trustedToken.algo}-${trustedToken.expectedB64}, got ${trustedToken.algo}-${actual}`,
      );
    }
    return;
  }
  // SHA1 has been formally collision-broken since 2017 (SHAttered) — refusing
  // it here closes a small but real downgrade window where a registry that
  // omits `dist.integrity` and only returns `dist.shasum` could ship a
  // colliding tarball that passed integrity but contained different code.
  // Modern npm always populates `dist.integrity`; failing closed when only
  // `shasum` is present pushes administrators to fix the upstream rather
  // than silently accepting weak verification.
  throw new Error(
    `Registry response for "${name}" did not include a sha256/sha384/sha512 integrity hash. ` +
      `Refusing to install — SHA1 \`shasum\` fallback is not accepted.`,
  );
}

export function extractTarballStrip1(tgzPath: string, destDir: string): void {
  let totalBytes = 0;
  let totalFiles = 0;
  let firstError: Error | null = null;
  const fail = (msg: string): void => {
    if (!firstError) firstError = new Error(msg);
  };

  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      if (firstError) {
        entry.resume();
        return;
      }
      const type = entry.type;
      if (type !== 'File' && type !== 'OldFile' && type !== 'Directory') {
        entry.resume();
        return;
      }
      const segs = String(entry.path).split('/');
      segs.shift();
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

      if (++totalFiles > MAX_EXTRACTED_FILE_COUNT) {
        fail(`Tarball contains more than ${MAX_EXTRACTED_FILE_COUNT} extractable entries`);
        entry.resume();
        return;
      }
      const declaredSize = typeof entry.size === 'number' ? entry.size : null;
      if (declaredSize !== null) {
        if (declaredSize > MAX_EXTRACTED_FILE_BYTES) {
          fail(
            `Tarball entry "${rel}" declares size ${declaredSize} > per-file cap ${MAX_EXTRACTED_FILE_BYTES}`,
          );
          entry.resume();
          return;
        }
        if (totalBytes + declaredSize > MAX_EXTRACTED_TOTAL_BYTES) {
          fail(
            `Tarball declared total extracted size exceeds cap of ${MAX_EXTRACTED_TOTAL_BYTES} bytes`,
          );
          entry.resume();
          return;
        }
      }

      const chunks: Buffer[] = [];
      let entryBytes = 0;
      entry.on('data', (chunk: Buffer) => {
        if (firstError) return;
        entryBytes += chunk.length;
        if (entryBytes > MAX_EXTRACTED_FILE_BYTES) {
          fail(
            `Tarball entry "${rel}" exceeds per-file extraction cap of ${MAX_EXTRACTED_FILE_BYTES} bytes`,
          );
          return;
        }
        if (totalBytes + entryBytes > MAX_EXTRACTED_TOTAL_BYTES) {
          fail(`Tarball total extracted size exceeds cap of ${MAX_EXTRACTED_TOTAL_BYTES} bytes`);
          return;
        }
        chunks.push(chunk);
      });
      entry.on('end', () => {
        if (firstError) return;
        totalBytes += entryBytes;
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, Buffer.concat(chunks));
      });
    },
  });

  if (firstError) throw firstError;
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
}

function assertTagmaPluginPackage(pkgJson: PackageJson, name: string): void {
  if (pkgJson.name !== name) {
    throw new Error(
      `Package identity mismatch: expected "${name}", got ${JSON.stringify(pkgJson.name)}`,
    );
  }
  const manifest = parsePluginManifestField(pkgJson);
  if (!manifest) {
    throw new Error(
      `Package "${name}" is not a tagma plugin (missing tagmaPlugin manifest in package.json)`,
    );
  }
}

function assertPackageVersion(pkgJson: PackageJson, name: string, version: string): void {
  if (pkgJson.version !== version) {
    throw new Error(
      `Package version mismatch for "${name}": expected ${version}, got ${JSON.stringify(pkgJson.version)}`,
    );
  }
}

function editorVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(pkgUrl, 'utf-8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function desktopVersion(): string | null {
  const candidates = [
    process.env.TAGMA_DESKTOP_VERSION,
    process.env.TAGMA_EDITOR_BUNDLED_VERSION,
    process.env.TAGMA_SIDECAR_BUNDLED_VERSION,
  ];
  const version = candidates.find(
    (candidate) => typeof candidate === 'string' && candidate.length > 0,
  );
  return version ?? null;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  // Empty array means a stable release; non-empty means prerelease
  // identifiers (e.g. ['beta', '1'] for "1.0.0-beta.1"). Build metadata
  // (everything after `+`) is parsed but not retained — semver §10 says it
  // does not affect precedence.
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | null {
  const match = value
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePrereleaseIdentifiers(a: readonly string[], b: readonly string[]): number {
  // Per semver §11: a stable release outranks any prerelease at the same
  // major.minor.patch. Otherwise compare identifiers left-to-right; numeric
  // identifiers compare numerically, alphanumeric identifiers compare ASCII,
  // and numeric always sorts below alphanumeric.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    const aIsNum = /^\d+$/.test(ai);
    const bIsNum = /^\d+$/.test(bi);
    if (aIsNum && bIsNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
    } else if (aIsNum) {
      return -1;
    } else if (bIsNum) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return a.length - b.length;
}

function compareVersionStrings(a: string, b: string): number | null {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) return null;
  if (parsedA.major !== parsedB.major) return parsedA.major - parsedB.major;
  if (parsedA.minor !== parsedB.minor) return parsedA.minor - parsedB.minor;
  if (parsedA.patch !== parsedB.patch) return parsedA.patch - parsedB.patch;
  return comparePrereleaseIdentifiers(parsedA.prerelease, parsedB.prerelease);
}

function assertEditorVersionSupportsPlugin(pkgJson: PackageJson, name: string): void {
  const manifest = parsePluginManifestField(pkgJson);
  const minEditorVersion = manifest?.minEditorVersion;
  if (minEditorVersion) {
    const currentEditorVersion = editorVersion();
    const cmp = compareVersionStrings(currentEditorVersion, minEditorVersion);
    if (cmp === null || cmp < 0) {
      throw new Error(
        `Plugin "${name}" requires tagma-editor package >= ${minEditorVersion}; current tagma-editor package is ${currentEditorVersion}.`,
      );
    }
  }

  const minDesktopVersion = manifest?.minDesktopVersion;
  if (!minDesktopVersion) return;
  const currentDesktopVersion = desktopVersion();
  if (!currentDesktopVersion) {
    throw new Error(
      `Plugin "${name}" requires Tagma desktop >= ${minDesktopVersion}, but this host did not report a desktop version.`,
    );
  }
  const cmp = compareVersionStrings(currentDesktopVersion, minDesktopVersion);
  if (cmp !== null && cmp >= 0) return;
  throw new Error(
    `Plugin "${name}" requires Tagma desktop >= ${minDesktopVersion}; current desktop is ${currentDesktopVersion}.`,
  );
}

function installRootPackageJson(name: string, spec: string): PackageJson {
  return {
    name: `tagma-plugin-store-${name.replace(/[^a-z0-9._-]+/gi, '-')}`,
    private: true,
    dependencies: {
      [name]: spec,
    },
  };
}

function packageManagerEnv(): Record<string, string> {
  const keep = new Set([
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'SHELL',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]);
  const env: Record<string, string> = { BUN_BE_BUN: '1' };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    if (keep.has(key) || key.startsWith('npm_config_') || key.startsWith('BUN_')) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Resolve the Bun binary that should run `bun install` inside the plugin
 * store. In dev `process.execPath` IS bun, so the historical
 * `[process.execPath, 'install', …]` invocation works. In packaged desktop
 * mode the sidecar is a single-file Bun-compiled `tagma-editor-server`
 * binary and `process.execPath` points at THAT — running
 * `tagma-editor-server install` does not invoke `bun install` and silently
 * returns immediately, leaving plugins with unresolved dependencies.
 *
 * Resolution order:
 *   1. `TAGMA_BUN_BIN` — explicit override the Electron launcher can pin
 *      to a bundled bun under resources/bun/bin/.
 *   2. `process.execPath` when the basename is `bun` (POSIX) or `bun.exe`
 *      (Windows). This is the dev case where the sidecar is launched as
 *      `bun apps/editor/server/index.ts` so reusing the same runtime is
 *      the cheapest correct answer.
 *   3. `Bun.which('bun')` — sidecar started from a non-bun launcher but
 *      bun is otherwise on PATH.
 *   4. Otherwise throw with a clear "bun is required" error so the desktop
 *      packager knows it must ship one (or skip plugin install entirely).
 */
function resolveBunBinary(): string {
  const explicit = process.env.TAGMA_BUN_BIN?.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(
        `TAGMA_BUN_BIN points at "${explicit}" but no file exists there. ` +
          `Set it to a real bun executable or unset to use the auto-detected one.`,
      );
    }
    return explicit;
  }
  // execPath is bun only when we're running under bun directly. The
  // single-file Bun-compiled sidecar reports a non-empty Bun.version too,
  // but its execPath is the sidecar binary, not bun — invoking it with
  // ['install'] starts another sidecar instance instead of running the
  // package manager. Detect that by checking the basename.
  const exec = process.execPath;
  const lower = exec.toLowerCase();
  const bunSuffix = process.platform === 'win32' ? '\\bun.exe' : '/bun';
  if (lower.endsWith(bunSuffix)) {
    return exec;
  }
  const fromPath = typeof Bun !== 'undefined' ? Bun.which('bun') : null;
  if (fromPath) return fromPath;
  throw new Error(
    'Cannot resolve a `bun` binary to install plugin dependencies. ' +
      'Set TAGMA_BUN_BIN to a real bun executable (e.g. bundled under resources/bun/bin/) ' +
      'so packaged builds can run `bun install` for the isolated plugin store.',
  );
}

async function syncPluginStoreDependencies(root: string): Promise<void> {
  const bun = resolveBunBinary();
  const proc = Bun.spawn([bun, 'install', '--ignore-scripts'], {
    cwd: root,
    env: packageManagerEnv(),
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
    throw new Error(`bun install failed while resolving isolated plugin dependencies: ${detail}`);
  }
}

function prepareInstallRoot(ws: WorkspaceState, name: string, spec: string): string {
  const root = pluginStoreDirFor(ws, name);
  fenceWithinPluginStore(ws, root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(
    resolve(root, 'package.json'),
    `${JSON.stringify(installRootPackageJson(name, spec), null, 2)}\n`,
  );
  return root;
}

function installedPluginPackagePath(ws: WorkspaceState, name: string): string {
  const pluginDir = pluginStorePackageDirFor(ws, name);
  fenceWithinPluginStore(ws, pluginDir);
  return resolve(pluginDir, 'package.json');
}

function validateInstalledPlugin(ws: WorkspaceState, name: string, version?: string): PackageJson {
  const pkgPath = installedPluginPackagePath(ws, name);
  if (!existsSync(pkgPath))
    throw new Error(`Plugin "${name}" was not installed in its isolated store`);
  const pkg = readPackageJson(pkgPath);
  assertTagmaPluginPackage(pkg, name);
  if (version) assertPackageVersion(pkg, name, version);
  assertEditorVersionSupportsPlugin(pkg, name);
  assertNoSymlinksInDir(pluginStorePackageDirFor(ws, name), `Plugin "${name}"`);
  return pkg;
}

export function readLocalPluginPackageName(absPath: string): string {
  const stat = statSync(absPath);
  let sourceDir: string;
  let cleanupTmp: string | null = null;

  if (stat.isDirectory()) {
    sourceDir = absPath;
  } else {
    cleanupTmp = mkdtempSync(join(tmpdir(), 'tagma-local-inspect-'));
    extractTarballStrip1(absPath, cleanupTmp);
    sourceDir = cleanupTmp;
  }

  try {
    const srcPkgPath = resolve(sourceDir, 'package.json');
    if (!existsSync(srcPkgPath)) throw new Error('Source does not contain a package.json');
    const srcPkg = readPackageJson(srcPkgPath);
    const pkgName = srcPkg.name;
    if (typeof pkgName !== 'string' || !pkgName) {
      throw new Error('Source package.json has no "name" field');
    }
    assertSafePluginName(pkgName);
    assertTagmaPluginPackage(srcPkg, pkgName);
    assertEditorVersionSupportsPlugin(srcPkg, pkgName);
    return pkgName;
  } finally {
    if (cleanupTmp) rmSync(cleanupTmp, { recursive: true, force: true });
  }
}

function pluginVersionLockPath(ws: WorkspaceState): string {
  return resolve(ws.workDir, '.tagma', 'plugins-lock.json');
}

export function readPluginVersionLock(ws: WorkspaceState): PluginVersionLockFile {
  if (!ws.workDir) return { plugins: [] };
  try {
    const p = pluginVersionLockPath(ws);
    if (!existsSync(p)) return { plugins: [] };
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { plugins?: unknown };
    if (!Array.isArray(parsed.plugins)) return { plugins: [] };
    return {
      plugins: parsed.plugins.filter((entry): entry is PluginVersionLockEntry => {
        const rec = entry as Record<string, unknown>;
        return (
          !!rec &&
          typeof rec.name === 'string' &&
          typeof rec.version === 'string' &&
          VERSION_RE.test(rec.version) &&
          (rec.integrity === null || typeof rec.integrity === 'string') &&
          (rec.shasum === null || typeof rec.shasum === 'string') &&
          typeof rec.lockedAt === 'string'
        );
      }),
    };
  } catch {
    return { plugins: [] };
  }
}

function writePluginVersionLock(ws: WorkspaceState, lock: PluginVersionLockFile): void {
  const dir = resolve(ws.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(pluginVersionLockPath(ws), JSON.stringify(lock, null, 2) + '\n');
}

export function getPluginVersionLock(
  ws: WorkspaceState,
  name: string,
): PluginVersionLockEntry | null {
  return readPluginVersionLock(ws).plugins.find((entry) => entry.name === name) ?? null;
}

export function recordPluginVersionLock(ws: WorkspaceState, meta: PackageMeta): void {
  const lock = readPluginVersionLock(ws);
  const plugins = lock.plugins.filter((entry) => entry.name !== meta.name);
  plugins.push({
    name: meta.name,
    version: meta.version,
    integrity: meta.integrity,
    shasum: meta.shasum,
    lockedAt: new Date().toISOString(),
  });
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  writePluginVersionLock(ws, { plugins });
}

export function removePluginVersionLock(ws: WorkspaceState, name: string): void {
  if (!ws.workDir) return;
  const lock = readPluginVersionLock(ws);
  const plugins = lock.plugins.filter((entry) => entry.name !== name);
  if (plugins.length !== lock.plugins.length) writePluginVersionLock(ws, { plugins });
}

function assertRegistryMetaMatchesLock(meta: PackageMeta, lock: PluginVersionLockEntry): void {
  if (meta.version !== lock.version) {
    throw new Error(
      `Plugin lock mismatch for "${meta.name}": expected ${lock.version}, got ${meta.version}`,
    );
  }
  if (lock.integrity && meta.integrity !== lock.integrity) {
    throw new Error(
      `Plugin lock mismatch for "${meta.name}": registry integrity changed for ${meta.version}`,
    );
  }
  if (!lock.integrity && lock.shasum && meta.shasum !== lock.shasum) {
    throw new Error(
      `Plugin lock mismatch for "${meta.name}": registry shasum changed for ${meta.version}`,
    );
  }
}

export async function preflightRegistryPackage(
  ws: WorkspaceState,
  specOrName: PluginInstallSpec | string,
  options: { preferLocked?: boolean } = {},
): Promise<RegistryPackagePreflight> {
  const spec = typeof specOrName === 'string' ? parsePluginInstallSpec(specOrName) : specOrName;
  assertSafePluginName(spec.name);
  const lock =
    options.preferLocked !== false && !spec.version ? getPluginVersionLock(ws, spec.name) : null;
  // The install pipeline always requires a concrete pinned version. Either
  // the caller passed one explicitly, or the workspace lockfile has one
  // recorded from a prior install. If neither is available, refuse —
  // silently substituting `dist-tags.latest` here would race a malicious
  // publish into the workspace and skip the audit trail. Callers that
  // genuinely want "install latest" must call resolveLatestPluginVersion
  // first and pass the resolved version in the spec.
  const pinnedVersion = spec.version ?? lock?.version;
  if (!pinnedVersion) {
    throw new Error(
      `Refusing to install "${spec.name}" without a pinned version. ` +
        `Pass a concrete semver in the spec, or call resolveLatestPluginVersion(name) first.`,
    );
  }
  const meta = await registryMeta(spec.name, pinnedVersion);
  if (lock) assertRegistryMetaMatchesLock(meta, lock);

  const tarBuffer = await downloadTarball(meta.tarball, spec.name);
  verifyIntegrity(tarBuffer, meta, spec.name);

  const tmpDir = mkdtempSync(join(tmpdir(), 'tagma-pkg-'));
  const tgzPath = join(tmpDir, 'package.tgz');
  const verifiedPackageDir = join(tmpDir, 'verified');
  writeFileSync(tgzPath, tarBuffer);
  mkdirSync(verifiedPackageDir, { recursive: true });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    extractTarballStrip1(tgzPath, verifiedPackageDir);
    const installedPkgPath = resolve(verifiedPackageDir, 'package.json');
    if (!existsSync(installedPkgPath)) {
      throw new Error(`Installed package "${spec.name}" did not contain a package.json`);
    }
    const installedPkg = readPackageJson(installedPkgPath);
    assertTagmaPluginPackage(installedPkg, spec.name);
    assertPackageVersion(installedPkg, spec.name, meta.version);
    assertEditorVersionSupportsPlugin(installedPkg, spec.name);
    return { meta, packageJson: installedPkg, verifiedPackageDir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function replaceInstalledPackageWithVerifiedCopy(
  ws: WorkspaceState,
  name: string,
  verifiedPackageDir: string,
): void {
  const pluginDir = pluginStorePackageDirFor(ws, name);
  fenceWithinPluginStore(ws, pluginDir);
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(dirname(pluginDir), { recursive: true });
  cpSync(verifiedPackageDir, pluginDir, { recursive: true, dereference: false });
}

export async function directRegistryInstall(
  ws: WorkspaceState,
  specOrName: PluginInstallSpec | string,
  options: { preferLocked?: boolean } = {},
): Promise<RegistryPackagePreflight & PluginInstallOutcome> {
  const preflight = await preflightRegistryPackage(ws, specOrName, options);
  return { ...preflight, pluginRoot: pluginStoreDirFor(ws, preflight.meta.name) };
}

export async function installPackage(
  ws: WorkspaceState,
  name: string,
): Promise<PluginInstallOutcome> {
  const spec = parsePluginInstallSpec(name);
  // Prefer the lockfile when present — that's the whole point of having
  // one for autoload. When neither the spec nor the lock pin a version,
  // resolve latest explicitly so the install path always carries a
  // concrete pinned version (no silent dist-tags.latest substitution).
  if (!spec.version && !getPluginVersionLock(ws, name)) {
    spec.version = await resolveLatestPluginVersion(name);
  }
  return installPackageSpec(ws, spec, { preferLocked: true });
}

export async function installPackageSpec(
  ws: WorkspaceState,
  spec: PluginInstallSpec,
  options: { preferLocked?: boolean } = {},
): Promise<PluginInstallOutcome> {
  const result = await installPackageSpecWithRollbackSnapshot(ws, spec, options);
  discardPluginSnapshot(result.snapshot);
  return { pluginRoot: result.pluginRoot };
}

export async function installPackageSpecWithRollbackSnapshot(
  ws: WorkspaceState,
  spec: PluginInstallSpec,
  options: { preferLocked?: boolean } = {},
): Promise<PluginInstallTransactionOutcome> {
  if (!ws.workDir) throw new Error('Cannot install plugin before setting a working directory');
  const snapshot = snapshotPluginState(ws, spec.name);
  let preflight: RegistryPackagePreflight | null = null;
  try {
    preflight = await preflightRegistryPackage(ws, spec, options);
    const root = prepareInstallRoot(ws, spec.name, preflight.meta.version);
    await syncPluginStoreDependencies(root);
    replaceInstalledPackageWithVerifiedCopy(ws, spec.name, preflight.verifiedPackageDir);
    validateInstalledPlugin(ws, spec.name, preflight.meta.version);
    recordPluginVersionLock(ws, preflight.meta);
    return { pluginRoot: root, snapshot };
  } catch (err) {
    restorePluginState(ws, snapshot);
    throw err;
  } finally {
    preflight?.cleanup();
  }
}

function currentPluginVersion(ws: WorkspaceState, name: string): string | null {
  try {
    const pkgPath = installedPluginPackagePath(ws, name);
    if (!existsSync(pkgPath)) return null;
    const pkg = readPackageJson(pkgPath);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function isStrictVersionUpgrade(current: string | null, latest: string): boolean {
  if (!current) return false;
  const cmp = compareVersionStrings(latest, current);
  return cmp !== null && cmp > 0;
}

const LOCAL_DEP_SPEC_PREFIXES = ['file:', 'link:', 'workspace:', 'portal:', 'patch:'];

function isLocalDependencySpec(spec: string): boolean {
  const trimmed = spec.trim();
  return LOCAL_DEP_SPEC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function readStoreRootDependencySpec(ws: WorkspaceState, name: string): string | null {
  if (!ws.workDir) return null;
  const root = pluginStoreDirFor(ws, name);
  const pkgPath = resolve(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = readPackageJson(pkgPath);
    const spec = pkg.dependencies?.[name];
    return typeof spec === 'string' ? spec : null;
  } catch {
    return null;
  }
}

export async function planPluginUpgrade(
  ws: WorkspaceState,
  name: string,
  options: { preflight?: boolean } = {},
): Promise<PluginUpgradePlan> {
  assertSafePluginName(name);
  const current = currentPluginVersion(ws, name);
  if (!current) {
    return {
      status: 'blocked',
      target: name,
      upgrades: [],
      blockers: [
        { name, currentVersion: null, latestVersion: null, reason: 'plugin is not installed' },
      ],
      message: `Plugin "${name}" is not installed in this workspace.`,
      warnings: [],
    };
  }
  // A locally-imported plugin's store root pins `file:<absPath>`; promoting
  // it to a registry version would silently replace the user's local copy
  // on next Upgrade click. Refuse the plan and tell them to handle it
  // manually (uninstall + re-import, or edit the local source).
  const installSpec = readStoreRootDependencySpec(ws, name);
  if (installSpec && isLocalDependencySpec(installSpec)) {
    return {
      status: 'blocked',
      target: name,
      upgrades: [],
      blockers: [
        {
          name,
          currentVersion: current,
          latestVersion: null,
          reason: 'installed from a local/workspace dependency; update it manually or uninstall it',
        },
      ],
      message: `Cannot upgrade "${name}": installed from a local source (${installSpec}). Re-import a newer copy or uninstall first.`,
      warnings: [],
    };
  }
  // The default plan path runs a full preflight (download + integrity +
  // tagmaPlugin + host version gates) so the UI never advertises an Upgrade
  // the server would 409 on at install time. Internal callers that hand
  // the plan straight to the installer pass `preflight: false` because the
  // installer's own preflight is authoritative — running it twice would
  // download the tarball twice for one user click.
  const runPreflight = options.preflight !== false;
  let preflight: RegistryPackagePreflight | null = null;
  try {
    // Resolve the registry's "latest" tag explicitly. The previous code
    // called `registryMeta(name)` and relied on a silent dist-tags.latest
    // fallback; that fallback is gone (registryMeta now requires a pinned
    // version), so the upgrade flow has to pin "latest" itself before
    // probing per-version metadata.
    const latestVersion = await resolveLatestPluginVersion(name);
    const meta = await registryMeta(name, latestVersion);
    if (!isStrictVersionUpgrade(current, meta.version)) {
      return {
        status: 'blocked',
        target: name,
        upgrades: [],
        blockers: [
          {
            name,
            currentVersion: current,
            latestVersion: meta.version,
            reason: 'no newer npm version is available',
          },
        ],
        message: `Cannot upgrade "${name}": no newer npm version is available.`,
        warnings: [],
      };
    }
    if (runPreflight) {
      // Pass the resolved latest version through so the preflight runs
      // against a known target and the pinned-version invariant holds.
      preflight = await preflightRegistryPackage(
        ws,
        { name, version: latestVersion },
        { preferLocked: false },
      );
    }
    const targetVersion = preflight?.meta.version ?? meta.version;
    return {
      status: 'ready',
      target: name,
      upgrades: [{ name, fromVersion: current, toVersion: targetVersion, reason: 'target' }],
      warnings: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'blocked',
      target: name,
      upgrades: [],
      blockers: [
        {
          name,
          currentVersion: current,
          latestVersion: preflight?.meta.version ?? null,
          reason: message,
        },
      ],
      message: `Cannot upgrade "${name}": ${message}.`,
      warnings: [],
    };
  } finally {
    preflight?.cleanup();
  }
}

function snapshotPluginBatchState(
  ws: WorkspaceState,
  names: readonly string[],
): PluginBatchStateSnapshot {
  return { snapshots: names.map((name) => snapshotPluginState(ws, name)) };
}

export function discardPluginBatchSnapshot(snapshot: PluginBatchStateSnapshot | null): void {
  if (!snapshot) return;
  for (const pluginSnapshot of snapshot.snapshots) discardPluginSnapshot(pluginSnapshot);
}

export async function restorePluginBatchStateAndResync(
  ws: WorkspaceState,
  snapshot: PluginBatchStateSnapshot,
): Promise<void> {
  for (const pluginSnapshot of snapshot.snapshots) restorePluginStateContents(ws, pluginSnapshot);
  discardPluginBatchSnapshot(snapshot);
}

export async function installPluginUpgradeBatchWithRollbackSnapshot(
  ws: WorkspaceState,
  name: string,
): Promise<PluginUpgradeBatchTransactionOutcome> {
  // Skip the plan-time preflight: installPackageSpecWithRollbackSnapshot
  // below runs its own authoritative preflight, so duplicating the tarball
  // download here would mean ~2× the bytes per upgrade click.
  const plan = await planPluginUpgrade(ws, name, { preflight: false });
  if (plan.status === 'blocked') throw new Error(plan.message);
  const snapshot = snapshotPluginBatchState(
    ws,
    plan.upgrades.map((entry) => entry.name),
  );
  try {
    let pluginRoot = pluginStoreDirFor(ws, name);
    for (const entry of plan.upgrades) {
      const result = await installPackageSpecWithRollbackSnapshot(
        ws,
        { name: entry.name, version: entry.toVersion },
        { preferLocked: false },
      );
      pluginRoot = result.pluginRoot;
      discardPluginSnapshot(result.snapshot);
    }
    return { plan, pluginRoot, snapshot };
  } catch (err) {
    for (const pluginSnapshot of snapshot.snapshots) restorePluginStateContents(ws, pluginSnapshot);
    discardPluginBatchSnapshot(snapshot);
    throw err;
  }
}

export async function installFromLocalPath(
  ws: WorkspaceState,
  absPath: string,
): Promise<PluginInstallOutcome & { name: string }> {
  const result = await installFromLocalPathWithRollbackSnapshot(ws, absPath);
  discardPluginSnapshot(result.snapshot);
  return { name: result.name, pluginRoot: result.pluginRoot };
}

export async function installFromLocalPathWithRollbackSnapshot(
  ws: WorkspaceState,
  absPath: string,
): Promise<LocalPluginInstallTransactionOutcome> {
  if (!ws.workDir) throw new Error('Cannot install plugin before setting a working directory');
  const pkgName = readLocalPluginPackageName(absPath);
  const snapshot = snapshotPluginState(ws, pkgName);
  try {
    const root = prepareInstallRoot(ws, pkgName, `file:${absPath}`);
    await syncPluginStoreDependencies(root);
    validateInstalledPlugin(ws, pkgName);
    removePluginVersionLock(ws, pkgName);
    return { name: pkgName, pluginRoot: root, snapshot };
  } catch (err) {
    restorePluginState(ws, snapshot);
    throw err;
  }
}

function removePluginFilesystemArtifacts(ws: WorkspaceState, name: string): void {
  const root = pluginStoreDirFor(ws, name);
  fenceWithinPluginStore(ws, root);
  rmSync(root, { recursive: true, force: true });
}

export function uninstallPackage(ws: WorkspaceState, name: string): void {
  assertSafePluginName(name);
  removePluginFilesystemArtifacts(ws, name);
  removePluginVersionLock(ws, name);
}

export interface PluginStateSnapshot {
  name: string;
  snapshotDir: string;
  prevLockEntry: PluginVersionLockEntry | null;
  hadPriorFiles: boolean;
  lockfiles: WorkspaceFileSnapshot[];
  // Membership in `.tagma/plugins.json` and `.tagma/plugin-blocklist.json`
  // before the install. Routes write manifest/blocklist between snapshot and
  // load, so a load-failure rollback that only restored on-disk state would
  // leave the manifest claiming a plugin is installed when its store has
  // been wiped, or leave the blocklist cleared after the user explicitly
  // chose to keep the plugin out.
  prevManifestHadEntry: boolean;
  prevBlocklistHadEntry: boolean;
}

export function snapshotPluginState(ws: WorkspaceState, name: string): PluginStateSnapshot {
  assertSafePluginName(name);
  if (!ws.workDir) throw new Error('Cannot snapshot plugin state: workspace directory is not set');
  const root = pluginStoreDirFor(ws, name);
  fenceWithinPluginStore(ws, root);
  const snapshotDir = mkdtempSync(join(tmpdir(), 'tagma-pkg-snap-'));
  const hadPriorFiles = existsSync(root);
  if (hadPriorFiles) cpSync(root, snapshotDir, { recursive: true, dereference: false });
  return {
    name,
    snapshotDir,
    prevLockEntry: getPluginVersionLock(ws, name),
    hadPriorFiles,
    lockfiles: snapshotPluginStoreLockfiles(ws, name),
    prevManifestHadEntry: readPluginManifest(ws).includes(name),
    prevBlocklistHadEntry: readPluginBlocklist(ws).includes(name),
  };
}

function snapshotPluginStoreLockfiles(ws: WorkspaceState, name: string): WorkspaceFileSnapshot[] {
  const root = pluginStoreDirFor(ws, name);
  return ['bun.lock', 'bun.lockb'].map((fileName) => {
    const path = resolve(root, fileName);
    return { path, contents: existsSync(path) ? readFileSync(path) : null };
  });
}

function restorePluginStateContents(ws: WorkspaceState, snapshot: PluginStateSnapshot): void {
  const root = pluginStoreDirFor(ws, snapshot.name);
  fenceWithinPluginStore(ws, root);
  rmSync(root, { recursive: true, force: true });
  if (snapshot.hadPriorFiles && existsSync(snapshot.snapshotDir)) {
    mkdirSync(dirname(root), { recursive: true });
    cpSync(snapshot.snapshotDir, root, { recursive: true, dereference: false });
  }
  restoreWorkspaceLockfiles(snapshot.lockfiles);
  restorePluginVersionLockEntry(ws, snapshot.name, snapshot.prevLockEntry);
  try {
    if (snapshot.prevManifestHadEntry) addToPluginManifest(ws, snapshot.name);
    else removeFromPluginManifest(ws, snapshot.name);
  } catch (err) {
    console.error(
      `[plugins] failed to restore manifest entry for "${snapshot.name}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
  try {
    if (snapshot.prevBlocklistHadEntry) addToPluginBlocklist(ws, snapshot.name);
    else removeFromPluginBlocklist(ws, snapshot.name);
  } catch (err) {
    console.error(
      `[plugins] failed to restore blocklist entry for "${snapshot.name}":`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function restorePluginState(ws: WorkspaceState, snapshot: PluginStateSnapshot): void {
  restorePluginStateContents(ws, snapshot);
  discardPluginSnapshot(snapshot);
}

export async function restorePluginStateAndResync(
  ws: WorkspaceState,
  snapshot: PluginStateSnapshot,
): Promise<void> {
  restorePluginState(ws, snapshot);
}

function restorePluginVersionLockEntry(
  ws: WorkspaceState,
  name: string,
  entry: PluginVersionLockEntry | null,
): void {
  const lock = readPluginVersionLock(ws);
  const plugins = lock.plugins.filter((candidate) => candidate.name !== name);
  if (entry) plugins.push(entry);
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  writePluginVersionLock(ws, { plugins });
}

function restoreWorkspaceLockfiles(lockfiles: readonly WorkspaceFileSnapshot[]): void {
  for (const file of lockfiles) {
    try {
      if (file.contents === null) {
        if (existsSync(file.path)) rmSync(file.path, { force: true });
      } else {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.contents);
      }
    } catch (err) {
      console.error(
        `[plugins] failed to restore ${file.path}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export function discardPluginSnapshot(snapshot: PluginStateSnapshot | null): void {
  if (!snapshot) return;
  try {
    rmSync(snapshot.snapshotDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export function listPluginStoreNames(ws: WorkspaceState): string[] {
  const root = resolve(ws.workDir, '.tagma', 'plugin-store');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
