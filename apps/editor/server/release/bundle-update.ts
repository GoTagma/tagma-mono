import type { HotupdateManifest } from '../update-manifest.js';
import {
  activateEditorDist,
  discardEditorStaging,
  finalizeEditorDistActivation,
  rollbackEditorDistActivation,
  stageEditorDist,
  type EditorActivationResult,
  type EditorStagingResult,
} from './editor-staging.js';
import {
  activateSidecarBinary,
  discardSidecarStaging,
  stageSidecarBinary,
  type SidecarStagingResult,
} from './sidecar-staging.js';

export interface BundleUpdateInput {
  manifest: HotupdateManifest;
  editorUserDir: string;
  sidecarUserDir: string;
  /**
   * Optional external abort signal. When fired, whichever download is currently
   * running (editor or sidecar tarball) rejects with AbortError; already-staged
   * bytes from the other side are discarded. No activation happens.
   */
  signal?: AbortSignal;
}

export interface BundleUpdateResult {
  editorVersion: string;
  sidecarVersion: string;
}

/**
 * Two-phase commit for editor + sidecar updates. Stage both artifacts first
 * (download + verify + park bytes). If either stage fails, no activation
 * happens and the other side's staged bytes are discarded. Only once both
 * stages succeed do we flip the live pointers — editor first, then sidecar.
 *
 * The narrow window between the two activations is the only place where a
 * crash can leave the two versions skewed on disk. `runtime-paths.ts` detects
 * that skew at startup and surfaces a warning so the user can re-run the
 * update to realign.
 */
export async function performBundleUpdate(input: BundleUpdateInput): Promise<BundleUpdateResult> {
  const { manifest, editorUserDir, sidecarUserDir, signal } = input;

  let editorStaged: EditorStagingResult | null = null;
  let sidecarStaged: SidecarStagingResult | null = null;
  let editorActivation: EditorActivationResult | null = null;
  try {
    editorStaged = await stageEditorDist(manifest, editorUserDir, signal);
    sidecarStaged = await stageSidecarBinary(manifest, sidecarUserDir, signal);
  } catch (err) {
    if (editorStaged) discardEditorStaging(editorStaged);
    if (sidecarStaged) discardSidecarStaging(sidecarStaged);
    throw err;
  }

  try {
    editorActivation = activateEditorDist(editorStaged, { keepPrevious: true });
    const sidecarResult = activateSidecarBinary(sidecarStaged);
    finalizeEditorDistActivation(editorActivation);
    return {
      editorVersion: editorActivation.version,
      sidecarVersion: sidecarResult.version,
    };
  } catch (err) {
    if (editorActivation) rollbackEditorDistActivation(editorActivation);
    throw err;
  }
}
