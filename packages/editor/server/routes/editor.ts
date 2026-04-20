import type express from 'express';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { errorMessage } from '../path-utils.js';

/**
 * Editor hot-update API (tier A: every desktop release ships a tarball).
 *
 * Shape mirrors routes/opencode.ts but targets the frontend `dist/` bundle,
 * not a CLI binary. Runtime env plumbed in by the electron launcher (see
 * packages/electron/src/runtime-paths.ts):
 *
 *   TAGMA_EDITOR_BUNDLED_VERSION       — installer's own version, baseline
 *                                        editor-dist shipped in resources/.
 *   TAGMA_EDITOR_USER_DIR              — userData/editor; writable root.
 *   TAGMA_EDITOR_USER_DIST_DIR         — userData/editor/dist; hot-update
 *                                        layer. static-assets.ts prefers this
 *                                        over TAGMA_EDITOR_DIST_DIR when it
 *                                        contains an index.html.
 *   TAGMA_EDITOR_UPDATE_CHANNEL        — "stable" | "alpha" | "beta" | "rc".
 *   TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL — https://<host>/editor-updates
 *                                        (sidecar appends /<channel>/manifest.json).
 *
 * Endpoints:
 *   GET  /api/editor/info    — what's bundled, what's staged in userData,
 *                              what's live, what the manifest currently
 *                              advertises, and whether an update is available.
 *   POST /api/editor/update  — fetch the manifest-declared tarball, verify
 *                              sha256, stream-extract into a staging dir under
 *                              userData, rename into place. A window reload
 *                              picks up the new bundle; no restart required.
 */

const MANIFEST_TIMEOUT_MS = 15_000;
const TARBALL_TIMEOUT_MS = 180_000;
// Frontend bundles are small; cap at 100 MB so a misconfigured manifest can't
// exhaust disk. Raise if the editor legitimately grows past this.
const MAX_DIST_TARBALL_BYTES = 100 * 1024 * 1024;

// Cache the remote manifest fetch so rapid-fire /info clicks don't hammer the
// release host. 5-minute TTL matches the pattern opencode.ts uses for its npm
// lookup — long enough to dedupe a settings-panel refresh storm, short enough
// that a freshly published manifest shows up within one cache window.
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;
let manifestCache: { url: string; value: EditorManifest; fetchedAt: number } | null = null;

export interface EditorManifestDist {
  /** Absolute HTTPS URL of the editor-dist tarball for this release. */
  url: string;
  /** Lowercase hex sha256 digest of the tarball's bytes. */
  sha256: string;
  /** Declared content-length for proactive size rejection before download. */
  size: number;
}

export interface EditorManifest {
  /** Semver of the editor bundle this manifest describes. */
  version: string;
  /** Release channel this manifest belongs to (stable/alpha/...). */
  channel: string;
  /**
   * Minimum installer (electron shell) version required to safely apply this
   * bundle. Prevents an old shell from hot-updating to a dist that relies on
   * an IPC or preload API the shell doesn't expose yet. Client refuses the
   * update and prompts the user to install the newest installer instead.
   */
  minShellVersion?: string;
  dist: EditorManifestDist;
  releaseNotesUrl?: string;
}

export interface EditorInfo {
  /** Version baked into the installer at build time (from package.json). */
  bundledVersion: string | null;
  /** Version currently staged under userData/editor/dist (null if none). */
  userInstalledVersion: string | null;
  /**
   * What express.static is actually serving right now. Equals the user version
   * when the userData layer is live, otherwise the bundled version.
   */
  activeVersion: string | null;
  /** Latest version the remote manifest advertises (null if unreachable). */
  latestVersion: string | null;
  /** True when latestVersion > activeVersion. Semver-aware. */
  updateAvailable: boolean;
  /** False when the sidecar has no writable userData (dev / headless). */
  canUpdate: boolean;
  /** Current channel the sidecar is tracking. */
  channel: string | null;
  /** Resolved manifest URL the sidecar would poll (null when disabled). */
  manifestUrl: string | null;
  /** Release notes URL from the manifest, if supplied. */
  releaseNotesUrl: string | null;
}

function resolveManifestUrl(): string | null {
  const base = process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL;
  const channel = process.env.TAGMA_EDITOR_UPDATE_CHANNEL ?? 'stable';
  if (!base || !base.trim()) return null;
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${channel}/manifest.json`;
}

async function fetchManifest(url: string, force = false): Promise<EditorManifest> {
  const now = Date.now();
  if (
    !force &&
    manifestCache &&
    manifestCache.url === url &&
    now - manifestCache.fetchedAt < MANIFEST_CACHE_TTL_MS
  ) {
    return manifestCache.value;
  }
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    // Release hosts often serve manifests through a CDN; always ask for a
    // fresh copy rather than a stale cached response.
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Manifest fetch failed: HTTP ${res.status} ${url}`);
  const body = (await res.json()) as Partial<EditorManifest>;
  validateManifest(body, url);
  const value = body as EditorManifest;
  manifestCache = { url, value, fetchedAt: now };
  return value;
}

