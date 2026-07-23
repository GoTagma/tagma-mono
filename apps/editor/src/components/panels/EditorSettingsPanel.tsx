import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { X, AlertTriangle, Loader2, CheckCircle2, RefreshCw, Terminal } from 'lucide-react';
import {
  api,
  type ChatDirtyConflictPolicy,
  type EditorSettings,
  type EditorViewMode,
  type GlobalSettings,
  type PluginDeclaredResult,
  type PluginRefreshResult,
  type PluginRegistry,
  type PythonDetectionResult,
  type PythonInstallPlan,
} from '../../api/client';
import { restartOpencodeForConfig } from '../../api/opencode-chat';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';
import {
  DEFAULT_OPENCODE_AGENT_MAX_STEPS,
  MAX_OPENCODE_AGENT_MAX_STEPS,
  MIN_OPENCODE_AGENT_MAX_STEPS,
} from '../../../shared/opencode-agent-step-limit.js';
import {
  DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS,
  MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS,
  MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS,
} from '../../../shared/chat-pipeline-repair-limit.js';

import {
  createEditorSettingsSaveQueue,
  type EditorSettingsSaveQueue,
} from './editor-settings-save-queue';

interface EditorSettingsPanelProps {
  workDir: string;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onClose: () => void;
}

type ApplyStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: PluginRefreshResult }
  | { kind: 'error'; message: string };

type PythonChoice = 'yes' | 'no';

type PythonWizardStatus =
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

