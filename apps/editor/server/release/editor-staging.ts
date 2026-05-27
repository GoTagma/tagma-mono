import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import { assertValidHotupdateVersion, type HotupdateManifest } from '../update-manifest.js';

const TARBALL_TIMEOUT_MS = 180_000;
const MAX_DIST_TARBALL_BYTES = 100 * 1024 * 1024;
// Decompression caps protect against zip-bomb-style tarballs where a tiny
// .tar.gz expands into gigabytes. The download cap above only bounds the
// compressed payload. Single-entry cap is generous enough for source-mapped
// JS bundles; cumulative is 4× the download cap to leave room for legit
// asset growth without ever letting the disk balloon unboundedly.
const MAX_TAR_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TAR_TOTAL_EXTRACTED_BYTES = 4 * MAX_DIST_TARBALL_BYTES;

/**
 * Filename of the in-bundle version sentinel that travels alongside the
 * editor-dist contents. Written into the staged directory before
 * `activateEditorDist`'s rename so the version moves atomically with the
 * bundle — no rename + writeFile race window where the on-disk content and
 * the userDir-level dist-version.txt can disagree. Recovery path is in
 * `static-assets.cleanupStaleUserDist`.
 */
export const BUNDLE_VERSION_FILE = '.tagma-bundle-version';

/**
 * Read the in-bundle version sentinel from a dist directory. Returns null
 * when the file is missing or empty. Used as a fallback ground truth for
 * the userDir-level `dist-version.txt` after a crashed activation.
 */
