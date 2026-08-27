import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, isValidHotupdateVersion } from '../update-manifest.js';

export class HotupdateVersionPolicyError extends Error {
  readonly kind = 'not-newer';
  readonly highestLocalVersion: string | null;

  constructor(targetVersion: string, highestLocalVersion: string | null) {
    super(
      highestLocalVersion
        ? `Hot update ${targetVersion} must be strictly newer than local Tagma version ${highestLocalVersion}. Use the installer to replace Tagma with an older release.`
        : `Hot update ${targetVersion} cannot be applied because the local Tagma version is unknown. Use the installer instead.`,
    );
    this.name = 'HotupdateVersionPolicyError';
    this.highestLocalVersion = highestLocalVersion;
  }
}

export class HotupdateShellPolicyError extends Error {
  readonly kind = 'shell-incompatible';
  readonly minShellVersion: string;
  readonly currentShellVersion: string | null;

  constructor(minShellVersion: string, currentShellVersion: string | null) {
    super(
      'Hot update requires installer ' +
        minShellVersion +
        ' or newer (current: ' +
        (currentShellVersion ?? 'unknown') +
        '). Install the latest Tagma installer and retry.',
    );
    this.name = 'HotupdateShellPolicyError';
    this.minShellVersion = minShellVersion;
    this.currentShellVersion = currentShellVersion;
  }
}

export function assertHotupdateShellCompatible(
  manifest: { readonly minShellVersion?: string },
  currentShellVersion: string | null | undefined,
): void {
  const minShellVersion = manifest.minShellVersion;
  if (
    !minShellVersion ||
    typeof currentShellVersion !== 'string' ||
    !isValidHotupdateVersion(currentShellVersion)
  ) {
    return;
  }
  if (compareVersions(currentShellVersion, minShellVersion) < 0) {
    throw new HotupdateShellPolicyError(minShellVersion, currentShellVersion);
  }
}

export function highestLocalTagmaVersion(
  versions: readonly (string | null | undefined)[],
): string | null {
  const validVersions = versions.filter(
    (version): version is string => typeof version === 'string' && isValidHotupdateVersion(version),
  );
  if (validVersions.length === 0) return null;
  return validVersions.reduce((highest, version) =>
    compareVersions(highest, version) >= 0 ? highest : version,
  );
}

export function assertHotupdateVersionUpgrade(
  targetVersion: string,
  localVersions: readonly (string | null | undefined)[],
): string {
  const highestLocalVersion = highestLocalTagmaVersion(localVersions);
  if (!highestLocalVersion || compareVersions(targetVersion, highestLocalVersion) <= 0) {
    throw new HotupdateVersionPolicyError(targetVersion, highestLocalVersion);
  }
  return highestLocalVersion;
}

function readUserEditorVersion(userDir: string | undefined): string | null {
  if (!userDir) return null;
  try {
    const distDir = join(userDir, 'dist');
    if (!existsSync(join(distDir, 'index.html'))) return null;
    for (const versionPath of [
      join(userDir, 'dist-version.txt'),
      // Activation renames dist/ first and writes the outer version second.
      // The in-bundle sentinel travels atomically with the editor bytes, so
      // it remains authoritative when that final write is interrupted.
      join(distDir, '.tagma-bundle-version'),
    ]) {
      try {
        const version = readFileSync(versionPath, 'utf-8').trim();
        if (isValidHotupdateVersion(version)) return version;
      } catch {
        /* try the recoverable in-bundle sentinel */
      }
    }
    return null;
  } catch {
    return null;
  }
}

function readUserSidecarVersion(
  userDir: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!userDir) return null;
  try {
    const pointer = JSON.parse(readFileSync(join(userDir, 'current.json'), 'utf-8')) as {
      version?: unknown;
    };
    if (typeof pointer.version !== 'string') return null;
    const version = pointer.version.trim();
    if (!isValidHotupdateVersion(version)) return null;
    const executable = platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
    return existsSync(join(userDir, 'versions', version, executable)) ? version : null;
  } catch {
    return null;
  }
}

export function collectLocalTagmaVersions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const versions = [
    env.TAGMA_EDITOR_BUNDLED_VERSION,
    env.TAGMA_SIDECAR_BUNDLED_VERSION ?? env.TAGMA_EDITOR_BUNDLED_VERSION,
    env.TAGMA_SIDECAR_ACTIVE_VERSION,
    readUserEditorVersion(env.TAGMA_EDITOR_USER_DIR),
    readUserSidecarVersion(env.TAGMA_SIDECAR_USER_DIR, platform),
  ].filter(
    (version): version is string => typeof version === 'string' && isValidHotupdateVersion(version),
  );
  return [...new Set(versions)];
}
