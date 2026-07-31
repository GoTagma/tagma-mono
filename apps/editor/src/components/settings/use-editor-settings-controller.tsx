import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type DiagnosticsSessionStatus,
  type EditorSettings,
  type GlobalSettings,
  type PluginDeclaredResult,
  type PluginRefreshResult,
  type PluginRegistry,
  type PythonDetectionResult,
  type PythonInstallPlan,
} from '../../api/client';
import { restartOpencodeForConfig } from '../../api/opencode-chat';
import { buildDiagnosticsAgentInstructions } from '../../diagnostics/renderer-diagnostics';
import { refreshRendererDiagnosticsBridge } from '../../diagnostics/renderer-diagnostics-bridge';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import {
  MAX_OPENCODE_AGENT_MAX_STEPS,
  MIN_OPENCODE_AGENT_MAX_STEPS,
} from '../../../shared/opencode-agent-step-limit.js';

import {
  createEditorSettingsSaveQueue,
  type EditorSettingsSaveQueue,
} from '../panels/editor-settings-save-queue';

export type ApplyStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: PluginRefreshResult }
  | { kind: 'error'; message: string };

export type PythonChoice = 'yes' | 'no';

export type PythonWizardStatus =
  | { kind: 'idle' }
  | { kind: 'detecting' }
  | { kind: 'configuring' }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }
  | { kind: 'installed'; message: string };

const OPENCODE_SETTINGS_LOCK_MESSAGE =
  'Wait for the active OpenCode chat to finish before changing OpenCode settings.';

export function getOpencodeSettingsMutationBlockMessage(lockState: {
  workspaceActive: boolean;
}): string | null {
  return lockState.workspaceActive ? OPENCODE_SETTINGS_LOCK_MESSAGE : null;
}

/**
 * Shared state/logic for the Editor Settings surfaces. Both the classic modal
 * (panels/EditorSettingsPanel.tsx) and the full-page settings view
 * (settings/EditorSettingsPage.tsx) drive the same controller so behaviour —
 * optimistic saves, OpenCode restart side effects, the Python wizard — stays
 * identical no matter which chrome renders it.
 */
