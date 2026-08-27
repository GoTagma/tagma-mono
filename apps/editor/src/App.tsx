import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePipelineStore } from './store/pipeline-store';
import { BoardCanvas } from './components/board/BoardCanvas';
import { Toolbar } from './components/board/Toolbar';
import { TaskConfigPanel } from './components/panels/TaskConfigPanel';
import { TrackConfigPanel } from './components/panels/TrackConfigPanel';
import { PipelineConfigPanel } from './components/panels/PipelineConfigPanel';
import { SecretsManagerPanel } from './components/panels/SecretsManagerPanel';
import { PluginsPage } from './components/plugins/PluginsPage';
import { UsagePage } from './components/usage/UsagePage';
import { EditorSettingsPage } from './components/settings/EditorSettingsPage';
import { FileExplorer, type FileExplorerMode } from './components/FileExplorer';
import { WelcomePage } from './components/WelcomePage';
import { PipelinePicker } from './components/PipelinePicker';
import { openPipelineFromPicker } from './components/pipeline-picker-transition';
import {
  api,
  type ServerState,
  type ServerStateEvent,
  type WorkspaceYamlEntry,
  type WorkflowGraphEvent,
  type WorkflowRunStatus,
  type WorkflowRunResult,
  type WorkflowYamlEntry,
  type DiagnosticItem,
  type PlatformExportProgressEvent,
  type PlatformExportTarget,
} from './api/client';
import { Loader2, ShieldCheck } from 'lucide-react';

import { RunView } from './components/run/RunView';
import { WorkflowView } from './components/workflow/WorkflowView';
import { resolveWorkflowPipelineEditorPath } from './components/workflow/workflow-graph-model';
import { YamlPreview } from './components/panels/YamlPreview';
import { useRunStore } from './store/run-store';
import { ErrorToast } from './components/ErrorToast';
import { useShortcuts } from './hooks/use-shortcuts';
import { useAutosave, loadDraft, clearDraft } from './hooks/use-autosave';
import { useDiskAutosave } from './hooks/use-disk-autosave';
import { getLastLocalFieldEditAt } from './hooks/use-local-field';
import { SaveAsDialog } from './components/SaveAsDialog';
import { TrackIODialog } from './components/panels/TrackIODialog';
import { DialogModal, type DialogInfo } from './components/DialogModal';
import { ConfirmModal, type ConfirmInfo } from './components/ConfirmModal';
import { GlobalRequirementsCheckModal } from './components/run/RequirementsCheckModal';
import { hasDesktopBridge, openDesktopWindow } from './desktop';
import { DesktopTitleStrip } from './components/DesktopWindowControls';
import { VersionStatusBar } from './components/VersionStatusBar';
import {
  GlobalConfirmModal,
  PLATFORM_EXPORT_LABELS,
  PLATFORM_EXPORT_STAGE_LABELS,
  PLATFORM_EXPORT_TARGETS,
  PlatformExportProgressToast,
  UnsavedChangesModal,
  ViewportNotificationStack,
  type PlatformExportProgressState,
  type UnsavedAction,
} from './components/AppOverlays';
import { ChatPanel } from './components/chat/ChatPanel';
import { isChatDrivenEditLikely, useChatStore } from './store/chat-store';
import { useEditorSettingsStore } from './store/editor-settings-store';
import { RightDock, useRightDock } from './components/RightDock';
import {
  hasLocalEditorChanges,
  resolveDirtyDiskChange,
  shouldShowReloadFailureDialog,
} from './utils/chat-dirty-conflict';
import { resolveInspectorTarget } from './utils/inspector-target';
import {
  findTaskSearchMatches,
  type TaskSearchMatch,
  type TaskSearchMode,
} from './utils/task-search';
import {
  didOpenWorkflowPipelineFromGraph,
  shouldClearWorkflowReturnPathForNavigation,
  type WorkflowReturnPathNavigation,
} from './utils/workflow-return-state';
import { useYamlEditLockStore, YAML_EDIT_LOCK_MESSAGE } from './store/yaml-edit-lock-store';
import { createRunSaveController } from './utils/run-save-flow';
import {
  buildWorkspacePipelineMenuItems,
  type WorkspaceStagedPipeline,
} from './utils/workspace-yaml-list';

type ExplorerIntent = {
  mode: FileExplorerMode;
} & (
  | { purpose: 'import' | 'export' | 'workdir' | 'plugin-import' }
  | { purpose: 'export-platform'; targetPlatform: PlatformExportTarget }
);

type WorkspacePipelineListState = {
  workspaceKey: string | null;
  liveEntries: WorkspaceYamlEntry[];
  stagedTargets: WorkspaceStagedPipeline[];
};

function workflowEventSeq(event: WorkflowGraphEvent): number | null {
  return typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : null;
}

export function workflowEventSignature(event: WorkflowGraphEvent): string {
  const seq = workflowEventSeq(event);
  return seq === null ? JSON.stringify(event) : `${event.graphRunId}:${seq}`;
}

export function appendWorkflowEvent(
  events: WorkflowGraphEvent[],
  event: WorkflowGraphEvent,
): WorkflowGraphEvent[] {
  const signature = workflowEventSignature(event);
  if (events.some((existing) => workflowEventSignature(existing) === signature)) {
    return events;
  }
  const seq = workflowEventSeq(event);
  if (
    seq !== null &&
    events.some(
      (existing) =>
        existing.graphRunId === event.graphRunId && (workflowEventSeq(existing) ?? -1) >= seq,
    )
  ) {
    return events;
  }
  return [...events, event];
}

function workflowResultFromGraphEnd(event: WorkflowGraphEvent): WorkflowRunResult | null {
  if (event.type !== 'graph_end') return null;
  return {
    graphRunId: event.graphRunId,
    success: event.success,
    abortReason: event.abortReason,
    pipelines: event.pipelines,
  };
}

export function isWorkflowTerminalEvent(event: WorkflowGraphEvent): boolean {
  return event.type === 'graph_end';
}

interface WorkflowRunStateSnapshot {
  events: WorkflowGraphEvent[];
  result: WorkflowRunResult | null;
  running: boolean;
  graphRunId: string | null;
}

export function reconcileWorkflowRunState(
  current: WorkflowRunStateSnapshot,
  snapshot: Pick<WorkflowRunStatus, 'events' | 'result' | 'running' | 'graphRunId'>,
): WorkflowRunStateSnapshot {
  const events = snapshot.events.reduce<WorkflowGraphEvent[]>(appendWorkflowEvent, current.events);
  const terminalResult =
    [...events].reverse().map(workflowResultFromGraphEnd).find(Boolean) ?? null;
  const result = snapshot.result ?? terminalResult ?? current.result;
  return {
    events,
    result,
    running: snapshot.running,
    graphRunId: snapshot.running ? (snapshot.graphRunId ?? current.graphRunId) : null,
  };
}

function isMissingWorkflowRunError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { status?: number }).status === 404 &&
    err.message === 'No workflow run in progress'
  );
}

