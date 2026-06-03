import { create } from 'zustand';
import {
  api,
  RevisionConflictError,
  setClientRevision,
  setClientWorkspace,
  withYamlEditLockRequestBypass,
} from '../api/client';
import type {
  ServerState,
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
  TrackFolder,
  ValidationError,
  DagEdge,
  PluginRegistry,
  PlatformExportModel,
  PlatformExportProgressEvent,
  PlatformExportTarget,
} from '../api/client';
import {
  clearLastLocalFieldEditAt,
  discardAllLocalFieldEdits,
  flushAllLocalFields,
} from '../hooks/use-local-field';
import { generateConfigId } from '../../shared/config-id.js';
import { requestWorkspaceSwitch } from '../desktop';
import {
  buildDownstreamPortsReport,
  buildUpstreamPortsReport,
  computeSyncedInputs,
  computeSyncedOutputs,
  inputBindingsToPorts,
  mergeInputPortsIntoBindings,
  mergeOutputPortsIntoBindings,
  outputBindingsToPorts,
  portsEqual,
} from '../utils/ports';
import {
  buildYamlPreviewBlocks,
  parsePreviewYaml,
  revertYamlPreviewHunk,
  serializePreviewYaml,
  type YamlPreviewBlock,
  type YamlPreviewChangeSource,
} from '../utils/yaml-preview-diff';
import {
  getLocalYamlEditLockId,
  isLocalYamlEditLockActive,
  isYamlEditLocked,
  YAML_EDIT_LOCK_MESSAGE,
} from './yaml-edit-lock-store';

/**
 * D9: Diff-based Undo/Redo Implementation
 *
 * This file implements a memory-efficient undo/redo system using diffs instead
 * of full state snapshots. Key concepts:
 *
 * 1. **Diff-based storage**: Each HistoryEntry stores a HistoryDiff containing
 *    old/new values for each state slice (config, positions, folders, dagEdges,
 *    validationErrors). Only slices within the entry's scope are populated.
 *
 * 2. **Lazy completion**: When pushing a history entry, we only capture the
 *    "old" (pre-mutation) state. The "new" (post-mutation) state is filled in
 *    lazily during undo/redo operations. This reduces memory usage by ~50%.
 *
 * 3. **Scope-based restoration**: Each entry has a scope ('config', 'positions',
 *    or 'both') that determines which state slices it owns. Undo/redo only
 *    restore owned slices, allowing interleaved edits (e.g., config edit +
 *    position drag) to be undone independently.
 *
 * 4. **Coalescing**: Rapid successive edits with the same coalesceKey are
 *    merged into a single undo entry. This prevents typing a word from creating
 *    10 separate undo steps.
 *
 * 5. **Forward/reverse application**:
 *    - Undo: Apply diff in reverse (restore old values)
 *    - Redo: Apply diff forward (restore new values)
 *
 * This design maintains the same semantics as full-snapshot undo/redo while
 * using significantly less memory, especially for large pipelines.
 */

const EMPTY_REGISTRY: PluginRegistry = {
  drivers: [],
  triggers: [],
  completions: [],
  middlewares: [],
};

interface YamlLockBypassOptions {
  allowDuringYamlEditLock?: boolean;
}

/**
 * User-facing toast shown when a mutation is rejected with HTTP 409 because
 * the client's observed revision is stale. The store reconciles by adopting
 * `currentState` from the error payload and surfacing this message so the
 * user knows their edit was dropped and the UI now reflects the latest
 * authoritative server truth. We intentionally do NOT auto-retry the
 * mutation — the new base state may invalidate it.
 */
const REVISION_CONFLICT_MESSAGE =
  'Your change was rejected — another client updated the pipeline first. Reloaded to the latest version; please retry if needed.';

export interface TaskPosition {
  x: number;
}

/**
 * Undo/redo history entry. Uses diff-based storage instead of full snapshots
 * to reduce memory usage and make the undo stack more introspectable.
 *
 * P1-C1: `scope` indicates which slices of state this entry "owns" so that
 * undoing a position-only drag does NOT revert an unrelated config edit, and
 * vice-versa. Without scoping, every entry restores the WHOLE state at the
 * time of capture, which means a sync setTaskPosition push interleaved with
 * an in-flight updateTask leads to "undo undoes too much".
 *
 *   scope='config'    → restore config + dagEdges + validationErrors only
 *   scope='positions' → restore positions only
 *   scope='both'      → restore everything (used by mutations that touch
 *                       both config and positions atomically, e.g.
 *                       deleteTask, deleteTrack, transferTaskToTrack)
 *
 * `coalesceKey` + `pushedAt` enable streak-merging so that a burst of
 * same-field edits (e.g. typing into a task name) collapses into a single
 * undoable entry. See `pushHistory`.
 *
 * `pushId` is assigned by pushHistory and used by fire() to remove the
 * entry on API failure (the optimistic sync push must be rolled back).
 */
export type HistoryScope = 'config' | 'positions' | 'both';

export interface HistoryEntry {
  /** Diff-based change record instead of full snapshot */
  diff: HistoryDiff;
  coalesceKey?: string;
  /** When this entry was first pushed (immutable, for total-cap check). */
  coalesceStartedAt?: number;
  /** When this entry was last refreshed by a coalesced push (rolling). */
  pushedAt?: number;
  pushId?: number;
}

/**
 * Diff-based undo/redo: instead of storing full snapshots, store only the
 * changes. This reduces memory usage and makes the undo stack more
 * introspectable (you can see what each undo will do).
 *
 * The diff format mirrors the scope system: each diff carries only the
 * slices it modifies, and undo/redo apply or reverse those slices.
 */
export interface ConfigDiff {
  /** Old config (for reverse), null if scope doesn't include config */
  oldConfig: RawPipelineConfig | null;
  /** New config (for forward), null if scope doesn't include config */
  newConfig: RawPipelineConfig | null;
  /** Old dagEdges, null if scope doesn't include config */
  oldDagEdges: DagEdge[] | null;
  /** New dagEdges, null if scope doesn't include config */
  newDagEdges: DagEdge[] | null;
  /** Old validationErrors, null if scope doesn't include config */
  oldValidationErrors: ValidationError[] | null;
  /** New validationErrors, null if scope doesn't include config */
  newValidationErrors: ValidationError[] | null;
}

export interface PositionsDiff {
  /** Old positions map (for reverse), null if scope doesn't include positions */
  oldPositions: Map<string, TaskPosition> | null;
  /** New positions map (for forward), null if scope doesn't include positions */
  newPositions: Map<string, TaskPosition> | null;
  /** Old folders (for reverse), null if scope doesn't include positions */
  oldFolders: TrackFolder[] | null;
  /** New folders (for forward), null if scope doesn't include positions */
  newFolders: TrackFolder[] | null;
}

export interface HistoryDiff {
  scope: HistoryScope;
  config: ConfigDiff;
  positions: PositionsDiff;
}

/** Maximum entries kept in each history stack before oldest is dropped. */
const HISTORY_LIMIT = 50;

/**
 * Idle window in which a same-key follow-up push still merges into the
 * earlier streak. Long enough to cover natural typing pauses, short enough
 * that "I stopped, thought, then typed again" feels like two undos.
 */
const COALESCE_IDLE_MS = 1500;

/**
 * Hard cap on how long a single coalesce streak may last. Without this,
 * a continuous stream of keystrokes would refresh the timestamp forever and
 * one undo could rewind several minutes of typing. P1-H2: cap each streak
 * to ~3 seconds total, regardless of how fast the user types.
 */
const COALESCE_TOTAL_MS = 3000;

/**
 * Drag/layout bursts (grabbed task + companions) fire microseconds apart on
 * pointerup, so a tight idle window is enough to merge them while
 * guaranteeing two SEPARATE drags always get two undo entries.
 */
const LAYOUT_COALESCE_IDLE_MS = 200;
const LAYOUT_COALESCE_TOTAL_MS = 500;

function coalesceWindowsFor(key: string | undefined): { idle: number; total: number } {
  if (!key) return { idle: COALESCE_IDLE_MS, total: COALESCE_TOTAL_MS };
  if (key.startsWith('layout:'))
    return { idle: LAYOUT_COALESCE_IDLE_MS, total: LAYOUT_COALESCE_TOTAL_MS };
  return { idle: COALESCE_IDLE_MS, total: COALESCE_TOTAL_MS };
}

/**
 * Clipboard slot for copy/paste of a task or an entire track.
 * Payload is a deep-clonable plain object that keeps all fields except
 * identity (ids are regenerated on paste).
 */
export type ClipboardSlot =
  | { kind: 'task'; trackId: string; task: RawTaskConfig }
  | { kind: 'track'; track: RawTrackConfig }
  | null;

interface PipelineState {
  config: RawPipelineConfig;
  positions: Map<string, TaskPosition>;
  /**
   * Editor-only track grouping. Persisted in `.layout.json`, never in YAML.
   * A track may belong to at most one folder; tracks not present in any
   * folder render at the top level.
   */
  folders: TrackFolder[];
  selectedTaskId: string | null;
  selectedTaskIds: string[];
  selectedTrackId: string | null;
  validationErrors: ValidationError[];
  dagEdges: DagEdge[];
  yamlPath: string | null;
  manualNewPipelineYamlPath: string | null;
  yamlMtimeMs: number | null;
  yamlRunVersion: number;
  workDir: string;
  hostPlatform: PlatformExportTarget | null;
  isDirty: boolean;
  /** Wall-clock millis of the last successful save (manual or autosave). */
  lastAutosaveAt: number | null;
  layoutDirty: boolean;
  loading: boolean;
  errorMessage: string | null;
  registry: PluginRegistry;
  past: HistoryEntry[];
  future: HistoryEntry[];
  yamlPreviewBaselineYaml: string | null;
  yamlPreviewBlocks: YamlPreviewBlock[];
  /**
   * Snapshot of `config` as it last existed on disk — refreshed on load,
   * import, demo-load, new-pipeline, undo of a YAML preview block, and
   * after every successful save. Per-field "modified" badges in the
   * Inspector and per-node/track badges on the canvas compare the live
   * `config` against this baseline. `null` until the first load completes.
   */
  savedConfig: RawPipelineConfig | null;
  clipboard: ClipboardSlot;
  pinnedTaskId: string | null;
  pinnedTrackId: string | null;
  /**
   * Top-level view flag for the Plugins page. Mirrors `useRunStore().active`
   * in shape and intent: App.tsx renders the Plugins page when this is true
   * and the run view is not active. Kept here (rather than a dedicated
   * plugins store) because plugins are declared in `pipeline.plugins[]` so
   * the store already owns the adjacent data.
   */
  pluginsActive: boolean;

  /** Whether the Usage Stats top-level page is showing. Same gating semantics
   *  as `pluginsActive`. */
  usageActive: boolean;

