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
    if (!existsSync(join(userDir, 'dist', 'index.html'))) return null;
    const version = readFileSync(join(userDir, 'dist-version.txt'), 'utf-8').trim();
    return isValidHotupdateVersion(version) ? version : null;
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
