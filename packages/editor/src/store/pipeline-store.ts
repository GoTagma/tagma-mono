import { create } from 'zustand';
import { api, RevisionConflictError } from '../api/client';
import type {
  ServerState,
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
  ValidationError,
  DagEdge,
  PluginRegistry,
} from '../api/client';
import { flushAllLocalFields } from '../hooks/use-local-field';
import { generateConfigId } from '../../shared/config-id.js';

const EMPTY_REGISTRY: PluginRegistry = {
  drivers: [],
  triggers: [],
  completions: [],
  middlewares: [],
};

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
 * Undo/redo history entry. Captures only config-level state — selection,
 * transient UI and layoutDirty are intentionally excluded because they
 * should not be part of the undo stack (see Group 6 docs).
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
  scope: HistoryScope;
  config: RawPipelineConfig;
  positions: Map<string, TaskPosition>;
  dagEdges: DagEdge[];
  validationErrors: ValidationError[];
  coalesceKey?: string;
  /** When this entry was first pushed (immutable, for total-cap check). */
  coalesceStartedAt?: number;
  /** When this entry was last refreshed by a coalesced push (rolling). */
  pushedAt?: number;
  pushId?: number;
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
  selectedTaskId: string | null;
  selectedTaskIds: string[];
  selectedTrackId: string | null;
  validationErrors: ValidationError[];
  dagEdges: DagEdge[];
  yamlPath: string | null;
  yamlMtimeMs: number | null;
  workDir: string;
  isDirty: boolean;
  layoutDirty: boolean;
  loading: boolean;
  errorMessage: string | null;
  registry: PluginRegistry;
  past: HistoryEntry[];
  future: HistoryEntry[];
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

  applyState: (state: ServerState) => void;
  clearError: () => void;
  init: () => Promise<void>;
  setPipelineName: (name: string) => void;
  updatePipelineFields: (fields: Record<string, unknown>) => void;
  addTrack: (name: string) => void;
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
  setWorkDir: (workDir: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: (path: string) => Promise<void>;
  restoreDraft: (config: RawPipelineConfig) => Promise<void>;
  newPipeline: (name?: string) => Promise<void>;
  importFile: (sourcePath: string) => Promise<void>;
  exportFile: (destDir: string) => Promise<string | null>;
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

  // Plugins page top-level view toggle — parallel to runStore.active.
  showPluginsPage: () => void;
  hidePluginsPage: () => void;
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
    const positions = _get().positions;
    const obj: Record<string, { x: number }> = {};
    for (const [k, v] of positions) obj[k] = v;
    try {
      await api.saveLayout(obj);
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
    set({
      config: state.config,
      validationErrors: state.validationErrors,
      dagEdges: state.dag.edges,
      yamlPath: state.yamlPath,
      yamlMtimeMs: state.yamlMtimeMs ?? null,
      workDir: state.workDir,
      loading: false,
    });
  };

  /** Apply server state and restore layout positions from server */
  const applyStateWithLayout = (state: ServerState) => {
    const positions = new Map<string, TaskPosition>();
    if (state.layout?.positions) {
      for (const [k, v] of Object.entries(state.layout.positions)) {
        positions.set(k, v);
      }
    }
    set({
      config: state.config,
      validationErrors: state.validationErrors,
      dagEdges: state.dag.edges,
      yamlPath: state.yamlPath,
      yamlMtimeMs: state.yamlMtimeMs ?? null,
      workDir: state.workDir,
      positions,
      loading: false,
    });
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

  // Monotonic request counter used to reject out-of-order responses from
  // `fire()`. Rapid edits (rename, drag) can race: if request A is dispatched
  // first but its response arrives *after* request B's, A's stale ServerState
  // would overwrite B's — causing the UI to flicker back to an older value.
  // We stamp each fire() call with its epoch and only apply the response if
  // no newer request was dispatched in the meantime.
  let fireEpoch = 0;

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

  /** Convert the live positions Map to the wire shape replaceConfig expects. */
  const positionsToObj = (positions: Map<string, TaskPosition>): Record<string, { x: number }> => {
    const obj: Record<string, { x: number }> = {};
    for (const [k, v] of positions) obj[k] = v;
    return obj;
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
    return {
      scope,
      config: structuredClone(snap.config),
      positions: new Map(snap.positions),
      dagEdges: structuredClone(snap.dagEdges),
      validationErrors: structuredClone(snap.validationErrors),
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
    },
  ) => {
    const myEpoch = ++fireEpoch;
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

    const promise = fn().then(
      (state) => {
        if (myEpoch !== fireEpoch) return; // a newer request superseded us
        applyState(state);
      },
      (e) => {
        // RevisionConflictError is handled UNCONDITIONALLY — it signals that
        // our cached revision is stale, and the server's `currentState` is
        // the authoritative baseline. Even if a newer fire() has superseded
        // us, that newer request also used the stale revision, so it will
        // either also conflict or has already been rejected; either way,
        // reconciling to the server's state is always safe. Swallowing
        // conflicts via the epoch guard silently loses the server's
        // reconciliation signal and can strand the client on a stale
        // revision across a burst of edits.
        if (e instanceof RevisionConflictError) {
          // P1-C1: roll back the optimistic history push. Coalesced pushes
          // didn't add a new entry — the existing entry remains valid as
          // a snapshot for the previous successful mutation in the streak.
          if (pushHandle && !pushHandle.coalesced) {
            removeHistoryByPushId(pushHandle.pushId);
          }
          // C6: adopt the authoritative `currentState` returned in the
          // payload — do NOT restore the pre-mutation snapshot, because the
          // server's state is NEWER than our snapshot and is the correct
          // baseline to continue from. A brief UI flicker (optimistic state
          // → reconciled state) is acceptable and documented.
          //
          // We also clear `past`/`future` because the prior undo stack was
          // relative to a now-stale base config; replaying those entries
          // against the new baseline would produce confusing results. This
          // is deliberately aggressive — undo history is per-session UX, not
          // a source of truth, so dropping it on reconciliation is safer
          // than letting a stale stack silently corrupt future edits.
          applyStateWithLayout(e.currentState);
          set({
            isDirty: false,
            layoutDirty: false,
            past: [],
            future: [],
            errorMessage: REVISION_CONFLICT_MESSAGE,
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
      },
    );
    trackInFlight(promise);
  };

  return {
    config: { name: 'Loading...', tracks: [] },
    positions: new Map(),
    selectedTaskId: null,
    selectedTaskIds: [],
    selectedTrackId: null,
    validationErrors: [],
    dagEdges: [],
    yamlPath: null,
    yamlMtimeMs: null,
    workDir: '',
    isDirty: false,
    layoutDirty: false,
    loading: true,
    errorMessage: null,
    registry: EMPTY_REGISTRY,
    past: [],
    future: [],
    clipboard: null,
    pinnedTaskId: null,
    pinnedTrackId: null,
    pluginsActive: false,

    applyState,
    clearError: () => set({ errorMessage: null }),

    init: async () => {
      try {
        const [state, registry] = await Promise.all([api.getState(), fetchRegistrySnapshot()]);
        applyStateWithLayout(state);
        // Fresh page load always starts at the welcome page. The editor server
        // keeps `S.workDir` in process memory, so reopening a tab would
        // otherwise silently resume the previous workspace. Drop the server-
        // hydrated workDir/yamlPath on the client so the welcome gate in
        // App.tsx (`!workDir`) always fires on a new session. The user picks
        // a workspace via the welcome page, which calls setWorkDir and
        // re-syncs both sides. (Future desktop-app multi-window: pass the
        // target workspace as a launch arg and call setWorkDir in init.)
        set({
          workDir: '',
          yamlPath: null,
          yamlMtimeMs: null,
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
    addTrack: (name) => {
      const trackCount = _get().config.tracks.length;
      const color = TRACK_COLORS[trackCount % TRACK_COLORS.length];
      fire(() => api.addTrack(generateConfigId(), name, color), {
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
        return {
          positions,
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
      // Optimistically reorder tracks locally before API round-trip. We used
      // to also remap validationErrors paths via regex, but the server
      // response already contains authoritative validationErrors — just wait
      // for it. A brief single-frame mis-attribution is preferable to a
      // locally-invented path that could drift from the server.
      const snapshot = takeSnapshot();
      set((s) => {
        const tracks = s.config.tracks;
        const fromIndex = tracks.findIndex((t) => t.id === trackId);
        if (fromIndex < 0 || fromIndex === toIndex) return s;
        const without = tracks.filter((t) => t.id !== trackId);
        const moved = tracks[fromIndex];
        const newTracks = [...without];
        newTracks.splice(Math.min(toIndex, newTracks.length), 0, moved);
        return { config: { ...s.config, tracks: newTracks }, layoutDirty: true };
      });
      fire(() => api.reorderTrack(trackId, toIndex), {
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

    showPluginsPage: () => set({ pluginsActive: true }),
    hidePluginsPage: () => set({ pluginsActive: false }),

    setTaskPosition: (qualifiedId, x) => {
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
        // Auto-save current pipeline before switching workspace.
        // If the save fails we MUST abort the switch — otherwise the
        // caller may overwrite the in-memory pipeline and the user
        // silently loses their unsaved work.
        const current = _get();
        if (current.isDirty && current.yamlPath) {
          try {
            await flushLayout();
            await api.saveFile();
          } catch (saveErr) {
            set({
              errorMessage:
                'Cannot switch workspace: failed to save current pipeline — ' +
                errorToMessage(saveErr) +
                '. Save manually or discard changes before switching.',
            });
            return;
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
        const state = await api.setWorkDir(wd);
        const registry = await fetchRegistrySnapshot();
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, registry });
      } catch (e) {
        set({ errorMessage: 'Failed to set workspace: ' + errorToMessage(e) });
      }
    },

    openFile: async (path) => {
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
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [], registry });
      } catch (e) {
        set({ errorMessage: 'Failed to open file: ' + errorToMessage(e) });
      }
    },

    saveFile: async () => {
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
        set({ isDirty: false, layoutDirty: false });
      } catch (e) {
        set({ errorMessage: 'Failed to save: ' + errorToMessage(e) });
      }
    },

    saveFileAs: async (path) => {
      try {
        const state = await api.saveFileAs(path);
        applyState(state);
        set({ isDirty: false, layoutDirty: false });
      } catch (e) {
        set({ errorMessage: 'Failed to save: ' + errorToMessage(e) });
      }
    },

    restoreDraft: async (draftConfig) => {
      try {
        await drainInFlight();
        const s = _get();
        const state = await api.replaceConfig(draftConfig, positionsToObj(s.positions));
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
          });
          return;
        }
        set({ errorMessage: 'Failed to restore draft: ' + errorToMessage(e) });
        throw e;
      }
    },
    newPipeline: async (name) => {
      try {
        set({
          selectedTaskId: null,
          selectedTaskIds: [],
          selectedTrackId: null,
          pinnedTaskId: null,
          pinnedTrackId: null,
        });
        const state = await api.newPipeline(name);
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [] });
      } catch (e) {
        set({ errorMessage: 'Failed to create pipeline: ' + errorToMessage(e) });
      }
    },

    importFile: async (sourcePath) => {
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
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [], registry });
      } catch (e) {
        set({ errorMessage: 'Failed to import file: ' + errorToMessage(e) });
      }
    },

    exportFile: async (destDir) => {
      try {
        const result = await api.exportFile(destDir);
        return result.path;
      } catch (e) {
        set({ errorMessage: 'Failed to export: ' + errorToMessage(e) });
        return null;
      }
    },

    exportYaml: () => api.exportYaml(),

    importYaml: async (yaml) => {
      try {
        const state = await api.importYaml(yaml);
        set({ selectedTaskId: null, selectedTaskIds: [], pinnedTaskId: null, pinnedTrackId: null });
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [] });
      } catch (e) {
        set({ errorMessage: 'Invalid YAML: ' + errorToMessage(e) });
      }
    },

    loadDemo: async () => {
      try {
        const state = await api.loadDemo();
        set({ selectedTaskId: null, selectedTaskIds: [], pinnedTaskId: null, pinnedTrackId: null });
        applyStateWithLayout(state);
        set({ isDirty: false, layoutDirty: false, past: [], future: [] });
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
      // P0-C3: wait for any fire() in flight to settle so the past stack
      // reflects every committed mutation before we pop from it.
      await drainInFlight();

      const s = _get();
      if (s.past.length === 0) return;
      const prev = s.past[s.past.length - 1];
      // P1-C1: build the "current" entry to push to future. It mirrors
      // prev.scope so redo restores the exact same slice we're undoing.
      // P2-H3: deep-clone config-shaped fields for the same poisoning
      // protection snapshotToHistory provides.
      const current: HistoryEntry = {
        scope: prev.scope,
        config: structuredClone(s.config),
        positions: new Map(s.positions),
        dagEdges: structuredClone(s.dagEdges),
        validationErrors: structuredClone(s.validationErrors),
      };
      const preUndoPast = s.past;
      const preUndoFuture = s.future;
      // P1-C1: scoped restore. Only revert the slices owned by `prev.scope`.
      const restoreConfig = prev.scope === 'config' || prev.scope === 'both';
      const restorePositions = prev.scope === 'positions' || prev.scope === 'both';
      set((cur) => {
        const next: Partial<PipelineState> = {
          past: cur.past.slice(0, -1),
          future: [...cur.future, current],
          isDirty: true,
          layoutDirty: true,
        };
        if (restoreConfig) {
          next.config = prev.config;
          next.dagEdges = prev.dagEdges;
          next.validationErrors = prev.validationErrors;
          Object.assign(next, pruneStaleSelection(prev.config, cur));
        }
        if (restorePositions) {
          next.positions = new Map(prev.positions);
        }
        return next;
      });
      // Mirror restored state to server. We always send the post-set local
      // state so the wire format is uniform regardless of scope — server
      // gets a consistent snapshot of {config, positions} every time.
      const restored = _get();
      const myEpoch = ++fireEpoch;
      const promise = api.replaceConfig(restored.config, positionsToObj(restored.positions)).then(
        (state) => {
          if (myEpoch !== fireEpoch) return;
          applyState(state);
        },
        (e) => {
          // RevisionConflictError is handled UNCONDITIONALLY — it signals that
          // our cached revision is stale, and the server's `currentState` is
          // the authoritative baseline. Even if a newer fire() has superseded
          // us, that newer request also used the stale revision, so it will
          // either also conflict or has already been rejected; either way,
          // reconciling to the server's state is always safe.
          if (e instanceof RevisionConflictError) {
            applyStateWithLayout(e.currentState);
            set({
              isDirty: false,
              layoutDirty: false,
              past: [],
              future: [],
              errorMessage: REVISION_CONFLICT_MESSAGE,
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
            if (restoreConfig) {
              rb.config = current.config;
              rb.dagEdges = current.dagEdges;
              rb.validationErrors = current.validationErrors;
            }
            if (restorePositions) {
              rb.positions = new Map(current.positions);
            }
            return rb;
          });
        },
      );
      trackInFlight(promise);
      await promise;
    },

    redo: async () => {
      // P0-C3: same drain-then-apply discipline as undo().
      await drainInFlight();

      const s = _get();
      if (s.future.length === 0) return;
      const next = s.future[s.future.length - 1];
      // P1-C1: same scoped-restore semantics as undo, in the opposite
      // direction. The future entry mirrors the scope of the original
      // mutation it tracks. P2-H3: deep-clone for poisoning protection.
      const current: HistoryEntry = {
        scope: next.scope,
        config: structuredClone(s.config),
        positions: new Map(s.positions),
        dagEdges: structuredClone(s.dagEdges),
        validationErrors: structuredClone(s.validationErrors),
      };
      const preRedoPast = s.past;
      const preRedoFuture = s.future;
      const restoreConfig = next.scope === 'config' || next.scope === 'both';
      const restorePositions = next.scope === 'positions' || next.scope === 'both';
      set((cur) => {
        const patch: Partial<PipelineState> = {
          past: [...cur.past, current],
          future: cur.future.slice(0, -1),
          isDirty: true,
          layoutDirty: true,
        };
        if (restoreConfig) {
          patch.config = next.config;
          patch.dagEdges = next.dagEdges;
          patch.validationErrors = next.validationErrors;
          Object.assign(patch, pruneStaleSelection(next.config, cur));
        }
        if (restorePositions) {
          patch.positions = new Map(next.positions);
        }
        return patch;
      });
      const restored = _get();
      const myEpoch = ++fireEpoch;
      const promise = api.replaceConfig(restored.config, positionsToObj(restored.positions)).then(
        (state) => {
          if (myEpoch !== fireEpoch) return;
          applyState(state);
        },
        (e) => {
          // RevisionConflictError is handled UNCONDITIONALLY — it signals that
          // our cached revision is stale, and the server's `currentState` is
          // the authoritative baseline. Even if a newer fire() has superseded
          // us, that newer request also used the stale revision, so it will
          // either also conflict or has already been rejected; either way,
          // reconciling to the server's state is always safe.
          if (e instanceof RevisionConflictError) {
            applyStateWithLayout(e.currentState);
            set({
              isDirty: false,
              layoutDirty: false,
              past: [],
              future: [],
              errorMessage: REVISION_CONFLICT_MESSAGE,
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
            if (restoreConfig) {
              rb.config = current.config;
              rb.dagEdges = current.dagEdges;
              rb.validationErrors = current.validationErrors;
            }
            if (restorePositions) {
              rb.positions = new Map(current.positions);
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
            // RevisionConflictError is handled UNCONDITIONALLY — it signals that
            // our cached revision is stale, and the server's `currentState` is
            // the authoritative baseline. Even if a newer fire() has superseded
            // us, that newer request also used the stale revision, so it will
            // either also conflict or has already been rejected; either way,
            // reconciling to the server's state is always safe.
            if (e instanceof RevisionConflictError) {
              if (!pushHandle.coalesced) removeHistoryByPushId(pushHandle.pushId);
              applyStateWithLayout(e.currentState);
              set({
                isDirty: false,
                layoutDirty: false,
                past: [],
                future: [],
                errorMessage: REVISION_CONFLICT_MESSAGE,
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