export function readBundleVersionFromDist(distDir: string): string | null {
  try {
    const sentinel = join(distDir, BUNDLE_VERSION_FILE);
    if (!existsSync(sentinel)) return null;
    const value = readFileSync(sentinel, 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface EditorStagingResult {
  version: string;
  /** Absolute path of the scratch dir that contains the extracted bundle. */
  stagedDir: string;
  /** Absolute path where activate will move `stagedDir` to. */
  targetDistDir: string;
  /** Userdata root that owns `stagedDir` and `targetDistDir`. */
  userDir: string;
}

export interface EditorActivationResult {
  version: string;
  distDir: string;
  userDir: string;
  previousDir: string;
  previousVersion: string | null;
  keptPrevious: boolean;
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

async function downloadToFile(
  url: string,
  destFile: string,
  externalSignal?: AbortSignal,
): Promise<number> {
  const timeoutSignal = AbortSignal.timeout(TARBALL_TIMEOUT_MS);
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
  const res = await fetch(url, { signal });
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
      throw new Error(`Tarball exceeds ${MAX_DIST_TARBALL_BYTES} byte cap (received ${total}+)`);
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

function sanitizeTarEntryPath(rawPath: string): string | null {
  const rel = rawPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!rel || rel.startsWith('/') || rel.split('/').some((part) => part === '..')) return null;
  return rel;
}

function isInsideDirectory(target: string, parent: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function extractTarballTo(tgzPath: string, destDir: string): void {
  const root = resolve(destDir);
  mkdirSync(root, { recursive: true });
  // Streaming write per entry: openSync + writeSync chunk-by-chunk instead of
  // buffering the whole entry in memory. A small .tar.gz can decompress into
  // multi-GB single files (zip-bomb), so we enforce per-entry and cumulative
  // caps and abort the entire tar.t() walk the moment either is exceeded.
  //
  // Aborts work by throwing inline from the `onentry` callback / data
  // handler — both fire synchronously inside tar.t({sync:true})'s read loop,
  // so the throw propagates up through the synchronous tar.t() call. (An
  // earlier draft used a `fatal` flag + entry.resume(), which spent CPU
  // walking remaining entries even after we knew we were giving up.) Open
  // file descriptors for the in-flight entry are closed before the throw;
  // the caller (`stageEditorDist`) catches and rms the partial staged dir.
  let totalExtracted = 0;
  tar.t({
    file: tgzPath,
    sync: true,
    onentry: (entry) => {
      const rel = sanitizeTarEntryPath(String(entry.path));
      if (!rel) {
        entry.resume();
        return;
      }
      const target = resolve(root, rel);
      if (!isInsideDirectory(target, root)) {
        entry.resume();
        return;
      }
      if (entry.type === 'Directory') {
        mkdirSync(target, { recursive: true });
        entry.resume();
        return;
      }
      if (entry.type !== 'File' && entry.type !== 'OldFile') {
        entry.resume();
        return;
      }
      // Tar header declares each entry's size — bail before opening the file
      // when the header itself is already over budget.
      const declared = typeof entry.size === 'number' ? entry.size : 0;
      if (declared > MAX_TAR_ENTRY_BYTES) {
        throw new Error(
          `Tarball entry ${rel} declares ${declared} bytes, exceeds ${MAX_TAR_ENTRY_BYTES} per-file cap`,
        );
      }
      if (totalExtracted + declared > MAX_TAR_TOTAL_EXTRACTED_BYTES) {
        throw new Error(
          `Tarball cumulative extracted size would exceed ${MAX_TAR_TOTAL_EXTRACTED_BYTES} byte cap`,
        );
      }
      mkdirSync(dirname(target), { recursive: true });
      const fd = openSync(target, 'w');
      let written = 0;
      let closed = false;
      const closeFd = () => {
        if (closed) return;
        closed = true;
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      };
      entry.on('data', (c: Buffer) => {
        // The header-declared size is advisory — a malicious tarball can
        // stream more bytes than its header claimed. Re-check on every chunk
        // against both caps; throwing here aborts tar.t synchronously.
        if (written + c.byteLength > MAX_TAR_ENTRY_BYTES) {
          closeFd();
          throw new Error(`Tarball entry ${rel} exceeds ${MAX_TAR_ENTRY_BYTES} per-file cap`);
        }
        if (totalExtracted + c.byteLength > MAX_TAR_TOTAL_EXTRACTED_BYTES) {
          closeFd();
          throw new Error(
            `Tarball cumulative extracted size exceeds ${MAX_TAR_TOTAL_EXTRACTED_BYTES} byte cap`,
          );
        }
        try {
          writeSync(fd, c);
        } catch (err) {
          closeFd();
          throw err;
        }
        written += c.byteLength;
        totalExtracted += c.byteLength;
      });
      entry.on('end', closeFd);
    },
  });
}

/**
 * Download + verify + extract the manifest-advertised editor-dist tarball into
 * a scratch directory under `userDir`. Does NOT touch `userDir/dist` — the
 * caller is responsible for calling `activateEditorDist` to swap staged into
 * place. Safe to call multiple times: an existing `dist.staged` from a
 * previous run is wiped first.
 */
export async function stageEditorDist(
  manifest: HotupdateManifest,
  userDir: string,
  signal?: AbortSignal,
): Promise<EditorStagingResult> {
  assertValidHotupdateVersion(manifest.version, 'editor version');
  mkdirSync(userDir, { recursive: true });
  const stagedDir = join(userDir, 'dist.staged');
  const targetDistDir = join(userDir, 'dist');

  if (existsSync(stagedDir)) {
    rmSync(stagedDir, { recursive: true, force: true });
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'tagma-editor-stage-'));
  const tgzPath = join(tempRoot, 'editor-dist.tgz');
  let extractStarted = false;
  try {
    await downloadToFile(manifest.dist.url, tgzPath, signal);

    const actualSha = await sha256OfFile(tgzPath);
    if (actualSha.toLowerCase() !== manifest.dist.sha256.toLowerCase()) {
      throw new Error(
        `sha256 mismatch: manifest expected ${manifest.dist.sha256}, tarball hashed to ${actualSha}. Refusing to install.`,
      );
    }

    extractStarted = true;
    extractTarballTo(tgzPath, stagedDir);

    if (!existsSync(join(stagedDir, 'index.html'))) {
      rmSync(stagedDir, { recursive: true, force: true });
      throw new Error('Extracted tarball is missing index.html — not a valid editor-dist bundle.');
    }

    // In-bundle version sentinel. Written BEFORE activation's rename so the
    // version moves atomically with the bundle contents — no separate
    // writeFile after rename can be interrupted. Recovery in
    // cleanupStaleUserDist reads this when the userDir-level
    // dist-version.txt is missing.
    writeFileSync(join(stagedDir, BUNDLE_VERSION_FILE), manifest.version + '\n', 'utf-8');

    return { version: manifest.version, stagedDir, targetDistDir, userDir };
  } catch (err) {
    // Extraction can fail mid-stream (size cap, malformed entry, write
    // error). The streaming writer leaves a partially-populated
    // `dist.staged` behind — wipe it so the caller doesn't see a half-built
    // staged dir on the next call. Sentinel `extractStarted` skips this for
    // pre-extract failures (download / sha mismatch) where stagedDir was
    // never touched.
    if (extractStarted && existsSync(stagedDir)) {
      try {
        rmSync(stagedDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Atomically swap the scratch dir produced by `stageEditorDist` into `dist/`.
 * Preserves the previous `dist/` as `dist.previous/` until the swap succeeds,
 * so a mid-rename failure leaves the old bundle in place.
 */
export function activateEditorDist(
  staged: EditorStagingResult,
  options: { keepPrevious?: boolean } = {},
): EditorActivationResult {
  if (!existsSync(staged.stagedDir)) {
    throw new Error(
      `activateEditorDist: no staged bundle at ${staged.stagedDir}. Call stageEditorDist first.`,
    );
  }

  const previousDir = join(staged.userDir, 'dist.previous');
  const versionFile = join(staged.userDir, 'dist-version.txt');
  const previousVersion = existsSync(versionFile)
    ? readFileSync(versionFile, 'utf-8').trim() || null
    : null;
  if (existsSync(previousDir)) {
    rmSync(previousDir, { recursive: true, force: true });
  }

  if (existsSync(staged.targetDistDir)) {
    renameSync(staged.targetDistDir, previousDir);
  }
  try {
    renameSync(staged.stagedDir, staged.targetDistDir);
    writeFileSync(versionFile, staged.version + '\n', 'utf-8');
  } catch (err) {
    if (existsSync(staged.targetDistDir)) {
      try {
        rmSync(staged.targetDistDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    if (existsSync(previousDir)) {
      try {
        renameSync(previousDir, staged.targetDistDir);
      } catch {
        /* best-effort */
      }
    }
    if (previousVersion) {
      try {
        writeFileSync(versionFile, previousVersion + '\n', 'utf-8');
      } catch {
        /* best-effort */
      }
    } else {
      try {
        rmSync(versionFile, { force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }

  if (!options.keepPrevious && existsSync(previousDir)) {
    try {
      rmSync(previousDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  return {
    version: staged.version,
    distDir: staged.targetDistDir,
    userDir: staged.userDir,
    previousDir,
    previousVersion,
    keptPrevious: !!options.keepPrevious,
  };
}

export function finalizeEditorDistActivation(activation: EditorActivationResult): void {
  if (!activation.keptPrevious) return;
  try {
    if (existsSync(activation.previousDir)) {
      rmSync(activation.previousDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}

export function rollbackEditorDistActivation(activation: EditorActivationResult): void {
  const versionFile = join(activation.userDir, 'dist-version.txt');
  try {
    if (existsSync(activation.distDir)) {
      rmSync(activation.distDir, { recursive: true, force: true });
    }
    if (existsSync(activation.previousDir)) {
      renameSync(activation.previousDir, activation.distDir);
    }
    if (activation.previousVersion) {
      writeFileSync(versionFile, activation.previousVersion + '\n', 'utf-8');
    } else {
      rmSync(versionFile, { force: true });
    }
  } catch {
    /* best-effort */
  }
}

/** Discard a staged bundle produced by `stageEditorDist`. Best-effort. */
export function discardEditorStaging(staged: EditorStagingResult): void {
  try {
    if (existsSync(staged.stagedDir)) {
      rmSync(staged.stagedDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}
