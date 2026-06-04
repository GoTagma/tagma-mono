import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, parse as parsePath, relative, resolve } from 'node:path';
import {
  assertValidHotupdateVersion,
  compareVersions,
  pickSidecarTarget,
  type HotupdateManifest,
} from '../update-manifest.js';
import { downloadUrlToBuffer } from './download.js';

const MAX_SIDECAR_BINARY_BYTES = 300 * 1024 * 1024;
const SIDECAR_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

export interface SidecarStagingResult {
  version: string;
  userDir: string;
  /** Final location of the staged binary (already inside `versions/<v>/`). */
  binaryPath: string;
  /**
   * sha256 of the staged binary, lowercase hex. The same value the manifest
   * advertised and the same value the download was verified against — we
   * propagate it from the verify step so the activate step can pin it into
   * current.json without re-hashing the file. runtime-paths.ts re-checks
   * this hash before launch to detect tamper of the userData binary.
   */
  sha256: string;
}

function sidecarCurrentFile(userDir: string): string {
  return join(userDir, 'current.json');
}

function sidecarVersionDir(userDir: string, version: string): string {
  assertValidHotupdateVersion(version, 'sidecar version');
  const versionsRoot = resolve(userDir, 'versions');
  const versionDir = resolve(versionsRoot, version);
  const rel = relative(versionsRoot, versionDir);
  if (rel === '' || rel.startsWith('..') || parsePath(rel).root) {
    throw new Error(`Refusing unsafe sidecar version path: ${version}`);
  }
  return versionDir;
}

function sidecarExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Best-effort sweep of leftover staging / displaced dirs from a prior crashed
 * run. Names are reserved (leading dot + fixed prefix) so this can't collide
 * with a real version dir. No other process writes here, so a sequential rm
 * is safe.
 */