  applyState: (state: ServerState) => void;
  applyStateWithLayout: (state: ServerState) => void;
  applyStateWithPreview: (state: ServerState, source: YamlPreviewChangeSource) => void;
  adoptDiskState: (state: ServerState, source?: YamlPreviewChangeSource) => void;
  resetYamlPreviewBaseline: (config?: RawPipelineConfig) => void;
  revertYamlPreviewBlock: (blockId: string) => Promise<boolean>;
  clearError: () => void;
  init: () => Promise<void>;
  setPipelineName: (name: string) => void;
  updatePipelineFields: (fields: Record<string, unknown>) => void;
  addTrack: (name: string, opts?: { folderId?: string }) => void;
  renameTrack: (trackId: string, name: string) => void;
  updateTrackFields: (trackId: string, fields: Record<string, unknown>) => void;
  deleteTrack: (trackId: string) => void;
  moveTrackTo: (trackId: string, toIndex: number) => void;
  addTask: (
    trackId: string,
    name: string,
    options?: { kind?: 'prompt' | 'command'; positionX?: number },
  ) => void;
  updateTask: (trackId: string, taskId: string, patch: Partial<RawTaskConfig>) => void;
  deleteTask: (trackId: string, taskId: string) => void;
  transferTaskToTrack: (fromTrackId: string, taskId: string, toTrackId: string) => void;
  addDependency: (
    fromTrackId: string,
    fromTaskId: string,
    toTrackId: string,
    toTaskId: string,
  ) => void;
  removeDependency: (trackId: string, taskId: string, depRef: string) => void;
  setRegistry: (registry: PluginRegistry) => void;
  /**
   * Re-fetch /api/state without touching layout or undo history.
   * Used after plugin install/uninstall so validationErrors (which depend
   * on the server's live SDK registry) reflect the new known-types set.
   */
  refreshServerState: () => Promise<void>;
  selectTask: (qualifiedId: string | null) => void;
  toggleTaskSelection: (qualifiedId: string) => void;
  selectTrack: (trackId: string | null) => void;
  setTaskPosition: (qualifiedId: string, x: number) => void;
  setWorkDir: (workDir: string) => Promise<boolean>;
  clearWorkspace: () => void;
  openFile: (path: string, opts?: YamlLockBypassOptions) => Promise<void>;
  saveFile: (opts?: YamlLockBypassOptions) => Promise<boolean>;
  saveFileAs: (path: string, opts?: YamlLockBypassOptions) => Promise<boolean>;
  syncLocalStateToServerMemory: (opts?: YamlLockBypassOptions) => Promise<boolean>;
  restoreDraft: (config: RawPipelineConfig) => Promise<void>;
  newPipeline: (name?: string) => Promise<void>;
  importFile: (sourcePath: string) => Promise<void>;
  exportFile: (destDir: string) => Promise<string | null>;
  exportPlatformFile: (
    destDir: string,
    targetPlatform: PlatformExportTarget,
    model?: PlatformExportModel | null,
    onProgress?: (event: PlatformExportProgressEvent) => void,
  ) => Promise<string | null>;
  exportYaml: () => Promise<string>;
  importYaml: (yaml: string) => Promise<void>;
  loadDemo: () => Promise<void>;

  // Undo/redo (config-level history only). Async because each call mirrors
  // the local restore to the server via api.replaceConfig and waits for any
  // in-flight mutations to settle so the past stack is stable.
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Clipboard: copy / paste / duplicate selected task or track.
  copySelection: () => boolean;
  pasteClipboard: () => boolean;
  duplicateSelection: () => boolean;
  pinTask: (qualifiedId: string) => void;
  unpinTask: () => void;
  pinTrack: (trackId: string) => void;
  unpinTrack: () => void;

  // ── Track folders (editor-only grouping, persisted in .layout.json). ──
  /** Create a new folder; optionally seed with member tracks. Returns id. */
  createFolder: (opts?: { name?: string; trackIds?: string[]; color?: string }) => string;
  /** Delete a folder; member tracks fall back to the top level. */
  deleteFolder: (folderId: string) => void;
  /** Rename a folder. */
  renameFolder: (folderId: string, name: string) => void;
  /** Set or clear a folder's accent color. */
  setFolderColor: (folderId: string, color: string | null) => void;
  /** Toggle the collapsed state of a folder. */
  toggleFolderCollapsed: (folderId: string) => void;
  /**
   * Move a track in/out of a folder.
   *   folderId === null  → remove from any folder (root level)
   *   atIndex undefined  → append to the folder's trackIds
   */
  moveTrackToFolder: (trackId: string, folderId: string | null, atIndex?: number) => void;
  /** Move a track out of any folder and place it at a root/config order slot atomically. */
  moveTrackToRoot: (trackId: string, toIndex: number) => void;
  /** Reorder a folder among its peers. */
  reorderFolder: (folderId: string, toIndex: number) => void;

  // Plugins page top-level view toggle — parallel to runStore.active.
  showPluginsPage: () => void;
  hidePluginsPage: () => void;

  // Usage stats page top-level view toggle — same pattern as Plugins.
  showUsagePage: () => void;
  hideUsagePage: () => void;

  /**
   * Walk every task in the current config and, for any command task whose
   * dataflow bindings don't match what its direct neighbours expose, PATCH the
   * task to adopt the synced shape. Used by the external-change handler so
   * that a YAML edit made by the chat agent (which can add dependencies or
   * upstream outputs) doesn't leave the user staring at a "Sync N" button —
   * the ports are reconciled automatically as part of applying the change.
   *
   * Mutations fire with `skipHistory: true`, so auto-sync passes never
   * appear on the undo stack: the user can still undo their pre-chat edits
   * without replaying an irrelevant binding reconciliation.
   */
  autoSyncAllBindings: (
    source?: YamlPreviewChangeSource | null,
    opts?: YamlLockBypassOptions,
  ) => Promise<void>;
}

/**
 * Extract a human-readable message from any thrown value. Fetch errors from
 * `request()` in api/client.ts are thrown as `new Error(err.error ?? ...)`,
 * so `.message` normally carries the server-reported reason.
 */
function errorToMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

const TRACK_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#6366f1',
];

/** Snapshot of mutable slice used for optimistic rollback. */
interface Snapshot {
  config: RawPipelineConfig;
  positions: Map<string, TaskPosition>;
  folders: TrackFolder[];
  dagEdges: DagEdge[];
  validationErrors: ValidationError[];
  selectedTaskId: string | null;
  selectedTaskIds: string[];
  selectedTrackId: string | null;
  pinnedTaskId: string | null;
  pinnedTrackId: string | null;
  isDirty: boolean;
  layoutDirty: boolean;
}

