import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePipelineStore } from './store/pipeline-store';
import { BoardCanvas } from './components/board/BoardCanvas';
import { Toolbar } from './components/board/Toolbar';
import { TaskConfigPanel } from './components/panels/TaskConfigPanel';
import { TrackConfigPanel } from './components/panels/TrackConfigPanel';
import { PipelineConfigPanel } from './components/panels/PipelineConfigPanel';
import { EditorSettingsPanel } from './components/panels/EditorSettingsPanel';
import { PluginsPage } from './components/plugins/PluginsPage';
import { FileExplorer, type FileExplorerMode } from './components/FileExplorer';
import { WelcomePage } from './components/WelcomePage';
import { api, type ServerStateEvent } from './api/client';
import { Loader2, X as XIcon, Check, Square, ShieldCheck } from 'lucide-react';

import { RunView } from './components/run/RunView';
import { YamlPreview } from './components/panels/YamlPreview';
import { useRunStore } from './store/run-store';
import { ErrorToast } from './components/ErrorToast';
import { useShortcuts } from './hooks/use-shortcuts';
import { useAutosave, loadDraft, clearDraft } from './hooks/use-autosave';
import { SearchOverlay } from './components/SearchOverlay';
import { SaveAsDialog } from './components/SaveAsDialog';
import { DialogModal, type DialogInfo } from './components/DialogModal';
import { ConfirmModal, type ConfirmInfo } from './components/ConfirmModal';
import { hasDesktopBridge, openDesktopWindow } from './desktop';
import { DesktopTitleStrip } from './components/DesktopWindowControls';

type ExplorerIntent = {
  mode: FileExplorerMode;
  purpose: 'import' | 'export' | 'workdir' | 'plugin-import';
};

