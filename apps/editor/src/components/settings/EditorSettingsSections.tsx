import type { ReactNode } from 'react';
import { X, AlertTriangle, Loader2, CheckCircle2, RefreshCw, Terminal } from 'lucide-react';
import {
  type ChatDirtyConflictPolicy,
  type EditorViewMode,
  type PluginDeclaredResult,
} from '../../api/client';
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

import { DiagnosticsSettingsSection } from '../panels/DiagnosticsSettingsSection';
import type { ApplyStatus, EditorSettingsController } from './use-editor-settings-controller';

/**
 * Settings categories drive the page sidebar (settings/EditorSettingsPage.tsx)
 * and double as the filter for `EditorSettingsSections`. The order here is the
 * render order everywhere.
 */
export type SettingsCategory =
  | 'opencode-agents'
  | 'diagnostics'
  | 'chat'
  | 'python-agent'
  | 'plugins'
  | 'inspector'
  | 'autosave';

export const SETTINGS_CATEGORIES: ReadonlyArray<{ id: SettingsCategory; label: string }> = [
  { id: 'opencode-agents', label: 'OpenCode Agents' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'chat', label: 'Chat' },
  { id: 'python-agent', label: 'Python AI Agent' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'autosave', label: 'Autosave' },
];

interface EditorSettingsSectionsProps {
  controller: EditorSettingsController;
  /** When set, only the listed categories render. Defaults to all categories. */
  categories?: readonly SettingsCategory[];
}

/**
 * The settings form body shared by the classic modal and the full settings
 * page. Workspace/error/loading notices always render on top; each section is
 * gated by the `categories` filter so the page can show one category at a time
 * while the modal stacks them all.
 */
export function EditorSettingsSections({ controller, categories }: EditorSettingsSectionsProps) {
  const {
    globalSettings,
    settings,
    declared,
    loading,
    saving,
    pythonSaving,
    globalSaving,
    error,
    applyStatus,
    diagnosticsStatus,
    diagnosticsBusy,
    diagnosticsCopied,
    agentMaxStepsDraft,
    setAgentMaxStepsDraft,
    agentMaxStepsSaved,
    setAgentMaxStepsSaved,
    agentMaxStepsDraftValid,
    agentMaxStepsChanged,
    hasWorkspace,
    opencodeSettingsMutationBlocked,
    opencodeSettingsMutationBlockMessage,
    settingsInputsDisabled,
    globalSettingsInputsDisabled,
    updateField,
    enableDiagnostics,
    disableDiagnostics,
    copyDiagnosticsInstructions,
    saveGlobalAgentMaxSteps,
    handleApply,
    openPythonWizard,
    handlePythonToggle,
  } = controller;
  const show = (id: SettingsCategory) => !categories || categories.includes(id);

  return (
    <>
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

      {show('opencode-agents') && globalSettings && (
        <div>
          <label className="field-label">OpenCode agents</label>
          <div className="space-y-2 border border-tagma-border bg-tagma-bg px-2.5 py-2">
            <div className="text-[11px] text-tagma-text">Agent max steps</div>
            <p className="text-[10px] leading-relaxed text-tagma-muted">
              Machine-wide upper limit for every Tagma-managed agent. Agents that finish early stop
              immediately; this value does not force extra work. Applying a change restarts OpenCode
              for the current workspace.
            </p>
            <div className="flex items-center gap-2">
              <input
                aria-label="Agent max steps"
                type="number"
                min={MIN_OPENCODE_AGENT_MAX_STEPS}
                max={MAX_OPENCODE_AGENT_MAX_STEPS}
                step={1}
                value={agentMaxStepsDraft}
                disabled={globalSettingsInputsDisabled}
                onChange={(event) => {
                  setAgentMaxStepsDraft(event.target.value);
                  setAgentMaxStepsSaved(false);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    agentMaxStepsChanged &&
                    !globalSettingsInputsDisabled
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
                disabled={globalSettingsInputsDisabled || !agentMaxStepsChanged}
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

      {show('diagnostics') && (
        <DiagnosticsSettingsSection
          status={diagnosticsStatus}
          busy={diagnosticsBusy}
          copied={diagnosticsCopied}
          hasWorkspace={hasWorkspace}
          currentWorkspace={controller.workDir}
          onEnable={() => void enableDiagnostics()}
          onDisable={() => void disableDiagnostics()}
          onCopy={() => void copyDiagnosticsInstructions()}
        />
      )}

      {settings && show('chat') && (
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
              description="On runs AI-authored staged pipeline commands in your real workspace before finalization. They execute with normal host command authority and may modify files or external state. Off skips only execution; compilation, staging isolation, and conflict-safe finalization stay active."
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
                0 = off; default {DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS}; compile and
                executed-trial repair budget; it does not run the pipeline this many times.
                Trial-plan authoring is separately limited to two attempts per YAML revision.
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
                {settings.chatContextLimitEnabled ? '0 = stateless, no history' : 'Off = unlimited'}
              </span>
            </div>
          </div>
        </div>
      )}

      {settings && show('python-agent') && (
        <div>
          <label className="field-label">Python AI Agent</label>
          <ToggleRow
            label="Enable Python AI Agent"
            description="Configures a workspace-local Python environment for helper tools. Pipeline authoring still prefers native commands first; Python is used only when it keeps the workflow simpler."
            checked={settings.pythonAgent.enabled}
            disabled={
              settingsInputsDisabled || saving || globalSaving || opencodeSettingsMutationBlocked
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
      )}

      {settings && show('plugins') && (
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
      )}

      {settings && show('inspector') && (
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
      )}

      {settings && show('autosave') && (
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
      )}
    </>
  );
}

/** Persistence locations + per-store saving indicators, shown at the bottom. */
export function SettingsStorageFooter({ controller }: { controller: EditorSettingsController }) {
  const { saving, pythonSaving, globalSaving } = controller;
  return (
    <>
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
    </>
  );
}

/** Secondary modal for detecting/configuring/installing the Python agent. */
export function PythonAgentWizard({ controller }: { controller: EditorSettingsController }) {
  const {
    settings,
    pythonWizardOpen,
    pythonDetection: detection,
    pythonChoice: choice,
    selectedPythonId: selectedId,
    manualPythonPath: manualPath,
    installVersion,
    installPlan,
    pythonStatus: status,
    opencodeSettingsMutationBlockMessage,
    setPythonChoice: onChoice,
    setSelectedPythonId: onSelectedId,
    setManualPythonPath: onManualPath,
    setInstallVersion: onInstallVersion,
    closePythonWizard: onClose,
    configurePython,
    installPython,
  } = controller;
  const wizardModalRef = useModalFocusTrap<HTMLDivElement>();

  if (!settings || !pythonWizardOpen) return null;

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
                onClick={() => void configurePython()}
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
                <div className="font-mono text-[10px] text-tagma-muted border border-tagma-border/60 bg-tagma-bg px-2 py-1 break-all">
                  {installPlan.command.join(' ')}
                </div>
              )}
              <button
                onClick={() => void installPython()}
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
              title={isInstalled ? 'Installed' : 'Missing — click Install / Load Plugins to install'}
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
