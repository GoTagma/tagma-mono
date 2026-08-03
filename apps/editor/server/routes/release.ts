import type express from 'express';
import { errorMessage } from '../path-utils.js';
import { fetchHotupdateManifest, resolveHotupdateManifestUrl } from '../update-manifest.js';
import { performBundleUpdate } from '../release/bundle-update.js';
import { cancelHotupdate, endHotupdate, tryBeginHotupdate } from '../release/hotupdate-lock.js';
import {
  assertHotupdateVersionUpgrade,
  assertHotupdateShellCompatible,
  collectLocalTagmaVersions,
  HotupdateShellPolicyError,
  HotupdateVersionPolicyError,
} from '../release/version-policy.js';
import { stopOpencodeProcesses } from '../opencode-lifecycle.js';

export interface ReleaseRouteDependencies {
  readonly stopOpencodeProcesses?: typeof stopOpencodeProcesses;
  readonly performBundleUpdate?: typeof performBundleUpdate;
}

export function registerReleaseRoutes(
  app: express.Express,
  dependencies: ReleaseRouteDependencies = {},
): void {
  const stopProcesses = dependencies.stopOpencodeProcesses ?? stopOpencodeProcesses;
  const updateBundle = dependencies.performBundleUpdate ?? performBundleUpdate;
  /**
   * POST /api/release/update
   *
   * Atomic editor + sidecar update. Stages both artifacts first — if either
   * stage fails, neither activation happens. Returns the per-component
   * versions so the UI can render "Updated to X.Y.Z" feedback.
   *
   * Returns 409 when another bundle update is already running. Serialization
   * is in-process only; the sidecar is a singleton per desktop, so that is
   * sufficient.
   */
  app.post('/api/release/update', async (_req, res) => {
    const editorUserDir = process.env.TAGMA_EDITOR_USER_DIR;
    const sidecarUserDir = process.env.TAGMA_SIDECAR_USER_DIR;
    const opencodeUserDir = process.env.TAGMA_OPENCODE_USER_DIR;
    if (!editorUserDir || !sidecarUserDir || !opencodeUserDir) {
      return res.status(400).json({
        error:
          'Release updates require a writable userData directory. This is only available when running under the desktop app.',
      });
    }
    // Release endpoint pins to ONE manifest; editor pair is the source of
    // truth (see resolveHotupdateManifestUrl jsdoc).
    const manifestUrl = resolveHotupdateManifestUrl('editor');
    if (!manifestUrl) {
      return res.status(400).json({
        error:
          'No update manifest URL configured. Set tagma.updateManifestBaseUrl in the installer package metadata.',
      });
    }
    const controller = new AbortController();
    const lock = tryBeginHotupdate('release', controller);
    if (!lock.ok) {
      return res
        .status(409)
        .json({ error: `Another ${lock.activeKind} update is already running.` });
    }
    try {
      const manifest = await fetchHotupdateManifest(manifestUrl, true, controller.signal);
      const localVersions = collectLocalTagmaVersions();
      assertHotupdateVersionUpgrade(manifest.version, localVersions);
      assertHotupdateShellCompatible(
        manifest,
        process.env.TAGMA_SIDECAR_BUNDLED_VERSION ?? process.env.TAGMA_EDITOR_BUNDLED_VERSION,
      );
      await stopProcesses(3_000);
      const result = await updateBundle({
        manifest,
        editorUserDir,
        sidecarUserDir,
        opencodeUserDir,
        localVersions,
        signal: controller.signal,
      });
      res.json({
        ok: true,
        editorVersion: result.editorVersion,
        sidecarVersion: result.sidecarVersion,
        opencodeVersion: result.opencodeVersion,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        return res.status(499).json({ error: 'Release update canceled.', kind: 'canceled' });
      }
      if (err instanceof HotupdateVersionPolicyError) {
        return res.status(409).json({
          error: err.message,
          kind: err.kind,
          highestLocalVersion: err.highestLocalVersion,
        });
      }
      if (err instanceof HotupdateShellPolicyError) {
        return res.status(409).json({
          error: err.message,
          kind: err.kind,
          minShellVersion: err.minShellVersion,
          currentShellVersion: err.currentShellVersion,
        });
      }
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      endHotupdate(controller);
    }
  });

  app.post('/api/release/update/cancel', (_req, res) => {
    if (!cancelHotupdate('release')) {
      return res.status(409).json({ error: 'No release update in flight.' });
    }
    res.json({ ok: true });
  });
}
