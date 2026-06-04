import type express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../path-utils.js';
import {
  compareVersions,
  fetchHotupdateManifest,
  pickSidecarTarget,
  resolveHotupdateManifestUrl,
} from '../update-manifest.js';
import {
  activateSidecarBinary,
  discardSidecarStaging,
  stageSidecarBinary,
} from '../release/sidecar-staging.js';
import { cancelHotupdate, endHotupdate, tryBeginHotupdate } from '../release/hotupdate-lock.js';

export interface SidecarInfo {
  bundledVersion: string | null;
  userInstalledVersion: string | null;
  activeVersion: string | null;
  activeSource: 'bundled' | 'user' | 'dev' | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  canUpdate: boolean;
  pendingRestart: boolean;
  minShellVersion: string | null;
  shellCompatible: boolean;
  channel: string | null;
  manifestUrl: string | null;
  releaseNotesUrl: string | null;
  platform: NodeJS.Platform;
  arch: string;
}

interface SidecarPointer {
  version: string;
}

function sidecarUserDir(): string | null {
  return process.env.TAGMA_SIDECAR_USER_DIR ?? null;
}

function sidecarCurrentFile(userDir: string): string {
  return join(userDir, 'current.json');
}

function sidecarExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
}

function sidecarBinaryPath(
  userDir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(userDir, 'versions', version, sidecarExecutableName(platform));
}

function readCurrentPointer(userDir: string | undefined): SidecarPointer | null {
  if (!userDir) return null;
  try {
    const raw = JSON.parse(readFileSync(sidecarCurrentFile(userDir), 'utf-8')) as {
      version?: unknown;
    };
    if (typeof raw.version !== 'string' || !raw.version.trim()) return null;
    return { version: raw.version.trim() };
  } catch {
    return null;
  }
}

function readInstalledVersion(userDir: string | undefined): string | null {
  const pointer = readCurrentPointer(userDir);
  if (!pointer || !userDir) return null;
  return existsSync(sidecarBinaryPath(userDir, pointer.version)) ? pointer.version : null;
}

async function performUpdate(signal?: AbortSignal): Promise<{ version: string; path: string }> {
  const userDir = sidecarUserDir();
  if (!userDir) {
    throw new Error(
      'Sidecar updates require a writable userData directory. This is only available when running under the desktop app.',
    );
  }
  const manifestUrl = resolveHotupdateManifestUrl('sidecar');
  if (!manifestUrl) {
    throw new Error(
      'No update manifest URL configured. Set tagma.updateManifestBaseUrl in the installer package metadata.',
    );
  }
  const manifest = await fetchHotupdateManifest(manifestUrl, true, signal);

  // Note: no route-level "already on this version" short-circuit anymore —
  // it would only check `existsSync(binary)` and miss a corrupt or truncated
  // binary, leaving the user wedged when they re-click Update to self-heal.
  // `stageSidecarBinary` handles the cheap path internally: if the on-disk
  // binary hashes to what the manifest advertises, it returns without ever
  // hitting the network. The activate call below is idempotent in that case
  // (rewrites current.json with the same content).
  const staged = await stageSidecarBinary(manifest, userDir, signal);
  try {
    return activateSidecarBinary(staged);
  } catch (err) {
    discardSidecarStaging(staged);
    throw err;
  }
}

export function registerSidecarRoutes(app: express.Express): void {
  app.get('/api/sidecar/info', async (req, res) => {
    try {
      const userDir = sidecarUserDir();
      const bundledVersion =
        process.env.TAGMA_SIDECAR_BUNDLED_VERSION ??
        process.env.TAGMA_EDITOR_BUNDLED_VERSION ??
        null;
      const activeVersion = process.env.TAGMA_SIDECAR_ACTIVE_VERSION ?? bundledVersion ?? null;
      const activeSource =
        (process.env.TAGMA_SIDECAR_ACTIVE_SOURCE as SidecarInfo['activeSource']) ??
        (bundledVersion ? 'dev' : null);
      const userInstalledVersion = readInstalledVersion(userDir ?? undefined);
      const channel =
        process.env.TAGMA_SIDECAR_UPDATE_CHANNEL ?? process.env.TAGMA_EDITOR_UPDATE_CHANNEL ?? null;
      const manifestUrl = resolveHotupdateManifestUrl('sidecar');

      let latestVersion: string | null = null;
      let releaseNotesUrl: string | null = null;
      let minShellVersion: string | null = null;
      let hasTarget = false;
      if (manifestUrl) {
        try {
          const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
          const manifest = await fetchHotupdateManifest(manifestUrl, forceRefresh);
          const target = pickSidecarTarget(manifest);
          if (target) {
            latestVersion = manifest.version;
            releaseNotesUrl = manifest.releaseNotesUrl ?? null;
            minShellVersion = manifest.minShellVersion ?? null;
            hasTarget = true;
          }
        } catch {
          latestVersion = null;
        }
      }

      const highestLocal = (() => {
        const candidates = [activeVersion, userInstalledVersion].filter(
          (value): value is string => !!value,
        );
        if (candidates.length === 0) return null;
        return candidates.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
      })();

      const pendingRestart =
        !!userInstalledVersion &&
        !!activeVersion &&
        compareVersions(userInstalledVersion, activeVersion) > 0;

      const shellCompatible =
        !minShellVersion ||
        !bundledVersion ||
        compareVersions(bundledVersion, minShellVersion) >= 0;

      const payload: SidecarInfo = {
        bundledVersion,
        userInstalledVersion,
        activeVersion,
        activeSource,
        latestVersion,
        updateAvailable:
          !!latestVersion &&
          !!highestLocal &&
          hasTarget &&
          compareVersions(latestVersion, highestLocal) > 0,
        canUpdate: !!userDir && !!manifestUrl && hasTarget,
        pendingRestart,
        minShellVersion,
        shellCompatible,
        channel,
        manifestUrl,
        releaseNotesUrl,
        platform: process.platform,
        arch: process.arch,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/sidecar/update', async (_req, res) => {
    const controller = new AbortController();
    const lock = tryBeginHotupdate('sidecar', controller);
    if (!lock.ok) {
      return res
        .status(409)
        .json({ error: `Another ${lock.activeKind} update is already running.` });
    }
    try {
      const result = await performUpdate(controller.signal);
      res.json({ ok: true, version: result.version, path: result.path });
    } catch (err) {
      if (controller.signal.aborted) {
        return res.status(499).json({ error: 'Sidecar update canceled.', kind: 'canceled' });
      }
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      endHotupdate(controller);
    }
  });

  app.post('/api/sidecar/update/cancel', (_req, res) => {
    if (!cancelHotupdate('sidecar')) {
      return res.status(409).json({ error: 'No sidecar update in flight.' });
    }
    res.json({ ok: true });
  });
}
