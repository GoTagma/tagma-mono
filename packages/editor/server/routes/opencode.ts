import type express from 'express';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { errorMessage } from '../path-utils.js';

/**
 * OpenCode CLI bundle + update API.
 *
 * The desktop app ships a pinned opencode binary under
 * `resources/opencode/bin/` (staged at build time by
 * `packages/electron/scripts/fetch-opencode.mjs`). The sidecar's PATH is
 * prepended with that directory plus a writable `userData/opencode/bin/`
 * layer so in-app updates land in userData and win over the signed bundle.
 *
 * Endpoints:
 *   GET  /api/opencode/info   — what's shipped, what's running, what's latest
 *   POST /api/opencode/update — fetch `opencode-ai@<target>` for the current
 *                               platform/arch and extract the binary into
 *                               userData/opencode/bin/. Next spawn picks it
 *                               up automatically via the already-prepended
 *                               PATH layer; no app restart required.
 *
 * Why re-implement fetch/verify/extract here instead of reusing
 * server/plugins/install.ts? That module's MAX_TARBALL_BYTES is 50 MB —
 * opencode platform tarballs are 100–150 MB because they ship a
 * self-contained Bun single-file executable. Duplicating the minimal logic
 * keeps the plugin installer's tight cap intact while letting the opencode
 * path run under a larger (but still bounded) ceiling.
 */

const NPM_REGISTRY = 'https://registry.npmjs.org';
const REGISTRY_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 180_000;
const MAX_OPENCODE_TARBALL_BYTES = 200 * 1024 * 1024; // 200 MB hard cap

// Cache /api/opencode/info's npm lookup so rapid-fire clicks in the Settings
// panel don't each fire a registry request. 5-minute TTL matches how fast a
// user could plausibly need a fresh answer without stampeding npm.
const LATEST_CACHE_TTL_MS = 5 * 60 * 1000;
let latestCache: { value: string; fetchedAt: number } | null = null;

function resolvePackageName(): string {
  const osSegment = process.platform === 'win32' ? 'windows' : process.platform;
  if (process.arch === 'x64') return `opencode-${osSegment}-x64-baseline`;
  if (process.arch === 'arm64') return `opencode-${osSegment}-arm64`;
  throw new Error(`Unsupported opencode target for this machine: ${process.platform}/${process.arch}`);
}

function binaryRelPath(): string {
  return process.platform === 'win32' ? 'bin/opencode.exe' : 'bin/opencode';
}