export function EditorSettingsPanel({
  workDir,
  onRegistryUpdate,
  onClose,
}: EditorSettingsPanelProps) {
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
  const mountedRef = useRef(true);
  const settingsSaveQueueRef = useRef<EditorSettingsSaveQueue<EditorSettings> | null>(null);
  if (!settingsSaveQueueRef.current) {
    settingsSaveQueueRef.current = createEditorSettingsSaveQueue<EditorSettings>({
      persist: (patch) => api.updateEditorSettings(patch),
      onValue: (next) => {
        useEditorSettingsStore.getState().updateLocal(next);
        if (mountedRef.current) setSettings(next);
      },
      onSavingChange: (nextSaving) => {
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
  const modalRef = useModalFocusTrap<HTMLDivElement>();
  const opencodeSettingsMutationBlockMessage = useYamlEditLockStore(
    getOpencodeSettingsMutationBlockMessage,
  );

  const hasWorkspace = workDir.length > 0;
  const opencodeSettingsMutationBlocked = opencodeSettingsMutationBlockMessage !== null;
  const settingsInputsDisabled = !hasWorkspace || pythonSaving;

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
  }, []);

  const updateField = <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    if (!settings) return;
    if (!hasWorkspace) {
      setError('Open a workspace before changing editor settings.');
      return;
    }
    setError(null);
    settingsSaveQueue.update(key, value);
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

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell flex w-full max-w-[680px] flex-col border border-tagma-border bg-tagma-surface shadow-panel animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 id="editor-settings-title" className="panel-title">
            Editor Settings
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="modal-viewport-body space-y-4 px-5 py-4">
          {!hasWorkspace && (
            <WarnBox>
              Open a workspace first — editor settings are stored per workspace in{' '}
              <code>.tagma/editor-settings.json</code>.
            </WarnBox>
          )}

          {error && <ErrorBox>{error}</ErrorBox>}

          {loading && (
            <div className="flex items-center gap-2 text-[11px] text-tagma-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          )}

          {globalSettings && (
            <div>
              <label className="field-label">OpenCode agents</label>
              <div className="space-y-2 border border-tagma-border bg-tagma-bg px-2.5 py-2">
                <div className="text-[11px] text-tagma-text">Agent max steps</div>
                <p className="text-[10px] leading-relaxed text-tagma-muted">
                  Machine-wide upper limit for every Tagma-managed agent. Agents that finish early
                  stop immediately; this value does not force extra work. Applying a change restarts
                  OpenCode for the current workspace.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    aria-label="Agent max steps"
                    type="number"
                    min={MIN_OPENCODE_AGENT_MAX_STEPS}
                    max={MAX_OPENCODE_AGENT_MAX_STEPS}
                    step={1}
                    value={agentMaxStepsDraft}
                    disabled={globalSaving || pythonSaving || opencodeSettingsMutationBlocked}
                    onChange={(event) => {
                      setAgentMaxStepsDraft(event.target.value);
                      setAgentMaxStepsSaved(false);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        agentMaxStepsChanged &&
                        !globalSaving &&
                        !pythonSaving &&
                        !opencodeSettingsMutationBlocked
                      ) {
                        event.preventDefault();
                        void saveGlobalAgentMaxSteps();
                      } else if (event.key === 'Escape') {
                        setAgentMaxStepsDraft(String(globalSettings.opencodeAgentMaxSteps));
                        setAgentMaxStepsSaved(false);
                      }
                    }}
                    className="w-20 px-1.5 py-1 bg-tagma-surface border border-tagma-border text-tagma-text"
                  />
                  <button
                    type="button"
                    onClick={() => void saveGlobalAgentMaxSteps()}
                    disabled={
                      globalSaving ||
                      pythonSaving ||
                      opencodeSettingsMutationBlocked ||
                      !agentMaxStepsChanged
                    }
                    className="flex items-center gap-1.5 border border-tagma-accent/50 px-2.5 py-1 text-[11px] text-tagma-accent transition-colors hover:bg-tagma-accent/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {globalSaving && <Loader2 size={11} className="animate-spin" />}
                    Apply
                  </button>
                </div>
                <div className="min-h-4 text-[9px] text-tagma-muted">
                  {opencodeSettingsMutationBlockMessage
                    ? opencodeSettingsMutationBlockMessage
                    : !agentMaxStepsDraftValid
                      ? 'Enter a whole number from ' +
                        MIN_OPENCODE_AGENT_MAX_STEPS +
                        ' to ' +
                        MAX_OPENCODE_AGENT_MAX_STEPS +
                        '.'
                      : agentMaxStepsSaved
                        ? 'Saved globally.'
                        : 'Default ' +
                          DEFAULT_OPENCODE_AGENT_MAX_STEPS +
                          '; range ' +
                          MIN_OPENCODE_AGENT_MAX_STEPS +
                          '-' +
                          MAX_OPENCODE_AGENT_MAX_STEPS +
                          '.'}
                </div>
              </div>
            </div>
          )}

          {settings && (
            <>
              <div>
                <label className="field-label">Chat</label>
                <RadioGroupRow<ChatDirtyConflictPolicy>
                  label="When the agent edits a file you have unsaved changes to"
                  description="Chat-driven edits land on disk immediately. If the canvas has unsaved changes at the same time, this picks how to resolve the collision. Applies only when the file-watcher catches the conflict; the fallback path (Windows fs.watch drop) always preserves your canvas unless you set Prefer agent here."
                  value={settings.chatDirtyConflictPolicy}
                  disabled={settingsInputsDisabled}
                  onChange={(v) => updateField('chatDirtyConflictPolicy', v)}
                  options={[
                    {
                      value: 'ask',
                      label: 'Ask each time',
                      hint: 'Show a prompt and let me choose per incident.',
                    },
                    {
                      value: 'prefer-user',
                      label: 'Keep my edits',
                      hint: "Discard the agent's disk version; my canvas wins and overwrites disk on the next save.",
                    },
                    {
                      value: 'prefer-agent',
                      label: "Use the agent's changes",
                      hint: 'Silently adopt the disk version and discard my unsaved canvas edits.',
                    },
                  ]}
                />
                <div className="mt-2 space-y-2 border border-tagma-border bg-tagma-bg px-2.5 py-2">
                  <ToggleRow
                    label="Trial-run Chat pipeline changes"
                    description="On runs changed pipelines in the real workspace after they compile and before applying them. Off skips only the run; compilation, staging isolation, and conflict-safe finalization stay active."
                    checked={settings.opencodeChatTrialRunEnabled}
                    disabled={settingsInputsDisabled}
                    onChange={(v) => updateField('opencodeChatTrialRunEnabled', v)}
                  />
                  <div className="flex items-center gap-2 text-[11px]">
                    <label htmlFor="chat-pipeline-repair-attempts" className="text-tagma-muted">
                      Automatic repair attempts:
                    </label>
                    <input
                      id="chat-pipeline-repair-attempts"
                      type="number"
                      min={MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS}
                      max={MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS}
                      step={1}
                      value={settings.opencodeChatPipelineRepairMaxAttempts}
                      disabled={settingsInputsDisabled}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) {
                          const clamped = Math.max(
                            MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS,
                            Math.min(MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS, n),
                          );
                          void updateField('opencodeChatPipelineRepairMaxAttempts', clamped);
                        }
                      }}
                      className="w-16 px-1 py-0.5 bg-tagma-surface border border-tagma-border text-tagma-text disabled:opacity-50"
                    />
                    <span className="text-tagma-muted/70">
                      0 = off; default {DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS}; shared by compile
                      and trial run
                    </span>
                  </div>
                  <ToggleRow
                    label="Limit chat memory"
                    description="Off keeps unlimited conversation history in the active OpenCode session. On starts fresh sessions according to the round limit below."
                    checked={settings.chatContextLimitEnabled}
                    disabled={settingsInputsDisabled}
                    onChange={(v) => updateField('chatContextLimitEnabled', v)}
                  />
                  <div className="flex items-center gap-2 text-[11px]">
                    <label htmlFor="context-rounds" className="text-tagma-muted">
                      Context rounds:
                    </label>
                    <input
                      id="context-rounds"
                      type="number"
                      min={0}
                      max={200}
                      step={1}
                      value={settings.chatContextRounds}
                      disabled={settingsInputsDisabled || !settings.chatContextLimitEnabled}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) {
                          const clamped = Math.max(0, Math.min(200, n));
                          void updateField('chatContextRounds', clamped);
                        }
                      }}
                      className="w-16 px-1 py-0.5 bg-tagma-surface border border-tagma-border text-tagma-text disabled:opacity-50"
                    />
                    <span className="text-tagma-muted/70">
                      {settings.chatContextLimitEnabled
                        ? '0 = stateless, no history'
                        : 'Off = unlimited'}
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <label className="field-label">Python AI Agent</label>
                <ToggleRow
                  label="Enable Python AI Agent"
                  description="Configures a workspace-local Python environment for helper tools. Pipeline authoring still prefers native commands first; Python is used only when it keeps the workflow simpler."
                  checked={settings.pythonAgent.enabled}
                  disabled={
                    settingsInputsDisabled ||
                    saving ||
                    globalSaving ||
                    opencodeSettingsMutationBlocked
                  }
                  onChange={(v) => void handlePythonToggle(v)}
                />
                {settings.pythonAgent.enabled && (
                  <div className="mt-2 border border-tagma-border bg-tagma-bg p-2.5 space-y-1.5">
                    <div className="text-[10px] text-tagma-muted font-mono">
                      {settings.pythonAgent.interpreterCommand ?? 'python'}{' '}
                      {settings.pythonAgent.interpreterArgs.join(' ')}
                    </div>
                    <div className="text-[10px] text-tagma-muted font-mono">
                      venv: {settings.pythonAgent.venvPath ?? '.tagma/.python-agent/venv'}
                    </div>
                    <button
                      onClick={() => void openPythonWizard()}
                      disabled={
                        settingsInputsDisabled ||
                        saving ||
                        globalSaving ||
                        opencodeSettingsMutationBlocked
                      }
                      className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-border text-tagma-text hover:bg-tagma-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Terminal size={11} />
                      Reconfigure
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="field-label">Plugins</label>
                <ToggleRow
                  label="Auto-install declared plugins"
                  description="When opening this workspace, automatically install plugins listed in any of its YAML files (.tagma/*.yaml → pipeline.plugins) if they aren't already in node_modules. Off by default — auto-pulling npm packages is convenient for trusted personal workspaces but a security smell elsewhere."
                  checked={settings.autoInstallDeclaredPlugins}
                  disabled={settingsInputsDisabled}
                  onChange={(v) => updateField('autoInstallDeclaredPlugins', v)}
                />
                <div className="mt-2 border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
                  <DeclaredPreview declared={declared} />

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handleApply}
                      disabled={!hasWorkspace || applyStatus.kind === 'running'}
                      className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
                      title="Re-scan all YAMLs in this workspace and install/load any missing plugins. Affects plugins only — other settings above save instantly."
                    >
                      {applyStatus.kind === 'running' ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                      Install / Load Plugins
                    </button>
                    {!settings.autoInstallDeclaredPlugins && (
                      <span className="text-[9px] text-tagma-muted">
                        (toggle is off — only loads already-installed plugins)
                      </span>
                    )}
                  </div>

                  <ApplyResult status={applyStatus} />
                </div>
              </div>

              <div>
                <label className="field-label">Inspector</label>
                <RadioGroupRow<EditorViewMode>
                  label="View mode"
                  description="Production hides debug aids and infrastructure plumbing across Track, Task, and Pipeline inspectors — best for day-to-day pipeline operation. Debug surfaces every field while you're building or troubleshooting the pipeline."
                  value={settings.viewMode}
                  disabled={settingsInputsDisabled}
                  onChange={(v) => updateField('viewMode', v)}
                  options={[
                    {
                      value: 'production',
                      label: 'Production view',
                      hint: 'Compact inspectors. Hides inheritance hints, dataflow editor, lifecycle hooks, agent profile/permissions, and advanced trigger/completion config.',
                    },
                    {
                      value: 'debug',
                      label: 'Debug view',
                      hint: 'Show every field. Inheritance chains, conflict badges, port wiring, hooks — the full configuration surface.',
                    },
                  ]}
                />
              </div>

              <div>
                <label className="field-label">Autosave</label>
                <ToggleRow
                  label="Enable autosave"
                  description="Periodically write the flowchart to its YAML file. Saves are skipped while a run is active, while there is no file to save to, and within 2 seconds of your last keystroke."
                  checked={settings.autoSaveEnabled}
                  disabled={settingsInputsDisabled}
                  onChange={(v) => updateField('autoSaveEnabled', v)}
                />
                <div className="mt-2 flex items-center gap-2 text-[11px]">
                  <label htmlFor="autosave-interval" className="text-tagma-muted">
                    Interval (seconds):
                  </label>
                  <input
                    id="autosave-interval"
                    type="number"
                    min={5}
                    max={600}
                    step={5}
                    value={settings.autoSaveIntervalSec}
                    disabled={settingsInputsDisabled || !settings.autoSaveEnabled}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value, 10);
                      if (Number.isFinite(n)) {
                        const clamped = Math.max(5, Math.min(600, n));
                        void updateField('autoSaveIntervalSec', clamped);
                      }
                    }}
                    className="w-16 px-1 py-0.5 bg-tagma-surface border border-tagma-border text-tagma-text"
                  />
                  <span className="text-tagma-muted/70">(default 30, range 5–600)</span>
                </div>
              </div>
            </>
          )}

          <div className="border-t border-tagma-border" />

          <div className="space-y-0.5 text-[10px] text-tagma-muted font-mono">
            <div>
              Global: <code>~/.tagma/global-settings.json</code>
              {globalSaving ? ' · saving…' : ''}
            </div>
            <div>
              Workspace: <code>.tagma/editor-settings.json</code>
              {saving || pythonSaving ? ' · saving…' : ''}
            </div>
          </div>
        </div>
      </div>
      {settings && pythonWizardOpen && (
        <PythonAgentWizard
          detection={pythonDetection}
          choice={pythonChoice}
          selectedId={selectedPythonId}
          manualPath={manualPythonPath}
          installVersion={installVersion}
          installPlan={installPlan}
          status={pythonStatus}
          opencodeSettingsMutationBlockMessage={opencodeSettingsMutationBlockMessage}
          onChoice={setPythonChoice}
          onSelectedId={setSelectedPythonId}
          onManualPath={setManualPythonPath}
          onInstallVersion={setInstallVersion}
          onClose={() => {
            setPythonWizardOpen(false);
            setPythonStatus({ kind: 'idle' });
          }}
          onConfigure={() => void configurePython()}
          onInstall={() => void installPython()}
        />
      )}
    </div>
  );
}