export function useEditorSettingsController(
  workDir: string,
  onRegistryUpdate: (registry: PluginRegistry) => void,
) {
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings | null>(null);
  const [agentMaxStepsDraft, setAgentMaxStepsDraft] = useState('');
  const [globalSaving, setGlobalSaving] = useState(false);
  const [agentMaxStepsSaved, setAgentMaxStepsSaved] = useState(false);
  const [settings, setSettings] = useState<EditorSettings | null>(null);
  const [declared, setDeclared] = useState<PluginDeclaredResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pythonSaving, setPythonSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<ApplyStatus>({ kind: 'idle' });
  const [pythonWizardOpen, setPythonWizardOpen] = useState(false);
  const [pythonDetection, setPythonDetection] = useState<PythonDetectionResult | null>(null);
  const [pythonChoice, setPythonChoice] = useState<PythonChoice>('no');
  const [selectedPythonId, setSelectedPythonId] = useState<string>('');
  const [manualPythonPath, setManualPythonPath] = useState('');
  const [installVersion, setInstallVersion] = useState('3.13');
  const [installPlan, setInstallPlan] = useState<PythonInstallPlan | null>(null);
  const [pythonStatus, setPythonStatus] = useState<PythonWizardStatus>({ kind: 'idle' });
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<DiagnosticsSessionStatus | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const mountedRef = useRef(true);
  const globalSavingRef = useRef(false);
  const workspaceSavingRef = useRef(false);
  const settingsSaveQueueRef = useRef<EditorSettingsSaveQueue<EditorSettings> | null>(null);
  if (!settingsSaveQueueRef.current) {
    settingsSaveQueueRef.current = createEditorSettingsSaveQueue<EditorSettings>({
      persist: (patch) => api.updateEditorSettings(patch),
      onValue: (next) => {
        useEditorSettingsStore.getState().updateLocal(next);
        if (mountedRef.current) setSettings(next);
      },
      onSavingChange: (nextSaving) => {
        workspaceSavingRef.current = nextSaving;
        if (mountedRef.current) setSaving(nextSaving);
      },
      onError: (saveError) => {
        if (mountedRef.current) {
          setError(
            saveError instanceof Error ? saveError.message : 'Failed to save editor settings',
          );
        }
      },
    });
  }
  const settingsSaveQueue = settingsSaveQueueRef.current;
  const opencodeSettingsMutationBlockMessage = useYamlEditLockStore(
    getOpencodeSettingsMutationBlockMessage,
  );

  const hasWorkspace = workDir.length > 0;
  const opencodeSettingsMutationBlocked = opencodeSettingsMutationBlockMessage !== null;
  const settingsInputsDisabled = !hasWorkspace || pythonSaving || globalSaving;
  const globalSettingsInputsDisabled =
    globalSaving || pythonSaving || saving || opencodeSettingsMutationBlocked;

  const refreshDeclared = useCallback(async () => {
    if (!hasWorkspace) return;
    try {
      const next = await api.getDeclaredPlugins();
      setDeclared(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to scan workspace plugins');
    }
  }, [hasWorkspace]);

  // Initial load: fetch global settings, workspace settings, and the declared
  // plugin snapshot in parallel so the panel paints in one shot.
  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    setLoading(true);
    setError(null);
    Promise.allSettled([api.getGlobalSettings(), api.getEditorSettings(), api.getDeclaredPlugins()])
      .then(([globalRes, settingsRes, declaredRes]) => {
        if (cancelled) return;
        if (globalRes.status === 'fulfilled') {
          setGlobalSettings(globalRes.value);
          setAgentMaxStepsDraft(String(globalRes.value.opencodeAgentMaxSteps));
        } else {
          setError(
            globalRes.reason instanceof Error
              ? globalRes.reason.message
              : 'Failed to load global settings',
          );
        }
        if (settingsRes.status === 'fulfilled') {
          settingsSaveQueue.reset(settingsRes.value);
        } else {
          setError(
            settingsRes.reason instanceof Error
              ? settingsRes.reason.message
              : 'Failed to load editor settings',
          );
        }
        if (declaredRes.status === 'fulfilled') {
          setDeclared(declaredRes.value);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [settingsSaveQueue]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getDiagnosticsSession()
      .then((status) => {
        if (!cancelled) setDiagnosticsStatus(status);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : 'Failed to load coding agent diagnostics status',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workDir]);

  const updateField = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    if (!settings || globalSavingRef.current) return;
    if (!hasWorkspace) {
      setError('Open a workspace before changing editor settings.');
      return;
    }
    setError(null);
    settingsSaveQueue.update(key, value);
  };

  const enableDiagnostics = async () => {
    if (!hasWorkspace || diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setDiagnosticsCopied(false);
    setError(null);
    try {
      const status = await api.enableDiagnosticsSession();
      setDiagnosticsStatus(status);
      await refreshRendererDiagnosticsBridge();
    } catch (enableError) {
      setError(
        enableError instanceof Error
          ? enableError.message
          : 'Failed to enable coding agent diagnostics',
      );
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const disableDiagnostics = async () => {
    if (diagnosticsBusy) return;
    setDiagnosticsBusy(true);
    setDiagnosticsCopied(false);
    setError(null);
    try {
      const status = await api.disableDiagnosticsSession();
      setDiagnosticsStatus(status);
      await refreshRendererDiagnosticsBridge();
    } catch (disableError) {
      setError(
        disableError instanceof Error
          ? disableError.message
          : 'Failed to disable coding agent diagnostics',
      );
    } finally {
      setDiagnosticsBusy(false);
    }
  };

  const copyDiagnosticsInstructions = async () => {
    if (!diagnosticsStatus?.enabled) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(
        buildDiagnosticsAgentInstructions(diagnosticsStatus.connection),
      );
      setDiagnosticsCopied(true);
      window.setTimeout(() => {
        if (mountedRef.current) setDiagnosticsCopied(false);
      }, 2_000);
    } catch (copyError) {
      setError(
        copyError instanceof Error ? copyError.message : 'Failed to copy diagnostics instructions',
      );
    }
  };

  const parsedAgentMaxSteps =
    agentMaxStepsDraft.trim().length > 0 ? Number(agentMaxStepsDraft) : Number.NaN;
  const agentMaxStepsDraftValid =
    Number.isInteger(parsedAgentMaxSteps) &&
    parsedAgentMaxSteps >= MIN_OPENCODE_AGENT_MAX_STEPS &&
    parsedAgentMaxSteps <= MAX_OPENCODE_AGENT_MAX_STEPS;
  const agentMaxStepsChanged =
    agentMaxStepsDraftValid &&
    globalSettings !== null &&
    parsedAgentMaxSteps !== globalSettings.opencodeAgentMaxSteps;

  const saveGlobalAgentMaxSteps = async () => {
    if (globalSavingRef.current || workspaceSavingRef.current || pythonSaving) return;
    if (opencodeSettingsMutationBlockMessage) {
      setError(opencodeSettingsMutationBlockMessage);
      return;
    }
    if (!globalSettings || !agentMaxStepsDraftValid) {
      setError(
        `Agent max steps must be a whole number from ${MIN_OPENCODE_AGENT_MAX_STEPS} to ${MAX_OPENCODE_AGENT_MAX_STEPS}.`,
      );
      return;
    }

    globalSavingRef.current = true;
    setGlobalSaving(true);
    setAgentMaxStepsSaved(false);
    setError(null);
    try {
      const saved = await api.updateGlobalSettings({
        opencodeAgentMaxSteps: parsedAgentMaxSteps,
      });
      setGlobalSettings(saved);
      setAgentMaxStepsDraft(String(saved.opencodeAgentMaxSteps));
      setAgentMaxStepsSaved(true);
      if (hasWorkspace) {
        try {
          await restartOpencodeForConfig();
        } catch (restartError) {
          setError(
            restartError instanceof Error
              ? `Step limit saved globally, but OpenCode restart failed: ${restartError.message}`
              : 'Step limit saved globally, but OpenCode restart failed.',
          );
        }
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save global settings');
    } finally {
      globalSavingRef.current = false;
      setGlobalSaving(false);
    }
  };

  const handleApply = async () => {
    if (!hasWorkspace) return;
    setApplyStatus({ kind: 'running' });
    try {
      const result = await api.refreshPlugins();
      onRegistryUpdate(result.registry);
      setApplyStatus({ kind: 'done', result });
      // Refresh the read-only preview so the install/missing chips reflect
      // the new on-disk state without the user having to reopen the panel.
      await refreshDeclared();
    } catch (e) {
      setApplyStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to apply',
      });
    }
  };

  const openPythonWizard = useCallback(async () => {
    if (!hasWorkspace) {
      setError('Open a workspace before configuring Python.');
      return;
    }
    setPythonWizardOpen(true);
    setPythonStatus({ kind: 'detecting' });
    try {
      const detection = await api.detectPythonAgent();
      setPythonDetection(detection);
      const defaultId = detection.defaultId ?? detection.detected[0]?.id ?? '';
      setSelectedPythonId(defaultId);
      setPythonChoice(detection.detected.length > 0 ? 'yes' : 'no');
      const plan = await api.getPythonAgentInstallPlan('3.13', detection.packageManager);
      setInstallPlan(plan);
      setPythonStatus({ kind: 'idle' });
    } catch (e) {
      setPythonStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to detect Python',
      });
    }
  }, [hasWorkspace]);

  const handlePythonToggle = async (enabled: boolean) => {
    if (opencodeSettingsMutationBlockMessage) {
      setError(opencodeSettingsMutationBlockMessage);
      return;
    }
    if (enabled) {
      await openPythonWizard();
      return;
    }
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, pythonAgent: { ...settings.pythonAgent, enabled: false } };
    setSettings(next);
    useEditorSettingsStore.getState().updateLocal(next);
    setPythonSaving(true);
    setError(null);
    try {
      const result = await api.disablePythonAgent();
      settingsSaveQueue.reset(result.settings);
      try {
        await restartOpencodeForConfig();
      } catch (e) {
        setError(
          e instanceof Error
            ? `Python settings saved, but OpenCode restart failed: ${e.message}`
            : 'Python settings saved, but OpenCode restart failed',
        );
      }
    } catch (e) {
      settingsSaveQueue.reset(previous);
      setError(e instanceof Error ? e.message : 'Failed to disable Python AI Agent');
    } finally {
      setPythonSaving(false);
    }
  };

  const selectedPython = pythonDetection?.detected.find((item) => item.id === selectedPythonId);

  useEffect(() => {
    if (!pythonWizardOpen || pythonChoice !== 'no') return;
    let cancelled = false;
    api
      .getPythonAgentInstallPlan(installVersion, pythonDetection?.packageManager)
      .then((plan) => {
        if (!cancelled) setInstallPlan(plan);
      })
      .catch((e) => {
        if (!cancelled) {
          setPythonStatus({
            kind: 'error',
            message: e instanceof Error ? e.message : 'Failed to build Python install command',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [installVersion, pythonChoice, pythonWizardOpen, pythonDetection?.packageManager]);

  const configurePython = async () => {
    if (opencodeSettingsMutationBlockMessage) {
      setPythonStatus({ kind: 'error', message: opencodeSettingsMutationBlockMessage });
      return;
    }
    if (!settings) return;
    const command = pythonChoice === 'yes' ? (selectedPython?.command ?? manualPythonPath) : '';
    const args = pythonChoice === 'yes' ? (selectedPython?.args ?? []) : [];
    if (!command.trim()) {
      setPythonStatus({ kind: 'error', message: 'Select a Python version or paste a path.' });
      return;
    }
    setPythonStatus({ kind: 'configuring' });
    try {
      const result = await api.configurePythonAgent(command.trim(), args);
      settingsSaveQueue.reset(result.settings);
      try {
        await restartOpencodeForConfig();
      } catch (e) {
        setPythonStatus({
          kind: 'error',
          message:
            e instanceof Error
              ? `Python configured, but OpenCode restart failed: ${e.message}`
              : 'Python configured, but OpenCode restart failed',
        });
        return;
      }
      setPythonWizardOpen(false);
      setPythonStatus({ kind: 'idle' });
    } catch (e) {
      setPythonStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to configure Python AI Agent',
      });
    }
  };

  const installPython = async () => {
    setPythonStatus({ kind: 'installing' });
    try {
      const result = await api.installPythonAgent(installVersion, pythonDetection?.packageManager);
      if (result.result.exitCode !== 0) {
        setPythonStatus({
          kind: 'error',
          message: result.result.stderr || result.result.stdout || 'Python install command failed',
        });
        return;
      }
      const detection = await api.detectPythonAgent();
      setPythonDetection(detection);
      setSelectedPythonId(detection.defaultId ?? detection.detected[0]?.id ?? '');
      setPythonChoice(detection.detected.length > 0 ? 'yes' : 'no');
      setPythonStatus({
        kind: 'installed',
        message: 'Install command finished. Detection refreshed.',
      });
    } catch (e) {
      setPythonStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to install Python',
      });
    }
  };

  const closePythonWizard = useCallback(() => {
    setPythonWizardOpen(false);
    setPythonStatus({ kind: 'idle' });
  }, []);

  return {
    // Echoed inputs.
    workDir,
    // Loaded data and request state.
    globalSettings,
    settings,
    declared,
    loading,
    saving,
    pythonSaving,
    error,
    applyStatus,
    diagnosticsStatus,
    diagnosticsBusy,
    diagnosticsCopied,
    // Global "Agent max steps" draft.
    agentMaxStepsDraft,
    setAgentMaxStepsDraft,
    globalSaving,
    agentMaxStepsSaved,
    setAgentMaxStepsSaved,
    agentMaxStepsDraftValid,
    agentMaxStepsChanged,
    // Derived guards shared by every section.
    hasWorkspace,
    opencodeSettingsMutationBlocked,
    opencodeSettingsMutationBlockMessage,
    settingsInputsDisabled,
    globalSettingsInputsDisabled,
    // Python wizard state and setters.
    pythonWizardOpen,
    pythonDetection,
    pythonChoice,
    selectedPythonId,
    manualPythonPath,
    installVersion,
    installPlan,
    pythonStatus,
    selectedPython,
    setPythonChoice,
    setSelectedPythonId,
    setManualPythonPath,
    setInstallVersion,
    closePythonWizard,
    // Actions.
    updateField,
    enableDiagnostics,
    disableDiagnostics,
    copyDiagnosticsInstructions,
    saveGlobalAgentMaxSteps,
    handleApply,
    openPythonWizard,
    handlePythonToggle,
    configurePython,
    installPython,
  };
}

export type EditorSettingsController = ReturnType<typeof useEditorSettingsController>;