function validateManifest(body: Partial<EditorManifest>, url: string): void {
  if (typeof body.version !== 'string' || !body.version) {
    throw new Error(`Manifest at ${url} missing "version"`);
  }
  if (typeof body.channel !== 'string' || !body.channel) {
    throw new Error(`Manifest at ${url} missing "channel"`);
  }
  const dist = body.dist;
  if (!dist || typeof dist !== 'object') {
    throw new Error(`Manifest at ${url} missing "dist"`);
  }
  if (typeof dist.url !== 'string' || !/^https?:\/\//i.test(dist.url)) {
    throw new Error(`Manifest at ${url} has bad dist.url`);
  }
  if (typeof dist.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(dist.sha256)) {
    throw new Error(`Manifest at ${url} has bad dist.sha256 (want 64 hex chars)`);
  }
  if (typeof dist.size !== 'number' || !Number.isFinite(dist.size) || dist.size <= 0) {
    throw new Error(`Manifest at ${url} has bad dist.size`);
  }
  if (dist.size > MAX_DIST_TARBALL_BYTES) {
    throw new Error(
      `Manifest at ${url} advertises a ${dist.size} byte tarball, exceeds ${MAX_DIST_TARBALL_BYTES} byte cap`,
    );
  }
}

/**
 * Compare two semver-like strings. Returns negative / 0 / positive matching
 * the standard compare contract. Supports the "build metadata" suffix
 * (+hotfix.N) as a tiebreaker so we remain correct if the user later adopts
 * tier B hotfix-only packages, even though tier A alone doesn't produce them.
 */
function compareVersions(a: string, b: string): number {
  const [coreA = '', metaA = ''] = a.split('+');
  const [coreB = '', metaB = ''] = b.split('+');
  const pa = coreA.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = coreB.split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  if (metaA === metaB) return 0;
  if (!metaA) return -1;
  if (!metaB) return 1;
  return metaA < metaB ? -1 : 1;
}

function readUserVersion(userDir: string | undefined): string | null {
  if (!userDir) return null;
  try {
    const p = join(userDir, 'dist-version.txt');
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function downloadToFile(url: string, destFile: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Tarball download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error('Tarball response has no body');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DIST_TARBALL_BYTES) {
    throw new Error(
      `Tarball too large: declared ${declared} bytes exceeds ${MAX_DIST_TARBALL_BYTES} byte cap`,
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
    if (total > MAX_DIST_TARBALL_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(
        `Tarball exceeds ${MAX_DIST_TARBALL_BYTES} byte cap (received ${total}+)`,
      );
    }
    chunks.push(value);
  }
  mkdirSync(dirname(destFile), { recursive: true });
  writeFileSync(
    destFile,
    Buffer.concat(
      chunks.map((c) => Buffer.from(c)),
      total,
    ),
  );
  return total;
}

/**
 * Stream-extract a tar.gz into `destDir`. Follows the same manual-streaming
 * pattern as routes/opencode.ts because Bun + tar v7 silently drops file
 * contents under tar.x(). Entries are validated to stay within destDir to
 * prevent path-traversal (`../../etc/passwd` style) entries from escaping.
 */
function extractTarballTo(tgzPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const destWithSep = destDir.endsWith(sep) ? destDir : destDir + sep;
  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      const rel = String(entry.path).replace(/\\/g, '/');
      if (rel.startsWith('/') || rel.includes('..')) {
        entry.resume();
        return;
      }
      if (entry.type === 'Directory') {
        mkdirSync(join(destDir, rel), { recursive: true });
        entry.resume();
        return;
      }
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        entry.resume();
        return;
      }
      const target = join(destDir, rel);
      if (!target.startsWith(destWithSep) && target !== destDir) {
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on('data', (c: Buffer) => chunks.push(c));
      entry.on('end', () => {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.concat(chunks));
      });
    },
  });
}

// Serialize concurrent update requests so a double-click on the settings
// panel's Update button can't race itself mid-extract and leave a corrupt
// dist directory behind.
let updateInFlight: Promise<unknown> | null = null;