interface PythonAgentWizardProps {
  detection: PythonDetectionResult | null;
  choice: PythonChoice;
  selectedId: string;
  manualPath: string;
  installVersion: string;
  installPlan: PythonInstallPlan | null;
  status: PythonWizardStatus;
  opencodeSettingsMutationBlockMessage: string | null;
  onChoice: (choice: PythonChoice) => void;
  onSelectedId: (id: string) => void;
  onManualPath: (path: string) => void;
  onInstallVersion: (version: string) => void;
  onClose: () => void;
  onConfigure: () => void;
  onInstall: () => void;
}

function PythonAgentWizard({
  detection,
  choice,
  selectedId,
  manualPath,
  installVersion,
  installPlan,
  status,
  opencodeSettingsMutationBlockMessage,
  onChoice,
  onSelectedId,
  onManualPath,
  onInstallVersion,
  onClose,
  onConfigure,
  onInstall,
}: PythonAgentWizardProps) {
  const busy =
    status.kind === 'detecting' || status.kind === 'configuring' || status.kind === 'installing';
  const detected = detection?.detected ?? [];
  const selected = detected.find((item) => item.id === selectedId) ?? null;
  const commandPreview =
    choice === 'yes'
      ? selected
        ? [selected.command, ...selected.args].join(' ')
        : manualPath
      : (installPlan?.command.join(' ') ?? '');
  const wizardModalRef = useModalFocusTrap<HTMLDivElement>();

  return (
    <div
      className="modal-viewport-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={wizardModalRef}
        className="modal-viewport-shell flex w-full max-w-[520px] flex-col border border-tagma-border bg-tagma-surface shadow-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="python-agent-wizard-title"
        tabIndex={-1}
      >
        <div className="panel-header">
          <h3 id="python-agent-wizard-title" className="panel-title">
            Python AI Agent
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close"
            disabled={busy}
          >
            <X size={14} />
          </button>
        </div>
        <div className="modal-viewport-body space-y-4 px-5 py-4">
          {opencodeSettingsMutationBlockMessage && (
            <WarnBox>{opencodeSettingsMutationBlockMessage}</WarnBox>
          )}
          <RadioGroupRow<PythonChoice>
            label="Is Python already installed on this device?"
            description={
              detection
                ? detected.length > 0
                  ? `${detected.length} Python installation${detected.length === 1 ? '' : 's'} detected.`
                  : 'No Python installation was detected.'
                : 'Detection is running.'
            }
            value={choice}
            disabled={busy}
            onChange={onChoice}
            options={[
              {
                value: 'yes',
                label: 'Yes',
                hint: 'Use a detected Python version or paste an interpreter path.',
              },
              {
                value: 'no',
                label: 'No',
                hint: 'Install Python through the platform package manager.',
              },
            ]}
          />

          {choice === 'yes' && (
            <div className="border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
              {detected.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-[10px] text-tagma-muted">Detected versions</div>
                  <select
                    className="w-full px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text"
                    value={selectedId}
                    disabled={busy}
                    onChange={(e) => onSelectedId(e.target.value)}
                  >
                    {detected.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.version} · {item.command} {item.args.join(' ')}
                        {item.default ? ' · default' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-1">
                  <label htmlFor="python-path" className="text-[10px] text-tagma-muted">
                    Python interpreter path
                  </label>
                  <input
                    id="python-path"
                    className="w-full px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text font-mono"
                    value={manualPath}
                    disabled={busy}
                    onChange={(e) => onManualPath(e.target.value)}
                    placeholder="C:\\Python313\\python.exe"
                  />
                </div>
              )}
              <button
                onClick={onConfigure}
                disabled={
                  busy ||
                  !!opencodeSettingsMutationBlockMessage ||
                  (!selected && manualPath.trim().length === 0)
                }
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {status.kind === 'configuring' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <CheckCircle2 size={11} />
                )}
                Configure
              </button>
            </div>
          )}

          {choice === 'no' && (
            <div className="border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <label htmlFor="python-version" className="text-[10px] text-tagma-muted">
                  Version
                </label>
                <input
                  id="python-version"
                  className="w-20 px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text"
                  value={installVersion}
                  disabled={busy}
                  onChange={(e) => onInstallVersion(e.target.value)}
                />
              </div>
              {installPlan && (
                <div className="font-mono text-[10px] text-tagma-muted border border-tagma-border/60 bg-black/10 px-2 py-1 break-all">
                  {installPlan.command.join(' ')}
                </div>
              )}
              <button
                onClick={onInstall}
                disabled={busy || !installPlan}
                className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {status.kind === 'installing' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Terminal size={11} />
                )}
                Install Python
              </button>
            </div>
          )}

          {commandPreview && (
            <div className="text-[10px] text-tagma-muted font-mono">command: {commandPreview}</div>
          )}
          {status.kind === 'detecting' && (
            <div className="flex items-center gap-1.5 text-[10px] text-tagma-muted">
              <Loader2 size={10} className="animate-spin" />
              Detecting Python...
            </div>
          )}
          {status.kind === 'installed' && (
            <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5 text-[10px] text-tagma-success/90">
              {status.message}
            </div>
          )}
          {status.kind === 'error' && <ErrorBox>{status.message}</ErrorBox>}
        </div>
      </div>
    </div>
  );
}

