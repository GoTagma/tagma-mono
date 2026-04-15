import { create } from 'zustand';
import { api } from '../api/client';
import type {
  RunTaskState,
  RunEvent,
  RawPipelineConfig,
  ApprovalRequestInfo,
} from '../api/client';
import { foldRunEvent, type RunFoldState } from './run-event-reducer';

interface RunStoreState extends RunFoldState {
  // `active` means the RunView is currently rendered. It is independent
  // from `status`: a run can still be executing on the server while the
  // user is back in the editor (minimized). Only `reset()` tears the
  // whole thing down and unsubscribes the SSE channel.
  active: boolean;
  // 'live'    -> show the running pipeline canvas (or, if idle, the history browser as a fallback)
  // 'history' -> always show the history browser, even if a run is in progress
  viewMode: 'live' | 'history';
  selectedTaskId: string | null;
  selectedTrackId: string | null;
  snapshot: RawPipelineConfig | null;

  startRun: (config: RawPipelineConfig) => Promise<void>;
  abortRun: () => Promise<void>;
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
  showHistoryView: () => void;
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
  };
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
      const next = foldRunEvent(state, event);
      if (next !== state) state = next;
    }
    if (state !== original) set(state);
  }

  function handleEvent(event: RunEvent) {
    // High-priority events (run lifecycle, approvals) flush immediately
    // so the UI transitions without waiting for the next frame.
    if (event.type === 'run_start' || event.type === 'run_end' ||
        event.type === 'run_error' || event.type === 'approval_request' ||
        event.type === 'approval_resolved') {
      // Fold any pending batch first to preserve ordering
      if (pendingEvents.length > 0) {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        flushEvents();
      }
      const current = pickFoldState(get());
      const next = foldRunEvent(current, event);
      if (next !== current) set(next);
      return;
    }
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
    pendingApprovals: new Map<string, ApprovalRequestInfo>(),
    lastEventSeq: 0,

    startRun: async (config) => {
      // Defensive: a previous run may have been minimized (still alive
      // server-side). Close its SSE subscription before starting the new
      // one so we don't leak listeners / get stray events.
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingEvents = [];
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      set({
        active: true,
        viewMode: 'live',
        status: 'starting',
        tasks: new Map(),
        logs: [],
        pipelineLogs: [],
        error: null,
        selectedTaskId: null,
        selectedTrackId: null,
        snapshot: config,
        pendingApprovals: new Map(),
        lastEventSeq: 0,
      });
      // Subscribe to SSE events before starting
      unsubscribe = api.subscribeRunEvents(handleEvent);
      try {
        await api.startRun();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to start run';
        set({ status: 'error', error: message });
      }
    },

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

    showView: () => set({ active: true, viewMode: 'live' }),

    showHistoryView: () => set({ active: true, viewMode: 'history' }),

    abortRun: async () => {
      try {
        await api.abortRun();
      } catch {
        // Intentionally swallow — abort is best-effort; state is finalized below.
      }
      set({ status: 'aborted' });
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
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      pendingEvents = [];
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
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
        pendingApprovals: new Map(),
        lastEventSeq: 0,
      });
    },
  };
});
