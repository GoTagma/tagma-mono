import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  assertValidHotupdateVersion,
  pickOpencodeTarget,
  type HotupdateManifest,
} from '../update-manifest.js';
import { downloadUrlToBuffer } from './download.js';

const MAX_OPENCODE_BINARY_BYTES = 300 * 1024 * 1024;
const OPENCODE_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

export interface OpencodeStagingResult {
  version: string;
  userDir: string;
  binaryPath: string;
  stagingBinaryPath: string;
  sha256: string;
}

export interface OpencodeActivationResult {
  version: string;
  userDir: string;
  binaryPath: string;
  previousBinaryPath: string | null;
  previousVersion: string | null;
  keptPrevious: boolean;
}

function opencodeExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function opencodeVersionFile(userDir: string): string {
  return join(userDir, 'version.txt');
}

function readInstalledVersion(userDir: string): string | null {
  try {
    const value = readFileSync(opencodeVersionFile(userDir), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function stageOpencodeBinary(
  manifest: HotupdateManifest,
  userDir: string,
  signal?: AbortSignal,
): Promise<OpencodeStagingResult> {
  const version = manifest.opencode?.version;
  if (!version) {
    throw new Error('Hot-update manifest is missing opencode.version.');
  }
  assertValidHotupdateVersion(version, 'opencode version');
  const target = pickOpencodeTarget(manifest);
  if (!target) {
    throw new Error(
      `No OpenCode update published for ${process.platform}/${process.arch} on channel ${manifest.channel}.`,
    );
  }
  if (target.size > MAX_OPENCODE_BINARY_BYTES) {
    throw new Error(
      `Manifest advertises a ${target.size} byte OpenCode binary, exceeds ${MAX_OPENCODE_BINARY_BYTES} byte cap`,
    );
  }

  const { buffer } = await downloadUrlToBuffer({
    url: target.url,
    label: 'OpenCode binary',
    maxBytes: MAX_OPENCODE_BINARY_BYTES,
    idleTimeoutMs: OPENCODE_DOWNLOAD_IDLE_TIMEOUT_MS,
    signal,
    expectedBytes: target.size > 0 ? target.size : undefined,
  });
  const actualSha = createHash('sha256').update(buffer).digest('hex');
  if (actualSha.toLowerCase() !== target.sha256.toLowerCase()) {
    throw new Error(
      `sha256 mismatch: manifest expected ${target.sha256}, OpenCode hashed to ${actualSha}. Refusing to install.`,
    );
  }

  const binDir = join(userDir, 'bin');
  const binaryPath = join(binDir, opencodeExecutableName());
  const stagingBinaryPath = `${binaryPath}.staging`;
  mkdirSync(binDir, { recursive: true });
  if (existsSync(stagingBinaryPath)) rmSync(stagingBinaryPath, { force: true });
  writeFileSync(stagingBinaryPath, buffer);
  if (process.platform !== 'win32') {
    chmodSync(stagingBinaryPath, 0o755);
  }

  return {
    version,
    userDir,
    binaryPath,
    stagingBinaryPath,
    sha256: actualSha.toLowerCase(),
  };
}

export function activateOpencodeBinary(
  staged: OpencodeStagingResult,
  options: { keepPrevious?: boolean } = {},
): OpencodeActivationResult {
  if (!existsSync(staged.stagingBinaryPath)) {
    throw new Error(
      `activateOpencodeBinary: no staged binary at ${staged.stagingBinaryPath}. Call stageOpencodeBinary first.`,
    );
  }
  const previousVersion = readInstalledVersion(staged.userDir);
  const previousBinaryPath = existsSync(staged.binaryPath) ? `${staged.binaryPath}.previous` : null;
  if (previousBinaryPath && existsSync(previousBinaryPath))
    rmSync(previousBinaryPath, { force: true });

  try {
    if (previousBinaryPath) {
      renameSync(staged.binaryPath, previousBinaryPath);
    }
    renameSync(staged.stagingBinaryPath, staged.binaryPath);
    writeFileSync(opencodeVersionFile(staged.userDir), staged.version + '\n', 'utf-8');
  } catch (err) {
    if (existsSync(staged.binaryPath)) {
      try {
        rmSync(staged.binaryPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
    if (previousBinaryPath && existsSync(previousBinaryPath)) {
      try {
        renameSync(previousBinaryPath, staged.binaryPath);
      } catch {
        /* best-effort */
      }
    }
    if (previousVersion) {
      try {
        writeFileSync(opencodeVersionFile(staged.userDir), previousVersion + '\n', 'utf-8');
      } catch {
        /* best-effort */
      }
    } else {
      try {
        rmSync(opencodeVersionFile(staged.userDir), { force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }

  if (!options.keepPrevious && previousBinaryPath && existsSync(previousBinaryPath)) {
    try {
      rmSync(previousBinaryPath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  return {
    version: staged.version,
    userDir: staged.userDir,
    binaryPath: staged.binaryPath,
    previousBinaryPath,
    previousVersion,
    keptPrevious: !!options.keepPrevious,
  };
}

export function finalizeOpencodeActivation(activation: OpencodeActivationResult): void {
  if (!activation.keptPrevious || !activation.previousBinaryPath) return;
  try {
    if (existsSync(activation.previousBinaryPath)) {
      rmSync(activation.previousBinaryPath, { force: true });
    }
  } catch {
    /* best-effort */
  }
}

export function rollbackOpencodeActivation(activation: OpencodeActivationResult): void {
  try {
    if (existsSync(activation.binaryPath)) {
      rmSync(activation.binaryPath, { force: true });
    }
    if (activation.previousBinaryPath && existsSync(activation.previousBinaryPath)) {
      renameSync(activation.previousBinaryPath, activation.binaryPath);
    }
    if (activation.previousVersion) {
      writeFileSync(
        opencodeVersionFile(activation.userDir),
        activation.previousVersion + '\n',
        'utf-8',
      );
    } else {
      rmSync(opencodeVersionFile(activation.userDir), { force: true });
    }
  } catch {
    /* best-effort */
  }
}

export function discardOpencodeStaging(staged: OpencodeStagingResult): void {
  try {
    if (existsSync(staged.stagingBinaryPath)) rmSync(staged.stagingBinaryPath, { force: true });
  } catch {
    /* best-effort */
  }
}
