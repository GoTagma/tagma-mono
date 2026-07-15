import type express from 'express';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { errorMessage } from '../path-utils.js';
import {
  ensureOpencode,
  ensureRealTagmaDirectory,
  resolveOpencodeBinary,
  restartOpencode,
  stopOpencodeProcesses,
} from '../opencode-lifecycle.js';
import { seedOpencodeArtifacts } from '../opencode-seed.js';
import { buildOpencodeSeedOptions } from '../opencode-seed-options.js';
import { startChatCompileWatcher } from '../chat-compile-watcher.js';
import { requireWorkspace } from '../require-workspace.js';
import { cancelHotupdate, endHotupdate, tryBeginHotupdate } from '../release/hotupdate-lock.js';
import { S } from '../state.js';
import {
  canBypassYamlEditLock,
  getActiveYamlEditLock,
  publicYamlEditLock,
} from '../yaml-edit-lock.js';

/**
 * OpenCode CLI bundle + update API.
 *
 * The desktop app ships a pinned opencode binary under
 * `resources/opencode/bin/` (staged at build time by
 * `apps/electron/scripts/fetch-opencode.mjs`). The sidecar's PATH is
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
const MAX_OPENCODE_TARBALL_REDIRECTS = 5;

const ALLOWED_TARBALL_HOSTS: ReadonlySet<string> = new Set([
  'registry.npmjs.org',
  'registry.npmjs.com',
]);

const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function assertStrictSemver(version: string, label: string): string {
  if (!STRICT_SEMVER_RE.test(version)) {
    throw new Error(`${label} is not a strict semver value: "${version}"`);
  }
  return version;
}

function assertHttpsTarballUrl(url: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} URL must be https://, got ${parsed.protocol}//${parsed.host}`);
  }
  if (!ALLOWED_TARBALL_HOSTS.has(parsed.host.toLowerCase())) {
    throw new Error(
      `${label} URL host "${parsed.host}" is not in the registry allowlist ` +
        `(${[...ALLOWED_TARBALL_HOSTS].join(', ')}).`,
    );
  }
  return parsed;
}

// Cache /api/opencode/info's npm lookup so rapid-fire clicks in the Settings
// panel don't each fire a registry request. 5-minute TTL matches how fast a
// user could plausibly need a fresh answer without stampeding npm.
const LATEST_CACHE_TTL_MS = 5 * 60 * 1000;
let latestCache: { value: string; fetchedAt: number } | null = null;

function resolvePackageName(): string {
  const osSegment = process.platform === 'win32' ? 'windows' : process.platform;
  if (process.arch === 'x64') return `opencode-${osSegment}-x64-baseline`;
  if (process.arch === 'arm64') return `opencode-${osSegment}-arm64`;
  throw new Error(
    `Unsupported opencode target for this machine: ${process.platform}/${process.arch}`,
  );
}

async function runOpencodeVersion(): Promise<string | null> {
  // Spawn `<resolved-opencode> --version`. Goes through the same resolver the
  // lifecycle uses so dev and release both probe the staged/bundled binary,
  // never a stray `.bun/bin` wrapper the user happens to have on PATH.
  // Returns the trimmed version string or null when the CLI can't be resolved
  // / exits non-zero.
  try {
    const binary = resolveOpencodeBinary();
    const proc = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
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

function independentOpencodeUpdatesAllowed(): boolean {
  if (process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE === '1') return true;
  return !process.env.TAGMA_OPENCODE_BUNDLED_VERSION;
}

function userOpencodeRuntimeEnabled(): boolean {
  return process.env.TAGMA_OPENCODE_SKIP_USER_DIR !== '1';
}

function mergeSignalWithTimeout(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

async function fetchLatestVersion(externalSignal?: AbortSignal): Promise<string> {
  const now = Date.now();
  if (latestCache && now - latestCache.fetchedAt < LATEST_CACHE_TTL_MS) {
    return latestCache.value;
  }
  const res = await fetch(`${NPM_REGISTRY}/opencode-ai/latest`, {
    headers: { Accept: 'application/json' },
    signal: mergeSignalWithTimeout(REGISTRY_TIMEOUT_MS, externalSignal),
  });
  if (!res.ok) throw new Error(`Registry lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error('Registry response missing "version"');
  }
  // Defend against a registry / mirror returning something that wouldn't be
  // safe to interpolate into a URL. assertStrictSemver throws with a clear
  // message if the registry-supplied string isn't a real version.
  assertStrictSemver(body.version, 'opencode latest version');
  latestCache = { value: body.version, fetchedAt: now };
  return body.version;
}

async function fetchRegistryMeta(
  pkgName: string,
  version: string,
  externalSignal?: AbortSignal,
): Promise<{ tarball: string; integrity: string | null; shasum: string | null }> {
  const res = await fetch(`${NPM_REGISTRY}/${pkgName}/${version}`, {
    headers: { Accept: 'application/json' },
    signal: mergeSignalWithTimeout(REGISTRY_TIMEOUT_MS, externalSignal),
  });
  if (!res.ok)
    throw new Error(`Registry fetch failed for ${pkgName}@${version}: HTTP ${res.status}`);
  const body = (await res.json()) as {
    dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown };
  };
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

export async function downloadTarball(
  url: string,
  externalSignal?: AbortSignal,
  redirectsRemaining = MAX_OPENCODE_TARBALL_REDIRECTS,
): Promise<Buffer> {
  // Pin URL host + scheme up front and disable automatic redirects so a
  // 30x to a non-allowlisted host gets rejected here rather than silently
  // followed.
  assertHttpsTarballUrl(url, 'opencode tarball');
  const res = await fetch(url, {
    signal: mergeSignalWithTimeout(TARBALL_TIMEOUT_MS, externalSignal),
    redirect: 'manual',
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (location) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Tarball redirect limit exceeded (${MAX_OPENCODE_TARBALL_REDIRECTS})`);
      }
      const next = assertHttpsTarballUrl(location, 'opencode tarball redirect');
      return downloadTarball(next.toString(), externalSignal, redirectsRemaining - 1);
    }
    throw new Error(`Tarball download failed (${res.status}): redirect with no location`);
  }
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
      throw new Error(
        `Tarball exceeds ${MAX_OPENCODE_TARBALL_BYTES} byte cap (received ${total}+)`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );
}

const TRUSTED_OPENCODE_INTEGRITY_ALGOS = new Set(['sha256', 'sha384', 'sha512']);

function verifyIntegrity(
  buf: Buffer,
  meta: { integrity: string | null; shasum: string | null },
  pkgName: string,
): void {
  if (meta.integrity) {
    const tokens = meta.integrity
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0);
    let trusted: { algo: string; expected: string } | null = null;
    for (const token of tokens) {
      const m = token.match(/^([a-z0-9]+)-([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error(`Bad integrity token for ${pkgName}: ${token}`);
      const [, algo, expected] = m;
      if (TRUSTED_OPENCODE_INTEGRITY_ALGOS.has(algo)) {
        trusted = { algo, expected };
        break;
      }
    }
    if (!trusted) {
      throw new Error(
        `Integrity field for ${pkgName} lacks a trusted algorithm (need sha256/sha384/sha512): ${meta.integrity}`,
      );
    }
    const actual = createHash(trusted.algo).update(buf).digest('base64');
    if (actual !== trusted.expected) {
      throw new Error(
        `Integrity mismatch for ${pkgName}: expected ${trusted.algo}-${trusted.expected}, got ${trusted.algo}-${actual}`,
      );
    }
    return;
  }
  // Same SHA1 fallback rejection as the plugin installer — see
  // server/plugins/install.ts for the rationale.
  throw new Error(
    `Registry response for ${pkgName} did not include a sha256/sha384/sha512 integrity hash. ` +
      `Refusing to install — SHA1 \`shasum\` fallback is not accepted.`,
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
// See routes/editor.ts for the cancel-controller rationale.
let cancelController: AbortController | null = null;

async function performUpdate(
  targetVersion: string,
  signal?: AbortSignal,
): Promise<{ version: string; path: string }> {
  const userDir = process.env.TAGMA_OPENCODE_USER_DIR;
  if (!userDir) {
    throw new Error(
      'OpenCode updates require a writable userData directory. This is only available when running under the desktop app.',
    );
  }
  // Strict semver — no dist-tags, no path-traversal characters, no
  // arbitrary registry strings. The version becomes part of the registry
  // URL ({pkgName}/{version}) so any laxity here is also a URL-injection
  // surface.
  assertStrictSemver(targetVersion, 'OpenCode target version');
  const pkgName = resolvePackageName();
  const meta = await fetchRegistryMeta(pkgName, targetVersion, signal);
  const buf = await downloadTarball(meta.tarball, signal);
  verifyIntegrity(buf, meta, pkgName);

  // Windows keeps running .exe files locked, so stop any existing opencode
  // serve process before replacing the userData binary. On macOS/Linux this
  // also guarantees the next chat bootstrap uses the freshly installed build.
  await stopOpencodeProcesses(3_000);

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

      // Active version drives the "update available" comparison. A userData
      // install can exist purely as the writable update destination while the
      // release-pinned runtime is deliberately using the bundled binary.
      const activeVersion = userOpencodeRuntimeEnabled()
        ? (userInstalledVersion ?? bundledVersion ?? runningVersion)
        : (bundledVersion ?? runningVersion);
      const updateAvailable = !!latestVersion && !!activeVersion && latestVersion !== activeVersion;

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
    const activeYamlLock = getActiveYamlEditLock(req.workspace ?? S);
    if (activeYamlLock) {
      return res.status(423).json({
        error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
        lock: publicYamlEditLock(activeYamlLock),
      });
    }
    if (!independentOpencodeUpdatesAllowed()) {
      return res.status(403).json({
        error:
          'Independent OpenCode updates are disabled because OpenCode is pinned to the Tagma release. Use Update Tagma so editor, sidecar, and OpenCode update together.',
      });
    }
    if (updateInFlight) {
      return res.status(409).json({ error: 'Another opencode update is already running.' });
    }
    const controller = new AbortController();
    const lock = tryBeginHotupdate('opencode', controller);
    if (!lock.ok) {
      return res
        .status(409)
        .json({ error: `Another ${lock.activeKind} update is already running.` });
    }
    cancelController = controller;
    try {
      const body = (req.body ?? {}) as { version?: unknown };
      const targetVersion =
        typeof body.version === 'string' && body.version
          ? body.version
          : await fetchLatestVersion(controller.signal);

      const task = performUpdate(targetVersion, controller.signal);
      updateInFlight = task;
      const result = await task;
      // Invalidate the latest-version cache so a follow-up /info call shows
      // the fresh "no update available" state immediately.
      latestCache = null;
      res.json({ ok: true, version: result.version, path: result.path });
    } catch (err) {
      if (controller.signal.aborted) {
        return res.status(499).json({ error: 'OpenCode update canceled.', kind: 'canceled' });
      }
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      updateInFlight = null;
      if (cancelController === controller) cancelController = null;
      endHotupdate(controller);
    }
  });

  app.post('/api/opencode/update/cancel', (_req, res) => {
    if (!cancelHotupdate('opencode')) {
      return res.status(409).json({ error: 'No opencode update in flight.' });
    }
    res.json({ ok: true });
  });

  // ─── Chat bootstrap endpoint ────────────────────────────────────────────
  //
  // The browser-side opencode SDK (`createOpencodeClient({ baseUrl })`) talks
  // directly to the spawned `opencode serve` process over CORS-enabled HTTP
  // (see opencode-lifecycle.ts — --cors flags are set from ALLOWED_ORIGINS).
  // This single endpoint lazily spawns opencode scoped to the active
  // workspace's cwd and hands its loopback URL to the renderer; every
  // subsequent chat request bypasses this server entirely.

  app.post('/api/opencode/chat/ensure', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Workspace directory is not set' });
    }
    try {
      // Scope opencode's view of the world to the workspace's `.tagma/`
      // subdirectory — that's where pipeline YAML lives, and the chat
      // pipeline agent may only write inside it. The agent may read `..` for
      // workspace context, but writes must stay rooted here. Setting cwd
      // here makes YAML-relative paths resolve there and matches what the agent's
      // system prompt promises the user. `mkdirSync recursive` is a no-op if
      // it already exists, which is the common case since the editor creates
      // `.tagma/` on first save.
      const workspaceRoot = ws.workDir;
      const tagmaCwd = ensureRealTagmaDirectory(workspaceRoot);
      const activeYamlLock = getActiveYamlEditLock(ws);
      const seedChanged = activeYamlLock
        ? false
        : seedOpencodeArtifacts(tagmaCwd, buildOpencodeSeedOptions(ws));
      startChatCompileWatcher(tagmaCwd, ws.registry);
      console.log('[opencode] ensure called, cwd =', tagmaCwd);
      const { baseUrl, auth } = activeYamlLock
        ? await ensureOpencode(tagmaCwd)
        : seedChanged
          ? await restartOpencode(tagmaCwd)
          : await ensureOpencode(tagmaCwd);
      console.log('[opencode] ensure resolved, baseUrl =', baseUrl);
      res.json({ ok: true, baseUrl, authHeader: auth.authorization });
    } catch (err) {
      console.error('[opencode] ensure FAILED:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // ─── Chat opencode restart endpoint ─────────────────────────────────────
  //
  // opencode 1.14.x caches /config/providers and /provider in memory. Writes
  // to auth.json (PUT/DELETE /auth/{id}) update disk but don't invalidate the
  // cache — so a fresh API key or a disconnect doesn't take effect until the
  // process restarts. The renderer calls this after any provider auth change
  // to kill + respawn opencode scoped to the active workspace. Returns the
  // new loopback URL so the browser can swap its SDK client over without a
  // full app restart.
  app.post('/api/opencode/chat/restart', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Workspace directory is not set' });
    }
    const activeYamlLock = getActiveYamlEditLock(ws);
    if (activeYamlLock && !canBypassYamlEditLock(activeYamlLock, req.get('X-Tagma-Yaml-Lock-Id'))) {
      return res.status(423).json({
        error: 'YAML/layout editing is locked while OpenCode chat is updating this workspace.',
        lock: publicYamlEditLock(activeYamlLock),
      });
    }
    try {
      const workspaceRoot = ws.workDir;
      const tagmaCwd = ensureRealTagmaDirectory(workspaceRoot);
      seedOpencodeArtifacts(tagmaCwd, buildOpencodeSeedOptions(ws));
      console.log('[opencode] restart called, cwd =', tagmaCwd);
      const { baseUrl, auth } = await restartOpencode(tagmaCwd);
      console.log('[opencode] restart resolved, baseUrl =', baseUrl);
      res.json({ ok: true, baseUrl, authHeader: auth.authorization });
    } catch (err) {
      console.error('[opencode] restart FAILED:', err);
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