async function runOpencodeVersion(): Promise<string | null> {
  // Spawn `opencode --version` using the sidecar's PATH (bundled + userData
  // layers prepended by runtime-paths.ts). Returns the trimmed version string
  // or null when the CLI can't be resolved / exits non-zero.
  try {
    const proc = Bun.spawn(['opencode', '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    const line = stdout.split(/\r?\n/).find((s) => s.trim().length > 0);
    if (!line) return null;
    // `opencode --version` prints a bare semver (e.g. "1.4.4"); be tolerant
    // of a leading "v" or `opencode 1.4.4` prefix in case upstream changes.
    const m = line.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
    return m ? m[1] : line.trim();
  } catch {
    return null;
  }
}

function readUserVersion(userDir: string | undefined): string | null {
  if (!userDir) return null;
  try {
    const p = join(userDir, 'version.txt');
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion(): Promise<string> {
  const now = Date.now();
  if (latestCache && now - latestCache.fetchedAt < LATEST_CACHE_TTL_MS) {
    return latestCache.value;
  }
  const res = await fetch(`${NPM_REGISTRY}/opencode-ai/latest`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Registry lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error('Registry response missing "version"');
  }
  latestCache = { value: body.version, fetchedAt: now };
  return body.version;
}

async function fetchRegistryMeta(
  pkgName: string,
  version: string,
): Promise<{ tarball: string; integrity: string | null; shasum: string | null }> {
  const res = await fetch(`${NPM_REGISTRY}/${pkgName}/${version}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Registry fetch failed for ${pkgName}@${version}: HTTP ${res.status}`);
  const body = (await res.json()) as { dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown } };
  const dist = body.dist ?? {};
  if (typeof dist.tarball !== 'string') {
    throw new Error(`No tarball URL for ${pkgName}@${version}`);
  }
  return {
    tarball: dist.tarball,
    integrity: typeof dist.integrity === 'string' ? dist.integrity : null,
    shasum: typeof dist.shasum === 'string' ? dist.shasum : null,
  };
}

async function downloadTarball(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Tarball download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error('Tarball response has no body');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_OPENCODE_TARBALL_BYTES) {
    throw new Error(
      `Tarball too large: declared ${declared} bytes exceeds ${MAX_OPENCODE_TARBALL_BYTES} byte cap`,
    );
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_OPENCODE_TARBALL_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`Tarball exceeds ${MAX_OPENCODE_TARBALL_BYTES} byte cap (received ${total}+)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );
}

function verifyIntegrity(
  buf: Buffer,
  meta: { integrity: string | null; shasum: string | null },
  pkgName: string,
): void {
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
  throw new Error(
    `Registry returned no integrity or shasum for ${pkgName}. Refusing to install unverified tarball.`,
  );
}

function extractBinary(tgzPath: string, destFile: string, isWindows: boolean): void {
  // Same Bun+tar-v7 workaround as server/plugins/install.ts — stream entries
  // manually because tar.x() silently drops file contents under Bun.
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
      segs.shift(); // strip: 1 (drop leading "package/")
      const rel = segs.join('/');
      if (rel !== wantRelPath) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        mkdirSync(dirname(destFile), { recursive: true });
        writeFileSync(destFile, Buffer.concat(chunks));
        if (!isWindows) chmodSync(destFile, 0o755);
        written = true;
      });
    },
  });
  if (!written) {
    throw new Error(`Did not find ${wantRelPath} in tarball — opencode layout may have changed.`);
  }
}

// Serialize concurrent /api/opencode/update requests so a second click mid-
// download can't race the first and leave a half-written binary behind.
let updateInFlight: Promise<unknown> | null = null;

async function performUpdate(
  targetVersion: string,
): Promise<{ version: string; path: string }> {
  const userDir = process.env.TAGMA_OPENCODE_USER_DIR;
  if (!userDir) {
    throw new Error(
      'OpenCode updates require a writable userData directory. This is only available when running under the desktop app.',
    );
  }
  const pkgName = resolvePackageName();
  const meta = await fetchRegistryMeta(pkgName, targetVersion);
  const buf = await downloadTarball(meta.tarball);
  verifyIntegrity(buf, meta, pkgName);

  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-opencode-update-'));
  const tgzPath = join(tempRoot, 'pkg.tgz');
  writeFileSync(tgzPath, buf);
  try {
    const binDir = join(userDir, 'bin');
    const destBinary = join(binDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    // Replace any prior user-installed binary atomically-ish: extract to a
    // staging name then rename. tar's extractor writes directly to destFile,
    // so we extract into a sibling staging file first.
    const stagingBinary = destBinary + '.staging';
    if (existsSync(stagingBinary)) rmSync(stagingBinary, { force: true });
    mkdirSync(binDir, { recursive: true });
    // Extract straight to stagingBinary by temporarily renaming the target
    // path the extractor is asked to write — avoids ripping out the currently
    // running binary (Windows locks an in-use .exe against deletion).
    extractBinary(tgzPath, stagingBinary, process.platform === 'win32');
    if (existsSync(destBinary)) {
      // On Windows, deleting a locked in-use .exe fails; rename-overwrite is
      // fine because the current process isn't holding the binary open.
      try {
        rmSync(destBinary, { force: true });
      } catch (err) {
        throw new Error(
          `Failed to remove previous opencode binary at ${destBinary}. ` +
            `If OpenCode is running, close it and retry. (${errorMessage(err)})`,
        );
      }
    }
    // `rename` across the staging path; falling back to copy+rm is not
    // needed because both live in the same directory.
    renameSync(stagingBinary, destBinary);
    writeFileSync(join(userDir, 'version.txt'), targetVersion + '\n', 'utf-8');
    return { version: targetVersion, path: destBinary };
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function registerOpencodeRoutes(app: express.Express): void {
  app.get('/api/opencode/info', async (_req, res) => {
    try {
      const userDir = process.env.TAGMA_OPENCODE_USER_DIR ?? null;
      const bundledVersion = process.env.TAGMA_OPENCODE_BUNDLED_VERSION ?? null;
      const userInstalledVersion = readUserVersion(userDir ?? undefined);

      const [runningVersion, latestVersion] = await Promise.all([
        runOpencodeVersion(),
        fetchLatestVersion().catch(() => null),
      ]);

      // Active version drives the "update available" comparison: prefer the
      // user-installed override when present (that's what PATH resolves to),
      // fall back to bundled for freshly-installed desktops, fall back to
      // the running probe when neither env var is set (dev / SDK direct use).
      const activeVersion = userInstalledVersion ?? bundledVersion ?? runningVersion;
      const updateAvailable =
        !!latestVersion && !!activeVersion && latestVersion !== activeVersion;

      res.json({
        bundledVersion,
        runningVersion,
        userInstalledVersion,
        latestVersion,
        updateAvailable,
        canUpdate: !!userDir,
        platform: process.platform,
        arch: process.arch,
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/opencode/update', async (req, res) => {
    try {
      if (updateInFlight) {
        return res.status(409).json({ error: 'Another opencode update is already running.' });
      }
      const body = (req.body ?? {}) as { version?: unknown };
      const targetVersion =
        typeof body.version === 'string' && body.version ? body.version : await fetchLatestVersion();

      const task = performUpdate(targetVersion);
      updateInFlight = task;
      try {
        const result = await task;
        // Invalidate the latest-version cache so a follow-up /info call shows
        // the fresh "no update available" state immediately.
        latestCache = null;
        res.json({ ok: true, version: result.version, path: result.path });
      } finally {
        updateInFlight = null;
      }
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