export function App() {
  const desktopMode = hasDesktopBridge();
  const config = usePipelineStore((s) => s.config);
  const positions = usePipelineStore((s) => s.positions);
  const selectedTaskId = usePipelineStore((s) => s.selectedTaskId);
  const selectedTaskIds = usePipelineStore((s) => s.selectedTaskIds);
  const selectedTrackId = usePipelineStore((s) => s.selectedTrackId);
  const pinnedTaskId = usePipelineStore((s) => s.pinnedTaskId);
  const pinnedTrackId = usePipelineStore((s) => s.pinnedTrackId);
  const validationErrors = usePipelineStore((s) => s.validationErrors);
  const dagEdges = usePipelineStore((s) => s.dagEdges);
  const yamlPath = usePipelineStore((s) => s.yamlPath);
  const yamlMtimeMs = usePipelineStore((s) => s.yamlMtimeMs);
  const workDir = usePipelineStore((s) => s.workDir);
  const hostPlatform = usePipelineStore((s) => s.hostPlatform);
  const isDirty = usePipelineStore((s) => s.isDirty);
  const layoutDirty = usePipelineStore((s) => s.layoutDirty);
  const loading = usePipelineStore((s) => s.loading);
  const registry = usePipelineStore((s) => s.registry);
  const yamlPreviewBlocks = usePipelineStore((s) => s.yamlPreviewBlocks);
  const pluginsActive = usePipelineStore((s) => s.pluginsActive);
  const showPluginsPage = usePipelineStore((s) => s.showPluginsPage);
  const hidePluginsPage = usePipelineStore((s) => s.hidePluginsPage);
  const usageActive = usePipelineStore((s) => s.usageActive);
  const showUsagePage = usePipelineStore((s) => s.showUsagePage);
  const hideUsagePage = usePipelineStore((s) => s.hideUsagePage);
  const settingsActive = usePipelineStore((s) => s.settingsActive);
  const showSettingsPage = usePipelineStore((s) => s.showSettingsPage);
  const hideSettingsPage = usePipelineStore((s) => s.hideSettingsPage);
  const setPipelineName = usePipelineStore((s) => s.setPipelineName);
  const updatePipelineFields = usePipelineStore((s) => s.updatePipelineFields);
  const addTrack = usePipelineStore((s) => s.addTrack);
  const renameTrack = usePipelineStore((s) => s.renameTrack);
  const updateTrackFields = usePipelineStore((s) => s.updateTrackFields);
  const deleteTrack = usePipelineStore((s) => s.deleteTrack);
  const moveTrackTo = usePipelineStore((s) => s.moveTrackTo);
  const addTask = usePipelineStore((s) => s.addTask);
  const updateTask = usePipelineStore((s) => s.updateTask);
  const deleteTask = usePipelineStore((s) => s.deleteTask);
  const transferTaskToTrack = usePipelineStore((s) => s.transferTaskToTrack);
  const addDependency = usePipelineStore((s) => s.addDependency);
  const removeDependency = usePipelineStore((s) => s.removeDependency);
  const selectTask = usePipelineStore((s) => s.selectTask);
  const toggleTaskSelection = usePipelineStore((s) => s.toggleTaskSelection);
  const selectTrack = usePipelineStore((s) => s.selectTrack);
  const pinTask = usePipelineStore((s) => s.pinTask);
  const unpinTask = usePipelineStore((s) => s.unpinTask);
  const pinTrack = usePipelineStore((s) => s.pinTrack);
  const unpinTrack = usePipelineStore((s) => s.unpinTrack);
  const setTaskPosition = usePipelineStore((s) => s.setTaskPosition);
  const setTrackHeight = usePipelineStore((s) => s.setTrackHeight);
  const setRegistry = usePipelineStore((s) => s.setRegistry);
  const refreshServerState = usePipelineStore((s) => s.refreshServerState);
  const resetYamlPreviewBaseline = usePipelineStore((s) => s.resetYamlPreviewBaseline);
  const revertYamlPreviewBlock = usePipelineStore((s) => s.revertYamlPreviewBlock);
  const setWorkDir = usePipelineStore((s) => s.setWorkDir);
  const saveFile = usePipelineStore((s) => s.saveFile);
  const saveFileAs = usePipelineStore((s) => s.saveFileAs);
  const flushPendingLocalEdits = usePipelineStore((s) => s.flushPendingLocalEdits);
  const newPipeline = usePipelineStore((s) => s.newPipeline);
  const importFile = usePipelineStore((s) => s.importFile);
  const exportFile = usePipelineStore((s) => s.exportFile);
  const exportPlatformFile = usePipelineStore((s) => s.exportPlatformFile);
  const openFile = usePipelineStore((s) => s.openFile);
  const init = usePipelineStore((s) => s.init);
  const restoreDraft = usePipelineStore((s) => s.restoreDraft);
  const clearWorkspace = usePipelineStore((s) => s.clearWorkspace);

  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const yamlEditLockReason = useYamlEditLockStore((s) => s.reason);

  const runActive = useRunStore((s) => s.active);
  const runStatus = useRunStore((s) => s.status);
  const startRun = useRunStore((s) => s.startRun);
  const resetRun = useRunStore((s) => s.reset);
  const minimizeRun = useRunStore((s) => s.minimizeView);
  const showRunHistory = useRunStore((s) => s.showHistoryView);

  useEffect(() => {
    useYamlEditLockStore.getState().syncActiveYamlPath(yamlPath);
  }, [yamlPath]);

  const [showSecretsManager, setShowSecretsManager] = useState(false);
  const [pipelineInspectorSelected, setPipelineInspectorSelected] = useState(false);
  const [pipelineInspectorPinned, setPipelineInspectorPinned] = useState(false);
  const [explorer, setExplorer] = useState<ExplorerIntent | null>(null);
  const [dialog, setDialog] = useState<DialogInfo | null>(null);
  const [confirmInfo, setConfirmInfo] = useState<ConfirmInfo | null>(null);
  const [unsavedAction, setUnsavedAction] = useState<UnsavedAction | null>(null);
  const [workspacePipelines, setWorkspacePipelines] = useState<WorkspacePipelineListState>({
    workspaceKey: workDir || null,
    liveEntries: [],
    stagedTargets: [],
  });
  const workspaceStateVisible = workspacePipelines.workspaceKey === (workDir || null);
  // Keep this derived collection strictly live-only. PipelinePicker and
  // WorkflowView must never receive paths inside .chat-staging.
  const workspaceYamls = useMemo(
    () => (workspaceStateVisible ? workspacePipelines.liveEntries : []),
    [workspacePipelines.liveEntries, workspaceStateVisible],
  );
  const stagedWorkspacePipelines = useMemo(
    () => (workspaceStateVisible ? workspacePipelines.stagedTargets : []),
    [workspacePipelines.stagedTargets, workspaceStateVisible],
  );
  const [saveAsInput, setSaveAsInput] = useState<string | null>(null);
  const [newWorkflowInput, setNewWorkflowInput] = useState<string | null>(null);
  const [showTrackIO, setShowTrackIO] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchMode, setSearchMode] = useState<TaskSearchMode>('name');
  const [searchVisible, setSearchVisible] = useState(false);
  const [pipelinePickerActive, setPipelinePickerActive] = useState(false);
  const [openingPipelinePath, setOpeningPipelinePath] = useState<string | null>(null);
  const openingPipelinePathRef = useRef<string | null>(null);
  const [workflowViewActive, setWorkflowViewActive] = useState(false);
  const [workflowReturnPath, setWorkflowReturnPath] = useState<string | null>(null);
  const [workspaceWorkflows, setWorkspaceWorkflows] = useState<WorkflowYamlEntry[]>([]);
  const [selectedWorkflowPath, setSelectedWorkflowPath] = useState<string | null>(null);
  const [workflowEvents, setWorkflowEvents] = useState<WorkflowGraphEvent[]>([]);
  const [workflowRunResult, setWorkflowRunResult] = useState<WorkflowRunResult | null>(null);
  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowGraphRunId, setWorkflowGraphRunId] = useState<string | null>(null);
  const workflowRunStateRef = useRef<WorkflowRunStateSnapshot>({
    events: [],
    result: null,
    running: false,
    graphRunId: null,
  });
  const [platformExportProgress, setPlatformExportProgress] =
    useState<PlatformExportProgressState | null>(null);
  const platformExportBusy = platformExportProgress !== null;
  const clearWorkflowReturnPathForNavigation = useCallback(
    (navigation: WorkflowReturnPathNavigation) => {
      if (shouldClearWorkflowReturnPathForNavigation(navigation)) {
        setWorkflowReturnPath(null);
      }
    },
    [],
  );

  // Pending action to execute after workspace is set
  const afterWorkspaceRef = useRef<'new' | 'import' | 'save' | 'run' | null>(null);
  const workflowEventsUnsubscribeRef = useRef<(() => void) | null>(null);
  const diskAdoptRef = useRef<{ source: 'chat' | 'external'; token: number } | null>(null);
  const refreshSeqRef = useRef(0);
  const refreshWorkspaceYamls = useCallback(
    async (options: { preserveOnError?: boolean } = {}): Promise<WorkspaceYamlEntry[]> => {
      // Read from the store at call time. Workspace selection calls
      // setWorkDir() and then bootstraps in the same event turn, before React
      // has rendered a new closure with the updated workDir.
      const reqWorkDir = usePipelineStore.getState().workDir;
      if (!reqWorkDir) {
        refreshSeqRef.current += 1;
        setWorkspacePipelines({
          workspaceKey: null,
          liveEntries: [],
          stagedTargets: [],
        });
        return [];
      }
      const seq = ++refreshSeqRef.current;
      try {
        const result = await api.listWorkspaceYamls(reqWorkDir);
        if (seq !== refreshSeqRef.current) return [];
        if (usePipelineStore.getState().workDir !== reqWorkDir) return [];
        setWorkspacePipelines((current) => ({
          workspaceKey: reqWorkDir,
          liveEntries: result.entries,
          stagedTargets: current.workspaceKey === reqWorkDir ? current.stagedTargets : [],
        }));
        return result.entries;
      } catch {
        if (
          !options.preserveOnError &&
          seq === refreshSeqRef.current &&
          usePipelineStore.getState().workDir === reqWorkDir
        ) {
          setWorkspacePipelines((current) =>
            current.workspaceKey === reqWorkDir
              ? { ...current, liveEntries: [] }
              : {
                  workspaceKey: reqWorkDir,
                  liveEntries: [],
                  stagedTargets: [],
                },
          );
        }
        return [];
      }
    },
    [],
  );

  useEffect(() => {
    const workspaceKey = workDir || null;
    setWorkspacePipelines((current) =>
      current.workspaceKey === workspaceKey
        ? current
        : {
            workspaceKey,
            liveEntries: [],
            stagedTargets: [],
          },
    );
  }, [workDir]);

  useEffect(
    () => () => {
      workflowEventsUnsubscribeRef.current?.();
      workflowEventsUnsubscribeRef.current = null;
    },
    [],
  );

  useEffect(() => {
    workflowRunStateRef.current = {
      events: workflowEvents,
      result: workflowRunResult,
      running: workflowRunning,
      graphRunId: workflowGraphRunId,
    };
  }, [workflowEvents, workflowGraphRunId, workflowRunResult, workflowRunning]);

  const hasUnsavedEditorState = useCallback(
    () =>
      hasLocalEditorChanges({
        isDirty,
        layoutDirty,
        lastLocalFieldEditAt: getLastLocalFieldEditAt(),
      }),
    [isDirty, layoutDirty],
  );

  const guardUnsavedChanges = useCallback(
    (action: UnsavedAction) => {
      if (!hasUnsavedEditorState()) {
        void action.run();
        return;
      }
      setUnsavedAction(action);
    },
    [hasUnsavedEditorState],
  );

  const runUnsavedActionAfterSave = useCallback(async () => {
    const action = unsavedAction;
    if (!action) return;
    const saved = await saveFile();
    if (!saved) return;
    setUnsavedAction(null);
    await action.run();
  }, [saveFile, unsavedAction]);

  const runUnsavedActionDiscarding = useCallback(async () => {
    const action = unsavedAction;
    if (!action) return;
    setUnsavedAction(null);
    await action.run();
  }, [unsavedAction]);

  // Store errors are surfaced via <ErrorToast />, which subscribes directly
  // to `errorMessage` and handles auto-dismiss. No effect needed here.

  useEffect(() => {
    init();
    // init is a stable store action; [] would also be correct but including
    // the dep satisfies the exhaustive-deps rule without causing re-runs.
  }, [init]);

  // Kick opencode startup as soon as a workspace is in play — not when the
  // chat panel mounts. Opening/closing the chat tab now only toggles UI; the
  // spawn happens once per workspace, in the background. Re-fires on workspace
  // switch because the chat-store's bootstrap is keyed on the client workspace
  // and its internal re-entry guard coalesces concurrent callers.
  useEffect(() => {
    if (!workDir) return;
    useChatStore
      .getState()
      .bootstrap()
      .catch((err) => {
        console.error('[chat] bootstrap failed', err);
      });
  }, [workDir]);

  // Per-workspace editor settings. Loaded once per `workDir` bind so the
  // chat-conflict resolver below can consult `chatDirtyConflictPolicy`
  // without a round-trip on every `external-conflict` event. Cleared on
  // unbind so a subsequent rebind doesn't read another workspace's value.
  useEffect(() => {
    if (!workDir) {
      useEditorSettingsStore.getState().updateLocal(null);
      return;
    }
    void useEditorSettingsStore.getState().load();
  }, [workDir]);

  // M4: After the initial state load completes, check for a newer autosave
  // draft for the CURRENT yamlPath. Re-check on path switches; compare the
  // draft timestamp against the on-disk YAML mtime so we never offer to
  // restore an older draft on top of a newer saved file.
  const draftCheckKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    const draftKey = yamlPath ?? '__unsaved__';
    if (draftCheckKeyRef.current === draftKey) return;
    draftCheckKeyRef.current = draftKey;
    const draft = loadDraft(yamlPath);
    if (!draft) return;
    if (Date.now() - draft.savedAt > 7 * 24 * 3600_000) {
      clearDraft(draft.yamlPath);
      return;
    }
    if (typeof yamlMtimeMs === 'number' && draft.savedAt <= yamlMtimeMs) {
      clearDraft(draft.yamlPath);
      return;
    }
    setConfirmInfo({
      title: 'Recover unsaved draft?',
      details: [
        `An autosaved draft from ${new Date(draft.savedAt).toLocaleString()} was found for this pipeline.`,
        'Restoring overwrites the current in-memory pipeline with the draft contents.',
      ],
      confirmLabel: 'Restore',
      cancelLabel: 'Discard',
      onConfirm: () => {
        void restoreDraft(draft.config)
          .then(() => {
            clearDraft(draft.yamlPath);
          })
          .catch((err: unknown) => {
            setDialog({
              type: 'error',
              title: 'Draft Restore Failed',
              details: [err instanceof Error ? err.message : String(err)],
            });
          });
      },
      onCancel: () => {
        clearDraft(draft.yamlPath);
      },
    });
  }, [loading, yamlPath, yamlMtimeMs, restoreDraft]);

  // C1: Subscribe to external file change events and show a dialog.
  //
  // Multi-window sidecar: the EventSource URL encodes the workspace key
  // (client.ts: withWorkspaceParam). When `workDir` flips, the server now
  // dispatches this window's events from a different WorkspaceState, so we
  // must tear down and re-open the SSE connection against the new key.
  // Depending on `workDir` achieves that via the effect cleanup path.
  useEffect(() => {
    const refreshYamlList = () => {
      void refreshWorkspaceYamls();
    };
    const unsubscribe = api.subscribeStateEvents((event: ServerStateEvent) => {
      // Multi-window sidecar: the SSE stream is resubscribed whenever
      // `workDir` flips, but the effect cleanup path only runs on the next
      // React render. Events that arrive in the short window between
      // `setClientWorkspace(B)` and the new EventSource opening may still
      // belong to workspace A. Drop any payload whose embedded workDir
      // doesn't match the store so we never fire a "File reloaded" dialog
      // for a workspace this window is no longer showing.
      const currentWorkDir = usePipelineStore.getState().workDir;
      const syncYamlEditLock = (newState: ServerState) => {
        // Pass the workspace key explicitly: the lock store keys its `active`
        // flag by workspace so a lock held in another workspace stays
        // invisible here. SSE events are already filtered against
        // `currentWorkDir` upstream, so newState.workDir is the right key.
        useYamlEditLockStore
          .getState()
          .syncFromServer(newState.yamlEditLock, newState.workDir ?? null);
      };
      const applyDiskState = (newState: ServerState, source?: 'chat') => {
        const s = usePipelineStore.getState();
        s.adoptDiskState(newState, source === 'chat' ? 'chat' : undefined);
        const deferChatAutosync = source === 'chat' && useYamlEditLockStore.getState().active;
        if (!deferChatAutosync) {
          void s.autoSyncAllBindings(source === 'chat' ? 'chat' : null).catch(() => {
            /* fire() already surfaces errors via errorMessage */
          });
        }
        refreshYamlList();
      };
      const reloadAndApplyDiskState = (source: 'chat' | 'external', fileName: string) => {
        const token = Date.now();
        diskAdoptRef.current = { source, token };
        api
          .reloadFromDisk()
          .then((newState) => {
            if (!currentWorkDir) return;
            if (newState.workDir !== currentWorkDir) return;
            applyDiskState(newState, source === 'chat' ? 'chat' : undefined);
          })
          .catch(() => {
            // Agents can save transiently invalid YAML while a turn is still
            // running. Do not alarm the user for that intermediate state; the
            // post-chat reconcile compiles and reloads the finished file.
            if (
              !shouldShowReloadFailureDialog({
                source,
                chatDrivenLikely: isChatDrivenEditLikely(),
              })
            ) {
              return;
            }
            setDialog({
              type: 'error',
              title: source === 'chat' ? 'Agent reload failed' : 'External reload failed',
              details: [
                `The file "${fileName}" changed on disk, but the editor could not reload it.`,
              ],
            });
          })
          .finally(() => {
            setTimeout(() => {
              if (diskAdoptRef.current?.token === token) diskAdoptRef.current = null;
            }, 1000);
          });
      };
      const preserveLocalStateInServerMemory = () => {
        void usePipelineStore
          .getState()
          .syncLocalStateToServerMemory({ allowDuringYamlEditLock: true })
          .then((ok) => {
            if (ok) return;
            const s = usePipelineStore.getState();
            const localChangesStillNeedProtection = hasLocalEditorChanges({
              isDirty: s.isDirty,
              layoutDirty: s.layoutDirty,
              lastLocalFieldEditAt: getLastLocalFieldEditAt(),
            });
            if (diskAdoptRef.current || !localChangesStillNeedProtection) return;
            setDialog({
              type: 'error',
              title: 'Could not preserve local edits',
              details: [
                'The disk changed while the editor had unsaved changes, and the editor could not mirror your current canvas back to the server.',
                'Save manually after reviewing the conflict.',
              ],
            });
          });
      };
      if (event.type === 'external-change') {
        if (!currentWorkDir) return;
        if (event.newState?.workDir !== currentWorkDir) return;
        syncYamlEditLock(event.newState);
        // Host-owned V2 work remains isolated until commit. If this renderer
        // currently owns the YAML edit lock, wait for the authoritative
        // conflict/finalize event instead of applying an intermediate change.
        if (useYamlEditLockStore.getState().local && isChatDrivenEditLikely()) return;
        if (event.origin === 'chat-yaml-finalize') {
          refreshYamlList();
          return;
        }
        {
          const pendingAdopt = diskAdoptRef.current;
          if (pendingAdopt) {
            applyDiskState(event.newState, pendingAdopt.source === 'chat' ? 'chat' : undefined);
            return;
          }
          const s = usePipelineStore.getState();
          const chatDriven = isChatDrivenEditLikely();
          const policy =
            useEditorSettingsStore.getState().settings?.chatDirtyConflictPolicy ?? 'ask';
          const hasLocalChanges = hasLocalEditorChanges({
            isDirty: s.isDirty,
            layoutDirty: s.layoutDirty,
            lastLocalFieldEditAt: getLastLocalFieldEditAt(),
            includeRecentLocalFieldEdits: !chatDriven,
          });
          const decision = resolveDirtyDiskChange({
            source: chatDriven ? 'chat' : 'external',
            policy,
            hasLocalChanges,
          });
          const fileName =
            (event.newState.yamlPath ?? event.newState.workDir).split(/[/\\]/).pop() ??
            event.newState.yamlPath ??
            'pipeline';
          const doReload = () => {
            reloadAndApplyDiskState(chatDriven ? 'chat' : 'external', fileName);
          };

          if (decision === 'adopt-disk') {
            applyDiskState(event.newState, chatDriven ? 'chat' : undefined);
            if (!chatDriven) {
              setDialog({
                type: 'success',
                title: 'File reloaded',
                details: ['The pipeline file was changed externally and has been reloaded.'],
              });
            }
            return;
          }

          preserveLocalStateInServerMemory();
          refreshYamlList();

          if (decision === 'preserve-local') return;

          if (chatDriven) {
            setConfirmInfo({
              title: 'Agent edited the file',
              details: [
                `The assistant modified "${fileName}" while you had unsaved changes on the canvas.`,
                'Pick which version to keep. The editor has protected your current canvas while this dialog is open.',
              ],
              confirmLabel: "Use agent's changes",
              cancelLabel: 'Keep my edits',
              onConfirm: doReload,
            });
          } else {
            setConfirmInfo({
              title: 'File changed on disk',
              details: [
                `"${fileName}" was changed outside the editor while you had unsaved changes on the canvas.`,
                'Reloading discards your canvas edits. Keeping your edits means the next save will overwrite the disk version.',
              ],
              confirmLabel: 'Reload from disk',
              cancelLabel: 'Keep my edits',
              onConfirm: doReload,
            });
          }
          return;
        }
      } else if (event.type === 'external-conflict') {
        if (event.deferredByYamlEditLock) return;
        // Two paths share the same reload primitive:
        //   1. Chat-driven conflict — the user just told the agent to edit
        //      this file. Resolution follows `chatDirtyConflictPolicy`:
        //        - 'prefer-agent': silent adopt. Canvas edits discarded.
        //        - 'prefer-user' : keep canvas; next save overwrites disk.
        //        - 'ask'          (default): prompt per-incident.
        //   2. Non-chat-driven conflict — git pull, another editor, etc.
        //      changed the file while the canvas was dirty. Always prompt
        //      with the same two-choice modal so the user has an actual
        //      reload button (the previous error dialog had only OK).
        //
        // Reload MUST go through `api.reloadFromDisk()` (POST /api/state/reload)
        // rather than `api.getState()` — the file-watcher's conflict branch
        // deliberately does NOT re-parse the YAML, so getState() would return
        // the server's stale pre-conflict memory. The POST endpoint
        // re-reads YAML + layout off disk and hands back the reconciled
        // state so "adopt" actually reflects what's on disk.
        const chatDriven = isChatDrivenEditLikely();
        const doReload = () => {
          reloadAndApplyDiskState(chatDriven ? 'chat' : 'external', fileName);
        };
        const fileName = event.path.split(/[/\\]/).pop() ?? event.path;
        if (chatDriven) {
          const policy =
            useEditorSettingsStore.getState().settings?.chatDirtyConflictPolicy ?? 'ask';
          if (policy === 'prefer-agent') {
            doReload();
          } else if (policy === 'prefer-user') {
            // Preserve the dirty canvas. Still refresh the sidebar so
            // renames / new sibling files show up even though we're not
            // adopting this file's disk version.
            preserveLocalStateInServerMemory();
            refreshYamlList();
          } else {
            // 'ask' — let the user pick per-incident. The message is framed
            // around which edits to keep, not which to discard, so the two
            // options read symmetrically (each choice destroys the other
            // side's work). The sidebar still refreshes either way.
            preserveLocalStateInServerMemory();
            refreshYamlList();
            setConfirmInfo({
              title: 'Agent edited the file',
              details: [
                `The assistant modified "${fileName}" while you had unsaved changes on the canvas.`,
                'Pick which version to keep — the other side will be discarded.',
                'Tip: set a permanent default in Editor Settings → Chat.',
              ],
              confirmLabel: "Use agent's changes",
              cancelLabel: 'Keep my edits',
              onConfirm: doReload,
              // onCancel defaults to a no-op: the dirty canvas stays, the
              // next save overwrites the agent's disk version.
            });
          }
          return;
        }
        // Non-chat-driven: refresh sidebar so renames / new sibling files
        // show up, then prompt with a real reload button instead of the
        // dead-end OK dialog that left users stuck.
        preserveLocalStateInServerMemory();
        refreshYamlList();
        setConfirmInfo({
          title: 'File changed on disk',
          details: [
            `"${fileName}" was changed outside the editor while you had unsaved changes on the canvas.`,
            'Reloading discards your canvas edits. Keeping your edits means the next save will overwrite the disk version.',
          ],
          confirmLabel: 'Reload from disk',
          cancelLabel: 'Keep my edits',
          onConfirm: doReload,
        });
      } else if (event.type === 'state_sync') {
        // If the local workspace was cleared (e.g. PipelinePicker → Switch
        // Workspace), drop in-flight state_sync events for the prior
        // workspace — otherwise the server's stale workDir would re-hydrate
        // and immediately push the user into the editor.
        if (!currentWorkDir) return;
        if (event.newState?.workDir !== currentWorkDir) return;
        syncYamlEditLock(event.newState);
        // B5: Server sends full state on SSE (re)connect. This is a
        // reconnection catch-up, not a user-initiated reload, so it must
        // never clobber unsaved work AND must not re-run init().
        //
        // Why not init(): init() does `setClientWorkspace(null)` then reads
        // the URL's `?ws=` pin. In the Welcome → "Open Workspace..." flow
        // there is no pin, so init() falls through to the welcome branch and
        // writes workDir='' / yamlPath=null into the store. That races with
        // bootstrapAfterWorkspace()'s follow-up `openFile(firstYaml)` call:
        // by the time openFile fires, the client-side workspaceKey is null
        // again, the X-Tagma-Workspace header is dropped, and the server
        // returns 400 "No workspace bound to this request". Adopt the
        // server's state directly instead.
        //
        // P1-H1: still only adopt when local state is CLEAN — never clobber
        // unsaved work.
        const s = usePipelineStore.getState();
        if (!s.isDirty && !s.layoutDirty && s.past.length === 0 && s.future.length === 0) {
          s.applyState(event.newState);
        }
      }
    });
    return unsubscribe;
  }, [refreshWorkspaceYamls, workDir]);

  // C2: Warn on browser close when there are unsaved changes.
  // Skip under Electron — preventDefault on beforeunload silently cancels
  // window close there (no confirmation dialog), so the X button stops working
  // whenever the doc is dirty. The custom title-bar X handles its own confirm.
  useEffect(() => {
    if (hasDesktopBridge()) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const refreshWorkflowYamls = useCallback(async (): Promise<WorkflowYamlEntry[]> => {
    const reqWorkDir = usePipelineStore.getState().workDir;
    if (!reqWorkDir) {
      setWorkspaceWorkflows([]);
      setSelectedWorkflowPath(null);
      return [];
    }
    try {
      const result = await api.listWorkflowYamls();
      if (usePipelineStore.getState().workDir !== reqWorkDir) return [];
      setWorkspaceWorkflows(result.entries);
      setSelectedWorkflowPath((current) => {
        if (current && result.entries.some((entry) => entry.path === current)) return current;
        return result.entries[0]?.path ?? null;
      });
      return result.entries;
    } catch {
      if (usePipelineStore.getState().workDir === reqWorkDir) {
        setWorkspaceWorkflows([]);
        setSelectedWorkflowPath(null);
      }
      return [];
    }
  }, []);

  // Refresh the list of YAML files under {workDir}/.tagma whenever the
  // workspace or current file changes (covers save/new/import side-effects).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const yamls = await refreshWorkspaceYamls();
      if (cancelled) {
        // no-op: cancellation guard for unmounted effect
        void yamls;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspaceYamls, workDir, yamlPath]);

  useEffect(() => {
    void refreshWorkflowYamls();
  }, [refreshWorkflowYamls, workDir]);

  // Re-sync on visibility-restore. Even with `backgroundThrottling: false`
  // on the Electron BrowserWindow, OS-level minimize can still suspend the
  // process briefly, and Windows `fs.watch` is documented to drop
  // cross-process notifications outright (see file-watcher.ts). Re-list
  // yamls and force a clean disk re-read on
  // every visible-transition so the canvas and sidebar catch up.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const live = usePipelineStore.getState();
      if (!live.workDir) return;
      if (useYamlEditLockStore.getState().active) return;
      void refreshWorkspaceYamls();
      if (!live.yamlPath) return;
      if (live.isDirty || live.layoutDirty) return;
      if (useChatStore.getState().sending) return;
      api
        .reloadFromDisk()
        .then((newState) => {
          const after = usePipelineStore.getState();
          if (newState.workDir !== after.workDir) return;
          if (after.isDirty || after.layoutDirty) return;
          after.adoptDiskState(newState);
        })
        .catch(() => {
          /* transient — next file change or focus will retry */
        });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [refreshWorkspaceYamls]);

  const handleOpenWorkspaceFile = useCallback(
    (path: string) => {
      guardUnsavedChanges({
        title: 'Open YAML?',
        details: [
          'The current pipeline has unsaved changes.',
          'Save or discard those changes before opening another YAML.',
        ],
        run: () => {
          clearWorkflowReturnPathForNavigation('open-workspace-file');
          return openFile(path);
        },
      });
    },
    [clearWorkflowReturnPathForNavigation, openFile, guardUnsavedChanges],
  );

  const handleDeleteWorkspaceFile = useCallback(
    (path: string) => {
      if (yamlEditLocked) return;
      const name = path.split(/[/\\]/).pop() ?? path;
      const wasActive = yamlPath === path;
      const showDeleteConfirm = () =>
        setConfirmInfo({
          title: 'Remove Pipeline',
          details: [
            `Remove "${name}" and its companion .layout.json, .compile.log, and .requirements.md?`,
            'Run history under .tagma/logs/ is preserved.',
            'This cannot be undone.',
          ],
          confirmLabel: 'Remove',
          danger: true,
          onConfirm: async () => {
            const nextPath = wasActive
              ? (workspaceYamls.find((y) => y.path !== path)?.path ?? null)
              : null;

            try {
              await api.deleteFile(path);
            } catch (e: unknown) {
              setDialog({
                type: 'error',
                title: 'Remove Failed',
                details: [(e instanceof Error ? e.message : null) ?? 'Unknown error'],
              });
              return;
            }

            if (wasActive) {
              clearWorkflowReturnPathForNavigation('delete-active-pipeline');
              if (nextPath) {
                await openFile(nextPath);
              } else {
                await newPipeline();
              }
            } else {
              const remaining = await refreshWorkspaceYamls();
              // If the picker is the visible view and we just deleted the
              // last entry, drop into a blank new pipeline so the picker is
              // never shown empty (matches Q1=B in the design spec).
              if (pipelinePickerActive && remaining.length === 0) {
                setPipelinePickerActive(false);
                clearWorkflowReturnPathForNavigation('delete-picker-last-pipeline');
                await newPipeline();
              }
            }
          },
        });
      if (wasActive) {
        guardUnsavedChanges({
          title: 'Remove current YAML?',
          details: [
            'The current pipeline has unsaved changes.',
            'Save or discard those changes before removing this YAML.',
          ],
          run: showDeleteConfirm,
        });
        return;
      }
      showDeleteConfirm();
    },
    [
      yamlEditLocked,
      yamlPath,
      workspaceYamls,
      clearWorkflowReturnPathForNavigation,
      openFile,
      newPipeline,
      refreshWorkspaceYamls,
      guardUnsavedChanges,
      pipelinePickerActive,
    ],
  );

  // Helper: ensure workspace is set before proceeding
  const requireWorkspace = useCallback(
    (then: 'new' | 'import' | 'save' | 'run'): boolean => {
      if (workDir) return true;
      afterWorkspaceRef.current = then;
      setExplorer({ mode: 'directory', purpose: 'workdir' });
      return false;
    },
    [workDir],
  );

  // Save: workspace required, server auto-creates path in .tagma if needed
  const handleSave = useCallback(async () => {
    if (yamlEditLocked) return;
    if (!requireWorkspace('save')) return;
    await saveFile();
  }, [yamlEditLocked, requireWorkspace, saveFile]);

  // Ctrl+S — editor only. We block it in Run mode so a keystroke can't
  // accidentally kick off a pipeline-store save that would write over
  // the YAML file the engine is currently reading (§4.4).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (runActive) return;
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, runActive]);

  // Attribute each validation diagnostic to its root cause (track or task),
  // preserving the severity so downstream UI can distinguish errors from warnings.
  const { errorsByTask, errorsByTrack } = useMemo(() => {
    const byTask = new Map<string, DiagnosticItem[]>();
    const byTrack = new Map<string, DiagnosticItem[]>();

    for (const err of validationErrors) {
      const trackMatch = err.path.match(/tracks\[(\d+)\]/);
      if (!trackMatch) continue;
      const track = config.tracks[parseInt(trackMatch[1])];
      if (!track) continue;

      const item: DiagnosticItem = { message: err.message, severity: err.severity ?? 'error' };
      const taskMatch = err.path.match(/tasks\[(\d+)\]/);
      if (taskMatch) {
        const task = track.tasks[parseInt(taskMatch[1])];
        if (task) {
          const qid = `${track.id}.${task.id}`;
          const list = byTask.get(qid) ?? [];
          list.push(item);
          byTask.set(qid, list);
        }
      } else {
        const list = byTrack.get(track.id) ?? [];
        list.push(item);
        byTrack.set(track.id, list);
      }
    }

    return { errorsByTask: byTask, errorsByTrack: byTrack };
  }, [validationErrors, config]);

  // Pipeline-level (top-level) diagnostics: anything whose path does not start with "tracks[".
  const pipelineLevelErrors: DiagnosticItem[] = useMemo(
    () =>
      validationErrors
        .filter((e) => !/^tracks\[/.test(e.path))
        .map((e) => ({
          message: e.message,
          severity: (e.severity ?? 'error') as 'error' | 'warning',
        })),
    [validationErrors],
  );

  // H8: only "real" errors (severity !== 'warning') should block Save / Run.
  // The continue_from-in-depends_on hint is the canonical example — runtime
  // happily inserts the implicit edge, so the editor shouldn't refuse to run.
  const blockingValidationErrors = useMemo(
    () => validationErrors.filter((e) => e.severity !== 'warning'),
    [validationErrors],
  );

  // Only tasks with at least one blocking error are "invalid"; warning-only
  // tasks render with a softer visual treatment instead of the error style.
  const invalidTaskIds = useMemo(
    () =>
      new Set(
        [...errorsByTask.entries()]
          .filter(([, items]) => items.some((d) => d.severity === 'error'))
          .map(([qid]) => qid),
      ),
    [errorsByTask],
  );

  const sidebarTaskId = pinnedTaskId ?? selectedTaskId;

  const selectedInfo = useMemo(() => {
    if (!sidebarTaskId) return null;
    const [trackId, taskId] = sidebarTaskId.split('.');
    const track = config.tracks.find((t) => t.id === trackId);
    const task = track?.tasks.find((t) => t.id === taskId);
    if (!track || !task) return null;
    return { track, task, trackId, taskId };
  }, [sidebarTaskId, config]);

  const sidebarTrackId = pinnedTrackId ?? selectedTrackId;

  const selectedTrack = useMemo(() => {
    if (!sidebarTrackId) return null;
    return config.tracks.find((t) => t.id === sidebarTrackId) ?? null;
  }, [sidebarTrackId, config]);

  const taskInspectorVisible = !!(!pinnedTrackId && selectedInfo);
  const trackInspectorVisible = !!(!pinnedTaskId && selectedTrack);
  const inspectorTarget = resolveInspectorTarget({
    pipelineSelected: pipelineInspectorSelected,
    pipelinePinned: pipelineInspectorPinned,
    hasTaskSelection: taskInspectorVisible,
    hasTrackSelection: trackInspectorVisible,
  });

  // Right-side dock (multi-tab + optional detached column). Inspector auto-
  // hides when nothing is selectable, so we gate the tab on that condition.
  const inspectorAvailable = inspectorTarget !== 'empty';
  const rightDock = useRightDock();
  const { openTab: openRightDockTab } = rightDock;
  const pendingChatOpenRequest = useChatStore((s) => s.pendingChatOpenRequest);

  useEffect(() => {
    if (!pendingChatOpenRequest) return;
    minimizeRun();
    openRightDockTab('chat');
    useChatStore.getState().acknowledgeChatOpenRequest();
  }, [pendingChatOpenRequest, minimizeRun, openRightDockTab]);

  // Auto-open the chat tab when a pipeline-open transitions us into the
  // editor. Ref is seeded from the current yamlPath so a plain app refresh
  // (yamlPath already populated at mount) doesn't trigger; only a real
  // transition — null → path, or path A → path B — counts as "the user just
  // opened a pipeline".
  const prevYamlPathForChatRef = useRef<string | null>(yamlPath);
  useEffect(() => {
    if (yamlPath && yamlPath !== prevYamlPathForChatRef.current) {
      openRightDockTab('chat');
    }
    prevYamlPathForChatRef.current = yamlPath;
  }, [yamlPath, openRightDockTab]);

  const handleSelectPipeline = useCallback(() => {
    setPipelineInspectorSelected(true);
    selectTask(null);
    selectTrack(null);
    if (pinnedTaskId) unpinTask();
    if (pinnedTrackId) unpinTrack();
    rightDock.openTab('inspector');
  }, [pinnedTaskId, pinnedTrackId, rightDock, selectTask, selectTrack, unpinTask, unpinTrack]);

  const handleSelectTask = useCallback(
    (qualifiedId: string | null) => {
      setPipelineInspectorSelected(false);
      selectTask(qualifiedId);
    },
    [selectTask],
  );

  const closeTaskSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
  }, []);

  const handleSelectSearchMatch = useCallback(
    (match: TaskSearchMatch) => {
      handleSelectTask(match.qid);
      closeTaskSearch();
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: match.qid }));
      });
    },
    [closeTaskSearch, handleSelectTask],
  );

  const handleToggleTaskSelection = useCallback(
    (qualifiedId: string) => {
      setPipelineInspectorSelected(false);
      toggleTaskSelection(qualifiedId);
    },
    [toggleTaskSelection],
  );

  const handleSelectTrack = useCallback(
    (trackId: string | null) => {
      setPipelineInspectorSelected(false);
      selectTrack(trackId);
    },
    [selectTrack],
  );

  // Fresh selection → always surface the inspector. openTab is a no-op when
  // inspector is already the detached column (preserves the user's side-by-
  // side layout); otherwise it attaches + activates, so clicking a task/track
  // always reveals its details regardless of current dock state.
  const lastSidebarSelRef = useRef<string | null>(null);
  const suppressNextInspectorOpenRef = useRef(false);
  const handleYamlSelectTask = useCallback(
    (qualifiedId: string) => {
      setPipelineInspectorSelected(false);
      suppressNextInspectorOpenRef.current = true;
      selectTask(qualifiedId);
    },
    [selectTask],
  );
  const handleYamlSelectTrack = useCallback(
    (trackId: string) => {
      setPipelineInspectorSelected(false);
      suppressNextInspectorOpenRef.current = true;
      selectTrack(trackId);
    },
    [selectTrack],
  );
  useEffect(() => {
    const sel =
      pipelineInspectorSelected || pipelineInspectorPinned
        ? 'pipeline'
        : (sidebarTaskId ?? sidebarTrackId ?? null);
    if (!sel) {
      lastSidebarSelRef.current = null;
      return;
    }
    if (sel === lastSidebarSelRef.current) return;
    lastSidebarSelRef.current = sel;
    if (suppressNextInspectorOpenRef.current) {
      suppressNextInspectorOpenRef.current = false;
      return;
    }
    rightDock.openTab('inspector');
  }, [
    pipelineInspectorPinned,
    pipelineInspectorSelected,
    sidebarTaskId,
    sidebarTrackId,
    rightDock,
  ]);

  // Closing the inspector clears any active pin, so re-opening lands on the
  // live selection instead of the sticky pinned item. We also sync
  // lastSidebarSelRef to the now-exposed selection so the auto-open effect
  // above doesn't immediately re-surface the inspector.
  const inspectorVisible = rightDock.isTabVisible('inspector');
  const prevInspectorVisibleRef = useRef(inspectorVisible);
  useEffect(() => {
    if (prevInspectorVisibleRef.current && !inspectorVisible) {
      if (pipelineInspectorSelected) setPipelineInspectorSelected(false);
      if (pipelineInspectorPinned) setPipelineInspectorPinned(false);
      if (pinnedTaskId) unpinTask();
      if (pinnedTrackId) unpinTrack();
      if (pipelineInspectorPinned || pinnedTaskId || pinnedTrackId) {
        lastSidebarSelRef.current = selectedTaskId ?? selectedTrackId ?? null;
      }
    }
    prevInspectorVisibleRef.current = inspectorVisible;
  }, [
    inspectorVisible,
    pipelineInspectorPinned,
    pipelineInspectorSelected,
    pinnedTaskId,
    pinnedTrackId,
    selectedTaskId,
    selectedTrackId,
    unpinTask,
    unpinTrack,
  ]);

  const [pendingRun, setPendingRun] = useState(false);
  const runSaveController = useMemo(() => createRunSaveController(), []);

  useEffect(() => () => runSaveController.cancel(), [runSaveController]);

  const handleRun = useCallback(async () => {
    if (!requireWorkspace('run')) return;
    await flushPendingLocalEdits();
    const latest = usePipelineStore.getState();
    const latestBlockingValidationErrors = latest.validationErrors.filter(
      (e) => e.severity !== 'warning',
    );
    if (latestBlockingValidationErrors.length > 0) {
      setDialog({
        type: 'error',
        title: `Cannot run: ${latestBlockingValidationErrors.length} validation error(s)`,
        details: latestBlockingValidationErrors.map((e) => `[${e.path}] ${e.message}`),
      });
      return;
    }
    if (!latest.yamlPath || (latest.isDirty && !yamlEditLocked)) {
      await runSaveController.request({
        needsSave: true,
        save: saveFile,
        run: () => {
          const savedLatest = usePipelineStore.getState();
          const savedBlockingErrors = savedLatest.validationErrors.filter(
            (e) => e.severity !== 'warning',
          );
          if (savedBlockingErrors.length > 0) {
            setDialog({
              type: 'error',
              title: 'Cannot run: ' + savedBlockingErrors.length + ' validation error(s)',
              details: savedBlockingErrors.map((e) => '[' + e.path + '] ' + e.message),
            });
            return;
          }
          if (!savedLatest.yamlPath) return;
          resetYamlPreviewBaseline(savedLatest.config);
          startRun(
            savedLatest.config,
            savedLatest.selectedTaskIds.length > 0
              ? {
                  yamlPath: savedLatest.yamlPath,
                  targetTaskIds: [...savedLatest.selectedTaskIds],
                }
              : { yamlPath: savedLatest.yamlPath },
          );
        },
      });
      return;
    }
    resetYamlPreviewBaseline(latest.config);
    startRun(
      latest.config,
      latest.selectedTaskIds.length > 0
        ? { yamlPath: latest.yamlPath, targetTaskIds: [...latest.selectedTaskIds] }
        : { yamlPath: latest.yamlPath },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    requireWorkspace,
    yamlEditLocked,
    yamlPath,
    validationErrors,
    isDirty,
    flushPendingLocalEdits,
    saveFile,
    config,
    selectedTaskIds,
    resetYamlPreviewBaseline,
    startRun,
    runSaveController,
  ]);

  // After save completes and yamlPath is set, auto-trigger run
  useEffect(() => {
    if (pendingRun && yamlPath) {
      setPendingRun(false);
      handleRun();
    }
  }, [pendingRun, yamlPath, handleRun]);

  // Post-workspace bootstrap shared between the file-explorer "Select Workspace"
  // flow and the welcome page's "Open Recent" shortcut. Honors any pending
  // afterWorkspaceRef intent the user queued up before picking a workspace.
  const bootstrapAfterWorkspace = useCallback(async (): Promise<void> => {
    const pending = afterWorkspaceRef.current;
    afterWorkspaceRef.current = null;
    if (pending === 'import') {
      setExplorer({ mode: 'open', purpose: 'import' });
      return;
    }
    setExplorer(null);
    if (pending === 'new') {
      await newPipeline();
      return;
    }
    if (pending === 'save') {
      await saveFile();
      return;
    }
    if (pending === 'run') {
      const saved = await saveFile();
      if (saved) setPendingRun(true);
      else runSaveController.cancel();
      return;
    }
    // Default: show the pipeline picker when the workspace already has one
    // or more pipelines, otherwise drop straight into a blank new pipeline.
    // Empty workspaces never show an empty picker (Q1=B in design spec).
    //
    // Route through refreshWorkspaceYamls so the picker's first paint
    // already sees the correct list — direct api.listWorkspaceYamls()
    // here would skip the workspaceYamls state write and the picker would
    // briefly render against the prior workspace's cached entries until
    // the SSE/effect-driven refresh catches up.
    const bootWorkDir = usePipelineStore.getState().workDir;
    const entries = await refreshWorkspaceYamls();
    if (!bootWorkDir || usePipelineStore.getState().workDir !== bootWorkDir) return;
    if (entries.length > 0) {
      setPipelinePickerActive(true);
    } else {
      await newPipeline();
    }
  }, [newPipeline, saveFile, refreshWorkspaceYamls, runSaveController]);

  // Pinned-workspace bootstrap (URL `?ws=` or Electron "New Window →
  // <workspace>"). The store binds the workspace inside `init()` but no
  // longer auto-opens the first YAML — that decision lives in
  // bootstrapAfterWorkspace, the single source of truth for the
  // picker/blank-pipeline branch. Fire it once after init completes.
  const pinnedBootstrapDoneRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (pinnedBootstrapDoneRef.current) return;
    pinnedBootstrapDoneRef.current = true;
    if (!workDir || yamlPath) return;
    void bootstrapAfterWorkspace();
  }, [loading, workDir, yamlPath, bootstrapAfterWorkspace]);

  const handleOpenRecentWorkspace = useCallback(
    async (path: string) => {
      try {
        const switched = await setWorkDir(path);
        if (!switched) return;
        clearWorkflowReturnPathForNavigation('open-recent-workspace');
      } catch (e: unknown) {
        setDialog({
          type: 'error',
          title: 'Failed to open workspace',
          details: [(e instanceof Error ? e.message : null) ?? 'Unknown error'],
        });
        return;
      }
      await bootstrapAfterWorkspace();
    },
    [setWorkDir, bootstrapAfterWorkspace, clearWorkflowReturnPathForNavigation],
  );

  const handlePickerSelect = useCallback(
    (path: string) => {
      void openPipelineFromPicker({
        path,
        pendingPathRef: openingPipelinePathRef,
        setPendingPath: setOpeningPipelinePath,
        clearError: () => usePipelineStore.getState().clearError(),
        clearWorkflowReturnPath: () => clearWorkflowReturnPathForNavigation('picker-select'),
        openFile,
        readPipelineState: () => usePipelineStore.getState(),
        closePicker: () => setPipelinePickerActive(false),
      });
    },
    [openFile, clearWorkflowReturnPathForNavigation],
  );

  const handlePickerCreateNew = useCallback(async () => {
    if (openingPipelinePathRef.current !== null) return;
    // Same caveat as handlePickerSelect: newPipeline() swallows errors into
    // errorMessage. Stay on the picker if the create failed.
    const errBefore = usePipelineStore.getState().errorMessage;
    clearWorkflowReturnPathForNavigation('picker-create-new');
    await newPipeline();
    if (usePipelineStore.getState().errorMessage === errBefore) {
      setPipelinePickerActive(false);
    }
  }, [newPipeline, clearWorkflowReturnPathForNavigation]);

  const handlePickerSwitchWorkspace = useCallback(() => {
    if (openingPipelinePathRef.current !== null) return;
    clearWorkflowReturnPathForNavigation('picker-switch-workspace');
    setPipelinePickerActive(false);
    clearWorkspace();
  }, [clearWorkspace, clearWorkflowReturnPathForNavigation]);

  const handleExplorerConfirm = useCallback(
    async (path: string, capabilityToken?: string | null) => {
      if (!explorer) return;
      if (explorer.purpose === 'workdir') {
        const switched = await setWorkDir(path);
        if (!switched) return;
        clearWorkflowReturnPathForNavigation('explorer-workdir');
        await bootstrapAfterWorkspace();
      } else if (explorer.purpose === 'import') {
        setExplorer(null);
        guardUnsavedChanges({
          title: 'Import pipeline?',
          details: [
            'The current pipeline has unsaved changes.',
            'Save or discard those changes before importing another pipeline.',
          ],
          run: () => {
            clearWorkflowReturnPathForNavigation('import-file');
            return importFile(path, capabilityToken ?? '');
          },
        });
      } else if (explorer.purpose === 'export') {
        const destPath = await exportFile(path, capabilityToken ?? '');
        setExplorer(null);
        if (destPath) {
          setDialog({
            type: 'success',
            title: 'Export Successful',
            details: [`Exported to: ${destPath}`],
          });
        }
      } else if (explorer.purpose === 'export-platform') {
        const targetPlatform = explorer.targetPlatform;
        const targetLabel = PLATFORM_EXPORT_LABELS[targetPlatform];
        setExplorer(null);
        setPlatformExportProgress({
          targetPlatform,
          stage: 'preparing',
          detail: 'Waiting for export to start',
          messages: ['Preparing - Waiting for export to start'],
        });
        const onProgress = (event: PlatformExportProgressEvent) => {
          const detail = event.detail ?? PLATFORM_EXPORT_STAGE_LABELS[event.stage];
          const message = `${PLATFORM_EXPORT_STAGE_LABELS[event.stage]} - ${detail}`;
          setPlatformExportProgress((prev) => {
            const previousMessages = prev?.messages ?? [];
            const messages =
              previousMessages[previousMessages.length - 1] === message
                ? previousMessages
                : [...previousMessages, message].slice(-5);
            return {
              targetPlatform,
              stage: event.stage,
              detail,
              messages,
            };
          });
        };
        let destPath: string | null = null;
        try {
          destPath = await exportPlatformFile(
            path,
            targetPlatform,
            useChatStore.getState().model,
            onProgress,
            capabilityToken ?? '',
          );
        } finally {
          setPlatformExportProgress(null);
        }
        if (destPath) {
          setDialog({
            type: 'success',
            title: `Exported for ${targetLabel}`,
            details: [`Exported to: ${destPath}`],
          });
        }
      } else if (explorer.purpose === 'plugin-import') {
        setExplorer(null);
        showPluginsPage();
        try {
          const result = await api.importLocalPlugin(path, {
            declareInPipeline: !yamlEditLocked,
            capabilityToken: capabilityToken ?? undefined,
          });
          setRegistry(result.registry);
          const name = result.plugin.name;
          if (result.declaredPluginAdded) {
            await refreshServerState();
            usePipelineStore.setState({ isDirty: true });
          }
          setDialog({
            type: 'success',
            title: 'Plugin Imported',
            details: [
              `${name} v${result.plugin.version ?? '?'}`,
              ...(result.warning ? [result.warning] : []),
            ],
          });
        } catch (e: unknown) {
          setDialog({
            type: 'error',
            title: 'Import Failed',
            details: [(e instanceof Error ? e.message : null) ?? 'Unknown error'],
          });
        }
      }
    },
    [
      explorer,
      setWorkDir,
      importFile,
      exportFile,
      exportPlatformFile,
      bootstrapAfterWorkspace,
      setRegistry,
      refreshServerState,
      showPluginsPage,
      guardUnsavedChanges,
      clearWorkflowReturnPathForNavigation,
      yamlEditLocked,
    ],
  );

  // Batch import: copy each picked YAML into `.tagma/`. The server's
  // `/api/import-file` is one-at-a-time — calling it sequentially is fine
  // because each call (a) copies the file under the workspace and (b) sets
  // `S.config` to it, so the LAST file in `paths` ends up as the active
  // pipeline. That matches user intuition (the most recently clicked file is
  // the one they want open). Earlier files remain in `.tagma/` and show up in
  // the history list, ready to be opened.
  const handleExplorerConfirmMany = useCallback(
    async (paths: string[], capabilityTokens: Record<string, string> = {}) => {
      if (!explorer || paths.length === 0) return;
      if (paths.length === 1) {
        setExplorer(null);
        guardUnsavedChanges({
          title: 'Import pipeline?',
          details: [
            'The current pipeline has unsaved changes.',
            'Save or discard those changes before importing another pipeline.',
          ],
          run: () => {
            clearWorkflowReturnPathForNavigation('import-file');
            return importFile(paths[0], capabilityTokens[paths[0]] ?? '');
          },
        });
        return;
      }
      setExplorer(null);
      guardUnsavedChanges({
        title: 'Import pipelines?',
        details: [
          'The current pipeline has unsaved changes.',
          'Save or discard those changes before importing other pipelines.',
        ],
        run: async () => {
          clearWorkflowReturnPathForNavigation('import-many');
          const failures: { path: string; error: string }[] = [];
          for (const p of paths) {
            try {
              await importFile(p, capabilityTokens[p] ?? '');
            } catch (e: unknown) {
              failures.push({
                path: p,
                error: (e instanceof Error ? e.message : null) ?? 'Unknown error',
              });
            }
          }
          const succeeded = paths.length - failures.length;
          if (failures.length === 0) {
            setDialog({
              type: 'success',
              title: 'Pipelines Imported',
              details: [
                `Imported ${succeeded} pipelines into the workspace.`,
                `Now editing: ${paths[paths.length - 1].split(/[\\/]/).pop() ?? paths[paths.length - 1]}`,
              ],
            });
          } else {
            setDialog({
              type: 'error',
              title: 'Import Partially Failed',
              details: [
                `${succeeded} of ${paths.length} pipelines imported.`,
                ...failures.map((f) => `Failed: ${f.path} — ${f.error}`),
              ],
            });
          }
        },
      });
    },
    [explorer, importFile, guardUnsavedChanges, clearWorkflowReturnPathForNavigation],
  );

  const handleNewPipeline = useCallback(() => {
    if (!requireWorkspace('new')) return;
    guardUnsavedChanges({
      title: 'Create new pipeline?',
      details: [
        'The current pipeline has unsaved changes.',
        'Save or discard those changes before creating a new pipeline.',
      ],
      run: () => {
        clearWorkflowReturnPathForNavigation('new-pipeline');
        return newPipeline();
      },
    });
  }, [requireWorkspace, newPipeline, guardUnsavedChanges, clearWorkflowReturnPathForNavigation]);

  const handleImport = useCallback(() => {
    if (!requireWorkspace('import')) return;
    setExplorer({ mode: 'open', purpose: 'import' });
  }, [requireWorkspace]);

  const handleExport = useCallback(() => {
    if (yamlEditLocked) return;
    if (!yamlPath) return;
    setExplorer({ mode: 'directory', purpose: 'export' });
  }, [yamlEditLocked, yamlPath]);

  const handlePlatformExport = useCallback(
    (targetPlatform: PlatformExportTarget) => {
      if (yamlEditLocked) return;
      if (!yamlPath) return;
      if (platformExportBusy) return;
      setExplorer({ mode: 'directory', purpose: 'export-platform', targetPlatform });
    },
    [platformExportBusy, yamlEditLocked, yamlPath],
  );

  // U10: Save As... target file name. Server writes into {workDir}/.tagma/.
  const handleSaveAs = useCallback(() => {
    if (yamlEditLocked) return;
    if (!requireWorkspace('save')) return;
    const currentName = yamlPath ? (yamlPath.split(/[/\\]/).pop() ?? '') : 'pipeline.yaml';
    setSaveAsInput(currentName);
  }, [yamlEditLocked, requireWorkspace, yamlPath]);

  const refreshWorkflowRunStatus = useCallback(async () => {
    const current = workflowRunStateRef.current;
    if (!current.running && !current.graphRunId) return;
    try {
      const snapshot = await api.getWorkflowRunStatus(current.graphRunId ?? undefined);
      const next = reconcileWorkflowRunState(current, snapshot);
      setWorkflowEvents(next.events);
      setWorkflowRunResult(next.result);
      setWorkflowRunning(next.running);
      setWorkflowGraphRunId(next.graphRunId);
      workflowRunStateRef.current = next;
      if (!next.running) {
        workflowEventsUnsubscribeRef.current?.();
        workflowEventsUnsubscribeRef.current = null;
      }
    } catch {
      /* A transient status miss should not block returning to the graph. */
    }
  }, []);

  const handleShowWorkflows = useCallback(() => {
    if (!workDir) return;
    setWorkflowViewActive(true);
    void refreshWorkflowYamls();
    void refreshWorkflowRunStatus();
  }, [refreshWorkflowRunStatus, refreshWorkflowYamls, workDir]);

  const handleWorkflowStart = useCallback(
    async (path: string) => {
      setWorkflowRunning(true);
      setWorkflowGraphRunId(null);
      setWorkflowEvents([]);
      setWorkflowRunResult(null);
      workflowEventsUnsubscribeRef.current?.();
      workflowEventsUnsubscribeRef.current = null;
      try {
        const response = await api.startWorkflowRun(path);
        const graphRunId = response.graphRunId ?? response.result?.graphRunId ?? null;
        setWorkflowGraphRunId(graphRunId);
        setWorkflowEvents(response.events.reduce<WorkflowGraphEvent[]>(appendWorkflowEvent, []));
        setWorkflowRunResult(response.result);
        if (graphRunId) {
          setWorkflowViewActive(false);
          setPipelinePickerActive(false);
          showRunHistory(graphRunId);
        }
        if (!response.running) {
          setWorkflowRunning(false);
          return;
        }
        workflowEventsUnsubscribeRef.current = api.subscribeWorkflowEvents((event) => {
          if (graphRunId && event.graphRunId !== graphRunId) return;
          setWorkflowEvents((prev) => appendWorkflowEvent(prev, event));
          if (!isWorkflowTerminalEvent(event)) return;
          const result = workflowResultFromGraphEnd(event);
          if (result) {
            setWorkflowRunResult(result);
          }
          setWorkflowRunning(false);
          setWorkflowGraphRunId(null);
          workflowEventsUnsubscribeRef.current?.();
          workflowEventsUnsubscribeRef.current = null;
        });
      } catch (err: unknown) {
        setDialog({
          type: 'error',
          title: 'Workflow run failed',
          details: [err instanceof Error ? err.message : String(err)],
        });
        setWorkflowRunning(false);
      }
    },
    [showRunHistory],
  );

  const handleWorkflowAbort = useCallback(async () => {
    if (!workflowRunning) return;
    try {
      await api.abortWorkflowRun(workflowGraphRunId ?? undefined);
    } catch (err: unknown) {
      if (isMissingWorkflowRunError(err)) {
        await refreshWorkflowRunStatus();
        return;
      }
      setDialog({
        type: 'error',
        title: 'Abort workflow failed',
        details: [err instanceof Error ? err.message : String(err)],
      });
    }
  }, [refreshWorkflowRunStatus, workflowGraphRunId, workflowRunning]);

  const activeYamlName = useMemo(
    () => (yamlPath ? (yamlPath.split(/[/\\]/).pop() ?? null) : null),
    [yamlPath],
  );

  const handleNewWorkflow = useCallback(() => {
    if (!workDir) {
      setExplorer({ mode: 'directory', purpose: 'workdir' });
      return;
    }
    const base = activeYamlName ? activeYamlName.replace(/\.ya?ml$/i, '') : 'workflow';
    setNewWorkflowInput(`${base}-graph`);
  }, [activeYamlName, workDir]);

  const commitNewWorkflow = useCallback(
    async (name: string) => {
      if (!workDir) return;
      try {
        const result = await api.createWorkflow({
          name,
          pipelinePaths: [],
        });
        setNewWorkflowInput(null);
        await refreshWorkflowYamls();
        setSelectedWorkflowPath(result.workflow.path);
        setWorkflowViewActive(true);
      } catch (err: unknown) {
        setDialog({
          type: 'error',
          title: 'Workflow Create Failed',
          details: [err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [refreshWorkflowYamls, workDir],
  );

  const handleWorkflowUpdate = useCallback(
    async (path: string, pipelines: WorkflowYamlEntry['pipelines']) => {
      const result = await api.updateWorkflow({ path, pipelines });
      setWorkspaceWorkflows((current) => {
        const index = current.findIndex((entry) => entry.path === result.workflow.path);
        if (index < 0) return [...current, result.workflow];
        const next = [...current];
        next[index] = result.workflow;
        return next;
      });
      setSelectedWorkflowPath(result.workflow.path);
    },
    [],
  );

  const handleWorkflowEditPipeline = useCallback(
    (path: string, workflowPath: string | null = selectedWorkflowPath) => {
      const returnPath = workflowPath;
      guardUnsavedChanges({
        title: 'Open pipeline from graph?',
        details: [
          'Opening this pipeline switches from the pipeline graph overview to the pipeline editor.',
          'Unsaved changes in the current pipeline need to be saved or discarded first.',
        ],
        run: async () => {
          const expectedPath = resolveWorkflowPipelineEditorPath(workDir || '', path);
          const errBefore = usePipelineStore.getState().errorMessage;
          setWorkflowReturnPath(null);
          await openFile(expectedPath);
          const s = usePipelineStore.getState();
          if (
            !didOpenWorkflowPipelineFromGraph({
              expectedPath,
              yamlPath: s.yamlPath,
              errorBefore: errBefore,
              errorAfter: s.errorMessage,
            })
          ) {
            return;
          }
          setWorkflowReturnPath(returnPath);
          setWorkflowViewActive(false);
          setPipelinePickerActive(false);
        },
      });
    },
    [guardUnsavedChanges, openFile, selectedWorkflowPath, workDir],
  );

  const handleReturnToWorkflowGraph = useCallback(() => {
    if (workflowReturnPath) setSelectedWorkflowPath(workflowReturnPath);
    setWorkflowViewActive(true);
    setPipelinePickerActive(false);
    clearWorkflowReturnPathForNavigation('return-to-workflow-graph');
    void refreshWorkflowYamls();
    void refreshWorkflowRunStatus();
  }, [
    clearWorkflowReturnPathForNavigation,
    refreshWorkflowRunStatus,
    refreshWorkflowYamls,
    workflowReturnPath,
  ]);

  type ActionItem = {
    label: string;
    subLabel?: string;
    shortcut?: string;
    disabled?: boolean;
    onAction: () => void;
    onDelete?: () => void;
    deleteTitle?: string;
  };

  const workspaceItems = useMemo<ActionItem[]>(
    () =>
      buildWorkspacePipelineMenuItems({
        workDir,
        liveEntries: workspaceYamls,
        stagedTargets: stagedWorkspacePipelines,
        activeYamlName,
        yamlEditLocked,
        onOpen: handleOpenWorkspaceFile,
        onDelete: handleDeleteWorkspaceFile,
      }),
    [
      workDir,
      workspaceYamls,
      stagedWorkspacePipelines,
      activeYamlName,
      yamlEditLocked,
      handleOpenWorkspaceFile,
      handleDeleteWorkspaceFile,
    ],
  );

  const platformExportItems = useMemo<ActionItem[]>(() => {
    const currentPlatform = hostPlatform;
    return PLATFORM_EXPORT_TARGETS.filter((target) => target !== currentPlatform).map((target) => ({
      label: `Export to ${PLATFORM_EXPORT_LABELS[target]}...`,
      disabled: yamlEditLocked || !yamlPath || platformExportBusy,
      onAction: () => handlePlatformExport(target),
    }));
  }, [handlePlatformExport, hostPlatform, platformExportBusy, yamlEditLocked, yamlPath]);

  const menus = useMemo(() => {
    return [
      {
        label: 'File',
        items: [
          ...(desktopMode
            ? [
                {
                  label: 'New Window',
                  shortcut: 'Ctrl+Shift+N',
                  onAction: () => {
                    void openDesktopWindow();
                  },
                },
                { separator: true as const },
              ]
            : []),
          // L6: Open Workspace at top with separator — it switches the entire
          // working directory, unlike the save/import actions below.
          {
            label: 'Open Workspace...',
            onAction: () => setExplorer({ mode: 'directory', purpose: 'workdir' }),
          },
          { separator: true as const },
          { label: 'New Pipeline', onAction: handleNewPipeline },
          {
            label: 'New Graph...',
            disabled: !workDir || yamlEditLocked,
            onAction: handleNewWorkflow,
          },
          { label: 'Pipeline Graph...', disabled: !workDir, onAction: handleShowWorkflows },
          { separator: true as const },
          {
            label: 'Import Pipeline...',
            shortcut: 'Ctrl+O',
            onAction: handleImport,
          },
          {
            label: 'Export Pipeline...',
            disabled: yamlEditLocked || !yamlPath,
            onAction: handleExport,
          },
          ...platformExportItems,
          { separator: true as const },
          { label: 'Save', shortcut: 'Ctrl+S', disabled: yamlEditLocked, onAction: handleSave },
          { label: 'Save As...', disabled: yamlEditLocked, onAction: handleSaveAs },
        ],
      },
      {
        label: 'View',
        items: [
          { label: 'Track I/O', onAction: () => setShowTrackIO(true) },
          { label: 'Run History', disabled: !workDir, onAction: () => showRunHistory() },
        ],
      },
      {
        label: 'Graph',
        items: [
          {
            label: 'New Graph...',
            disabled: !workDir || yamlEditLocked,
            onAction: handleNewWorkflow,
          },
          { label: 'Open Pipeline Graph', disabled: !workDir, onAction: handleShowWorkflows },
        ],
      },
      {
        label: 'Plugins',
        items: [{ label: 'Manage Plugins...', onAction: () => showPluginsPage() }],
      },
      {
        label: 'Stats',
        items: [{ label: 'Usage Stats...', onAction: () => showUsagePage() }],
      },
      {
        label: 'Settings',
        items: [
          { label: 'Editor Settings', onAction: () => showSettingsPage() },
          { label: 'Secrets Manager...', onAction: () => setShowSecretsManager(true) },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    desktopMode,
    yamlPath,
    yamlEditLocked,
    handleNewPipeline,
    handleNewWorkflow,
    handleImport,
    handleExport,
    platformExportItems,
    handleSave,
    handleSaveAs,
    handleShowWorkflows,
    showRunHistory,
    showSettingsPage,
    workspaceItems,
    workDir,
  ]);

  useEffect(() => {
    if (!desktopMode) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        void openDesktopWindow();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [desktopMode]);

  // Ctrl+O → Import (editor only; suppressed during runs so a stray
  // keystroke can't clobber the pipeline-store while the engine is live)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
        e.preventDefault();
        if (runActive) return;
        handleImport();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleImport, runActive]);

  // U4: periodic localStorage draft autosave while dirty (crash recovery).
  useAutosave();

  // Disk autosave: periodic write-through to the YAML file (settings-gated).
  useDiskAutosave();

  // Global undo/redo/copy/paste/duplicate/search/escape shortcuts (U1).
  const shortcutHandlers = useMemo(
    () => ({
      onFocusSearch: () => setSearchVisible(true),
    }),
    [],
  );
  useShortcuts(shortcutHandlers);

  // U3: beforeunload warning when the document has unsaved changes.
  // Skip under Electron (see C2 above) — preventDefault would silently block
  // the title-bar close button. Desktop confirm lives in DesktopWindowControls.
  useEffect(() => {
    if (hasDesktopBridge()) return;
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty && !layoutDirty) return;
      e.preventDefault();
      // Legacy browsers require returnValue to be set to a string.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, layoutDirty]);

  const commitSaveAs = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      // The server enforces .tagma/<stem>/<stem>.yaml (folder name = YAML
      // stem). We strip any user-supplied extension to derive the stem, then
      // rebuild the canonical path so the server's strict validator accepts
      // it. The server will surface a 403 with a precise message if the stem
      // breaks the rules (whitespace, reserved name, illegal chars).
      const stem = trimmed.replace(/\.ya?ml$/i, '');
      const sep = workDir.includes('\\') ? '\\' : '/';
      const target = `${workDir}${sep}.tagma${sep}${stem}${sep}${stem}.yaml`;
      try {
        const saved = await saveFileAs(target);
        if (!saved) {
          setPendingRun(false);
          runSaveController.cancel();
          return;
        }
        setSaveAsInput(null);
        await refreshWorkspaceYamls();
      } catch (e: unknown) {
        setDialog({
          type: 'error',
          title: 'Save As Failed',
          details: [(e instanceof Error ? e.message : null) ?? 'Unknown error'],
        });
      }
    },
    [workDir, saveFileAs, refreshWorkspaceYamls, runSaveController],
  );

  // Back-from-run handler: while the run is live we just minimize the
  // view (SSE stays alive, run keeps executing server-side). Once the
  // run has reached a terminal state, Back actually tears it all down.
  const handleRunBack = () => {
    if (runStatus === 'running' || runStatus === 'starting') {
      minimizeRun();
    } else {
      resetRun();
    }
  };

  const searchMatches = useMemo(
    () => findTaskSearchMatches(config, searchQuery, searchMode),
    [config, searchQuery, searchMode],
  );

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-tagma-bg">
        <div className="flex items-center gap-2 text-tagma-muted">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-label font-mono">Loading...</span>
        </div>
      </div>
    );
  }

  const VIEW_TRANSITION = { duration: 0.26, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <>
      <AnimatePresence mode="wait">
        {!workDir &&
        !runActive &&
        !pluginsActive &&
        !usageActive &&
        !settingsActive &&
        !workflowViewActive ? (
          <motion.div
            key="welcome"
            className="h-full flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={VIEW_TRANSITION}
          >
            <DesktopTitleStrip />
            <div className="flex-1 min-h-0">
              <WelcomePage
                onOpenWorkspace={() => setExplorer({ mode: 'directory', purpose: 'workdir' })}
                onSelectRecent={handleOpenRecentWorkspace}
              />
            </div>
            <ErrorToast />
          </motion.div>
        ) : pipelinePickerActive &&
          !runActive &&
          !pluginsActive &&
          !usageActive &&
          !settingsActive &&
          !workflowViewActive ? (
          <motion.div
            key="picker"
            className="h-full flex flex-col"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={VIEW_TRANSITION}
          >
            <DesktopTitleStrip />
            <div className="flex-1 min-h-0">
              <PipelinePicker
                workDir={workDir}
                workspaceYamls={workspaceYamls}
                yamlEditLocked={yamlEditLocked}
                openingPath={openingPipelinePath}
                onPickPipeline={handlePickerSelect}
                onCreateNew={handlePickerCreateNew}
                onSwitchWorkspace={handlePickerSwitchWorkspace}
                onDeletePipeline={handleDeleteWorkspaceFile}
              />
            </div>
            <ErrorToast />
          </motion.div>
        ) : runActive ? (
          <motion.div
            key="run"
            className="h-full flex flex-col"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <div className="flex-1 min-h-0">
              <RunView
                config={config}
                dagEdges={dagEdges}
                positions={positions}
                onBack={handleRunBack}
              />
            </div>
            <VersionStatusBar />
            <ErrorToast />
          </motion.div>
        ) : workflowViewActive ? (
          <motion.div
            key="workflow"
            className="h-full flex flex-col"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <div className="flex-1 min-h-0">
              <WorkflowView
                workflows={workspaceWorkflows}
                selectedPath={selectedWorkflowPath}
                workDir={workDir}
                workspacePipelines={workspaceYamls}
                events={workflowEvents}
                result={workflowRunResult}
                running={workflowRunning}
                onSelectWorkflow={(path) => {
                  setSelectedWorkflowPath(path);
                  setWorkflowEvents([]);
                  setWorkflowRunResult(null);
                }}
                onBack={() => setWorkflowViewActive(false)}
                onRefresh={refreshWorkflowYamls}
                onStart={handleWorkflowStart}
                onAbort={handleWorkflowAbort}
                onCreateWorkflow={handleNewWorkflow}
                onSaveWorkflow={handleWorkflowUpdate}
                onEditPipeline={handleWorkflowEditPipeline}
              />
            </div>
            <VersionStatusBar />
            <ErrorToast />
          </motion.div>
        ) : pluginsActive ? (
          <motion.div
            key="plugins"
            className="h-full flex flex-col"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <div className="flex-1 min-h-0">
              <PluginsPage
                workDir={workDir}
                declaredPlugins={config.plugins ?? []}
                onBack={hidePluginsPage}
                onRegistryUpdate={setRegistry}
                onPluginsChange={(plugins) =>
                  updatePipelineFields({ plugins: plugins.length > 0 ? plugins : undefined })
                }
                onRequestBrowseLocal={() => setExplorer({ mode: 'open', purpose: 'plugin-import' })}
                onRefreshServerState={refreshServerState}
              />
            </div>
            <VersionStatusBar />
            <ErrorToast />
          </motion.div>
        ) : usageActive ? (
          <motion.div
            key="usage"
            className="h-full flex flex-col"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <div className="flex-1 min-h-0">
              <UsagePage onBack={hideUsagePage} />
            </div>
            <VersionStatusBar />
            <ErrorToast />
          </motion.div>
        ) : settingsActive ? (
          <motion.div
            key="settings"
            className="h-full flex flex-col"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <div className="flex-1 min-h-0">
              <EditorSettingsPage
                workDir={workDir}
                onRegistryUpdate={setRegistry}
                onBack={hideSettingsPage}
              />
            </div>
            <VersionStatusBar />
            <ErrorToast />
          </motion.div>
        ) : !yamlPath ? (
          // Bootstrap gap. After setWorkDir() flips workDir to the new
          // workspace, the picker/new-pipeline decision lives behind the
          // async refreshWorkspaceYamls() round-trip in
          // bootstrapAfterWorkspace. Without this branch the render falls
          // through to the editor for that interval, producing the visible
          // editor → picker flash on workspace open. Render a neutral
          // bg-matched placeholder that AnimatePresence can transition into
          // and out of without exposing the editor chrome.
          <motion.div
            key="workspace-bootstrap"
            className="h-full flex flex-col bg-tagma-bg"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={VIEW_TRANSITION}
          >
            <DesktopTitleStrip />
            <div className="flex-1 min-h-0" />
            <ErrorToast />
          </motion.div>
        ) : (
          <motion.div
            key="editor"
            className="h-full flex flex-col bg-tagma-bg"
            initial={{ opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={VIEW_TRANSITION}
          >
            <div
              onClick={() => {
                if (!pipelineInspectorPinned && !pinnedTaskId && !pinnedTrackId) {
                  setPipelineInspectorSelected(false);
                  handleSelectTask(null);
                  handleSelectTrack(null);
                }
              }}
            >
              <Toolbar
                pipelineName={config.name}
                yamlPath={yamlPath}
                workDir={workDir}
                isDirty={isDirty}
                errorCount={blockingValidationErrors.length}
                menus={menus}
                workspaceItems={workspaceItems}
                onUpdateName={setPipelineName}
                onSelectPipeline={handleSelectPipeline}
                onRun={handleRun}
                runTargetCount={selectedTaskIds.length}
                onReturnToWorkflowGraph={
                  workflowReturnPath ? handleReturnToWorkflowGraph : undefined
                }
                searchQuery={searchQuery}
                searchOpen={searchVisible}
                searchMatches={searchMatches}
                searchMode={searchMode}
                onSearchOpen={() => setSearchVisible(true)}
                onSearchClose={closeTaskSearch}
                onSearchQueryChange={setSearchQuery}
                onSearchModeChange={setSearchMode}
                onSelectSearchMatch={handleSelectSearchMatch}
              />
            </div>

            {yamlEditLocked && (
              <div className="flex items-center gap-2 border-b border-tagma-info/20 bg-tagma-info/8 px-3 py-1.5 text-body font-mono text-tagma-text">
                <ShieldCheck size={13} className="text-tagma-info" />
                <span>{yamlEditLockReason || YAML_EDIT_LOCK_MESSAGE}</span>
              </div>
            )}

            <div className="relative flex-1 flex overflow-hidden">
              <div className="flex-1 min-w-0 overflow-hidden">
                <BoardCanvas
                  config={config}
                  dagEdges={dagEdges}
                  positions={positions}
                  selectedTaskIds={selectedTaskIds}
                  invalidTaskIds={invalidTaskIds}
                  errorsByTask={errorsByTask}
                  errorsByTrack={errorsByTrack}
                  onSelectTask={handleSelectTask}
                  onToggleTaskSelection={handleToggleTaskSelection}
                  onSelectTrack={handleSelectTrack}
                  onAddTask={addTask}
                  onAddTrack={addTrack}
                  onDeleteTask={deleteTask}
                  onDeleteTrack={deleteTrack}
                  onRenameTrack={renameTrack}
                  onMoveTrackTo={moveTrackTo}
                  onAddDependency={addDependency}
                  onRemoveDependency={removeDependency}
                  onSetTaskPosition={setTaskPosition}
                  onSetTrackHeight={setTrackHeight}
                  onTransferTask={transferTaskToTrack}
                />
              </div>

              {/* Right dock: inspector / yaml / chat live in shared tab slots
                  (plus one optional "detached" column to the left of the tab
                  strip). Caps the right-side footprint at ~720px even with
                  two panels open, down from ~1000px when all three rendered
                  side-by-side. */}
              <RightDock
                state={rightDock}
                inspectorAvailable={inspectorAvailable}
                inspectorContent={
                  inspectorTarget === 'pipeline' ? (
                    <PipelineConfigPanel
                      config={config}
                      drivers={registry.drivers}
                      errors={pipelineLevelErrors}
                      onUpdate={updatePipelineFields}
                      isPinned={pipelineInspectorPinned}
                      onTogglePin={() => {
                        if (pipelineInspectorPinned) {
                          setPipelineInspectorPinned(false);
                          setPipelineInspectorSelected(false);
                        } else {
                          setPipelineInspectorPinned(true);
                          setPipelineInspectorSelected(true);
                          if (pinnedTaskId) unpinTask();
                          if (pinnedTrackId) unpinTrack();
                        }
                      }}
                    />
                  ) : inspectorTarget === 'task' && selectedInfo ? (
                    <TaskConfigPanel
                      key={sidebarTaskId}
                      task={selectedInfo.task}
                      trackId={selectedInfo.trackId}
                      qualifiedId={sidebarTaskId!}
                      pipelineConfig={config}
                      dependencies={[...(selectedInfo.task.depends_on ?? [])]}
                      drivers={registry.drivers}
                      errors={errorsByTask.get(sidebarTaskId!) ?? []}
                      onUpdateTask={updateTask}
                      onDeleteTask={deleteTask}
                      onRemoveDependency={removeDependency}
                      isPinned={!!pinnedTaskId}
                      onTogglePin={() => {
                        if (pinnedTaskId) {
                          unpinTask();
                        } else {
                          setPipelineInspectorPinned(false);
                          setPipelineInspectorSelected(false);
                          pinTask(sidebarTaskId!);
                        }
                      }}
                    />
                  ) : inspectorTarget === 'track' && selectedTrack ? (
                    <TrackConfigPanel
                      key={sidebarTrackId}
                      track={selectedTrack}
                      drivers={registry.drivers}
                      errors={errorsByTrack.get(sidebarTrackId!) ?? []}
                      onUpdateTrack={updateTrackFields}
                      onDeleteTrack={deleteTrack}
                      isPinned={!!pinnedTrackId}
                      onTogglePin={() => {
                        if (pinnedTrackId) {
                          unpinTrack();
                        } else {
                          setPipelineInspectorPinned(false);
                          setPipelineInspectorSelected(false);
                          pinTrack(sidebarTrackId!);
                        }
                      }}
                    />
                  ) : (
                    <div className="h-full flex items-center justify-center px-6 text-center">
                      <p className="text-body font-mono text-tagma-muted leading-relaxed">
                        Select the pipeline name, a task, or a track to inspect its configuration.
                      </p>
                    </div>
                  )
                }
                yamlContent={
                  <YamlPreview
                    config={config}
                    blocks={yamlPreviewBlocks}
                    onRevertBlock={revertYamlPreviewBlock}
                    selectedTaskId={selectedTaskId}
                    selectedTrackId={selectedTrackId}
                    onSelectTask={handleYamlSelectTask}
                    onSelectTrack={handleYamlSelectTrack}
                  />
                }
                chatContent={<ChatPanel />}
              />
            </div>

            <VersionStatusBar />

            {showSecretsManager && (
              <SecretsManagerPanel
                workDir={workDir}
                currentYamlPath={yamlPath}
                onClose={() => setShowSecretsManager(false)}
              />
            )}

            {saveAsInput !== null && (
              <SaveAsDialog
                defaultValue={saveAsInput}
                onConfirm={commitSaveAs}
                onCancel={() => {
                  setSaveAsInput(null);
                  setPendingRun(false);
                  runSaveController.cancel();
                }}
              />
            )}

            {showTrackIO && <TrackIODialog config={config} onClose={() => setShowTrackIO(false)} />}

            <ViewportNotificationStack>
              <ErrorToast contained />
              {platformExportProgress && (
                <PlatformExportProgressToast progress={platformExportProgress} contained />
              )}
            </ViewportNotificationStack>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Global modals — rendered at top level so they work from any view ─── */}

      {newWorkflowInput !== null && (
        <SaveAsDialog
          title="New Graph"
          inputLabel="Graph name (saved at .tagma/workflows/<name>.workflow.yaml)"
          inputAriaLabel="Graph name"
          placeholder="release-flow"
          confirmLabel="Create"
          defaultValue={newWorkflowInput}
          onConfirm={commitNewWorkflow}
          onCancel={() => setNewWorkflowInput(null)}
        />
      )}

      {/* File Explorer modal */}
      {explorer && (
        <FileExplorer
          mode={explorer.mode}
          title={
            explorer.purpose === 'import'
              ? 'Import Pipeline YAML'
              : explorer.purpose === 'export'
                ? 'Export Pipeline — Select Destination'
                : explorer.purpose === 'export-platform'
                  ? `Export to ${PLATFORM_EXPORT_LABELS[explorer.targetPlatform]} — Select Destination`
                  : explorer.purpose === 'plugin-import'
                    ? 'Import Local Plugin — Select Directory or Archive'
                    : 'Select Workspace Directory'
          }
          initialPath={
            explorer.purpose === 'import'
              ? undefined
              : explorer.purpose === 'export' || explorer.purpose === 'export-platform'
                ? workDir
                : workDir || undefined
          }
          fileFilter={
            explorer.purpose === 'import'
              ? ['.yaml', '.yml']
              : explorer.purpose === 'plugin-import'
                ? ['.tgz', '.tar.gz']
                : undefined
          }
          // C3: every legitimate "browse outside the workspace" intent flows
          // through one of these picker purposes. Anything else is in-workspace
          // navigation and stays subject to the server's workspace fence.
          picker={
            explorer.purpose === 'workdir' ||
            explorer.purpose === 'plugin-import' ||
            explorer.purpose === 'import' ||
            explorer.purpose === 'export' ||
            explorer.purpose === 'export-platform'
          }
          capabilityPurpose={
            explorer.purpose === 'plugin-import'
              ? 'import-plugin'
              : explorer.purpose === 'import'
                ? 'import-file'
                : explorer.purpose === 'export' || explorer.purpose === 'export-platform'
                  ? 'export-file'
                  : undefined
          }
          onConfirm={handleExplorerConfirm}
          onConfirmWithCapability={
            explorer.purpose === 'plugin-import' ||
            explorer.purpose === 'import' ||
            explorer.purpose === 'export' ||
            explorer.purpose === 'export-platform'
              ? handleExplorerConfirm
              : undefined
          }
          allowDirectorySelection={explorer.purpose === 'plugin-import'}
          workspaceDirectory={explorer.purpose === 'workdir'}
          multiple={explorer.purpose === 'import'}
          onConfirmMany={explorer.purpose === 'import' ? handleExplorerConfirmMany : undefined}
          onCancel={() => {
            const wasPluginImport = explorer?.purpose === 'plugin-import';
            setExplorer(null);
            setPendingRun(false);
            runSaveController.cancel();
            afterWorkspaceRef.current = null;
            if (wasPluginImport) showPluginsPage();
          }}
        />
      )}

      {/* Info / error dialog */}
      {dialog && <DialogModal info={dialog} onClose={() => setDialog(null)} />}

      {unsavedAction && (
        <UnsavedChangesModal
          action={unsavedAction}
          onSave={runUnsavedActionAfterSave}
          onDiscard={runUnsavedActionDiscarding}
          onCancel={() => setUnsavedAction(null)}
        />
      )}

      {/* Confirm dialog */}
      {confirmInfo && <ConfirmModal info={confirmInfo} onClose={() => setConfirmInfo(null)} />}

      {/* Global confirm channel — for callers outside App's tree (eg. title-bar X) */}
      <GlobalConfirmModal />

      {/* Pre-run requirements check modal — surfaces missing CLI tools / env vars */}
      <GlobalRequirementsCheckModal />
    </>
  );
}