export function App() {
  const desktopMode = hasDesktopBridge();
  const {
    config,
    positions,
    selectedTaskId,
    selectedTaskIds,
    selectedTrackId,
    pinnedTaskId,
    pinnedTrackId,
    validationErrors,
    dagEdges,
    yamlPath,
    yamlMtimeMs,
    workDir,
    isDirty,
    layoutDirty,
    loading,
    registry,
    pluginsActive,
    showPluginsPage,
    hidePluginsPage,
    setPipelineName,
    updatePipelineFields,
    addTrack,
    renameTrack,
    updateTrackFields,
    deleteTrack,
    moveTrackTo,
    addTask,
    updateTask,
    deleteTask,
    transferTaskToTrack,
    addDependency,
    removeDependency,
    selectTask,
    toggleTaskSelection,
    selectTrack,
    pinTask,
    unpinTask,
    pinTrack,
    unpinTrack,
    setTaskPosition,
    setRegistry,
    refreshServerState,
    setWorkDir,
    saveFile,
    saveFileAs,
    newPipeline,
    importFile,
    exportFile,
    openFile,
    init,
    restoreDraft,
  } = usePipelineStore();

  const {
    active: runActive,
    status: runStatus,
    tasks: runTasks,
    pendingApprovals: runPendingApprovals,
    startRun,
    reset: resetRun,
    minimizeView: minimizeRun,
    showView: showRun,
    showHistoryView: showRunHistory,
  } = useRunStore();

  const [showPipelineSettings, setShowPipelineSettings] = useState(false);
  const [showEditorSettings, setShowEditorSettings] = useState(false);
  const [explorer, setExplorer] = useState<ExplorerIntent | null>(null);
  const [dialog, setDialog] = useState<DialogInfo | null>(null);
  const [confirmInfo, setConfirmInfo] = useState<ConfirmInfo | null>(null);
  const [workspaceYamls, setWorkspaceYamls] = useState<
    { name: string; path: string; pipelineName: string | null }[]
  >([]);
  const [saveAsInput, setSaveAsInput] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [showYamlPreview, setShowYamlPreview] = useState(false);

  // Pending action to execute after workspace is set
  const afterWorkspaceRef = useRef<'new' | 'import' | 'save' | 'run' | null>(null);

  // Store errors are surfaced via <ErrorToast />, which subscribes directly
  // to `errorMessage` and handles auto-dismiss. No effect needed here.

  useEffect(() => {
    init();
    // init is a stable store action; [] would also be correct but including
    // the dep satisfies the exhaustive-deps rule without causing re-runs.
  }, [init]);

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
  useEffect(() => {
    const unsubscribe = api.subscribeStateEvents((event: ServerStateEvent) => {
      if (event.type === 'external-change') {
        // Server already reloaded — re-fetch state so the UI picks up changes.
        init();
        setDialog({
          type: 'success',
          title: 'File reloaded',
          details: ['The pipeline file was changed externally and has been reloaded.'],
        });
      } else if (event.type === 'external-conflict') {
        setDialog({
          type: 'error',
          title: 'External conflict',
          details: [
            `The file "${event.path}" was changed outside the editor.`,
            'Your in-memory edits may conflict. Please save or reload manually.',
          ],
        });
      } else if (event.type === 'state_sync') {
        // B5: Server sends full state on SSE (re)connect. This is a
        // reconnection catch-up, not a user-initiated reload, so it must
        // never clobber unsaved work.
        //
        // P1-H1: only re-init when local state is CLEAN. If the user has
        // unsaved edits (isDirty / layoutDirty) or non-empty undo history,
        // calling init() would silently:
        //   - drop their in-progress edits
        //   - wipe past/future stacks (init does past:[], future:[])
        //   - overwrite local positions via applyStateWithLayout
        // Skipping init in those cases is safe because mutations carry
        // their own If-Match revision check — any drift will be caught at
        // the next mutation and reconciled with a proper conflict toast.
        const s = usePipelineStore.getState();
        if (!s.isDirty && !s.layoutDirty && s.past.length === 0 && s.future.length === 0) {
          init();
        }
      }
    });
    return unsubscribe;
  }, [init]);

  // C2: Warn on browser close when there are unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const refreshWorkspaceYamls = useCallback(async (): Promise<
    { name: string; path: string; pipelineName: string | null }[]
  > => {
    if (!workDir) {
      setWorkspaceYamls([]);
      return [];
    }
    try {
      const result = await api.listWorkspaceYamls();
      setWorkspaceYamls(result.entries);
      return result.entries;
    } catch {
      setWorkspaceYamls([]);
      return [];
    }
  }, [workDir]);

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
  }, [refreshWorkspaceYamls, yamlPath]);

  const handleOpenWorkspaceFile = useCallback(
    async (path: string) => {
      await openFile(path);
    },
    [openFile],
  );

  const handleDeleteWorkspaceFile = useCallback(
    (path: string) => {
      const name = path.split(/[/\\]/).pop() ?? path;
      setConfirmInfo({
        title: 'Remove YAML',
        details: [`Remove "${name}" and its companion .layout.json?`, 'This cannot be undone.'],
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: async () => {
          const wasActive = yamlPath === path;
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
            if (nextPath) {
              await openFile(nextPath);
            } else {
              await newPipeline();
            }
          } else {
            await refreshWorkspaceYamls();
          }
        },
      });
    },
    [yamlPath, workspaceYamls, openFile, newPipeline, refreshWorkspaceYamls],
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
    if (!requireWorkspace('save')) return;
    await saveFile();
  }, [requireWorkspace, saveFile]);

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

  // Attribute each validation error to its root cause (track or task)
  // If all errors in a track are track-level (no task index), mark the track.
  // Otherwise mark the specific tasks.
  const { errorsByTask, errorsByTrack } = useMemo(() => {
    const byTask = new Map<string, string[]>(); // qid → messages
    const byTrack = new Map<string, string[]>(); // trackId → messages

    for (const err of validationErrors) {
      const trackMatch = err.path.match(/tracks\[(\d+)\]/);
      if (!trackMatch) continue;
      const track = config.tracks[parseInt(trackMatch[1])];
      if (!track) continue;

      const taskMatch = err.path.match(/tasks\[(\d+)\]/);
      if (taskMatch) {
        const task = track.tasks[parseInt(taskMatch[1])];
        if (task) {
          const qid = `${track.id}.${task.id}`;
          const list = byTask.get(qid) ?? [];
          list.push(err.message);
          byTask.set(qid, list);
        }
      } else {
        // Track-level error
        const list = byTrack.get(track.id) ?? [];
        list.push(err.message);
        byTrack.set(track.id, list);
      }
    }

    return { errorsByTask: byTask, errorsByTrack: byTrack };
  }, [validationErrors, config]);

  // Pipeline-level (top-level) errors: anything whose path does not start with "tracks[".
  const pipelineLevelErrors = useMemo(
    () => validationErrors.filter((e) => !/^tracks\[/.test(e.path)).map((e) => e.message),
    [validationErrors],
  );

  // H8: only "real" errors (severity !== 'warning') should block Save / Run.
  // The continue_from-in-depends_on hint is the canonical example — runtime
  // happily inserts the implicit edge, so the editor shouldn't refuse to run.
  const blockingValidationErrors = useMemo(
    () => validationErrors.filter((e) => e.severity !== 'warning'),
    [validationErrors],
  );

  // Compat: keep invalidTaskIds as a Set for BoardCanvas
  const invalidTaskIds = useMemo(() => new Set(errorsByTask.keys()), [errorsByTask]);

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

  const [pendingRun, setPendingRun] = useState(false);

  const handleRun = useCallback(async () => {
    // If a run is already live (possibly minimized), don't start a new
    // one — just reopen the existing view. This prevents the server's
    // 409 "run already in progress" and is almost always what the user
    // wanted when they click Run after minimizing.
    if (runStatus === 'running' || runStatus === 'starting') {
      showRun();
      return;
    }
    if (!requireWorkspace('run')) return;
    if (blockingValidationErrors.length > 0) {
      setDialog({
        type: 'error',
        title: `Cannot run: ${blockingValidationErrors.length} validation error(s)`,
        details: blockingValidationErrors.map((e) => `[${e.path}] ${e.message}`),
      });
      return;
    }
    if (!yamlPath || isDirty) {
      setPendingRun(true);
      await saveFile();
      return;
    }
    startRun(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    runStatus,
    showRun,
    requireWorkspace,
    yamlPath,
    validationErrors,
    isDirty,
    saveFile,
    config,
    startRun,
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
      setPendingRun(true);
      await saveFile();
      return;
    }
    // Default: open the first existing YAML in .tagma, or create a new one.
    try {
      const result = await api.listWorkspaceYamls();
      if (result.entries.length > 0) {
        await openFile(result.entries[0].path);
      } else {
        await newPipeline();
      }
    } catch {
      await newPipeline();
    }
  }, [newPipeline, saveFile, openFile]);

  const handleOpenRecentWorkspace = useCallback(
    async (path: string) => {
      try {
        const switched = await setWorkDir(path);
        if (!switched) return;
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
    [setWorkDir, bootstrapAfterWorkspace],
  );

  const handleExplorerConfirm = useCallback(
    async (path: string) => {
      if (!explorer) return;
      if (explorer.purpose === 'workdir') {
        const switched = await setWorkDir(path);
        if (!switched) return;
        await bootstrapAfterWorkspace();
      } else if (explorer.purpose === 'import') {
        await importFile(path);
        setExplorer(null);
      } else if (explorer.purpose === 'export') {
        const destPath = await exportFile(path);
        setExplorer(null);
        if (destPath) {
          setDialog({
            type: 'success',
            title: 'Export Successful',
            details: [`Exported to: ${destPath}`],
          });
        }
      } else if (explorer.purpose === 'plugin-import') {
        setExplorer(null);
        showPluginsPage();
        try {
          const result = await api.importLocalPlugin(path);
          setRegistry(result.registry);
          const name = result.plugin.name;
          if (!config.plugins?.includes(name)) {
            updatePipelineFields({ plugins: [...(config.plugins ?? []), name] });
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
      bootstrapAfterWorkspace,
      config.plugins,
      setRegistry,
      updatePipelineFields,
      showPluginsPage,
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
    async (paths: string[]) => {
      if (!explorer || paths.length === 0) return;
      if (paths.length === 1) {
        await importFile(paths[0]);
        setExplorer(null);
        return;
      }
      setExplorer(null);
      const failures: { path: string; error: string }[] = [];
      for (const p of paths) {
        try {
          await importFile(p);
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
    [explorer, importFile],
  );

  const handleNewPipeline = useCallback(() => {
    if (!requireWorkspace('new')) return;
    newPipeline();
  }, [requireWorkspace, newPipeline]);

  const handleImport = useCallback(() => {
    if (!requireWorkspace('import')) return;
    setExplorer({ mode: 'open', purpose: 'import' });
  }, [requireWorkspace]);

  const handleExport = useCallback(() => {
    if (!yamlPath) return;
    setExplorer({ mode: 'directory', purpose: 'export' });
  }, [yamlPath]);

  // U10: Save As... target file name. Server writes into {workDir}/.tagma/.
  const handleSaveAs = useCallback(() => {
    if (!requireWorkspace('save')) return;
    const currentName = yamlPath ? (yamlPath.split(/[/\\]/).pop() ?? '') : 'pipeline.yaml';
    setSaveAsInput(currentName);
  }, [requireWorkspace, yamlPath]);

  const activeYamlName = useMemo(
    () => (yamlPath ? (yamlPath.split(/[/\\]/).pop() ?? null) : null),
    [yamlPath],
  );

  type ActionItem = {
    label: string;
    subLabel?: string;
    shortcut?: string;
    disabled?: boolean;
    onAction: () => void;
    onDelete?: () => void;
    deleteTitle?: string;
  };

  const workspaceItems = useMemo<ActionItem[]>(() => {
    if (!workDir) return [{ label: '(No workspace selected)', disabled: true, onAction: () => {} }];
    if (workspaceYamls.length === 0)
      return [{ label: '(No YAML files in .tagma)', disabled: true, onAction: () => {} }];
    return workspaceYamls.map((y) => {
      const isActive = y.name === activeYamlName;
      const primary = y.pipelineName && y.pipelineName.trim() ? y.pipelineName : y.name;
      const secondary = y.pipelineName && y.pipelineName.trim() ? y.name : undefined;
      return {
        label: isActive ? `● ${primary}` : `   ${primary}`,
        subLabel: secondary,
        onAction: () => handleOpenWorkspaceFile(y.path),
        onDelete: () => handleDeleteWorkspaceFile(y.path),
        deleteTitle: `Remove ${y.name} and its .layout.json`,
      };
    });
  }, [workDir, workspaceYamls, activeYamlName, handleOpenWorkspaceFile, handleDeleteWorkspaceFile]);

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
          { separator: true as const },
          { label: 'Import Pipeline...', shortcut: 'Ctrl+O', onAction: handleImport },
          { label: 'Export Pipeline...', disabled: !yamlPath, onAction: handleExport },
          { separator: true as const },
          { label: 'Save', shortcut: 'Ctrl+S', onAction: handleSave },
          { label: 'Save As...', onAction: handleSaveAs },
        ],
      },
      {
        label: 'Plugins',
        items: [{ label: 'Manage Plugins...', onAction: () => showPluginsPage() }],
      },
      {
        label: 'Settings',
        items: [
          { label: 'Pipeline Settings', onAction: () => setShowPipelineSettings(true) },
          { label: 'Editor Settings', onAction: () => setShowEditorSettings(true) },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    desktopMode,
    yamlPath,
    handleNewPipeline,
    handleImport,
    handleExport,
    handleSave,
    handleSaveAs,
    workspaceItems,
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

  // Global undo/redo/copy/paste/duplicate/search/escape shortcuts (U1).
  const shortcutHandlers = useMemo(
    () => ({
      onFocusSearch: () => setSearchVisible(true),
    }),
    [],
  );
  useShortcuts(shortcutHandlers);

  // U3: beforeunload warning when the document has unsaved changes.
  useEffect(() => {
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
      const withExt = /\.ya?ml$/i.test(trimmed) ? trimmed : `${trimmed}.yaml`;
      // Build the target path inside the workspace's .tagma directory, matching
      // the server's auto-save-location convention.
      const sep = workDir.includes('\\') ? '\\' : '/';
      const target = `${workDir}${sep}.tagma${sep}${withExt}`;
      setSaveAsInput(null);
      try {
        await saveFileAs(target);
        await refreshWorkspaceYamls();
      } catch (e: unknown) {
        setDialog({
          type: 'error',
          title: 'Save As Failed',
          details: [(e instanceof Error ? e.message : null) ?? 'Unknown error'],
        });
      }
    },
    [workDir, saveFileAs, refreshWorkspaceYamls],
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

  // Summary numbers used by the minimized-run indicator.
  const runTaskCounts = useMemo(() => {
    const counts = {
      success: 0,
      failed: 0,
      running: 0,
      waiting: 0,
      skipped: 0,
      timeout: 0,
      blocked: 0,
    };
    for (const [, t] of runTasks) {
      if (t.status in counts) (counts as Record<string, number>)[t.status] += 1;
    }
    return counts;
  }, [runTasks]);

  // Is the run "minimized" — alive somewhere but the RunView is not
  // currently rendered? This drives the Toolbar slot that replaces the
  // Run button while a run is in flight or freshly terminated.
  const runIsMinimized = !runActive && runStatus !== 'idle';
  const runIsLive = runStatus === 'starting' || runStatus === 'running';

  // Abort-or-dismiss for the Toolbar slot. Aborting a live run goes
  // through a confirm dialog because it's irreversible; dismissing a
  // terminal run is a single click.
  const handleRunStopOrDismiss = useCallback(() => {
    if (runIsLive) {
      setConfirmInfo({
        title: 'Abort run?',
        details: [
          'The pipeline is still executing on the server.',
          'Aborting signals the engine to stop and discards any in-flight tasks.',
          'Only after this is done can you start a new run.',
        ],
        confirmLabel: 'Abort run',
        danger: true,
        onConfirm: () => {
          api.abortRun().catch(() => {
            /* best effort */
          });
          resetRun();
        },
      });
    } else {
      resetRun();
    }
  }, [runIsLive, resetRun]);

  // Toolbar slot: replaces the Run button while a run is minimized.
  // Keeps the "one run at a time" contract explicit — the only way to
  // start another run is to abort/dismiss the current one first, which
  // prevents accidental multi-instance runs (the server would 409
  // anyway, but this makes it clear in the UI).
  const runStatusSlot = useMemo(() => {
    if (!runIsMinimized) return null;
    const label = runIsLive
      ? runTasks.size > 0
        ? `Running ${runTaskCounts.success + runTaskCounts.failed + runTaskCounts.timeout + runTaskCounts.skipped}/${runTasks.size}`
        : 'Running'
      : runStatus === 'done'
        ? 'View run'
        : runStatus === 'failed'
          ? 'Run failed'
          : runStatus === 'aborted'
            ? 'Run aborted'
            : 'Run error';
    const borderClass = runIsLive
      ? 'border-tagma-ready/50 hover:bg-tagma-ready/5 text-tagma-ready'
      : runStatus === 'done'
        ? 'border-tagma-success/50 hover:bg-tagma-success/5 text-tagma-success'
        : 'border-tagma-error/50 hover:bg-tagma-error/5 text-tagma-error';
    return (
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={showRun}
          className={`flex items-center gap-1.5 px-2.5 h-[22px] border text-[10px] font-mono transition-colors ${borderClass}`}
          title="Return to Run view"
          aria-label="Return to Run view"
        >
          {runIsLive && <Loader2 size={10} className="animate-spin" />}
          {runStatus === 'done' && <Check size={10} />}
          {(runStatus === 'aborted' || runStatus === 'failed' || runStatus === 'error') && (
            <XIcon size={10} />
          )}
          <span>{label}</span>
          {runPendingApprovals.size > 0 && (
            <span className="flex items-center gap-0.5 text-tagma-warning">
              <ShieldCheck size={9} className="animate-pulse-slow" />
              {runPendingApprovals.size}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={handleRunStopOrDismiss}
          className="flex items-center justify-center h-[22px] w-[22px] border border-tagma-border/60 text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
          title={runIsLive ? 'Abort run' : 'Dismiss'}
          aria-label={runIsLive ? 'Abort run' : 'Dismiss run panel'}
        >
          {runIsLive ? <Square size={9} /> : <XIcon size={10} />}
        </button>
      </div>
    );
  }, [
    runIsMinimized,
    runIsLive,
    runStatus,
    runTasks.size,
    runTaskCounts.success,
    runTaskCounts.failed,
    runTaskCounts.timeout,
    runTaskCounts.skipped,
    runPendingApprovals.size,
    showRun,
    handleRunStopOrDismiss,
  ]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-tagma-bg">
        <div className="flex items-center gap-2 text-tagma-muted">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-xs font-mono">Loading...</span>
        </div>
      </div>
    );
  }

  const VIEW_TRANSITION = { duration: 0.28, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <>
      <AnimatePresence mode="wait">
        {!workDir && !runActive && !pluginsActive ? (
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
        ) : runActive ? (
          <motion.div
            key="run"
            className="h-full"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={VIEW_TRANSITION}
          >
            <RunView
              config={config}
              dagEdges={dagEdges}
              positions={positions}
              onBack={handleRunBack}
            />
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
                onRequestBrowseLocal={() =>
                  setExplorer({ mode: 'directory', purpose: 'plugin-import' })
                }
                onRefreshServerState={refreshServerState}
              />
            </div>
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
                if (!pinnedTaskId && !pinnedTrackId) {
                  selectTask(null);
                  selectTrack(null);
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
                onRun={handleRun}
                yamlPreviewOpen={showYamlPreview}
                onToggleYamlPreview={() => setShowYamlPreview((v) => !v)}
                onShowHistory={showRunHistory}
                runStatusSlot={runStatusSlot}
              />
            </div>

            <div className="flex-1 flex overflow-hidden">
              <div className={`flex-1 min-w-0 overflow-hidden ${showYamlPreview ? 'flex' : ''}`}>
                <div className={showYamlPreview ? 'flex-1 min-w-0 overflow-hidden' : 'h-full'}>
                  <BoardCanvas
                    config={config}
                    dagEdges={dagEdges}
                    positions={positions}
                    selectedTaskIds={selectedTaskIds}
                    invalidTaskIds={invalidTaskIds}
                    errorsByTask={errorsByTask}
                    errorsByTrack={errorsByTrack}
                    onSelectTask={selectTask}
                    onToggleTaskSelection={toggleTaskSelection}
                    onSelectTrack={selectTrack}
                    onAddTask={addTask}
                    onAddTrack={addTrack}
                    onDeleteTask={deleteTask}
                    onDeleteTrack={deleteTrack}
                    onRenameTrack={renameTrack}
                    onMoveTrackTo={moveTrackTo}
                    onAddDependency={addDependency}
                    onRemoveDependency={removeDependency}
                    onSetTaskPosition={setTaskPosition}
                    onTransferTask={transferTaskToTrack}
                  />
                </div>
                {showYamlPreview && (
                  <div className="w-80 shrink-0 overflow-hidden border-l border-tagma-border">
                    <YamlPreview config={config} onClose={() => setShowYamlPreview(false)} />
                  </div>
                )}
              </div>

              {!pinnedTrackId && selectedInfo && (
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
                  onTogglePin={() => (pinnedTaskId ? unpinTask() : pinTask(sidebarTaskId!))}
                />
              )}

              {!pinnedTaskId && selectedTrack && (
                <TrackConfigPanel
                  key={sidebarTrackId}
                  track={selectedTrack}
                  drivers={registry.drivers}
                  errors={errorsByTrack.get(sidebarTrackId!) ?? []}
                  onUpdateTrack={updateTrackFields}
                  onDeleteTrack={deleteTrack}
                  isPinned={!!pinnedTrackId}
                  onTogglePin={() => (pinnedTrackId ? unpinTrack() : pinTrack(sidebarTrackId!))}
                />
              )}
            </div>

            {/* Pipeline Settings modal */}
            {showPipelineSettings && (
              <PipelineConfigPanel
                config={config}
                drivers={registry.drivers}
                errors={pipelineLevelErrors}
                onUpdate={updatePipelineFields}
                onClose={() => setShowPipelineSettings(false)}
              />
            )}

            {/* Editor Settings modal */}
            {showEditorSettings && (
              <EditorSettingsPanel
                workDir={workDir}
                onRegistryUpdate={setRegistry}
                onClose={() => setShowEditorSettings(false)}
              />
            )}

            {saveAsInput !== null && (
              <SaveAsDialog
                defaultValue={saveAsInput}
                onConfirm={commitSaveAs}
                onCancel={() => setSaveAsInput(null)}
              />
            )}

            {searchVisible && (
              <SearchOverlay
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                onClose={() => setSearchVisible(false)}
                onSelectTask={selectTask}
                config={config}
              />
            )}

            <ErrorToast />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Global modals — rendered at top level so they work from any view ─── */}

      {/* File Explorer modal */}
      {explorer && (
        <FileExplorer
          mode={explorer.mode}
          title={
            explorer.purpose === 'import'
              ? 'Import Pipeline YAML'
              : explorer.purpose === 'export'
                ? 'Export Pipeline — Select Destination'
                : explorer.purpose === 'plugin-import'
                  ? 'Import Local Plugin — Select Directory'
                  : 'Select Workspace Directory'
          }
          initialPath={
            explorer.purpose === 'import'
              ? undefined
              : explorer.purpose === 'export'
                ? workDir
                : workDir || undefined
          }
          fileFilter={explorer.purpose === 'import' ? ['.yaml', '.yml'] : undefined}
          // C3: every legitimate "browse outside the workspace" intent flows
          // through one of these four purposes. Anything else is in-workspace
          // navigation and stays subject to the server's workspace fence.
          picker={
            explorer.purpose === 'workdir' ||
            explorer.purpose === 'plugin-import' ||
            explorer.purpose === 'import' ||
            explorer.purpose === 'export'
          }
          onConfirm={handleExplorerConfirm}
          multiple={explorer.purpose === 'import'}
          onConfirmMany={
            explorer.purpose === 'import' ? handleExplorerConfirmMany : undefined
          }
          onCancel={() => {
            const wasPluginImport = explorer?.purpose === 'plugin-import';
            setExplorer(null);
            setPendingRun(false);
            afterWorkspaceRef.current = null;
            if (wasPluginImport) showPluginsPage();
          }}
        />
      )}

      {/* Info / error dialog */}
      {dialog && <DialogModal info={dialog} onClose={() => setDialog(null)} />}

      {/* Confirm dialog */}
      {confirmInfo && <ConfirmModal info={confirmInfo} onClose={() => setConfirmInfo(null)} />}
    </>
  );
}