export const usePipelineStore = create<PipelineState>((set, _get) => {
  const takeSnapshot = (): Snapshot => {
    const s = _get();
    return {
      config: s.config,
      positions: new Map(s.positions),
      folders: structuredClone(s.folders),
      dagEdges: s.dagEdges,
      validationErrors: s.validationErrors,
      selectedTaskId: s.selectedTaskId,
      selectedTaskIds: s.selectedTaskIds,
      selectedTrackId: s.selectedTrackId,
      pinnedTaskId: s.pinnedTaskId,
      pinnedTrackId: s.pinnedTrackId,
      isDirty: s.isDirty,
      layoutDirty: s.layoutDirty,
    };
  };

  const restoreSnapshot = (snap: Snapshot) => {
    set({
      config: snap.config,
      positions: snap.positions,
      folders: snap.folders,
      dagEdges: snap.dagEdges,
      validationErrors: snap.validationErrors,
      selectedTaskId: snap.selectedTaskId,
      selectedTaskIds: snap.selectedTaskIds,
      selectedTrackId: snap.selectedTrackId,
      pinnedTaskId: snap.pinnedTaskId,
      pinnedTrackId: snap.pinnedTrackId,
      isDirty: snap.isDirty,
      layoutDirty: snap.layoutDirty,
    });
  };

  /**
   * Flush pending layout positions to the server.
   * Returns a promise that resolves on success and rejects on failure so
   * callers (saveFile) can await the result. On success, clear layoutDirty.
   * On failure, surface the error via errorMessage.
   */
  const flushLayout = async (): Promise<void> => {
    const s = _get();
    const obj: Record<string, { x: number }> = {};
    for (const [k, v] of s.positions) obj[k] = v;
    try {
      await api.saveLayout(obj, structuredClone(s.folders));
      set({ layoutDirty: false });
    } catch (e) {
      if (e instanceof RevisionConflictError) {
        // C6: same reconciliation strategy as fire() — adopt the server's
        // authoritative state, drop history, and surface the conflict toast.
        // We do NOT rethrow here: callers (e.g. saveFile) treat a resolved
        // conflict as a terminal state, not a transient failure to retry.
        applyStateWithLayout(e.currentState);
        set({
          isDirty: false,
          layoutDirty: false,
          past: [],
          future: [],
          errorMessage: REVISION_CONFLICT_MESSAGE,
          savedConfig: structuredClone(e.currentState.config),
        });
        return;
      }
      set({ errorMessage: 'Failed to save layout: ' + errorToMessage(e) });
      throw e;
    }
  };

  /**
   * Apply a fresh ServerState from the backend. Only server-derived fields
   * are updated; dirty tracking is owned by the caller (mutation actions set
   * isDirty true before firing, save actions set it false after success).
   */
  const applyState = (state: ServerState) => {
    setClientRevision(state.revision);
    // Config mutations return a full ServerState, but they do not own the
    // editor layout slice. Keep the local folders and only prune deleted
    // tracks. Full layout adoption is explicit via applyStateWithLayout().
    const validTrackIds = new Set<string>(state.config.tracks.map((t) => t.id));
    set({
      config: state.config,
      validationErrors: state.validationErrors,
      dagEdges: state.dag.edges,
      yamlPath: state.yamlPath,
      manualNewPipelineYamlPath: state.manualNewPipelineYamlPath ?? null,
      yamlMtimeMs: state.yamlMtimeMs ?? null,
      yamlRunVersion: state.yamlRunVersion ?? 0,
      workDir: state.workDir,
      hostPlatform: state.hostPlatform ?? null,
      folders: pruneFolderMembers(_get().folders, validTrackIds),
      loading: false,
    });
  };

  /** Apply server state and restore layout positions from server */
  const applyStateWithLayout = (state: ServerState) => {
    setClientRevision(state.revision);
    const positions = new Map<string, TaskPosition>();
    if (state.layout?.positions) {
      for (const [k, v] of Object.entries(state.layout.positions)) {
        positions.set(k, v);
      }
    }
    const validTrackIds = new Set<string>(state.config.tracks.map((t) => t.id));
    set({
      config: state.config,
      validationErrors: state.validationErrors,
      dagEdges: state.dag.edges,
      yamlPath: state.yamlPath,
      manualNewPipelineYamlPath: state.manualNewPipelineYamlPath ?? null,
      yamlMtimeMs: state.yamlMtimeMs ?? null,
      yamlRunVersion: state.yamlRunVersion ?? 0,
      workDir: state.workDir,
      hostPlatform: state.hostPlatform ?? null,
      positions,
      folders: pruneFolderMembers(state.layout?.folders, validTrackIds),
      loading: false,
    });
  };

  const resetYamlPreviewBaseline = (config?: RawPipelineConfig) => {
    const baselineConfig = config ?? _get().config;
    set({
      yamlPreviewBaselineYaml: serializePreviewYaml(baselineConfig),
      yamlPreviewBlocks: [],
      savedConfig: structuredClone(baselineConfig),
    });
  };

  /** Convert the live positions Map to the wire shape replaceConfig expects. */
  const positionsToObj = (positions: Map<string, TaskPosition>): Record<string, { x: number }> => {
    const obj: Record<string, { x: number }> = {};
    for (const [k, v] of positions) obj[k] = { x: v.x };
    return obj;
  };

  /**
   * Build the full layout wire payload (positions + folders) for the
   * `api.replaceConfig` / `api.saveLayout` calls. Folders are deep-cloned so
   * a later in-memory edit cannot retroactively mutate the in-flight payload.
   */
  const layoutPayload = (
    positions: Map<string, TaskPosition>,
    folders: TrackFolder[],
  ): { positions: Record<string, { x: number }>; folders: TrackFolder[] } => ({
    positions: positionsToObj(positions),
    folders: structuredClone(folders),
  });

  /**
   * Filter a folders array down to entries whose member trackIds still exist
   * in `validTrackIds`. Used by `applyState` so we never render folder entries
   * pointing at deleted tracks. Empty folders ARE preserved — the user may
   * have intentionally created an empty folder.
   */
  const pruneFolderMembers = (folders: unknown, validTrackIds: Set<string>): TrackFolder[] => {
    if (!Array.isArray(folders)) return [];
    const seenIds = new Set<string>();
    const claimedTracks = new Set<string>();
    const out: TrackFolder[] = [];
    for (const entry of folders) {
      if (!entry || typeof entry !== 'object') continue;
      const f = entry as Record<string, unknown>;
      if (typeof f.id !== 'string' || !f.id || seenIds.has(f.id)) continue;
      if (typeof f.name !== 'string') continue;
      const trackIds: string[] = [];
      if (Array.isArray(f.trackIds)) {
        for (const tid of f.trackIds) {
          if (typeof tid !== 'string') continue;
          if (!validTrackIds.has(tid)) continue;
          if (claimedTracks.has(tid)) continue;
          claimedTracks.add(tid);
          trackIds.push(tid);
        }
      }
      seenIds.add(f.id);
      out.push({
        id: f.id,
        name: f.name,
        color: typeof f.color === 'string' && f.color ? f.color : undefined,
        trackIds,
        collapsed: f.collapsed === true,
      });
    }
    return out;
  };

  const configWithTrackAt = (
    config: RawPipelineConfig,
    trackId: string,
    toIndex: number,
  ): RawPipelineConfig | null => {
    const fromIndex = config.tracks.findIndex((t) => t.id === trackId);
    if (fromIndex < 0) return null;
    const without = config.tracks.filter((t) => t.id !== trackId);
    const insertAt = Math.max(0, Math.min(toIndex, without.length));
    if (fromIndex === insertAt) return null;
    const moved = config.tracks[fromIndex];
    const tracks = [...without];
    tracks.splice(insertAt, 0, moved);
    return { ...config, tracks };
  };

  const foldersWithTrackPlacement = (
    folders: TrackFolder[],
    validTrackIds: Set<string>,
    trackId: string,
    folderId: string | null,
    atIndex?: number,
  ): TrackFolder[] | null => {
    if (!validTrackIds.has(trackId)) return null;
    const currentFolder = folders.find((f) => f.trackIds.includes(trackId));
    if (folderId === null && !currentFolder) return null;
    if (folderId !== null) {
      const target = folders.find((f) => f.id === folderId);
      if (!target) return null;
      const currentIdx = target.trackIds.indexOf(trackId);
      const desiredIdx =
        atIndex === undefined ? target.trackIds.length - (currentIdx >= 0 ? 1 : 0) : atIndex;
      if (currentFolder?.id === folderId && currentIdx === desiredIdx) return null;
    }

    const stripped = folders.map((f) => ({
      ...f,
      trackIds: f.trackIds.filter((t) => t !== trackId),
    }));
    if (folderId === null) return stripped;

    return stripped.map((f) => {
      if (f.id !== folderId) return f;
      const ids = [...f.trackIds];
      const insertAt =
        atIndex === undefined ? ids.length : Math.max(0, Math.min(atIndex, ids.length));
      ids.splice(insertAt, 0, trackId);
      return { ...f, trackIds: ids };
    });
  };

  const clonePositionsObj = (
    positions: Record<string, { x: number }> | undefined,
  ): Record<string, { x: number }> => {
    const obj: Record<string, { x: number }> = {};
    for (const [k, v] of Object.entries(positions ?? {})) obj[k] = { x: v.x };
    return obj;
  };

  const positionsEqual = (
    a: Record<string, { x: number }>,
    b: Record<string, { x: number }>,
  ): boolean => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => b[key]?.x === a[key].x);
  };

  const recordYamlPreviewChange = (
    source: YamlPreviewChangeSource,
    beforeConfig: RawPipelineConfig,
    afterConfig: RawPipelineConfig,
    beforePositions?: Map<string, TaskPosition>,
    afterPositions?: Map<string, TaskPosition>,
  ) => {
    const beforeYaml = serializePreviewYaml(beforeConfig);
    const afterYaml = serializePreviewYaml(afterConfig);
    if (beforeYaml === afterYaml) return;

    const layoutBefore = beforePositions ? positionsToObj(beforePositions) : undefined;
    const layoutAfter = afterPositions ? positionsToObj(afterPositions) : undefined;
    const layoutChanged =
      layoutBefore !== undefined &&
      layoutAfter !== undefined &&
      !positionsEqual(layoutBefore, layoutAfter);
    const current = _get();
    const baselineYaml = current.yamlPreviewBaselineYaml ?? beforeYaml;
    set({
      yamlPreviewBaselineYaml: baselineYaml,
      yamlPreviewBlocks: buildYamlPreviewBlocks({
        baselineYaml,
        previousBlocks: current.yamlPreviewBlocks,
        beforeYaml,
        afterYaml,
        source,
        changedAt: Date.now(),
        layoutBefore,
        layoutAfter,
        layoutChanged,
      }),
    });
  };

  const applyStateWithPreview = (state: ServerState, source: YamlPreviewChangeSource) => {
    const current = _get();
    const afterPositions = new Map<string, TaskPosition>();
    for (const [k, v] of Object.entries(state.layout?.positions ?? {})) {
      afterPositions.set(k, { x: v.x });
    }
    recordYamlPreviewChange(
      source,
      current.config,
      state.config,
      current.positions,
      afterPositions,
    );
    applyStateWithLayout(state);
  };

  // Monotonic request counter used to reject out-of-order responses from
  // local mutations and preserve-local requests.
  let fireEpoch = 0;
  let mutationGeneration = 0;
  let mutationTail: Promise<void> = Promise.resolve();

  const adoptDiskState = (state: ServerState, source?: YamlPreviewChangeSource) => {
    // Any in-flight local mutation or preserve-local request belongs to the
    // version the user just rejected. Advance the epoch before applying disk
    // state so late responses cannot put the discarded canvas back.
    fireEpoch++;
    mutationGeneration++;
    discardAllLocalFieldEdits();
    if (source) {
      applyStateWithPreview(state, source);
    } else {
      applyStateWithLayout(state);
      resetYamlPreviewBaseline(state.config);
    }
    set({
      isDirty: false,
      layoutDirty: false,
      past: [],
      future: [],
      errorMessage: null,
      savedConfig: structuredClone(state.config),
    });
  };

  const applyFreshStateWithLayout = (state: ServerState) => {
    applyStateWithLayout(state);
    resetYamlPreviewBaseline(state.config);
  };

  /**
   * Workspace/file open flows can load or unload plugins on the server.
   * The editor's dropdowns read from the client-side registry snapshot, so
   * those flows must explicitly re-sync `/api/registry` afterwards.
   */
  const fetchRegistrySnapshot = async (): Promise<PluginRegistry> => {
    try {
      return await api.getRegistry();
    } catch {
      return EMPTY_REGISTRY;
    }
  };

  // P0-C3: In-flight mutation tracking. `fire()` registers each request here
  // so `saveFile()` and `undo()`/`redo()` can drain pending writes before
  // dispatching their own. Without this, `saveFile` could race ahead of an
  // unresolved `replaceConfig` and the server might persist the *pre-undo*
  // config to disk while the in-memory state diverges.
  const inFlight = new Set<Promise<void>>();
  const trackInFlight = (p: Promise<unknown>): void => {
    const tracker: Promise<void> = p.then(
      () => {},
      () => {},
    );
    inFlight.add(tracker);
    void tracker.finally(() => {
      inFlight.delete(tracker);
    });
  };
  /**
   * Wait for all currently in-flight mutations to settle. Loops because
   * `flushAllLocalFields()` may queue NEW mutations during the drain — we
   * must catch those too so `saveFile` never proceeds with stale state.
   */
  const drainInFlight = async (): Promise<void> => {
    while (inFlight.size > 0) {
      await Promise.allSettled(Array.from(inFlight));
    }
  };

  /**
   * After an undo/redo restores an older config, any selected task or track
   * that no longer exists in that config must be dropped — otherwise panels
   * read `undefined` and crash, and pinned entities would refuse to clear.
   * Returns a partial state patch; caller spreads it into `set()`.
   *
   * P3-L2: takes only the selection-related fields it actually uses, not
   * the whole PipelineState, so the dependency surface is explicit.
   */
  interface SelectionFields {
    selectedTaskId: string | null;
    selectedTaskIds: string[];
    selectedTrackId: string | null;
    pinnedTaskId: string | null;
    pinnedTrackId: string | null;
  }
  const pruneStaleSelection = (nextConfig: RawPipelineConfig, current: SelectionFields) => {
    const trackIds = new Set(nextConfig.tracks.map((t) => t.id));
    const taskQids = new Set<string>();
    for (const t of nextConfig.tracks) {
      for (const k of t.tasks) taskQids.add(`${t.id}.${k.id}`);
    }
    const isTaskAlive = (qid: string | null) => qid !== null && taskQids.has(qid);
    const isTrackAlive = (tid: string | null) => tid !== null && trackIds.has(tid);
    return {
      selectedTaskId: isTaskAlive(current.selectedTaskId) ? current.selectedTaskId : null,
      selectedTaskIds: current.selectedTaskIds.filter((id) => taskQids.has(id)),
      selectedTrackId: isTrackAlive(current.selectedTrackId) ? current.selectedTrackId : null,
      pinnedTaskId: isTaskAlive(current.pinnedTaskId) ? current.pinnedTaskId : null,
      pinnedTrackId: isTrackAlive(current.pinnedTrackId) ? current.pinnedTrackId : null,
    };
  };

  /**
   * Snapshot → HistoryEntry projection. `scope` controls which slices of
   * state this entry restores when popped (see HistoryEntry doc).
   *
   * P2-H3/M1: deep-clone `config`, `dagEdges`, `validationErrors` via
   * structuredClone so any future in-place mutation upstream cannot
   * retroactively poison stored history entries. Without this, the entire
   * undo stack relies on every code path doing immutable updates — which
   * is currently true but fragile. Cost is negligible (config is KB-sized)
   * and runs only at push time, not on every state read.
   */
  const snapshotToHistory = (
    snap: Snapshot,
    coalesceKey?: string,
    scope: HistoryScope = 'config',
  ): HistoryEntry => {
    const now = Date.now();
    const includeConfig = scope === 'config' || scope === 'both';
    const includePositions = scope === 'positions' || scope === 'both';

    // Create a diff with only the "before" state (old values).
    // The "after" state (new values) will be filled in lazily during undo/redo.
    // This reduces memory usage by ~50% since we don't store both states upfront.
    const diff: HistoryDiff = {
      scope,
      config: {
        oldConfig: includeConfig ? structuredClone(snap.config) : null,
        newConfig: null, // filled in during undo
        oldDagEdges: includeConfig ? structuredClone(snap.dagEdges) : null,
        newDagEdges: null,
        oldValidationErrors: includeConfig ? structuredClone(snap.validationErrors) : null,
        newValidationErrors: null,
      },
      positions: {
        oldPositions: includePositions ? new Map(snap.positions) : null,
        newPositions: null,
        oldFolders: includePositions ? structuredClone(snap.folders) : null,
        newFolders: null,
      },
    };

    return {
      diff,
      coalesceKey,
      coalesceStartedAt: now,
      pushedAt: now,
    };
  };

  /**
   * Monotonic id stamped on every newly-added history entry. fire() uses it
   * to remove the just-pushed entry on API failure even if other sync pushes
   * (e.g. setTaskPosition) landed on top in the meantime.
   */
  let pushIdCounter = 0;

  /**
   * Push a pre-mutation snapshot onto the undo stack and clear redo. With
   * the P1-C1 refactor, fire() now pushes SYNCHRONOUSLY (before its API
   * call dispatches), which means the past stack reflects the user's
   * actual chronological order. Failed mutations are rolled back via
   * `removeHistoryByPushId`.
   *
   * Coalescing: if `entry.coalesceKey` matches the top of the stack AND the
   * previous push happened within COALESCE_WINDOW_MS, we KEEP the older
   * entry (which represents the state before the streak began) and drop
   * the new one. Any mutation without a coalesceKey always starts a fresh
   * entry. Coalesced pushes return `coalesced: true` so fire()'s rollback
   * path knows there is no new entry to remove on failure.
   */
  const pushHistory = (entry: HistoryEntry): { pushId: number; coalesced: boolean } => {
    const pushId = ++pushIdCounter;
    let coalesced = false;
    set((s) => {
      const top = s.past[s.past.length - 1];
      const now = entry.pushedAt ?? Date.now();
      if (entry.coalesceKey && top && top.coalesceKey === entry.coalesceKey) {
        const { idle, total } = coalesceWindowsFor(entry.coalesceKey);
        const idleOk = top.pushedAt !== undefined && now - top.pushedAt < idle;
        // P1-H2: total cap — no streak may stretch past `total` ms regardless
        // of how short the inter-keystroke pauses are. Without this, a fast
        // typist could collapse minutes of typing into a single undo entry.
        const totalOk = top.coalesceStartedAt === undefined || now - top.coalesceStartedAt < total;
        if (idleOk && totalOk) {
          // Refresh `pushedAt` only — do NOT touch `coalesceStartedAt` so
          // the total cap remains anchored to the streak's first push.
          coalesced = true;
          const refreshed = [...s.past];
          refreshed[refreshed.length - 1] = { ...top, pushedAt: now };
          return { past: refreshed, future: [] };
        }
      }
      const past = [...s.past, { ...entry, pushId }];
      if (past.length > HISTORY_LIMIT) past.shift();
      return { past, future: [] };
    });
    return { pushId, coalesced };
  };

  /**
   * Remove a previously-pushed history entry by its pushId. Used by fire()
   * to roll back the optimistic history push when the underlying API call
   * fails. Filtering by pushId (instead of popping the top) is necessary
   * because other sync pushes may have landed on top after ours.
   */
  const removeHistoryByPushId = (pushId: number): void => {
    set((s) => ({ past: s.past.filter((e) => e.pushId !== pushId) }));
  };

  let yamlEditLockBypassDepth = 0;

  const withOptionalYamlEditLockBypass = async <T>(
    opts: YamlLockBypassOptions | undefined,
    op: () => Promise<T>,
  ): Promise<T> => {
    if (!opts?.allowDuringYamlEditLock) return op();
    const lockId = getLocalYamlEditLockId();
    if (!lockId) return op();
    yamlEditLockBypassDepth += 1;
    try {
      return await withYamlEditLockRequestBypass(lockId, op);
    } finally {
      yamlEditLockBypassDepth -= 1;
    }
  };

  const blockIfYamlEditLocked = (): boolean => {
    if (!isYamlEditLocked()) return false;
    if (yamlEditLockBypassDepth > 0 && isLocalYamlEditLockActive()) return false;
    set({ errorMessage: YAML_EDIT_LOCK_MESSAGE });
    return true;
  };

  /**
   * Fire a mutation request. P1-C1 changes:
   *   1. History is pushed SYNCHRONOUSLY at the start of fire() (before the
   *      API call dispatches), so the past stack reflects the user's actual
   *      action order. The previous design pushed on success, which let
   *      later sync pushes (setTaskPosition) jump ahead and reorder past.
   *   2. On API failure, the just-pushed entry is removed via its pushId
   *      (unless it was coalesced into an existing entry, in which case
   *      there's no new entry to remove).
   *   3. `scope` describes which slices of state this mutation owns. fires
   *      with optimistic position mutations (deleteTask, deleteTrack,
   *      transferTaskToTrack, addTask-with-position) pass `scope='both'`.
   *      Plain config mutations default to 'config'.
   *
   * History invariant: the snapshot pushed onto `past` is the state BEFORE
   * the mutation. Restored on undo according to scope.
   */
  const fire = (
    fn: () => Promise<ServerState>,
    opts?: {
      snapshot?: Snapshot;
      errorPrefix?: string;
      skipHistory?: boolean;
      coalesceKey?: string;
      scope?: HistoryScope;
      previewSource?: YamlPreviewChangeSource | null;
    },
  ) => {
    if (blockIfYamlEditLocked()) return Promise.resolve();
    const queuedGeneration = mutationGeneration;
    // Capture pre-mutation snapshot for history. Reuse `opts.snapshot` when
    // provided (it's already a pre-mutation snapshot captured by the caller
    // BEFORE any optimistic local edits). Otherwise take one now.
    const preSnapshot: Snapshot = opts?.snapshot ?? takeSnapshot();
    const scope: HistoryScope = opts?.scope ?? 'config';
    // Every mutation implies a dirty document.
    set({ isDirty: true });

    // P1-C1: sync push BEFORE dispatching the API call so chronological
    // order is preserved. Track the push handle for failure rollback.
    let pushHandle: { pushId: number; coalesced: boolean } | null = null;
    if (!opts?.skipHistory) {
      pushHandle = pushHistory(snapshotToHistory(preSnapshot, opts?.coalesceKey, scope));
    }

    const runMutation = async (): Promise<void> => {
      if (queuedGeneration !== mutationGeneration) return;
      const myEpoch = ++fireEpoch;
      try {
        const state = await fn();
        if (myEpoch !== fireEpoch) return; // a newer request superseded us
        const suppressPreview = opts?.previewSource === null;
        if (scope !== 'positions' && !suppressPreview) {
          recordYamlPreviewChange(
            opts?.previewSource ?? 'editor',
            preSnapshot.config,
            state.config,
            preSnapshot.positions,
            _get().positions,
          );
        }
        applyState(state);
        if (suppressPreview) resetYamlPreviewBaseline(state.config);
      } catch (e) {
        // C6: RevisionConflictError signals that our cached revision is stale.
        // The server's `currentState` is the authoritative baseline.
        //
        // Network dispatch is serialized so ordinary local edits observe the
        // latest revision. The epoch guard still protects this path from
        // preserve-local/adopt-disk flows that can supersede a pending request.
        if (e instanceof RevisionConflictError) {
          if (myEpoch !== fireEpoch) return;

          // P1-C1: roll back the optimistic history push. Coalesced pushes
          // didn't add a new entry — the existing entry remains valid as
          // a snapshot for the previous successful mutation in the streak.
          if (pushHandle && !pushHandle.coalesced) {
            removeHistoryByPushId(pushHandle.pushId);
          }
          // Adopt the authoritative `currentState` returned in the payload —
          // do NOT restore the pre-mutation snapshot, because the server's
          // state is NEWER than our snapshot and is the correct baseline to
          // continue from. A brief UI flicker is acceptable.
          applyStateWithLayout(e.currentState);
          mutationGeneration++;
          set({
            isDirty: false,
            layoutDirty: false,
            past: [],
            future: [],
            errorMessage: REVISION_CONFLICT_MESSAGE,
            savedConfig: structuredClone(e.currentState.config),
          });
          return;
        }

        // Non-conflict errors still honor epoch ordering — if a later request
        // was dispatched after ours, it will apply its own result and we
        // should not clobber that with a stale rollback.
        if (myEpoch !== fireEpoch) return;

        // P1-C1: roll back the optimistic history push. Coalesced pushes
        // didn't add a new entry — the existing entry remains valid as
        // a snapshot for the previous successful mutation in the streak.
        if (pushHandle && !pushHandle.coalesced) {
          removeHistoryByPushId(pushHandle.pushId);
        }

        if (opts?.snapshot) restoreSnapshot(opts.snapshot);
        const prefix = opts?.errorPrefix ?? 'Operation failed';
        set({ errorMessage: `${prefix}: ${errorToMessage(e)}` });
      }
    };
    const promise = mutationTail.then(runMutation, runMutation);
    mutationTail = promise.then(
      () => {},
      () => {},
    );
    trackInFlight(promise);
    // Returning the promise is opt-in: callers that chain follow-up
    // work (e.g. auto-syncing bindings after `addDependency`) can `await`
    // this to run after applyState has finished reconciling the
    // authoritative server snapshot. Call sites that ignore the return
    // value get the same fire-and-forget semantics as before.
    return promise;
  };

  return {
    config: { name: 'Loading...', tracks: [] },
    positions: new Map(),
    folders: [],
    selectedTaskId: null,
    selectedTaskIds: [],
    selectedTrackId: null,
    validationErrors: [],
    dagEdges: [],
    yamlPath: null,
    manualNewPipelineYamlPath: null,
    yamlMtimeMs: null,
    yamlRunVersion: 0,
    workDir: '',
    hostPlatform: null,
    isDirty: false,
    lastAutosaveAt: null,
    layoutDirty: false,
    loading: true,
    errorMessage: null,
    registry: EMPTY_REGISTRY,
    past: [],
    future: [],
    yamlPreviewBaselineYaml: null,
    yamlPreviewBlocks: [],
    savedConfig: null,
    clipboard: null,
    pinnedTaskId: null,
    pinnedTrackId: null,
    pluginsActive: false,
    usageActive: false,

    applyState,
    applyStateWithLayout,
    applyStateWithPreview,
    adoptDiskState,
    resetYamlPreviewBaseline,
    revertYamlPreviewBlock: async (blockId) => {
      if (blockIfYamlEditLocked()) return false;
      await drainInFlight();

      const s = _get();
      const block = s.yamlPreviewBlocks.find((candidate) => candidate.id === blockId);
      if (!block) return false;

      const currentYaml = serializePreviewYaml(s.config);
      const nextYaml = revertYamlPreviewHunk(currentYaml, block.hunk);
      if (!nextYaml) {
        set({
          errorMessage:
            'Could not revert YAML preview block because the changed lines no longer match the current YAML.',
        });
        return false;
      }

      const preSnapshot = takeSnapshot();
      const pushHandle = pushHistory(snapshotToHistory(preSnapshot, undefined, 'config'));
      set({ isDirty: true });

      try {
        const nextConfig = parsePreviewYaml(nextYaml);
        const nextPositions = block.layoutChanged
          ? clonePositionsObj(block.layoutBefore)
          : positionsToObj(preSnapshot.positions);
        const state = await api.replaceConfig(nextConfig, {
          positions: nextPositions,
          folders: structuredClone(_get().folders),
        });
        const afterPositions = new Map<string, TaskPosition>();
        for (const [k, v] of Object.entries(nextPositions)) afterPositions.set(k, { x: v.x });
        recordYamlPreviewChange(
          'editor',
          preSnapshot.config,
          state.config,
          preSnapshot.positions,
          afterPositions,
        );
        applyStateWithLayout(state);
        return true;
      } catch (e) {
        if (!pushHandle.coalesced) removeHistoryByPushId(pushHandle.pushId);
        restoreSnapshot(preSnapshot);
        set({ errorMessage: 'Failed to revert YAML preview block: ' + errorToMessage(e) });
        return false;
      }
    },
    clearError: () => set({ errorMessage: null }),

    init: async () => {
      try {
        // Reset the module-level workspaceKey before any fetch so a re-entry
        // into init() (e.g. after external-change) cannot carry a stale
        // header that would pin requests to a previously-bound workspace
        // and snap the UI back to it after we have already cleared workDir.
        setClientWorkspace(null);

        // Multi-window sidecar: an Electron window launched with a specific
        // workspace pins it via `?ws=<abs-path>` on the initial URL (see
        // main.ts createEditorWindow). Honor that pin instead of landing on
        // the welcome page.
        const pinnedWorkspace =
          typeof window !== 'undefined'
            ? (() => {
                try {
                  const raw = new URL(window.location.href).searchParams.get('ws');
                  return raw && raw.trim() ? raw.trim() : null;
                } catch {
                  return null;
                }
              })()
            : null;

        if (pinnedWorkspace) {
          if (typeof window !== 'undefined') {
            const url = new URL(window.location.href);
            if (url.searchParams.has('ws')) {
              url.searchParams.delete('ws');
              window.history.replaceState(
                window.history.state,
                '',
                `${url.pathname}${url.search}${url.hash}`,
              );
            }
          }
          setClientWorkspace(pinnedWorkspace);
          try {
            const state = await api.setWorkDir(pinnedWorkspace);
            const registry = await fetchRegistrySnapshot();
            applyFreshStateWithLayout(state);
            set({
              isDirty: false,
              layoutDirty: false,
              registry,
              past: [],
              future: [],
            });
            // Workspace is now bound. The post-init useEffect in App.tsx
            // detects "loading=false + workDir set + yamlPath=null" and
            // fires bootstrapAfterWorkspace(), which is the single
            // entrypoint that decides between "show PipelinePicker" and
            // "fall through to a fresh blank pipeline" — keeping the
            // pinned (?ws= / Electron) flow consistent with the welcome
            // → Open-Recent flow.
            return;
          } catch {
            // Pinned workspace could not be opened (removed, permission
            // denied, sidecar rejected it). Fall through to the welcome path
            // so the user still gets a usable editor instead of a blank app.
            setClientWorkspace(null);
          }
        }

        const [state, registry] = await Promise.all([api.getState(), fetchRegistrySnapshot()]);
        applyFreshStateWithLayout(state);
        // Fresh page load (no ?ws= pin) always starts at the welcome page.
        // The editor server keeps `S.workDir` in process memory, so
        // reopening a tab would otherwise silently resume the previous
        // workspace. Drop the server-hydrated workDir/yamlPath on the
        // client so the welcome gate in App.tsx (`!workDir`) fires.
        set({
          workDir: '',
          yamlPath: null,
          manualNewPipelineYamlPath: null,
          yamlMtimeMs: null,
          yamlRunVersion: 0,
          hostPlatform: null,
          isDirty: false,
          layoutDirty: false,
          registry,
          past: [],
          future: [],
        });
      } catch (e) {
        set({ loading: false, errorMessage: 'Failed to initialize: ' + errorToMessage(e) });
      }
    },

    setPipelineName: (name) =>
      fire(() => api.updatePipeline({ name }), {
        errorPrefix: 'Failed to rename pipeline',
        coalesceKey: 'pipeline:name',
      }),
    updatePipelineFields: (fields) =>
      fire(() => api.updatePipeline(fields), {
        errorPrefix: 'Failed to update pipeline',
        coalesceKey: `pipeline:${Object.keys(fields).sort().join(',')}`,
      }),
    addTrack: (name, opts) => {
      const trackCount = _get().config.tracks.length;
      const color = TRACK_COLORS[trackCount % TRACK_COLORS.length];
      const id = generateConfigId();
      const targetFolderId = opts?.folderId;
      if (targetFolderId) {
        if (blockIfYamlEditLocked()) return;
        const snap = takeSnapshot();
        const s = _get();
        const track: RawTrackConfig = { id, name, color, tasks: [] };
        const nextConfig = { ...s.config, tracks: [...s.config.tracks, track] };
        const validTrackIds = new Set(nextConfig.tracks.map((t) => t.id));
        const nextFolders = foldersWithTrackPlacement(s.folders, validTrackIds, id, targetFolderId);
        if (!nextFolders) {
          set({ errorMessage: 'Failed to add track: folder not found' });
          return;
        }
        set({ config: nextConfig, folders: nextFolders, isDirty: true, layoutDirty: true });
        fire(() => api.replaceConfig(nextConfig, layoutPayload(s.positions, nextFolders)), {
          snapshot: snap,
          errorPrefix: 'Failed to add track',
          scope: 'both',
        });
        return;
      }
      fire(() => api.addTrack(id, name, color), {
        errorPrefix: 'Failed to add track',
      });
    },
    renameTrack: (trackId, name) =>
      fire(() => api.updateTrack(trackId, { name }), {
        errorPrefix: 'Failed to rename track',
        coalesceKey: `track:${trackId}:name`,
      }),
    updateTrackFields: (trackId, fields) =>
      fire(() => api.updateTrack(trackId, fields), {
        errorPrefix: 'Failed to update track',
        coalesceKey: `track:${trackId}:${Object.keys(fields).sort().join(',')}`,
      }),

    deleteTrack: (trackId) => {
      const snapshot = takeSnapshot();
      set((s) => {
        const positions = new Map(s.positions);
        for (const key of positions.keys()) {
          if (key.startsWith(trackId + '.')) positions.delete(key);
        }
        // Also strip the deleted track out of any folder so the slim header
        // count and member list reflect reality immediately. Empty folders
        // are preserved (the user may have meant to keep them as a sticky
        // group).
        const folders = s.folders.map((f) =>
          f.trackIds.includes(trackId)
            ? { ...f, trackIds: f.trackIds.filter((t) => t !== trackId) }
            : f,
        );
        return {
          positions,
          folders,
          selectedTaskId: s.selectedTaskId?.startsWith(trackId + '.') ? null : s.selectedTaskId,
          selectedTaskIds: s.selectedTaskIds.filter((id) => !id.startsWith(trackId + '.')),
          pinnedTaskId: s.pinnedTaskId?.startsWith(trackId + '.') ? null : s.pinnedTaskId,
          pinnedTrackId: s.pinnedTrackId === trackId ? null : s.pinnedTrackId,
        };
      });

      // scope='both' because we deleted positions for every task in the track
      // alongside the config mutation.
      fire(() => api.deleteTrack(trackId), {
        snapshot,
        errorPrefix: 'Failed to delete track',
        scope: 'both',
      });
    },

    moveTrackTo: (trackId, toIndex) => {
      if (blockIfYamlEditLocked()) return;
      const snapshot = takeSnapshot();
      const s = _get();
      const nextConfig = configWithTrackAt(s.config, trackId, toIndex);
      if (!nextConfig) return;
      set({ config: nextConfig });
      fire(() => api.replaceConfig(nextConfig, layoutPayload(s.positions, s.folders)), {
        snapshot,
        errorPrefix: 'Failed to reorder track',
      });
    },

    addTask: (trackId, name, options) => {
      const id = generateConfigId();
      const kind = options?.kind ?? 'prompt';
      const positionX = options?.positionX;
      // L2: Use empty string instead of 'TODO' so validation surfaces a
      // meaningful warning instead of silently accepting a placeholder value.
      const task: RawTaskConfig =
        kind === 'command' ? { id, name, command: '' } : { id, name, prompt: '' };
      const snapshot = takeSnapshot();
      const touchedPositions = positionX !== undefined;
      if (touchedPositions) {
        set((s) => {
          const positions = new Map(s.positions);
          positions.set(`${trackId}.${id}`, { x: positionX });
          return { positions, layoutDirty: true };
        });
      }
      // scope='both' only when we wrote a position for the new task; plain
      // task adds at the default location stay 'config' so undoing one
      // doesn't accidentally rewind unrelated drag positions.
      fire(() => api.addTask(trackId, task), {
        snapshot,
        errorPrefix: 'Failed to add task',
        scope: touchedPositions ? 'both' : 'config',
      });
    },

    updateTask: (trackId, taskId, patch) =>
      fire(() => api.updateTask(trackId, taskId, patch), {
        errorPrefix: 'Failed to update task',
        coalesceKey: `task:${trackId}.${taskId}:${Object.keys(patch).sort().join(',')}`,
      }),

    deleteTask: (trackId, taskId) => {
      const qid = `${trackId}.${taskId}`;
      const snapshot = takeSnapshot();
      set((s) => ({
        selectedTaskId: s.selectedTaskId === qid ? null : s.selectedTaskId,
        selectedTaskIds: s.selectedTaskIds.filter((id) => id !== qid),
        pinnedTaskId: s.pinnedTaskId === qid ? null : s.pinnedTaskId,
        positions: (() => {
          const p = new Map(s.positions);
          p.delete(qid);
          return p;
        })(),
      }));

      // scope='both' because we deleted the qid's position alongside the
      // config mutation — undo must restore both.
      fire(() => api.deleteTask(trackId, taskId), {
        snapshot,
        errorPrefix: 'Failed to delete task',
        scope: 'both',
      });
    },

    transferTaskToTrack: (fromTrackId, taskId, toTrackId) => {
      const qidOld = `${fromTrackId}.${taskId}`;
      const qidNew = `${toTrackId}.${taskId}`;
      // Minimal optimistic move: relocate the task to the new track in
      // config and rename its position key. We do NOT recompute dagEdges
      // locally — the server response is authoritative and will replace them
      // on success. A single-frame mismatch (edges still pointing at the old
      // qid) is preferable to a hand-rolled rewrite that could drift.
      const snapshot = takeSnapshot();
      set((s) => {
        let moved: RawTaskConfig | undefined;
        const withoutTask = s.config.tracks.map((t) => {
          if (t.id !== fromTrackId) return t;
          const remaining: RawTaskConfig[] = [];
          for (const k of t.tasks) {
            if (k.id === taskId) moved = k;
            else remaining.push(k);
          }
          return { ...t, tasks: remaining };
        });
        if (!moved) return s;
        const newTracks = withoutTask.map((t) =>
          t.id === toTrackId ? { ...t, tasks: [...t.tasks, moved!] } : t,
        );

        // Rename position key unless the new qid was already set (e.g. by a
        // preceding setTaskPosition call from the drop handler).
        const positions = new Map(s.positions);
        const oldPos = positions.get(qidOld);
        if (!positions.has(qidNew) && oldPos) positions.set(qidNew, oldPos);
        positions.delete(qidOld);

        return {
          config: { ...s.config, tracks: newTracks },
          positions,
          selectedTaskId: s.selectedTaskId === qidOld ? qidNew : s.selectedTaskId,
          selectedTaskIds: s.selectedTaskIds.map((id) => (id === qidOld ? qidNew : id)),
          pinnedTaskId: s.pinnedTaskId === qidOld ? qidNew : s.pinnedTaskId,
          layoutDirty: true,
        };
      });

      // scope='both' because we renamed a position key (qidOld→qidNew)
      // alongside the config mutation.
      fire(() => api.transferTask(fromTrackId, taskId, toTrackId), {
        snapshot,
        errorPrefix: 'Failed to move task',
        scope: 'both',
      });
    },

    addDependency: (fromTrackId, fromTaskId, toTrackId, toTaskId) => {
      // L8: Client-side cycle detection — reject edges that would create a
      // cycle before hitting the server. Use BFS from the target back through
      // existing edges; if the source is reachable, the edge would form a cycle.
      const src = `${fromTrackId}.${fromTaskId}`;
      const dst = `${toTrackId}.${toTaskId}`;
      const edges = usePipelineStore.getState().dagEdges;
      const visited = new Set<string>();
      const queue = [dst];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === src) {
          set({ errorMessage: 'Cannot add dependency: would create a cycle' });
          setTimeout(() => {
            const s = usePipelineStore.getState();
            if (s.errorMessage === 'Cannot add dependency: would create a cycle') {
              set({ errorMessage: null });
            }
          }, 3000);
          return;
        }
        if (visited.has(current)) continue;
        visited.add(current);
        for (const e of edges) {
          if (e.from === current) queue.push(e.to);
        }
      }
      fire(() => api.addDependency(fromTrackId, fromTaskId, toTrackId, toTaskId), {
        errorPrefix: 'Failed to add dependency',
      });
    },

    removeDependency: (trackId, taskId, depRef) =>
      fire(() => api.removeDependency(trackId, taskId, depRef), {
        errorPrefix: 'Failed to remove dependency',
      }),

    setRegistry: (registry) => set({ registry }),

    refreshServerState: async () => {
      try {
        const state = await api.getState();
        applyState(state);
      } catch (e) {
        set({ errorMessage: 'Failed to refresh state: ' + errorToMessage(e) });
      }
    },

    selectTask: (qualifiedId) =>
      set({
        selectedTaskId: qualifiedId,
        selectedTaskIds: qualifiedId ? [qualifiedId] : [],
        selectedTrackId: null,
      }),
    toggleTaskSelection: (qualifiedId) =>
      set((s) => {
        const ids = s.selectedTaskIds.includes(qualifiedId)
          ? s.selectedTaskIds.filter((id) => id !== qualifiedId)
          : [...s.selectedTaskIds, qualifiedId];
        return {
          selectedTaskId: ids.length > 0 ? ids[ids.length - 1] : null,
          selectedTaskIds: ids,
          selectedTrackId: null,
        };
      }),
    selectTrack: (trackId) =>
      set({ selectedTrackId: trackId, selectedTaskId: null, selectedTaskIds: [] }),
    pinTask: (qualifiedId) => set({ pinnedTaskId: qualifiedId, pinnedTrackId: null }),
    unpinTask: () => set({ pinnedTaskId: null }),
    pinTrack: (trackId) => set({ pinnedTrackId: trackId, pinnedTaskId: null }),
    unpinTrack: () => set({ pinnedTrackId: null }),

    // ── Folder actions ──
    // Folders are an editor-only grouping persisted in `.layout.json`. Every
    // mutation follows the same pattern: snapshot pre-state, mutate folders
    // immutably, push a history entry under scope='positions' (folders ride
    // alongside positions in the layout file), and mark layoutDirty so the
    // next save flushes them. No immediate API call — flushLayout handles
    // it on save (or autosave).
    createFolder: (opts) => {
      if (blockIfYamlEditLocked()) return '';
      const s = _get();
      const snap = takeSnapshot();
      const id = `f_${generateConfigId()}`;
      const trackIds = (opts?.trackIds ?? []).filter((t) =>
        s.config.tracks.some((tr) => tr.id === t),
      );
      // A track can only live in one folder — strip these ids out of any
      // other folder before we add the new one.
      const stripped = s.folders.map((f) => ({
        ...f,
        trackIds: f.trackIds.filter((t) => !trackIds.includes(t)),
      }));
      const folder: TrackFolder = {
        id,
        name: opts?.name?.trim() || 'New folder',
        color: opts?.color,
        trackIds,
        collapsed: false,
      };
      set({ folders: [...stripped, folder], isDirty: true, layoutDirty: true });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
      return id;
    },

    deleteFolder: (folderId) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      if (!s.folders.some((f) => f.id === folderId)) return;
      const snap = takeSnapshot();
      // Tracks fall back to the top level — no need to relocate them, just
      // drop the folder. Their order in `config.tracks` is preserved.
      set({
        folders: s.folders.filter((f) => f.id !== folderId),
        isDirty: true,
        layoutDirty: true,
      });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
    },

    renameFolder: (folderId, name) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      const folder = s.folders.find((f) => f.id === folderId);
      const trimmed = name.trim() || 'Folder';
      if (!folder || folder.name === trimmed) return;
      const snap = takeSnapshot();
      set({
        folders: s.folders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)),
        isDirty: true,
        layoutDirty: true,
      });
      pushHistory(snapshotToHistory(snap, `folder:rename:${folderId}`, 'positions'));
    },

    setFolderColor: (folderId, color) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      const folder = s.folders.find((f) => f.id === folderId);
      if (!folder) return;
      const next = color || undefined;
      if ((folder.color ?? undefined) === next) return;
      const snap = takeSnapshot();
      set({
        folders: s.folders.map((f) => (f.id === folderId ? { ...f, color: next } : f)),
        isDirty: true,
        layoutDirty: true,
      });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
    },

    toggleFolderCollapsed: (folderId) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      const folder = s.folders.find((f) => f.id === folderId);
      if (!folder) return;
      const snap = takeSnapshot();
      set({
        folders: s.folders.map((f) => (f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)),
        isDirty: true,
        layoutDirty: true,
      });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
    },

    moveTrackToFolder: (trackId, folderId, atIndex) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      const snap = takeSnapshot();
      const validTrackIds = new Set(s.config.tracks.map((t) => t.id));
      const nextFolders = foldersWithTrackPlacement(
        s.folders,
        validTrackIds,
        trackId,
        folderId,
        atIndex,
      );
      if (!nextFolders) return;
      set({ folders: nextFolders, isDirty: true, layoutDirty: true });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
    },

    moveTrackToRoot: (trackId, toIndex) => {
      if (blockIfYamlEditLocked()) return;
      const snap = takeSnapshot();
      const s = _get();
      const validTrackIds = new Set(s.config.tracks.map((t) => t.id));
      const nextFolders = foldersWithTrackPlacement(s.folders, validTrackIds, trackId, null);
      const nextConfig = configWithTrackAt(s.config, trackId, toIndex) ?? s.config;
      if (!nextFolders && nextConfig === s.config) return;
      const folders = nextFolders ?? s.folders;
      set({ config: nextConfig, folders, isDirty: true, layoutDirty: true });
      fire(() => api.replaceConfig(nextConfig, layoutPayload(s.positions, folders)), {
        snapshot: snap,
        errorPrefix: 'Failed to move track',
        scope: 'both',
      });
    },

    reorderFolder: (folderId, toIndex) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      const fromIndex = s.folders.findIndex((f) => f.id === folderId);
      if (fromIndex < 0) return;
      const clamped = Math.max(0, Math.min(toIndex, s.folders.length - 1));
      if (fromIndex === clamped) return;
      const snap = takeSnapshot();
      const next = [...s.folders];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(clamped, 0, moved);
      set({ folders: next, isDirty: true, layoutDirty: true });
      pushHistory(snapshotToHistory(snap, undefined, 'positions'));
    },

    showPluginsPage: () => set({ pluginsActive: true }),
    hidePluginsPage: () => set({ pluginsActive: false }),

    showUsagePage: () => set({ usageActive: true }),
    hideUsagePage: () => set({ usageActive: false }),

    autoSyncAllBindings: async (source: YamlPreviewChangeSource | null = 'editor', opts) => {
      // Chat-driven reconcile holds the YAML edit lock while it runs the
      // post-turn binding autosync. Routing through `withOptionalYamlEditLockBypass`
      // lets the caller opt into the lock-owner bypass (matches saveFile /
      // openFile / syncLocalStateToServerMemory) so `fire()` doesn't trip
      // `blockIfYamlEditLocked` and surface a stale "chat is updating YAML"
      // toast right at turn end.
      return withOptionalYamlEditLockBypass(opts, async () => {
        const { config } = _get();
        const updates: {
          trackId: string;
          taskId: string;
          patch: Pick<RawTaskConfig, 'inputs' | 'outputs'>;
        }[] = [];

        for (const track of config.tracks) {
          if (!track.id) continue;
          for (const task of track.tasks ?? []) {
            if (!task.id) continue;
            // Prompt tasks show inferred ports in the editor, but auto-sync
            // still avoids materializing those inferred rows into YAML. Users
            // opt into explicit prompt bindings via the inspector.
            if (task.command === undefined) continue;

            const qid = `${track.id}.${task.id}`;
            const upstream = buildUpstreamPortsReport(config, qid);
            const downstream = buildDownstreamPortsReport(config, qid);

            const nextInputs =
              upstream.candidates.length > 0
                ? computeSyncedInputs(inputBindingsToPorts(task.inputs), upstream.candidates)
                : inputBindingsToPorts(task.inputs);
            const nextOutputs =
              downstream.candidates.length > 0
                ? computeSyncedOutputs(outputBindingsToPorts(task.outputs), downstream.candidates)
                : outputBindingsToPorts(task.outputs);

            const currentInputs = inputBindingsToPorts(task.inputs);
            const currentOutputs = outputBindingsToPorts(task.outputs);
            const inputsChanged = !portsEqual(currentInputs, nextInputs);
            const outputsChanged = !portsEqual(currentOutputs, nextOutputs);
            if (!inputsChanged && !outputsChanged) continue;

            updates.push({
              trackId: track.id,
              taskId: task.id,
              patch: {
                inputs: mergeInputPortsIntoBindings(task.inputs, nextInputs),
                outputs: mergeOutputPortsIntoBindings(task.outputs, nextOutputs),
              },
            });
          }
        }

        if (updates.length === 0) return;

        // Serialise: each PATCH bumps the server revision; dispatching
        // concurrently would trip the revision guard for all but one.
        for (const u of updates) {
          try {
            await fire(
              () => api.updateTask(u.trackId, u.taskId, u.patch as Partial<RawTaskConfig>),
              {
                errorPrefix: 'Failed to auto-sync bindings',
                skipHistory: true,
                previewSource: source,
              },
            );
          } catch {
            // fire() already surfaces the error via errorMessage; swallow here so
            // one failing PATCH doesn't abort the rest of the pass.
          }
        }
      });
    },

    setTaskPosition: (qualifiedId, x) => {
      if (blockIfYamlEditLocked()) return;
      const s = _get();
      // Skip no-op writes so dead-clicks don't bloat history.
      if (s.positions.get(qualifiedId)?.x === x) return;
      // Capture pre-mutation snapshot BEFORE the set() so the history entry
      // represents the state before this (and any coalesced) drag began.
      const snap = takeSnapshot();
      set((s) => {
        const positions = new Map(s.positions);
        positions.set(qualifiedId, { x });
        return { positions, isDirty: true, layoutDirty: true };
      });
      // P1-C1: scope='positions' so undoing this entry only reverts the
      // positions slice — any concurrent config edit is preserved.
      // Coalesce all position writes within the same drag burst (grabbed +
      // companions fire in the same tick on pointerup) into a single entry.
      pushHistory(snapshotToHistory(snap, 'layout:position', 'positions'));
    },

    setWorkDir: async (wd) => {
      try {
        if ((await requestWorkspaceSwitch(wd)) === 'focus-other') {
          return false;
        }
        // Auto-save current pipeline before switching workspace.
        // If the save fails we MUST abort the switch — otherwise the
        // caller may overwrite the in-memory pipeline and the user
        // silently loses their unsaved work.
        const current = _get();
        if ((current.isDirty || current.layoutDirty) && current.yamlPath) {
          try {
            const saved = await _get().saveFile();
            if (!saved) throw new Error(_get().errorMessage ?? 'save failed');
          } catch (saveErr) {
            set({
              errorMessage:
                'Cannot switch workspace: failed to save current pipeline — ' +
                errorToMessage(saveErr) +
                '. Save manually or discard changes before switching.',
            });
            return false;
          }
        }
        // Clear per-pipeline UI state so the previous workspace's
        // selection/pins/history don't leak into whatever pipeline the
        // caller opens next.
        set({
          selectedTaskId: null,
          selectedTaskIds: [],
          selectedTrackId: null,
          pinnedTaskId: null,
          pinnedTrackId: null,
          past: [],
          future: [],
        });
        // Switch workspace and apply the returned state (workDir only —
        // the server still holds the previous config/yamlPath, which the
        // caller will overwrite by opening an existing file or creating a
        // new pipeline).
        //
        // Multi-window sidecar: stamp the workspace key on the client BEFORE
        // the first fetch targeting the new workspace, so the server's
        // `resolveWorkspace` middleware routes this PATCH (and everything
        // after it) to the correct WorkspaceState.
        setClientWorkspace(wd);
        let state;
        try {
          state = await api.setWorkDir(wd);
        } catch (e) {
          if (e instanceof RevisionConflictError) {
            // Defense in depth: setClientWorkspace already cleared
            // lastRevision for the new workspace, so this branch should
            // never fire in practice. If it does, adopt the server's
            // authoritative state (already populated by request() on 409)
            // and report success — the client is now consistent with the
            // server and the UI will reflect the switched workspace.
            applyFreshStateWithLayout(e.currentState);
            const registry = await fetchRegistrySnapshot();
            set({
              isDirty: false,
              layoutDirty: false,
              past: [],
              future: [],
              registry,
              lastAutosaveAt: null,
            });
            return true;
          }
          throw e;
        }
        const registry = await fetchRegistrySnapshot();
        applyFreshStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, registry, lastAutosaveAt: null });
        return true;
      } catch (e) {
        set({ errorMessage: 'Failed to set workspace: ' + errorToMessage(e) });
        return false;
      }
    },

    clearWorkspace: () => {
      // Defense in depth: drop the client-side workspace key BEFORE flipping
      // local workDir to ''. The App.tsx SSE subscription is keyed on
      // workDir, so flipping that triggers an effect cleanup + re-subscribe;
      // if the API client still carries the old workspace key during the
      // re-subscribe window, the server replays the prior workspace's state
      // and re-hydrates workDir back to the old path.
      setClientWorkspace(null);
      set({
        workDir: '',
        yamlPath: null,
        manualNewPipelineYamlPath: null,
        yamlMtimeMs: null,
        yamlRunVersion: 0,
        hostPlatform: null,
        isDirty: false,
        layoutDirty: false,
        lastAutosaveAt: null,
        past: [],
        future: [],
        selectedTaskId: null,
        selectedTaskIds: [],
        selectedTrackId: null,
        pinnedTaskId: null,
        pinnedTrackId: null,
        savedConfig: null,
      });
    },

    openFile: async (path, opts) => {
      await withOptionalYamlEditLockBypass(opts, async () => {
        if (blockIfYamlEditLocked()) return;
        try {
          const state = await api.openFile(path);
          const registry = await fetchRegistrySnapshot();
          set({
            selectedTaskId: null,
            selectedTaskIds: [],
            selectedTrackId: null,
            pinnedTaskId: null,
            pinnedTrackId: null,
          });
          applyFreshStateWithLayout(state);
          set({
            isDirty: false,
            layoutDirty: false,
            past: [],
            future: [],
            registry,
            lastAutosaveAt: null,
          });
        } catch (e) {
          set({ errorMessage: 'Failed to open file: ' + errorToMessage(e) });
        }
      });
    },

    saveFile: async (opts) => {
      return withOptionalYamlEditLockBypass(opts, async () => {
        if (blockIfYamlEditLocked()) return false;
        try {
          // C3: Flush all pending debounced field commits so the server's
          // in-memory config includes the user's latest keystrokes. This
          // synchronously dispatches updateTask/etc. through fire(), which
          // registers their promises in `inFlight`.
          flushAllLocalFields();
          // P0-C3: Drain any in-flight mutations (the just-flushed commits
          // above, plus any earlier undo/redo replaceConfig still on the wire)
          // BEFORE we send /api/save. Otherwise saveFile can race ahead of an
          // unresolved mutation and either persist a stale config to disk or
          // fail with a 409 because lastRevision hasn't caught up.
          await drainInFlight();
          // Flush layout last so the layout file lands on disk alongside the
          // YAML. Awaiting surfaces any layout error before we commit the save.
          await flushLayout();
          const state = await api.saveFile();
          applyState(state);
          set({
            isDirty: false,
            layoutDirty: false,
            lastAutosaveAt: Date.now(),
            savedConfig: structuredClone(state.config),
          });
          clearLastLocalFieldEditAt();
          return true;
        } catch (e) {
          set({ errorMessage: 'Failed to save: ' + errorToMessage(e) });
          return false;
        }
      });
    },

    saveFileAs: async (path, opts) => {
      return withOptionalYamlEditLockBypass(opts, async () => {
        if (blockIfYamlEditLocked()) return false;
        try {
          flushAllLocalFields();
          await drainInFlight();
          await flushLayout();
          const state = await api.saveFileAs(path);
          applyState(state);
          set({
            isDirty: false,
            layoutDirty: false,
            lastAutosaveAt: Date.now(),
            savedConfig: structuredClone(state.config),
          });
          clearLastLocalFieldEditAt();
          return true;
        } catch (e) {
          set({ errorMessage: 'Failed to save: ' + errorToMessage(e) });
          return false;
        }
      });
    },

    syncLocalStateToServerMemory: async (opts) => {
      return withOptionalYamlEditLockBypass(opts, async () => {
        if (blockIfYamlEditLocked()) return false;
        flushAllLocalFields();
        const current = _get();
        const localConfig = current.config;
        const localPositions = new Map(current.positions);
        const wasDirty = current.isDirty;
        const wasLayoutDirty = current.layoutDirty;
        const myEpoch = ++fireEpoch;

        const localFolders = structuredClone(current.folders);
        const promise = api
          .replaceConfig(localConfig, layoutPayload(localPositions, localFolders))
          .then(
            (state) => {
              if (myEpoch !== fireEpoch) return false;
              applyStateWithLayout(state);
              set({
                isDirty: wasDirty,
                layoutDirty: wasLayoutDirty,
                errorMessage: null,
              });
              return true;
            },
            (e) => {
              if (myEpoch !== fireEpoch) return false;
              set({
                isDirty: wasDirty,
                layoutDirty: wasLayoutDirty,
                errorMessage: 'Failed to preserve local edits: ' + errorToMessage(e),
              });
              return false;
            },
          );
        trackInFlight(promise);
        return promise;
      });
    },

    restoreDraft: async (draftConfig) => {
      if (blockIfYamlEditLocked()) return;
      try {
        await drainInFlight();
        const s = _get();
        const state = await api.replaceConfig(draftConfig, layoutPayload(s.positions, s.folders));
        applyState(state);
        set({
          isDirty: true,
          layoutDirty: s.layoutDirty,
          past: [],
          future: [],
          errorMessage: null,
        });
      } catch (e) {
        if (e instanceof RevisionConflictError) {
          applyStateWithLayout(e.currentState);
          set({
            isDirty: false,
            layoutDirty: false,
            past: [],
            future: [],
            errorMessage: REVISION_CONFLICT_MESSAGE,
            savedConfig: structuredClone(e.currentState.config),
          });
          return;
        }
        set({ errorMessage: 'Failed to restore draft: ' + errorToMessage(e) });
        throw e;
      }
    },
    newPipeline: async (name) => {
      if (blockIfYamlEditLocked()) return;
      try {
        set({
          selectedTaskId: null,
          selectedTaskIds: [],
          selectedTrackId: null,
          pinnedTaskId: null,
          pinnedTrackId: null,
        });
        const state = await api.newPipeline(name);
        applyFreshStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [], lastAutosaveAt: null });
      } catch (e) {
        set({ errorMessage: 'Failed to create pipeline: ' + errorToMessage(e) });
      }
    },

    importFile: async (sourcePath) => {
      if (blockIfYamlEditLocked()) return;
      try {
        const state = await api.importFile(sourcePath);
        const registry = await fetchRegistrySnapshot();
        set({
          selectedTaskId: null,
          selectedTaskIds: [],
          selectedTrackId: null,
          pinnedTaskId: null,
          pinnedTrackId: null,
        });
        applyFreshStateWithLayout(state);
        set({
          isDirty: false,
          layoutDirty: false,
          past: [],
          future: [],
          registry,
          lastAutosaveAt: null,
        });
      } catch (e) {
        set({ errorMessage: 'Failed to import file: ' + errorToMessage(e) });
      }
    },

    exportFile: async (destDir) => {
      if (blockIfYamlEditLocked()) return null;
      try {
        const result = await api.exportFile(destDir);
        return result.path;
      } catch (e) {
        set({ errorMessage: 'Failed to export: ' + errorToMessage(e) });
        return null;
      }
    },

    exportPlatformFile: async (destDir, targetPlatform, model, onProgress) => {
      if (blockIfYamlEditLocked()) return null;
      try {
        const result = await api.exportPlatformFile(destDir, targetPlatform, model, onProgress);
        return result.path;
      } catch (e) {
        set({ errorMessage: 'Failed to export platform pipeline: ' + errorToMessage(e) });
        return null;
      }
    },

    exportYaml: () => api.exportYaml(),

    importYaml: async (yaml) => {
      if (blockIfYamlEditLocked()) return;
      try {
        const state = await api.importYaml(yaml);
        set({ selectedTaskId: null, selectedTaskIds: [], pinnedTaskId: null, pinnedTrackId: null });
        applyFreshStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [], lastAutosaveAt: null });
      } catch (e) {
        set({ errorMessage: 'Invalid YAML: ' + errorToMessage(e) });
      }
    },

    loadDemo: async () => {
      if (blockIfYamlEditLocked()) return;
      try {
        const state = await api.loadDemo();
        set({ selectedTaskId: null, selectedTaskIds: [], pinnedTaskId: null, pinnedTrackId: null });
        applyFreshStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [], lastAutosaveAt: null });
      } catch (e) {
        set({ errorMessage: 'Failed to load demo: ' + errorToMessage(e) });
      }
    },

    // ---- Undo / Redo ----------------------------------------------------
    // Semantics (after P0+P1 fixes): scoped restore + atomic server mirror.
    //
    // Each history entry carries a `scope` ('config' | 'positions' | 'both')
    // indicating which slices of state it owns. undo() restores ONLY those
    // slices, leaving unrelated slices at their current values. This is what
    // makes "undo my last drag" preserve a concurrent typing edit and vice
    // versa — full-snapshot restores produced "undo undoes too much" bugs.
    //
    // Atomic server mirror via `api.replaceConfig({config, positions})`:
    // without sending layout alongside config, the server's layout.positions
    // would still hold the post-edit state and any external observer would
    // see a config/layout mismatch.
    //
    // Flow:
    //   1. drainInFlight() — wait for any pending fire() to settle so we
    //      undo from a STABLE history stack, not one that's about to grow.
    //   2. Apply the scoped restore to local state.
    //   3. Fire api.replaceConfig with the post-restore local state.
    //   4. On success, re-apply the authoritative ServerState (which carries
    //      fresh validationErrors/dagEdges).
    //   5. On failure, restore the scoped slices back to their pre-undo
    //      values via `current` — `preUndoPast`/`preUndoFuture` recover the
    //      stack, the scoped block recovers config/positions.
    //
    // Returns a promise so callers (e.g. saveFile) can await completion. The
    // promise also lands in `inFlight` so saveFile drains it implicitly.

    canUndo: () => _get().past.length > 0,
    canRedo: () => _get().future.length > 0,

    undo: async () => {
      if (blockIfYamlEditLocked()) return;
      // P0-C3: wait for any fire() in flight to settle so the past stack
      // reflects every committed mutation before we pop from it.
      await drainInFlight();

      const s = _get();
      if (s.past.length === 0) return;
      const prev = s.past[s.past.length - 1];
      const diff = prev.diff;
      const scope = diff.scope;

      // Complete the popped entry with the current ("after") state, then move
      // that same diff to the redo stack. Redo moves it back to `past`, so the
      // before/after pair remains stable across repeated undo/redo cycles.
      const completedDiff: HistoryDiff = {
        scope,
        config: {
          oldConfig: diff.config.oldConfig,
          newConfig:
            scope === 'config' || scope === 'both'
              ? (diff.config.newConfig ?? structuredClone(s.config))
              : null,
          oldDagEdges: diff.config.oldDagEdges,
          newDagEdges:
            scope === 'config' || scope === 'both'
              ? (diff.config.newDagEdges ?? structuredClone(s.dagEdges))
              : null,
          oldValidationErrors: diff.config.oldValidationErrors,
          newValidationErrors:
            scope === 'config' || scope === 'both'
              ? (diff.config.newValidationErrors ?? structuredClone(s.validationErrors))
              : null,
        },
        positions: {
          oldPositions: diff.positions.oldPositions,
          newPositions:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.newPositions ?? new Map(s.positions))
              : null,
          oldFolders: diff.positions.oldFolders,
          newFolders:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.newFolders ?? structuredClone(s.folders))
              : null,
        },
      };

      const current: HistoryEntry = { ...prev, diff: completedDiff };
      const preUndoPast = s.past;
      const preUndoFuture = s.future;
      // P1-C1: scoped restore. Only revert the slices owned by `prev.scope`.
      // Folders ride with positions (same layout-side concept).
      const restoreConfig = scope === 'config' || scope === 'both';
      const restorePositions = scope === 'positions' || scope === 'both';
      set((cur) => {
        const next: Partial<PipelineState> = {
          past: cur.past.slice(0, -1),
          future: [...cur.future, current],
          isDirty: true,
          layoutDirty: true,
        };
        if (restoreConfig && diff.config.oldConfig !== null) {
          next.config = diff.config.oldConfig;
          next.dagEdges = diff.config.oldDagEdges ?? [];
          next.validationErrors = diff.config.oldValidationErrors ?? [];
          Object.assign(next, pruneStaleSelection(diff.config.oldConfig, cur));
        }
        if (restorePositions && diff.positions.oldPositions !== null) {
          next.positions = new Map(diff.positions.oldPositions);
          next.folders = structuredClone(diff.positions.oldFolders ?? []);
        }
        return next;
      });
      // Mirror restored state to server. We always send the post-set local
      // state so the wire format is uniform regardless of scope — server
      // gets a consistent snapshot of {config, positions, folders} every time.
      const restored = _get();
      const myEpoch = ++fireEpoch;
      const promise = api
        .replaceConfig(restored.config, layoutPayload(restored.positions, restored.folders))
        .then(
          (state) => {
            if (myEpoch !== fireEpoch) return;
            applyState(state);
          },
          (e) => {
            // C6: same epoch-guarded conflict handling as fire() — see the
            // comment in fire() for the race-condition rationale.
            if (e instanceof RevisionConflictError) {
              if (myEpoch !== fireEpoch) return;
              applyStateWithLayout(e.currentState);
              set({
                isDirty: false,
                layoutDirty: false,
                past: [],
                future: [],
                errorMessage: REVISION_CONFLICT_MESSAGE,
                savedConfig: structuredClone(e.currentState.config),
              });
              return;
            }

            if (myEpoch !== fireEpoch) return;
            // Scoped rollback — restore only the slices we actually changed.
            set(() => {
              const rb: Partial<PipelineState> = {
                past: preUndoPast,
                future: preUndoFuture,
                errorMessage: 'Failed to undo: ' + errorToMessage(e),
              };
              if (restoreConfig && completedDiff.config.newConfig !== null) {
                rb.config = completedDiff.config.newConfig;
                rb.dagEdges = completedDiff.config.newDagEdges ?? [];
                rb.validationErrors = completedDiff.config.newValidationErrors ?? [];
              }
              if (restorePositions && completedDiff.positions.newPositions !== null) {
                rb.positions = new Map(completedDiff.positions.newPositions);
                rb.folders = structuredClone(completedDiff.positions.newFolders ?? []);
              }
              return rb;
            });
          },
        );
      trackInFlight(promise);
      await promise;
    },

    redo: async () => {
      if (blockIfYamlEditLocked()) return;
      // P0-C3: same drain-then-apply discipline as undo().
      await drainInFlight();

      const s = _get();
      if (s.future.length === 0) return;
      const next = s.future[s.future.length - 1];
      const diff = next.diff;
      const scope = diff.scope;

      // Move the completed diff back to the undo stack. If a legacy/incomplete
      // future entry somehow appears, fill its "before" side from the current
      // pre-redo state so a follow-up undo still has a valid rollback target.
      const completedDiff: HistoryDiff = {
        scope,
        config: {
          oldConfig:
            scope === 'config' || scope === 'both'
              ? (diff.config.oldConfig ?? structuredClone(s.config))
              : null,
          newConfig:
            scope === 'config' || scope === 'both'
              ? (diff.config.newConfig ?? structuredClone(s.config))
              : null,
          oldDagEdges:
            scope === 'config' || scope === 'both'
              ? (diff.config.oldDagEdges ?? structuredClone(s.dagEdges))
              : null,
          newDagEdges:
            scope === 'config' || scope === 'both'
              ? (diff.config.newDagEdges ?? structuredClone(s.dagEdges))
              : null,
          oldValidationErrors:
            scope === 'config' || scope === 'both'
              ? (diff.config.oldValidationErrors ?? structuredClone(s.validationErrors))
              : null,
          newValidationErrors:
            scope === 'config' || scope === 'both'
              ? (diff.config.newValidationErrors ?? structuredClone(s.validationErrors))
              : null,
        },
        positions: {
          oldPositions:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.oldPositions ?? new Map(s.positions))
              : null,
          newPositions:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.newPositions ?? new Map(s.positions))
              : null,
          oldFolders:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.oldFolders ?? structuredClone(s.folders))
              : null,
          newFolders:
            scope === 'positions' || scope === 'both'
              ? (diff.positions.newFolders ?? structuredClone(s.folders))
              : null,
        },
      };

      const current: HistoryEntry = { ...next, diff: completedDiff };
      const preRedoPast = s.past;
      const preRedoFuture = s.future;
      const restoreConfig = scope === 'config' || scope === 'both';
      const restorePositions = scope === 'positions' || scope === 'both';
      set((cur) => {
        const patch: Partial<PipelineState> = {
          past: [...cur.past, current],
          future: cur.future.slice(0, -1),
          isDirty: true,
          layoutDirty: true,
        };
        if (restoreConfig && completedDiff.config.newConfig !== null) {
          patch.config = completedDiff.config.newConfig;
          patch.dagEdges = completedDiff.config.newDagEdges ?? [];
          patch.validationErrors = completedDiff.config.newValidationErrors ?? [];
          Object.assign(patch, pruneStaleSelection(completedDiff.config.newConfig, cur));
        }
        if (restorePositions && completedDiff.positions.newPositions !== null) {
          patch.positions = new Map(completedDiff.positions.newPositions);
          patch.folders = structuredClone(completedDiff.positions.newFolders ?? []);
        }
        return patch;
      });
      const restored = _get();
      const myEpoch = ++fireEpoch;
      const promise = api
        .replaceConfig(restored.config, layoutPayload(restored.positions, restored.folders))
        .then(
          (state) => {
            if (myEpoch !== fireEpoch) return;
            applyState(state);
          },
          (e) => {
            // C6: same epoch-guarded conflict handling as fire().
            if (e instanceof RevisionConflictError) {
              if (myEpoch !== fireEpoch) return;
              applyStateWithLayout(e.currentState);
              set({
                isDirty: false,
                layoutDirty: false,
                past: [],
                future: [],
                errorMessage: REVISION_CONFLICT_MESSAGE,
                savedConfig: structuredClone(e.currentState.config),
              });
              return;
            }

            if (myEpoch !== fireEpoch) return;
            set(() => {
              const rb: Partial<PipelineState> = {
                past: preRedoPast,
                future: preRedoFuture,
                errorMessage: 'Failed to redo: ' + errorToMessage(e),
              };
              if (restoreConfig && completedDiff.config.oldConfig !== null) {
                rb.config = completedDiff.config.oldConfig;
                rb.dagEdges = completedDiff.config.oldDagEdges ?? [];
                rb.validationErrors = completedDiff.config.oldValidationErrors ?? [];
              }
              if (restorePositions && completedDiff.positions.oldPositions !== null) {
                rb.positions = new Map(completedDiff.positions.oldPositions);
                rb.folders = structuredClone(completedDiff.positions.oldFolders ?? []);
              }
              return rb;
            });
          },
        );
      trackInFlight(promise);
      await promise;
    },

    // ---- Clipboard ------------------------------------------------------
    // Copy/paste/duplicate operate on the current selection. Paste creates
    // new ids so clones are independent. Paste routes through the normal
    // mutation path (fire() → api.addTask / addTrack), so clones
    // participate in undo history automatically.

    copySelection: () => {
      const s = _get();
      if (s.selectedTaskId) {
        const [trackId, taskId] = s.selectedTaskId.split('.');
        const track = s.config.tracks.find((t) => t.id === trackId);
        const task = track?.tasks.find((t) => t.id === taskId);
        if (!task) return false;
        set({ clipboard: { kind: 'task', trackId, task: { ...task } } });
        return true;
      }
      if (s.selectedTrackId) {
        const track = s.config.tracks.find((t) => t.id === s.selectedTrackId);
        if (!track) return false;
        set({
          clipboard: {
            kind: 'track',
            track: { ...track, tasks: track.tasks.map((t) => ({ ...t })) },
          },
        });
        return true;
      }
      return false;
    },

    pasteClipboard: () => {
      if (blockIfYamlEditLocked()) return false;
      const s = _get();
      const clip = s.clipboard;
      if (!clip) return false;
      if (clip.kind === 'task') {
        // Target track: selected track, else selected task's track, else
        // the clipboard's original track, else the first track.
        let targetTrackId = clip.trackId;
        if (s.selectedTrackId) targetTrackId = s.selectedTrackId;
        else if (s.selectedTaskId) targetTrackId = s.selectedTaskId.split('.')[0];
        if (!s.config.tracks.some((t) => t.id === targetTrackId)) {
          targetTrackId = s.config.tracks[0]?.id ?? '';
        }
        if (!targetTrackId) return false;
        const cloned: RawTaskConfig = {
          ...clip.task,
          id: generateConfigId(),
          name: clip.task.name ? `${clip.task.name} (copy)` : undefined,
          // Strip dependencies: referenced ids may not resolve in the new
          // location and would fail server-side validation.
          depends_on: undefined,
          // continue_from without its backing dep is dangling. Clearing here
          // prevents the cloned task being saved to YAML with a stale ref
          // before any reconcile step runs.
          continue_from: undefined,
        };
        fire(() => api.addTask(targetTrackId, cloned), { errorPrefix: 'Failed to paste task' });
        return true;
      }
      if (clip.kind === 'track') {
        // Server exposes addTrack(id, name, color) + per-task addTask, so
        // clone the track and replay tasks sequentially. History records
        // the initial addTrack entry; subsequent task adds extend it.
        const newTrackId = generateConfigId();
        const newName = `${clip.track.name} (copy)`;
        const tasksToClone: RawTaskConfig[] = clip.track.tasks.map((t) => ({
          ...t,
          id: generateConfigId(),
          depends_on: undefined,
          // continue_from without its backing dep is dangling after the clone.
          continue_from: undefined,
        }));
        const myEpoch = ++fireEpoch;
        const preSnapshot = takeSnapshot();
        set({ isDirty: true });
        // P1-C1: push the history entry SYNCHRONOUSLY (matching fire()'s
        // contract) so a paste appears in the undo stack at the moment the
        // user triggered it, not after the loop of addTask calls finishes.
        // Track the push handle so we can roll back if the paste fails.
        const pushHandle = pushHistory(snapshotToHistory(preSnapshot, undefined, 'config'));
        const pasteTrackPromise = api
          .addTrack(newTrackId, newName, clip.track.color)
          .then(async (state) => {
            if (myEpoch !== fireEpoch) return;
            applyState(state);
            for (const task of tasksToClone) {
              try {
                const next = await api.addTask(newTrackId, task);
                if (myEpoch !== fireEpoch) return;
                applyState(next);
              } catch (e) {
                if (myEpoch !== fireEpoch) return;
                if (!pushHandle.coalesced) removeHistoryByPushId(pushHandle.pushId);
                set({ errorMessage: 'Failed to paste task in cloned track: ' + errorToMessage(e) });
                return;
              }
            }
          })
          .catch((e) => {
            // C6: same epoch-guarded conflict handling as fire().
            if (e instanceof RevisionConflictError) {
              if (myEpoch !== fireEpoch) return;
              if (!pushHandle.coalesced) removeHistoryByPushId(pushHandle.pushId);
              applyStateWithLayout(e.currentState);
              set({
                isDirty: false,
                layoutDirty: false,
                past: [],
                future: [],
                errorMessage: REVISION_CONFLICT_MESSAGE,
                savedConfig: structuredClone(e.currentState.config),
              });
              return;
            }

            if (myEpoch !== fireEpoch) return;
            if (!pushHandle.coalesced) removeHistoryByPushId(pushHandle.pushId);
            restoreSnapshot(preSnapshot);
            set({ errorMessage: 'Failed to paste track: ' + errorToMessage(e) });
          });
        trackInFlight(pasteTrackPromise);
        return true;
      }
      return false;
    },

    duplicateSelection: () => {
      if (blockIfYamlEditLocked()) return false;
      // Ctrl+D = copy + paste in place, without disturbing the clipboard.
      const s = _get();
      if (s.selectedTaskId) {
        const [trackId, taskId] = s.selectedTaskId.split('.');
        const track = s.config.tracks.find((t) => t.id === trackId);
        const task = track?.tasks.find((t) => t.id === taskId);
        if (!task) return false;
        const cloned: RawTaskConfig = {
          ...task,
          id: generateConfigId(),
          name: task.name ? `${task.name} (copy)` : undefined,
          depends_on: undefined,
          // continue_from without its backing dep is dangling after duplicate.
          continue_from: undefined,
        };
        fire(() => api.addTask(trackId, cloned), { errorPrefix: 'Failed to duplicate task' });
        return true;
      }
      if (s.selectedTrackId) {
        const track = s.config.tracks.find((t) => t.id === s.selectedTrackId);
        if (!track) return false;
        const prevClip = s.clipboard;
        set({
          clipboard: {
            kind: 'track',
            track: { ...track, tasks: track.tasks.map((t) => ({ ...t })) },
          },
        });
        const result = _get().pasteClipboard();
        set({ clipboard: prevClip });
        return result;
      }
      return false;
    },
  };
});