async function performUpdate(
  manifest: EditorManifest,
): Promise<{ version: string; distDir: string }> {
  const userDir = process.env.TAGMA_EDITOR_USER_DIR;
  if (!userDir) {
    throw new Error(
      'Editor updates require a writable userData directory. This is only available when running under the desktop app.',
    );
  }

  // Pre-flight: minShellVersion gate. Skip when the client doesn't know its
  // shell version (dev mode) — dev is responsible for keeping everything in
  // sync. In packaged mode TAGMA_EDITOR_BUNDLED_VERSION is always set.
  const shellVersion = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
  if (manifest.minShellVersion && shellVersion) {
    if (compareVersions(shellVersion, manifest.minShellVersion) < 0) {
      throw new Error(
        `This update requires installer ${manifest.minShellVersion} or newer (current: ${shellVersion}). Install the latest Tagma installer and retry.`,
      );
    }
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-editor-update-'));
  const tgzPath = join(tempRoot, 'editor-dist.tgz');
  try {
    await downloadToFile(manifest.dist.url, tgzPath);

    const actualSha = await sha256OfFile(tgzPath);
    if (actualSha.toLowerCase() !== manifest.dist.sha256.toLowerCase()) {
      throw new Error(
        `sha256 mismatch: manifest expected ${manifest.dist.sha256}, tarball hashed to ${actualSha}. Refusing to install.`,
      );
    }

    // Stage extraction into userDir/dist.staging, then rename over dist/.
    // renameSync on a directory is atomic on POSIX and uses MoveFileEx on
    // Win32. The previous dist is moved to dist.previous first so a botched
    // rename leaves a recoverable state instead of wiping the layer.
    const distDir = join(userDir, 'dist');
    const stagingDir = join(userDir, 'dist.staging');
    const previousDir = join(userDir, 'dist.previous');
    mkdirSync(userDir, { recursive: true });
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    if (existsSync(previousDir)) rmSync(previousDir, { recursive: true, force: true });

    extractTarballTo(tgzPath, stagingDir);
    // Sanity-check the extracted payload actually looks like a dist bundle.
    // A tarball with no index.html would silently break the app once the
    // userData layer took over — fail the update instead.
    if (!existsSync(join(stagingDir, 'index.html'))) {
      throw new Error('Extracted tarball is missing index.html — not a valid editor-dist bundle.');
    }

    if (existsSync(distDir)) {
      renameSync(distDir, previousDir);
    }
    try {
      renameSync(stagingDir, distDir);
    } catch (err) {
      // Roll back so the sidecar can still serve the old bundle on next start.
      if (existsSync(previousDir)) {
        try {
          renameSync(previousDir, distDir);
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }
    writeFileSync(join(userDir, 'dist-version.txt'), manifest.version + '\n', 'utf-8');
    // Best-effort cleanup of the pre-swap snapshot. We don't throw if this
    // fails because the new bundle is already live — a stray dist.previous/
    // only costs disk space and will be overwritten on the next update.
    if (existsSync(previousDir)) {
      try {
        rmSync(previousDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return { version: manifest.version, distDir };
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export function registerEditorRoutes(app: express.Express): void {
  app.get('/api/editor/info', async (_req, res) => {
    try {
      const bundledVersion = process.env.TAGMA_EDITOR_BUNDLED_VERSION ?? null;
      const userDir = process.env.TAGMA_EDITOR_USER_DIR ?? null;
      const userDistDir = process.env.TAGMA_EDITOR_USER_DIST_DIR ?? null;
      const channel = process.env.TAGMA_EDITOR_UPDATE_CHANNEL ?? null;
      const manifestUrl = resolveManifestUrl();

      const userInstalledVersion = readUserVersion(userDir ?? undefined);
      // Active version = whatever static-assets.ts is actually serving right
      // now. userData dist wins only when it has an index.html, matching the
      // runtime resolution logic exactly.
      const userLive =
        userInstalledVersion && userDistDir && existsSync(join(userDistDir, 'index.html'));
      const activeVersion = userLive ? userInstalledVersion : bundledVersion;

      let latestVersion: string | null = null;
      let releaseNotesUrl: string | null = null;
      if (manifestUrl) {
        try {
          const manifest = await fetchManifest(manifestUrl);
          latestVersion = manifest.version;
          releaseNotesUrl = manifest.releaseNotesUrl ?? null;
        } catch {
          // Offline / DNS / 404 is expected when the manifest host isn't set
          // up yet. Surface as latestVersion=null, UI shows "manifest
          // unreachable" rather than erroring the whole settings panel.
          latestVersion = null;
        }
      }

      const updateAvailable =
        !!latestVersion &&
        !!activeVersion &&
        compareVersions(latestVersion, activeVersion) > 0;

      const payload: EditorInfo = {
        bundledVersion,
        userInstalledVersion,
        activeVersion,
        latestVersion,
        updateAvailable,
        canUpdate: !!userDir && !!manifestUrl,
        channel,
        manifestUrl,
        releaseNotesUrl,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/editor/update', async (_req, res) => {
    try {
      if (updateInFlight) {
        return res
          .status(409)
          .json({ error: 'Another editor update is already running.' });
      }
      const manifestUrl = resolveManifestUrl();
      if (!manifestUrl) {
        return res.status(400).json({
          error:
            'No update manifest URL configured. Set tagma.updateManifestBaseUrl in the installer\'s package.json.',
        });
      }
      // Force-refresh the manifest cache on an explicit update click so the
      // user isn't ever blocked by a 5-min-old "nothing to do" snapshot.
      const manifest = await fetchManifest(manifestUrl, true);

      const task = performUpdate(manifest);
      updateInFlight = task;
      try {
        const result = await task;
        res.json({ ok: true, version: result.version, distDir: result.distDir });
      } finally {
        updateInFlight = null;
      }
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
