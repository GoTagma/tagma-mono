import { create } from 'zustand';
import { api } from '../api/client';
import type {
  RunTaskState,
  RunEvent,
  RawPipelineConfig,
  ApprovalRequestInfo,
  DagEdge,
} from '../api/client';
import { usePipelineStore, type TaskPosition } from './pipeline-store';
import { foldRunEvent, type RunFoldState } from './run-event-reducer';

/**
 * Optional bundle passed to startRun when launching a run whose config
 * differs from the current editor state (e.g. replaying a historical
 * snapshot from the run history). The editor's own dagEdges/positions
 * describe a potentially unrelated pipeline, so we need our own.
 *
 * `fromRunId` is forwarded to the backend so it loads the snapshot yaml
 * instead of serializing S.config.
 */
export interface RunStartOverrides {
  readonly fromRunId?: string;
  readonly yamlPath?: string | null;
  readonly targetTaskIds?: readonly string[];
  readonly dagEdges?: DagEdge[];
  readonly positions?: Map<string, TaskPosition>;
}

/**
 * Server payload returned by /api/run/start when the host is missing one or
 * more dependencies declared in the pipeline's `*.requirements.md`. The store
 * holds it until the user picks an action in the pre-run modal (re-check,
 * run-anyway, or cancel). When non-null the modal renders on top of the
 * editor; the run never started on the server side.
 */
export interface RequirementsMissingState {
  readonly missing: { readonly binaries: readonly string[]; readonly envs: readonly string[] };
  readonly requirementsPath: string;
  readonly snapshot: RawPipelineConfig;
  readonly fromRunId: string | null;
  readonly yamlPath: string | null;
  readonly targetTaskIds: readonly string[] | null;
}

interface RunStoreState extends RunFoldState {
  // `active` means the RunView is currently rendered. It is independent
  // from `status`: a run can still be executing on the server while the
  // user is back in the editor (minimized). Only `reset()` tears the
  // whole thing down and unsubscribes the SSE channel.
  active: boolean;
  // 'live'    -> legacy live canvas mode; new run entry points use history
  // 'history' -> always show the history browser, even if a run is in progress
  viewMode: 'live' | 'history';
  selectedTaskId: string | null;
  selectedTrackId: string | null;
  snapshot: RawPipelineConfig | null;
  /**
   * Overrides for DAG edges / task positions used when the run was
   * launched from a source other than the current editor state (i.e.
   * replay-from-history). Null for normal live runs — the RunView then
   * falls back to the editor-derived props passed in from App.tsx.
   */
  replayDagEdges: DagEdge[] | null;
  replayPositions: Map<string, TaskPosition> | null;
  /** Original history runId this run was replayed from, if any. */
  replayFromRunId: string | null;
  /** Run id the history page should select when it opens. */
  historySelectedRunId: string | null;
  /** YAML path that launched the current/minimized run, if it came from an open file. */
  yamlPath: string | null;

  /**
   * When the most recent startRun call was rejected by the requirements
   * preflight, this holds everything the modal needs to render and to retry
   * (or skip) the launch. Null when no preflight modal is in flight.
   */
  requirementsMissing: RequirementsMissingState | null;

  startRun: (
    config: RawPipelineConfig,
    overrides?: RunStartOverrides,
    opts?: { skipPreflight?: boolean },
  ) => Promise<string | null>;
  /**
   * Re-launch the most recent startRun attempt, optionally skipping the
   * preflight check. Used by the requirements-missing modal: "Re-check"
   * passes no skip flag (preflight runs again); "Run anyway" passes
   * skipPreflight: true.
   */
  retryRunFromRequirements: (opts?: { skipPreflight?: boolean }) => Promise<void>;
  /** Dismiss the requirements-missing modal without launching the run. */
  dismissRequirementsCheck: () => void;
  abortRun: (runId?: string) => Promise<void>;
  selectTask: (taskId: string | null) => void;
  selectTrack: (trackId: string | null) => void;
  // Only 'approved' and 'rejected' are user-driven outcomes the UI can post;
  // 'timeout' / 'aborted' arrive from the engine via SSE.
  resolveApproval: (requestId: string, outcome: 'approved' | 'rejected') => Promise<void>;
  /**
   * Hide the RunView without stopping the run. SSE stays subscribed,
   * tasks / snapshot / pendingApprovals are preserved, and `showView()`
   * re-renders the view seamlessly when the user wants to come back.
   */
  minimizeView: () => void;
  /** Re-open the RunView after a prior `minimizeView()`. */
  showView: () => void;
  /** Open the RunView pinned to the history browser, regardless of run status. */
  showHistoryView: (runId?: unknown) => void;
  reset: () => void;
}