function sweepStaleStagingDirs(versionsRoot: string): void {
  try {
    for (const entry of readdirSync(versionsRoot)) {
      if (entry.startsWith('.stage-') || entry.startsWith('.discarded-')) {
        try {
          rmSync(join(versionsRoot, entry), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* best-effort — versionsRoot may not exist yet */
  }
}

async function downloadBinary(
  url: string,
  declaredSize: number,
  externalSignal?: AbortSignal,
): Promise<Buffer> {
  if (declaredSize > MAX_SIDECAR_BINARY_BYTES) {
    throw new Error(
      `Manifest advertises a ${declaredSize} byte sidecar, exceeds ${MAX_SIDECAR_BINARY_BYTES} byte cap`,
    );
  }
  const { buffer } = await downloadUrlToBuffer({
    url,
    label: 'Sidecar binary',
    maxBytes: MAX_SIDECAR_BINARY_BYTES,
    idleTimeoutMs: SIDECAR_DOWNLOAD_IDLE_TIMEOUT_MS,
    signal: externalSignal,
    expectedBytes: declaredSize > 0 ? declaredSize : undefined,
  });
  return buffer;
}

/**
 * Download + verify the platform-specific sidecar binary and place it at its
 * final home `userDir/versions/<version>/<executable>`. Does NOT touch
 * `current.json` — the caller must call `activateSidecarBinary` to flip the
 * live pointer.
 */
export async function stageSidecarBinary(
  manifest: HotupdateManifest,
  userDir: string,
  signal?: AbortSignal,
): Promise<SidecarStagingResult> {
  const target = pickSidecarTarget(manifest);
  if (!target) {
    throw new Error(
      `No sidecar update published for ${process.platform}/${process.arch} on channel ${manifest.channel}.`,
    );
  }

  const shellVersion =
    process.env.TAGMA_SIDECAR_BUNDLED_VERSION ?? process.env.TAGMA_EDITOR_BUNDLED_VERSION;
  if (manifest.minShellVersion && shellVersion) {
    if (compareVersions(shellVersion, manifest.minShellVersion) < 0) {
      throw new Error(
        `This update requires installer ${manifest.minShellVersion} or newer (current: ${shellVersion}). Install the latest Tagma installer and retry.`,
      );
    }
  }

  // Compute target paths up-front. `sidecarVersionDir` validates the version
  // string (semver + path-safety) and throws before any I/O happens, which
  // preserves the test invariant that bad versions never create `versions/`.
  const versionDir = sidecarVersionDir(userDir, manifest.version);
  const versionsRoot = dirname(versionDir);
  const binaryPath = join(versionDir, sidecarExecutableName());

  // Same-version short-circuit: only skip the redownload when the on-disk
  // binary actually hashes to what the manifest advertises. The previous
  // gate (which lived in routes/sidecar.ts and only checked file existence)
  // would lock the user out of self-repair if `versions/<v>/<exe>` was
  // truncated, half-written, or otherwise corrupt — `current.json` says X,
  // existsSync agreed, alreadyInstalled returned, redownload never fired.
  // Verifying the content closes that loop: a hash mismatch falls through to
  // the staged replace below, so the user can recover by re-clicking Update.
  if (existsSync(binaryPath)) {
    try {
      const existingHash = await sha256OfFile(binaryPath);
      if (existingHash.toLowerCase() === target.sha256.toLowerCase()) {
        return {
          version: manifest.version,
          userDir,
          binaryPath,
          sha256: target.sha256.toLowerCase(),
        };
      }
    } catch {
      // unreadable binary — fall through to restage
    }
  }

  const binary = await downloadBinary(target.url, target.size, signal);
  const actualSha = createHash('sha256').update(binary).digest('hex');
  if (actualSha.toLowerCase() !== target.sha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch: manifest expected ${target.sha256}, sidecar hashed to ${actualSha}. Refusing to install.`,
    );
  }

  // Commit point: from here on we will create `versions/`. Tests assert that
  // pre-verify failures (sha mismatch, bad version, no platform target) leave
  // `versions/` absent; defer the mkdir until after the hash check so that
  // contract holds without per-failure cleanup.
  mkdirSync(versionsRoot, { recursive: true });
  sweepStaleStagingDirs(versionsRoot);

  // Stage inside `versionsRoot` so the rename below is same-filesystem.
  // The previous design staged under `os.tmpdir()` and renamed across
  // mounts/drives — `renameSync` throws EXDEV across filesystems, which is
  // routine on macOS (`/tmp` separate from user data) and Windows (TEMP on
  // C:, app installed elsewhere). EXDEV here was unrecoverable: the old
  // `versions/<v>/` had already been deleted unconditionally before the
  // rename, so the user was left with no working sidecar at all.
  const stagingDir = mkdtempSync(join(versionsRoot, `.stage-${manifest.version}-`));
  let stagingMoved = false;
  let displacedDir: string | null = null;
  try {
    const stagedBinary = join(stagingDir, sidecarExecutableName());
    writeFileSync(stagedBinary, binary);
    if (process.platform !== 'win32') {
      chmodSync(stagedBinary, 0o755);
    }
    writeFileSync(join(stagingDir, 'version.txt'), manifest.version + '\n', 'utf-8');

    // Atomic side-swap rather than delete-then-rename. Two reasons the old
    // delete-first code was wrong:
    //   1. delete-then-rename has a window where a crash leaves NEITHER the
    //      old nor the new dir on disk — `current.json` then points at a
    //      version with no binary.
    //   2. on Windows the rename of an existing dir whose `.exe` is locked
    //      by a running sidecar throws EPERM. The old code had already
    //      destroyed the old dir by that point, so failure was terminal.
    //      With rename-aside, we can rename the displaced dir back and the
    //      caller is no worse off than before the attempt.
    if (existsSync(versionDir)) {
      displacedDir = join(versionsRoot, `.discarded-${manifest.version}-${Date.now()}`);
      renameSync(versionDir, displacedDir);
    }
    try {
      renameSync(stagingDir, versionDir);
      stagingMoved = true;
    } catch (err) {
      if (displacedDir && existsSync(displacedDir)) {
        try {
          renameSync(displacedDir, versionDir);
          displacedDir = null;
        } catch {
          /* best-effort rollback — nothing more we can do here */
        }
      }
      throw err;
    }

    if (displacedDir) {
      try {
        rmSync(displacedDir, { recursive: true, force: true });
      } catch {
        /* best-effort — sweepStaleStagingDirs catches it next call */
      }
    }

    return {
      version: manifest.version,
      userDir,
      binaryPath,
      sha256: actualSha.toLowerCase(),
    };
  } finally {
    if (!stagingMoved && existsSync(stagingDir)) {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Flip `current.json` to point at the staged version. Atomic via rename.
 *
 * The pointer carries the binary's sha256 alongside the version so
 * runtime-paths.ts can verify the binary on every launch — without it the
 * read-side hash check is dead code, because no writer ever produces a
 * pointer with `sha256` set. Operationally this closes the loop fix.md
 * called out: a userData binary tampered after install is now refused at
 * launch and the launcher falls back to the bundled copy.
 */
export function activateSidecarBinary(staged: SidecarStagingResult): {
  version: string;
  path: string;
} {
  if (!existsSync(staged.binaryPath)) {
    throw new Error(
      `activateSidecarBinary: no staged binary at ${staged.binaryPath}. Call stageSidecarBinary first.`,
    );
  }
  mkdirSync(staged.userDir, { recursive: true });
  const currentFile = sidecarCurrentFile(staged.userDir);
  const stagingFile = currentFile + '.staging';
  const pointer = {
    version: staged.version,
    sha256: staged.sha256,
  };
  writeFileSync(stagingFile, JSON.stringify(pointer, null, 2) + '\n', 'utf-8');
  renameSync(stagingFile, currentFile);
  return { version: staged.version, path: staged.binaryPath };
}

/** Discard a staged sidecar (removes `versions/<v>/`). Best-effort. */
export function discardSidecarStaging(staged: SidecarStagingResult): void {
  try {
    const versionDir = sidecarVersionDir(staged.userDir, staged.version);
    if (existsSync(versionDir)) {
      rmSync(versionDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
}