function DeclaredPreview({ declared }: { declared: PluginDeclaredResult | null }) {
  if (!declared) {
    return <div className="text-[10px] text-tagma-muted">Scanning workspace YAMLs…</div>;
  }
  if (declared.declared.length === 0) {
    return (
      <div className="text-[10px] text-tagma-muted">
        No plugins declared in any YAML under <code>.tagma/</code> in this workspace.
      </div>
    );
  }
  const installedSet = new Set(declared.installed);
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-tagma-muted">
        {declared.declared.length} declared plugin{declared.declared.length !== 1 ? 's' : ''}
        {' across all YAMLs · '}
        <span className="text-tagma-success">{declared.installed.length} installed</span>
        {' · '}
        <span className={declared.missing.length > 0 ? 'text-tagma-warning' : 'text-tagma-muted'}>
          {declared.missing.length} missing
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {declared.declared.map((name) => {
          const isInstalled = installedSet.has(name);
          return (
            <span
              key={name}
              className={
                'text-[9px] font-mono px-1.5 py-0.5 border ' +
                (isInstalled
                  ? 'text-tagma-success border-tagma-success/40 bg-tagma-success/5'
                  : 'text-tagma-warning border-tagma-warning/40 bg-tagma-warning/5')
              }
              title={
                isInstalled ? 'Installed' : 'Missing — click Install / Load Plugins to install'
              }
            >
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

interface RadioGroupRowProps<T extends string> {
  label: string;
  description: string;
  value: T;
  disabled?: boolean;
  onChange: (next: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint: string }>;
}

function RadioGroupRow<T extends string>({
  label,
  description,
  value,
  disabled,
  onChange,
  options,
}: RadioGroupRowProps<T>) {
  return (
    <div
      className={`px-2.5 py-2 border border-tagma-border bg-tagma-bg ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="text-[11px] text-tagma-text">{label}</div>
      <div className="text-[10px] text-tagma-muted mt-0.5 mb-2 leading-snug">{description}</div>
      <div className="space-y-1">
        {options.map((opt) => {
          const checked = opt.value === value;
          return (
            <label
              key={opt.value}
              className={`flex items-start gap-2 px-1.5 py-1 border ${checked ? 'border-tagma-accent/50 bg-tagma-accent/5' : 'border-transparent hover:border-tagma-border/60'} ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                className="mt-[2px] accent-tagma-accent"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(opt.value)}
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-tagma-text">{opt.label}</div>
                <div className="text-[10px] text-tagma-muted leading-snug">{opt.hint}</div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ label, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <label
      className={`flex items-start gap-3 px-2.5 py-2 border border-tagma-border bg-tagma-bg ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-tagma-border/80'}`}
    >
      <input
        type="checkbox"
        className="mt-[2px] accent-tagma-accent"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-tagma-text">{label}</div>
        <div className="text-[10px] text-tagma-muted mt-0.5 leading-snug">{description}</div>
      </div>
    </label>
  );
}

function ApplyResult({ status }: { status: ApplyStatus }) {
  if (status.kind === 'idle' || status.kind === 'running') return null;

  if (status.kind === 'error') {
    return (
      <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
        <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
          <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
          <span>{status.message}</span>
        </div>
      </div>
    );
  }

  const { result } = status;
  const installedCount = result.installed.length;
  const loadedCount = result.loaded.length;
  const missingCount = result.missing.length;
  const errorCount = result.errors.length;
  const declaredCount = result.declared.length;
  const nothingHappened = installedCount === 0 && loadedCount === 0 && errorCount === 0;

  return (
    <div className="space-y-1.5">
      <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5">
        <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
          <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
          <div className="space-y-0.5">
            {installedCount > 0 && (
              <div>
                Installed {installedCount}: {result.installed.join(', ')}
              </div>
            )}
            {loadedCount > 0 && (
              <div>
                Loaded {loadedCount}: {result.loaded.join(', ')}
              </div>
            )}
            {nothingHappened && missingCount === 0 && (
              <div>
                {declaredCount === 0
                  ? 'No plugins declared in this workspace.'
                  : 'All declared plugins were already installed and loaded.'}
              </div>
            )}
          </div>
        </div>
      </div>
      {missingCount > 0 && (
        <div className="bg-tagma-warning/8 border border-tagma-warning/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-warning/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-warning shrink-0 mt-[1px]" />
            <div className="space-y-0.5">
              <div>
                Still missing ({missingCount}): {result.missing.join(', ')}
              </div>
              {!result.settings.autoInstallDeclaredPlugins && (
                <div className="text-tagma-warning/70">
                  Turn on "Auto-install declared plugins" to install them.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {errorCount > 0 && (
        <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
            <div className="space-y-0.5">
              {result.errors.map((err, i) => (
                <div key={`${err.name}-${i}`}>
                  <span className="text-tagma-error">{err.name}:</span> {err.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-warning/8 border border-tagma-warning/30 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-warning/90 font-mono">
        <AlertTriangle size={10} className="text-tagma-warning shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-error/8 border border-tagma-error/30 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
        <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}