function pickFoldState(s: RunStoreState): RunFoldState {
  return {
    runId: s.runId,
    status: s.status,
    tasks: s.tasks,
    logs: s.logs,
    pipelineLogs: s.pipelineLogs,
    error: s.error,
    pendingApprovals: s.pendingApprovals,
    lastEventSeq: s.lastEventSeq,
    abortReason: s.abortReason,
  };
}

function approvalWithRunId(req: ApprovalRequestInfo, runId: string): ApprovalRequestInfo {
  return req.runId === runId ? req : { ...req, runId };
}

function replaceApprovalsForRun(
  pendingApprovals: Map<string, ApprovalRequestInfo>,
  runId: string,
  nextApprovals: readonly ApprovalRequestInfo[],
): Map<string, ApprovalRequestInfo> {
  const pending = new Map<string, ApprovalRequestInfo>();
  for (const [id, req] of pendingApprovals) {
    if (req.runId === runId) continue;
    pending.set(id, req);
  }
  for (const req of nextApprovals) {
    pending.set(req.id, approvalWithRunId(req, runId));
  }
  return pending;
}

function foldGlobalApprovals(
  pendingApprovals: Map<string, ApprovalRequestInfo>,
  event: RunEvent,
): Map<string, ApprovalRequestInfo> {
  switch (event.type) {
    case 'run_start':
      return replaceApprovalsForRun(pendingApprovals, event.runId, []);
    case 'run_snapshot':
      return replaceApprovalsForRun(pendingApprovals, event.runId, event.pendingApprovals);
    case 'approval_request': {
      const pending = new Map(pendingApprovals);
      pending.set(event.request.id, approvalWithRunId(event.request, event.runId));
      return pending;
    }
    case 'approval_resolved': {
      const pending = new Map(pendingApprovals);
      pending.delete(event.requestId);
      return pending;
    }
    default:
      return pendingApprovals;
  }
}

function isFocusedRunEvent(state: RunFoldState, event: RunEvent): boolean {
  return state.runId !== null && state.runId === event.runId;
}

export const useRunStore = create<RunStoreState>((set, get) => {
  let unsubscribe: (() => void) | null = null;

  // Batch SSE events and flush once per animation frame to prevent
  // high-frequency task_log lines from flooding React with re-renders.
  let pendingEvents: RunEvent[] = [];
  let rafId: number | null = null;

  function flushEvents() {
    rafId = null;
    if (pendingEvents.length === 0) return;
    const batch = pendingEvents;
    pendingEvents = [];
    let state = pickFoldState(get());
    const original = state;
    for (const event of batch) {
      if (!isFocusedRunEvent(state, event)) {
        const pendingApprovals = foldGlobalApprovals(state.pendingApprovals, event);
        if (pendingApprovals !== state.pendingApprovals) state = { ...state, pendingApprovals };
        continue;
      }
      const next = foldRunEvent(state, event);
      if (next !== state) state = next;
    }
    if (state !== original) set(state);
  }

  function handleEvent(event: RunEvent) {
    // High-priority events (run lifecycle, approvals) flush immediately
    // so the UI transitions without waiting for the next frame.
    if (
      event.type === 'run_start' ||
      event.type === 'run_snapshot' ||
      event.type === 'run_end' ||
      event.type === 'run_error' ||
      event.type === 'approval_request' ||
      event.type === 'approval_resolved'
    ) {
      // Fold any pending batch first to preserve ordering
      if (pendingEvents.length > 0) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        flushEvents();
      }
      const current = pickFoldState(get());
      if (!isFocusedRunEvent(current, event)) {
        const pendingApprovals = foldGlobalApprovals(current.pendingApprovals, event);
        if (pendingApprovals !== current.pendingApprovals) set({ pendingApprovals });
        return;
      }
      const next = foldRunEvent(current, event);
      if (next !== current) {
        set({
          ...next,
          ...(event.type === 'run_start' ? { historySelectedRunId: event.runId } : {}),
        });
      }
      return;
    }
    if (!isFocusedRunEvent(pickFoldState(get()), event)) return;
    // Buffer task_update / task_log and flush once per frame
    pendingEvents.push(event);
    if (rafId === null) rafId = requestAnimationFrame(flushEvents);
  }

  return {
    active: false,
    viewMode: 'live',
    runId: null,
    status: 'idle',
    tasks: new Map<string, RunTaskState>(),
    logs: [],
    pipelineLogs: [],
    error: null,
    selectedTaskId: null,
    selectedTrackId: null,
    snapshot: null,
    replayDagEdges: null,
    replayPositions: null,
    replayFromRunId: null,
    historySelectedRunId: null,
    yamlPath: null,
    requirementsMissing: null,
    pendingApprovals: new Map<string, ApprovalRequestInfo>(),
    lastEventSeq: 0,
    abortReason: null,

    startRun: async (config, overrides, opts) => {
      // Defensive: a previous run may have been minimized (still alive
      // server-side). Close its SSE subscription before starting the new
      // one so we don't leak listeners / get stray events.
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingEvents = [];
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      set({
        active: true,
        viewMode: 'history',
        runId: null,
        status: 'starting',
        tasks: new Map(),
        logs: [],
        pipelineLogs: [],
        error: null,
        selectedTaskId: null,
        selectedTrackId: null,
        snapshot: config,
        replayDagEdges: overrides?.dagEdges ?? null,
        replayPositions: overrides?.positions ?? null,
        replayFromRunId: overrides?.fromRunId ?? null,
        historySelectedRunId: null,
        yamlPath: overrides?.yamlPath ?? null,
        requirementsMissing: null,
        pendingApprovals: new Map(),
        lastEventSeq: 0,
        abortReason: null,
      });
      // Subscribe to SSE events before starting
      unsubscribe = api.subscribeRunEvents(handleEvent);
      try {
        const startOpts: {
          fromRunId?: string;
          skipPreflight?: boolean;
          targetTaskIds?: readonly string[];
          yamlPath?: string | null;
        } = {};
        if (overrides?.fromRunId) startOpts.fromRunId = overrides.fromRunId;
        if (!overrides?.fromRunId && overrides?.yamlPath) startOpts.yamlPath = overrides.yamlPath;
        if (overrides?.targetTaskIds && overrides.targetTaskIds.length > 0) {
          startOpts.targetTaskIds = overrides.targetTaskIds;
        }
        if (opts?.skipPreflight) startOpts.skipPreflight = true;
        const result = await api.startRun(
          Object.keys(startOpts).length > 0 ? startOpts : undefined,
        );
        if (result.runId) {
          // The POST response is the authoritative focus for this start.
          // SSE may have replayed other live workspace runs before the
          // response arrived; those must not keep or steal focus.
          set({
            runId: result.runId,
            historySelectedRunId: result.runId,
          });
        }
        if (result.yamlRunVersion !== undefined && !overrides?.fromRunId) {
          usePipelineStore.setState({ yamlRunVersion: result.yamlRunVersion });
        }
        for (const event of result.events ?? []) {
          handleEvent(event);
        }
        return result.runId ?? null;
      } catch (e: unknown) {
        // Requirements preflight failure: don't slide RunView in — surface a
        // pre-run modal at App level and bounce back to the editor. The
        // `.body` field on the api error carries the structured payload.
        const apiErr = e as Error & { status?: number; body?: unknown };
        const body = apiErr.body as
          | {
              error?: string;
              missing?: { binaries?: string[]; envs?: string[] };
              requirementsPath?: string;
            }
          | undefined;
        if (
          apiErr.status === 400 &&
          body?.error === 'requirements_missing' &&
          body.requirementsPath
        ) {
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
          set({
            active: false,
            status: 'idle',
            error: null,
            historySelectedRunId: null,
            requirementsMissing: {
              missing: {
                binaries: body.missing?.binaries ?? [],
                envs: body.missing?.envs ?? [],
              },
              requirementsPath: body.requirementsPath,
              snapshot: config,
              fromRunId: overrides?.fromRunId ?? null,
              yamlPath: overrides?.yamlPath ?? null,
              targetTaskIds: overrides?.targetTaskIds ? [...overrides.targetTaskIds] : null,
            },
          });
          return null;
        }
        const message = e instanceof Error ? e.message : 'Failed to start run';
        set({ status: 'error', error: message });
        return null;
      }
    },

    retryRunFromRequirements: async (opts) => {
      const pending = get().requirementsMissing;
      if (!pending) return;
      const fromRunId = pending.fromRunId;
      const yamlPath = pending.yamlPath;
      const overrides: RunStartOverrides | undefined =
        fromRunId || yamlPath || pending.targetTaskIds
          ? {
              ...(fromRunId ? { fromRunId } : {}),
              ...(yamlPath ? { yamlPath } : {}),
              ...(pending.targetTaskIds ? { targetTaskIds: pending.targetTaskIds } : {}),
            }
          : undefined;
      // Defer to the main startRun path so SSE / state reset / event-buffer
      // bookkeeping all stay in one place. startRun will clear
      // requirementsMissing as part of its initial state set().
      await get().startRun(pending.snapshot, overrides, opts);
    },

    dismissRequirementsCheck: () => set({ requirementsMissing: null }),

    // NOTE: deliberately do NOT reset `viewMode` here. While the RunView's
    // exit animation is playing (AnimatePresence mode="wait"), the component
    // is still mounted — flipping viewMode from 'history' → 'live' mid-exit
    // causes RunView to re-render with `showHistory=false`, briefly painting
    // the live track canvas (whose track-lane layout is visually identical
    // to the editor), which looks like an "editor flash" right before the
    // transition animation kicks in. `viewMode` is dead state while
    // `active: false`; every re-entry point (startRun / showView /
    // showHistoryView) sets it explicitly.
    minimizeView: () => set({ active: false }),

    showView: () => {
      const runId = get().runId;
      set({
        active: true,
        viewMode: 'history',
        ...(runId ? { historySelectedRunId: runId } : {}),
      });
    },

    showHistoryView: (runId) => {
      const focusedRunId =
        runId === undefined ? undefined : typeof runId === 'string' ? runId : null;
      set({
        active: true,
        viewMode: 'history',
        ...(focusedRunId !== undefined ? { historySelectedRunId: focusedRunId } : {}),
      });
    },

    abortRun: async (runId) => {
      const targetRunId = runId ?? get().runId ?? undefined;
      try {
        await api.abortRun(targetRunId);
      } catch (e: unknown) {
        if (targetRunId && targetRunId === get().runId) {
          const message = e instanceof Error ? e.message : 'Failed to abort run';
          set({ error: message });
        }
        return;
      }
      if (targetRunId && targetRunId === get().runId) set({ status: 'aborted', error: null });
    },

    selectTask: (taskId) => set({ selectedTaskId: taskId, selectedTrackId: null }),

    selectTrack: (trackId) => set({ selectedTrackId: trackId, selectedTaskId: null }),

    resolveApproval: async (requestId, outcome) => {
      // Optimistically remove from queue; restore on failure so user can retry.
      const state = get();
      const savedApproval = state.pendingApprovals.get(requestId);
      const pending = new Map(state.pendingApprovals);
      pending.delete(requestId);
      set({ pendingApprovals: pending });
      try {
        await api.resolveApproval(requestId, outcome);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to resolve approval';
        // Restore the approval so the user can retry
        if (savedApproval) {
          const restored = new Map(get().pendingApprovals);
          restored.set(requestId, savedApproval);
          set({ pendingApprovals: restored, error: message });
        } else {
          set({ error: message });
        }
      }
    },

    reset: () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingEvents = [];
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      // See minimizeView: leaving viewMode alone keeps RunView's exit
      // animation painting the same content it was showing when Back
      // was clicked (history browser stays visible until exit completes).
      set({
        active: false,
        runId: null,
        status: 'idle',
        tasks: new Map(),
        logs: [],
        pipelineLogs: [],
        error: null,
        selectedTaskId: null,
        selectedTrackId: null,
        snapshot: null,
        replayDagEdges: null,
        replayPositions: null,
        replayFromRunId: null,
        historySelectedRunId: null,
        yamlPath: null,
        requirementsMissing: null,
        pendingApprovals: new Map(),
        lastEventSeq: 0,
        abortReason: null,
      });
    },
  };
});
