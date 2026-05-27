import { useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Trash2,
  Terminal,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  ShieldAlert,
  FolderOpen,
  Pin,
  Eye,
} from 'lucide-react';
import type {
  CommandConfig,
  RawTaskConfig,
  RawPipelineConfig,
  RawTrackConfig,
  TriggerConfig,
  CompletionConfig,
  TaskInputBindings,
  TaskOutputBindings,
  DiagnosticItem,
} from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { useDriverCapability } from '../../hooks/use-driver-capability';
import { MiddlewareEditor } from './MiddlewareEditor';
import { PortsEditor } from './PortsEditor';
import {
  buildDownstreamPortsReport,
  buildInferredPromptPorts,
  buildUpstreamPortsReport,
  computeSyncedInputs,
  computeSyncedOutputs,
  inputBindingsToPorts,
  mergeInputPortsIntoBindings,
  mergeOutputPortsIntoBindings,
  outputBindingsToPorts,
} from '../../utils/ports';
import { isCommandTaskConfig } from '@tagma/types';
import {
  InheritedValue,
  ResetButton,
  resolveScalar,
  resolvePermissions,
  permsToString,
} from './InheritedValue';
import { ConfirmDialog } from './ConfirmDialog';
import { ModifiedBadge } from './ModifiedBadge';
import { findSavedTask, isTaskFieldModified } from '../../utils/dirty-tracking';
import { SchemaForm, getBuiltinSchema } from './SchemaForm';
import { FieldHelpButton } from './FieldHelpButton';
import { CopyableField } from './CopyableField';
import { InspectorModelField, isBuiltinOpencodeDriver } from './InspectorModelField';
import {
  DEFAULT_COMPLETION_TYPE,
  getEffectiveCompletionType,
  normalizeCompletionForEditor,
} from './completion-defaults';
import { FileExplorer } from '../FileExplorer';
import type { FileExplorerMode } from '../FileExplorer';

function commandToEditorText(command: CommandConfig | undefined): string {
  if (!command) return '';
  if (typeof command === 'string') return command;
  return JSON.stringify(command);
}

function parseCommandEditorText(value: string): CommandConfig {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (('shell' in parsed && typeof (parsed as { shell?: unknown }).shell === 'string') ||
        ('argv' in parsed &&
          Array.isArray((parsed as { argv?: unknown }).argv) &&
          (parsed as { argv: unknown[] }).argv.every((arg) => typeof arg === 'string')))
    ) {
      return parsed as CommandConfig;
    }
  } catch {
    /* keep as shell text */
  }
  return value;
}
import { resolveDependencyLocateTarget } from '../../utils/dependency-locate';

const KNOWN_TRIGGER_TYPES = new Set(['manual', 'file']);
const KNOWN_COMPLETION_TYPES = new Set(['exit_code', 'file_exists', 'output_check']);

// TriggerConfig / CompletionConfig carry `[key: string]: unknown` so any
// indexed lookup on them returns `unknown`. These tiny narrowing helpers
// let the JSX stay readable without a cast at every call site.
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * H7: Inline conflict banner shown when an external file change brought a
 * new server value for a field while the user had uncommitted edits. Lets
 * the user keep their typing or accept the incoming server version without
 * losing context. Without this, the local-field hook silently kept local
 * edits and there was no UI affordance to reconcile.
 */
function FieldConflictBadge({
  changed,
  onDiscard,
  onAccept,
}: {
  changed: boolean;
  onDiscard: () => void;
  onAccept: () => void;
}) {
  if (!changed) return null;
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1 mb-1 bg-tagma-warning/10 border border-tagma-warning/40 text-[10px]">
      <div className="flex items-center gap-1.5 text-tagma-warning min-w-0">
        <AlertTriangle size={10} className="shrink-0" />
        <span className="truncate">External change available</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onDiscard}
          className="px-1.5 py-0.5 hover:bg-tagma-warning/20 text-tagma-warning"
          title="Adopt the external change, discarding local edits"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onAccept}
          className="px-1.5 py-0.5 hover:bg-tagma-warning/20 text-tagma-warning"
          title="Keep local edits and overwrite the external change"
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}

/** Merge builtin + registry plugin list into a unique, sorted option list. */
function mergeTypeOptions(builtin: string[], registry: string[]): string[] {
  const set = new Set<string>([...builtin, ...registry]);
  return Array.from(set);
}

interface TaskConfigPanelProps {
  task: RawTaskConfig;
  trackId: string;
  qualifiedId: string;
  pipelineConfig: RawPipelineConfig;
  dependencies: string[];
  drivers: string[];
  errors: DiagnosticItem[];
  onUpdateTask: (trackId: string, taskId: string, patch: Partial<RawTaskConfig>) => void;
  onDeleteTask: (trackId: string, taskId: string) => void;
  onRemoveDependency: (trackId: string, taskId: string, depRef: string) => void;
  isPinned: boolean;
  onTogglePin: () => void;
}

/** Find the enclosing track for a task panel. */
function findTrack(trackId: string, config: RawPipelineConfig): RawTrackConfig | undefined {
  return config.tracks.find((t) => t.id === trackId);
}

export function TaskConfigPanel({
  task,
  trackId,
  qualifiedId,
  pipelineConfig,
  dependencies,
  drivers,
  errors,
  onUpdateTask,
  onDeleteTask,
  onRemoveDependency,
  isPinned,
  onTogglePin,
}: TaskConfigPanelProps) {
  const mode: 'prompt' | 'command' = isCommandTaskConfig(task) ? 'command' : 'prompt';
  const isDebugView =
    useEditorSettingsStore((s) => s.settings?.viewMode ?? 'production') === 'debug';
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTrackProfile, setShowTrackProfile] = useState(false);
  const [fileBrowser, setFileBrowser] = useState<{
    mode: FileExplorerMode;
    initialPath?: string;
    onSelect: (path: string) => void;
  } | null>(null);

  const track = findTrack(trackId, pipelineConfig);
  const trackName = track?.name ?? trackId;

  // Saved-on-disk baseline for this task. `null` until the first load
  // completes, or when the task itself was added since the last save —
  // both mean "no clean baseline to compare against", which the
  // `isTaskFieldModified` helper handles by treating any populated value
  // as modified.
  const savedConfig = usePipelineStore((s) => s.savedConfig);
  const savedTask = useMemo(
    () => findSavedTask(savedConfig, trackId, task.id),
    [savedConfig, trackId, task.id],
  );
  const isFieldModified = useCallback(
    (key: keyof RawTaskConfig) => isTaskFieldModified(savedTask, task, key),
    [savedTask, task],
  );

  // Resolved inherited values (task → track → pipeline → default).
  const resolvedDriver = useMemo(
    () => resolveScalar(task.driver, track?.driver, pipelineConfig.driver, 'opencode'),
    [task.driver, track?.driver, pipelineConfig.driver],
  );
  const resolvedModel = useMemo(
    () => resolveScalar(task.model, track?.model, pipelineConfig.model, undefined),
    [task.model, track?.model, pipelineConfig.model],
  );
  const resolvedReasoning = useMemo(
    () =>
      resolveScalar(
        task.reasoning_effort,
        track?.reasoning_effort,
        pipelineConfig.reasoning_effort,
        undefined,
      ),
    [task.reasoning_effort, track?.reasoning_effort, pipelineConfig.reasoning_effort],
  );
  const resolvedAgentProfile = useMemo(
    () => resolveScalar(task.agent_profile, track?.agent_profile, undefined),
    [task.agent_profile, track?.agent_profile],
  );
  const resolvedCwd = useMemo(
    () => resolveScalar(task.cwd, track?.cwd, undefined, '.'),
    [task.cwd, track?.cwd],
  );
  const resolvedTimeout = useMemo(
    () => resolveScalar(task.timeout, undefined, pipelineConfig.timeout, undefined),
    [task.timeout, pipelineConfig.timeout],
  );
  const resolvedPerms = useMemo(
    () => resolvePermissions(task.permissions, track?.permissions),
    [task.permissions, track?.permissions],
  );
  const dependencyLocateTargets = useMemo(() => {
    const targets = new Map<string, string | null>();
    for (const dep of dependencies) {
      targets.set(dep, resolveDependencyLocateTarget(pipelineConfig, trackId, dep));
    }
    return targets;
  }, [dependencies, pipelineConfig, trackId]);

  // Typed-ports report — what direct upstreams export, where the current
  // inputs drifted from them, and which names are ambiguous across
  // multiple producers. Recomputed whenever the pipeline config or this
  // task's qid changes. Memoized so re-rendering the panel on unrelated
  // store updates (log stream, runtime status) doesn't re-walk the DAG.
  const upstreamReport = useMemo(
    () => buildUpstreamPortsReport(pipelineConfig, qualifiedId),
    [pipelineConfig, qualifiedId],
  );
  const syncNewCount = useMemo(() => {
    const declared = new Set(Object.keys(task.inputs ?? {}));
    const available = new Set(upstreamReport.candidates.map((c) => c.port.name));
    let n = 0;
    for (const name of available) if (!declared.has(name)) n++;
    return n;
  }, [task.inputs, upstreamReport.candidates]);

  // Reverse direction: downstream tasks declare inputs that this task
  // could fulfil by exporting outputs. `syncNewOutputCount` counts how
  // many NEW outputs would be adopted (names the downstream already
  // wants but this task hasn't declared yet). Zero hides the button.
  const downstreamReport = useMemo(
    () => buildDownstreamPortsReport(pipelineConfig, qualifiedId),
    [pipelineConfig, qualifiedId],
  );
  const syncNewOutputCount = useMemo(() => {
    const declared = new Set(Object.keys(task.outputs ?? {}));
    const wanted = new Set(downstreamReport.candidates.map((c) => c.port.name));
    let n = 0;
    for (const name of wanted) if (!declared.has(name)) n++;
    return n;
  }, [task.outputs, downstreamReport.candidates]);

  // For Prompt Tasks, derive the inferred port view the engine will use
  // at runtime: inputs from direct-upstream Commands, outputs from
  // direct-downstream Commands. Memoized so the inspector doesn't walk
  // the DAG on every unrelated store tick (logs, status transitions).
  const inferredPromptPorts = useMemo(
    () => (mode === 'prompt' ? buildInferredPromptPorts(pipelineConfig, qualifiedId) : null),
    [mode, pipelineConfig, qualifiedId],
  );

  const registry = usePipelineStore((s) => s.registry);
  const triggerOptions = mergeTypeOptions(['manual', 'file'], registry.triggers);
  const completionOptions = mergeTypeOptions(
    ['exit_code', 'file_exists', 'output_check'],
    registry.completions,
  );
  const effectiveCompletionType = getEffectiveCompletionType(task.completion);

  // F2/G5: look up the resolved driver's capabilities for the current task.
  // Used below to surface inline warnings next to `agent_profile` and
  // `continue_from` when the driver cannot honor them.
  const driverCaps = useDriverCapability(resolvedDriver.value);
  const systemPromptUnsupported = driverCaps ? driverCaps.systemPrompt === false : false;
  const sessionResumeUnsupported = driverCaps ? driverCaps.sessionResume === false : false;

  const commitField = useCallback(
    (patch: Partial<RawTaskConfig>) => {
      onUpdateTask(trackId, task.id, patch);
    },
    [trackId, task.id, onUpdateTask],
  );

  const handleBindingsChange = useCallback(
    (next: {
      inputs?: TaskInputBindings | undefined;
      outputs?: TaskOutputBindings | undefined;
    }) => {
      commitField({ inputs: next.inputs, outputs: next.outputs });
    },
    [commitField],
  );

  const handleSyncInputsFromUpstream = useCallback(() => {
    const nextInputs = computeSyncedInputs(
      inputBindingsToPorts(task.inputs),
      upstreamReport.candidates,
    );
    handleBindingsChange({
      inputs: mergeInputPortsIntoBindings(task.inputs, nextInputs),
      outputs: task.outputs,
    });
  }, [task.inputs, task.outputs, upstreamReport.candidates, handleBindingsChange]);

  const handleSyncOutputsFromDownstream = useCallback(() => {
    const nextOutputs = computeSyncedOutputs(
      outputBindingsToPorts(task.outputs),
      downstreamReport.candidates,
    );
    handleBindingsChange({
      inputs: task.inputs,
      outputs: mergeOutputPortsIntoBindings(task.outputs, nextOutputs),
    });
  }, [task.inputs, task.outputs, downstreamReport.candidates, handleBindingsChange]);

  const openFileBrowser = useCallback(
    (mode: FileExplorerMode, currentValue: string, onSelect: (path: string) => void) => {
      setFileBrowser({ mode, initialPath: currentValue || undefined, onSelect });
    },
    [],
  );
  const handleLocateDependency = useCallback((targetQid: string) => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: targetQid }));
    });
  }, []);

  const handleLocateSelf = useCallback(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qualifiedId }));
    });
  }, [qualifiedId]);

  // H7: useLocalField exposes `serverChanged` / `discardLocal` / `acceptLocal`
  // as extras on the returned tuple so existing 3-element destructuring still
  // works. We grab the full result for the high-traffic fields (name, prompt,
  // command) so the user can resolve a server-vs-local conflict without
  // losing their in-progress edits when an external file change arrives.
  const nameField = useLocalField(task.name ?? '', (v) => commitField({ name: v }));
  const [name, setName, blurName] = nameField;
  const promptField = useLocalField(task.prompt ?? '', (v) => commitField({ prompt: v }));
  const [prompt, setPrompt, blurPrompt] = promptField;
  const commandField = useLocalField(commandToEditorText(task.command), (v) =>
    commitField({ command: parseCommandEditorText(v) }),
  );
  const [command, setCommand, blurCommand] = commandField;
  const handleDriverChange = useCallback(
    (value: string) => {
      onUpdateTask(trackId, task.id, { driver: value || undefined });
    },
    [trackId, task.id, onUpdateTask],
  );
  const [timeout, setTimeout_, blurTimeout] = useLocalField(task.timeout ?? '', (v) =>
    commitField({ timeout: v || undefined }),
  );
  const [agentProfile, setAgentProfile, blurAgentProfile] = useLocalField(
    task.agent_profile ?? '',
    (v) => commitField({ agent_profile: v || undefined }),
  );
  const [cwd, setCwd, blurCwd] = useLocalField(task.cwd ?? '', (v) =>
    commitField({ cwd: v || undefined }),
  );
  const [model, setModel, blurModel] = useLocalField(task.model ?? '', (v) =>
    commitField({ model: v || undefined }),
  );

  const handlePermToggle = useCallback(
    (key: 'read' | 'write' | 'execute') => {
      const current = task.permissions ?? { read: false, write: false, execute: false };
      const next = { ...current, [key]: !current[key] };
      if (!next.read && !next.write && !next.execute) {
        commitField({ permissions: undefined });
      } else {
        commitField({ permissions: next });
      }
    },
    [task.permissions, commitField],
  );

  const handleTriggerTypeChange = useCallback(
    (type: string) => {
      if (!type) {
        commitField({ trigger: undefined });
      } else {
        commitField({ trigger: { type } as TriggerConfig });
      }
    },
    [commitField],
  );

  const handleTriggerField = useCallback(
    (field: string, value: string) => {
      const current = task.trigger ?? { type: 'manual' };
      const next = { ...current, [field]: value || undefined };
      commitField({ trigger: next });
    },
    [task.trigger, commitField],
  );

  const handleCompletionTypeChange = useCallback(
    (type: string) => {
      const next = normalizeCompletionForEditor({ type } as CompletionConfig);
      commitField({ completion: next });
    },
    [commitField],
  );

  const handleCompletionField = useCallback(
    (field: string, value: unknown) => {
      const current = task.completion ?? { type: DEFAULT_COMPLETION_TYPE };
      const next = normalizeCompletionForEditor({ ...current, [field]: value } as CompletionConfig);
      commitField({ completion: next });
    },
    [task.completion, commitField],
  );

  const handleContinueFromChange = useCallback(
    (v: string) => {
      commitField({ continue_from: v || undefined });
    },
    [commitField],
  );

  // F7: continue_from candidates — widen to any upstream dependency. The SDK
  // accepts continue_from when upstream driver supports parseResult, or
  // downstream driver supports session resume. The client can't perfectly
  // know driver capabilities yet (TODO: expose DriverCapabilities via
  // /api/registry) so we let server-side validation report incompatibility
  // and offer every upstream dep as a candidate.
  const continueFromCandidates = dependencies;
  const downstreamTasksThatDependOnMe = useMemo(() => {
    const out: { trackId: string; taskId: string; qualified: string }[] = [];
    const myQualified = `${trackId}.${task.id}`;
    for (const tr of pipelineConfig.tracks) {
      for (const t of tr.tasks) {
        if (t.id === task.id && tr.id === trackId) continue;
        const deps = t.depends_on ?? [];
        const matches = deps.some((d) => {
          const qid = d.includes('.') ? d : `${tr.id}.${d}`;
          return qid === myQualified;
        });
        if (matches) {
          out.push({ trackId: tr.id, taskId: t.id, qualified: `${tr.id}.${t.id}` });
        }
      }
    }
    return out;
  }, [pipelineConfig.tracks, trackId, task.id]);

  return (
    <div className="h-full bg-tagma-bg flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          Task Inspector
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleLocateSelf}
            className="p-1 text-tagma-muted hover:text-tagma-accent transition-colors"
            title="Locate task on canvas"
            aria-label="Locate task on canvas"
          >
            <Eye size={12} />
          </button>
          <button
            onClick={onTogglePin}
            className={`p-1 transition-colors ${isPinned ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text'}`}
            title={isPinned ? 'Unpin panel (allow switching)' : 'Pin panel (lock to this task)'}
            aria-label={isPinned ? 'Unpin panel' : 'Pin panel'}
          >
            <Pin size={12} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {errors.length > 0 &&
          (() => {
            const errs = errors.filter((d) => d.severity === 'error');
            const warns = errors.filter((d) => d.severity === 'warning');
            return (
              <>
                {errs.length > 0 && (
                  <div className="bg-tagma-error/8 border border-tagma-error/30 px-2.5 py-1.5 space-y-1">
                    {errs.map((d, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono"
                      >
                        <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
                        <span>{d.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                {warns.length > 0 && (
                  <div className="bg-tagma-warning/8 border border-tagma-warning/30 px-2.5 py-1.5 space-y-1">
                    {warns.map((d, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1.5 text-[10px] text-tagma-warning/90 font-mono"
                      >
                        <AlertTriangle size={10} className="text-tagma-warning shrink-0 mt-[1px]" />
                        <span>{d.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

        {/* ID (readonly) * */}
        <div>
          <label className="field-label">
            Task ID <span className="text-tagma-error">*</span>
          </label>
          <div
            className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1 truncate"
            title={qualifiedId}
          >
            {qualifiedId}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="field-label">
            Name
            <FieldHelpButton field="Name" scope="task" />
            <ModifiedBadge visible={isFieldModified('name')} />
          </label>
          {isDebugView && (
            <FieldConflictBadge
              changed={nameField.serverChanged}
              onDiscard={nameField.discardLocal}
              onAccept={nameField.acceptLocal}
            />
          )}
          <CopyableField value={name} label="Copy task name">
            <input
              type="text"
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={blurName}
              placeholder="Task name..."
            />
          </CopyableField>
        </div>

        {/* Type (fixed at creation, not switchable) */}
        <div>
          <label className="field-label">Type</label>
          <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] border border-tagma-border bg-tagma-bg text-tagma-muted">
            {mode === 'prompt' ? <MessageSquare size={11} /> : <Terminal size={11} />}
            <span>{mode === 'prompt' ? 'Prompt Task' : 'Command Task'}</span>
          </div>
        </div>

        {/* Prompt / Command */}
        <div>
          <label className="field-label">
            {mode === 'prompt' ? 'Prompt' : 'Command'}
            <FieldHelpButton
              field={mode === 'prompt' ? 'Prompt' : 'Command'}
              scope={mode === 'prompt' ? 'prompt task' : 'command task'}
            />
            <ModifiedBadge visible={isFieldModified(mode === 'prompt' ? 'prompt' : 'command')} />
          </label>
          {isDebugView && (
            <FieldConflictBadge
              changed={mode === 'prompt' ? promptField.serverChanged : commandField.serverChanged}
              onDiscard={mode === 'prompt' ? promptField.discardLocal : commandField.discardLocal}
              onAccept={mode === 'prompt' ? promptField.acceptLocal : commandField.acceptLocal}
            />
          )}
          <CopyableField
            value={mode === 'prompt' ? prompt : command}
            label={mode === 'prompt' ? 'Copy task prompt' : 'Copy task command'}
            buttonClassName="top-2 translate-y-0"
          >
            <textarea
              className="field-input min-h-[120px] resize-y font-mono text-[11px]"
              value={mode === 'prompt' ? prompt : command}
              onChange={(e) =>
                mode === 'prompt' ? setPrompt(e.target.value) : setCommand(e.target.value)
              }
              onBlur={mode === 'prompt' ? blurPrompt : blurCommand}
              placeholder={
                mode === 'prompt' ? 'Enter the task prompt...' : 'Enter the shell command...'
              }
            />
          </CopyableField>
        </div>

        {/* AI-specific fields (only for prompt mode) */}
        {mode === 'prompt' && (
          <>
            {/* Driver */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Driver
                  <FieldHelpButton field="Driver" scope="task" />
                  <ModifiedBadge visible={isFieldModified('driver')} />
                </label>
                <ResetButton
                  visible={!!task.driver}
                  onReset={() => commitField({ driver: undefined })}
                />
              </div>
              <select
                className="field-input"
                value={task.driver ?? ''}
                onChange={(e) => handleDriverChange(e.target.value)}
              >
                <option value="">(inherited)</option>
                {drivers.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <InheritedValue
                isOverridden={!!task.driver}
                resolved={resolvedDriver}
                trackName={trackName}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Model */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Model
                  <FieldHelpButton field="Model" scope="task" />
                  <ModifiedBadge visible={isFieldModified('model')} />
                </label>
                <ResetButton
                  visible={!!task.model}
                  onReset={() => commitField({ model: undefined })}
                />
              </div>
              <InspectorModelField
                value={model}
                onChange={setModel}
                onBlur={blurModel}
                copyLabel="Copy task model"
                placeholder={
                  isBuiltinOpencodeDriver(resolvedDriver.value)
                    ? 'e.g. opencode/big-pickle, anthropic/claude-sonnet-4-5'
                    : 'e.g. claude-sonnet-4-6'
                }
                enableOpencodeModels={isBuiltinOpencodeDriver(resolvedDriver.value)}
              />
              <InheritedValue
                isOverridden={!!task.model}
                resolved={resolvedModel}
                trackName={trackName}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Reasoning Effort */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Reasoning Effort
                  <FieldHelpButton field="Reasoning Effort" scope="task" />
                  <ModifiedBadge visible={isFieldModified('reasoning_effort')} />
                </label>
                <ResetButton
                  visible={!!task.reasoning_effort}
                  onReset={() => commitField({ reasoning_effort: undefined })}
                />
              </div>
              <select
                className="field-input"
                value={task.reasoning_effort ?? ''}
                onChange={(e) => commitField({ reasoning_effort: e.target.value || undefined })}
              >
                <option value="">(inherited)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <InheritedValue
                isOverridden={!!task.reasoning_effort}
                resolved={resolvedReasoning}
                trackName={trackName}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Agent Profile */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Agent Profile
                  <FieldHelpButton field="Agent Profile" scope="task" />
                  <ModifiedBadge visible={isFieldModified('agent_profile')} />
                </label>
                <ResetButton
                  visible={!!task.agent_profile}
                  onReset={() => commitField({ agent_profile: undefined })}
                />
              </div>
              <CopyableField
                value={agentProfile}
                label="Copy task agent profile"
                buttonClassName="top-2 translate-y-0"
              >
                <textarea
                  className="field-input min-h-[60px] resize-y font-mono text-[11px]"
                  value={agentProfile}
                  onChange={(e) => setAgentProfile(e.target.value)}
                  onBlur={blurAgentProfile}
                  placeholder="Named profile or multi-line system prompt..."
                />
              </CopyableField>
              {systemPromptUnsupported && (
                <p className="text-[10px] text-tagma-warning mt-1 flex items-start gap-1">
                  <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                  <span>
                    Driver "{resolvedDriver.value ?? 'unknown'}" does not support{' '}
                    <code>systemPrompt</code> — this text will be silently dropped at runtime.
                  </span>
                </p>
              )}
              {/* Track profile inheritance — collapsible block for multi-line readability */}
              {track?.agent_profile ? (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => setShowTrackProfile((v) => !v)}
                    className="text-[10px] text-tagma-muted hover:text-tagma-text flex items-center gap-1 transition-colors"
                  >
                    {showTrackProfile ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    <span>
                      {task.agent_profile ? (
                        <>
                          Overrides track "<span className="text-tagma-text/70">{trackName}</span>"
                          profile
                        </>
                      ) : (
                        <>
                          Inherited from track "
                          <span className="text-tagma-text/70">{trackName}</span>"
                        </>
                      )}
                    </span>
                  </button>
                  {showTrackProfile && (
                    <pre className="mt-1 text-[10px] font-mono text-tagma-muted/80 bg-tagma-bg border border-tagma-border px-2 py-1.5 max-h-[120px] overflow-auto whitespace-pre-wrap break-words">
                      {track.agent_profile}
                    </pre>
                  )}
                </div>
              ) : (
                <InheritedValue
                  isOverridden={!!task.agent_profile}
                  resolved={resolvedAgentProfile}
                  trackName={trackName}
                  pipelineName={pipelineConfig.name}
                />
              )}
            </div>

            {/* Permissions */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Permissions
                  <FieldHelpButton field="Permissions" scope="task" />
                  <ModifiedBadge visible={isFieldModified('permissions')} />
                </label>
                <ResetButton
                  visible={!!task.permissions}
                  onReset={() => commitField({ permissions: undefined })}
                />
              </div>
              <div className="flex gap-3">
                {(['read', 'write', 'execute'] as const).map((key) => {
                  const isExecute = key === 'execute';
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-1.5 cursor-pointer"
                      title={
                        isExecute
                          ? 'Allows arbitrary shell execution (Bash, bypassPermissions on claude-code). Enable only in trusted workdirs.'
                          : undefined
                      }
                    >
                      <input
                        type="checkbox"
                        checked={!!task.permissions?.[key]}
                        onChange={() => handlePermToggle(key)}
                        className="accent-tagma-accent"
                      />
                      <span
                        className={`text-[11px] capitalize ${isExecute ? 'text-tagma-error' : 'text-tagma-text'}`}
                      >
                        {key}
                      </span>
                      {isExecute && <ShieldAlert size={10} className="text-tagma-error" />}
                    </label>
                  );
                })}
              </div>
              <InheritedValue
                isOverridden={!!task.permissions}
                resolved={{
                  value: permsToString(resolvedPerms.value),
                  source: resolvedPerms.source,
                }}
                trackName={trackName}
                pipelineName={pipelineConfig.name}
              />
            </div>
          </>
        )}

        {/* Timeout */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">
              Timeout
              <FieldHelpButton field="Timeout" scope="task" />
              <ModifiedBadge visible={isFieldModified('timeout')} />
            </label>
            {isDebugView && (
              <ResetButton
                visible={!!task.timeout}
                onReset={() => commitField({ timeout: undefined })}
              />
            )}
          </div>
          <CopyableField value={timeout} label="Copy task timeout">
            <input
              type="text"
              className="field-input"
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
              onBlur={blurTimeout}
              placeholder="e.g. 5m, 30s"
            />
          </CopyableField>
          {isDebugView && (
            <InheritedValue
              isOverridden={!!task.timeout}
              resolved={resolvedTimeout}
              trackName={trackName}
              pipelineName={pipelineConfig.name}
            />
          )}
        </div>

        {/* CWD */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">
              Working Directory
              <FieldHelpButton field="Working Directory" scope="task" />
              <ModifiedBadge visible={isFieldModified('cwd')} />
            </label>
            {isDebugView && (
              <ResetButton visible={!!task.cwd} onReset={() => commitField({ cwd: undefined })} />
            )}
          </div>
          <div className="flex gap-1">
            <CopyableField
              value={cwd}
              label="Copy task working directory"
              className="flex-1 min-w-0"
            >
              <input
                type="text"
                className="field-input font-mono text-[11px]"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                onBlur={blurCwd}
                placeholder="./path (relative, inherited)"
              />
            </CopyableField>
            <button
              type="button"
              onClick={() => openFileBrowser('directory', cwd, (path) => setCwd(path))}
              className="shrink-0 p-1.5 border border-tagma-border text-tagma-muted hover:text-tagma-accent hover:border-tagma-accent/40 transition-colors"
              title="Browse..."
              aria-label="Browse for working directory"
            >
              <FolderOpen size={13} />
            </button>
          </div>
          {isDebugView && (
            <InheritedValue
              isOverridden={!!task.cwd}
              resolved={resolvedCwd}
              trackName={trackName}
              pipelineName={pipelineConfig.name}
            />
          )}
        </div>

        {/* Dependencies */}
        {dependencies.length > 0 && (
          <div>
            <label className="field-label">
              Dependencies
              <FieldHelpButton field="Dependencies" scope="task" />
              <ModifiedBadge visible={isFieldModified('depends_on')} />
            </label>
            <div className="space-y-1">
              {dependencies.map((dep) => {
                const locateTarget = dependencyLocateTargets.get(dep) ?? null;
                return (
                  <div
                    key={dep}
                    className="flex items-center gap-1.5 bg-tagma-bg border border-tagma-border px-2 py-1"
                  >
                    <span className="text-[11px] font-mono text-tagma-text flex-1 truncate">
                      {dep}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        if (locateTarget) handleLocateDependency(locateTarget);
                      }}
                      disabled={!locateTarget}
                      className={`transition-colors ${
                        locateTarget
                          ? 'text-tagma-muted hover:text-tagma-accent'
                          : 'text-tagma-muted/30 cursor-not-allowed'
                      }`}
                      title={
                        locateTarget
                          ? `Locate dependency ${locateTarget}`
                          : 'Cannot locate unresolved dependency'
                      }
                      aria-label={`Locate dependency ${dep}`}
                    >
                      <Eye size={10} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveDependency(trackId, task.id, dep)}
                      className="text-tagma-muted hover:text-tagma-error transition-colors"
                      aria-label="Remove dependency"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Continue From — shown whenever there's any upstream dependency (F7). */}
        {isDebugView && mode === 'prompt' && continueFromCandidates.length > 0 && (
          <div>
            <label className="field-label">
              Continue From
              <span className="text-[10px] text-tagma-muted font-normal ml-1">
                (resume session from an upstream task)
              </span>
              <FieldHelpButton field="Continue From" scope="task" />
              <ModifiedBadge visible={isFieldModified('continue_from')} />
            </label>
            <select
              className="field-input"
              value={task.continue_from ?? ''}
              onChange={(e) => handleContinueFromChange(e.target.value)}
            >
              <option value="">none</option>
              {continueFromCandidates.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-tagma-muted mt-1">
              Uses session resume when both drivers support it; otherwise falls back to injecting
              the upstream normalized output. Server validation will flag unsupported combinations.
            </p>
            {sessionResumeUnsupported && (
              <p className="text-[10px] text-tagma-warning mt-1 flex items-start gap-1">
                <AlertTriangle size={10} className="mt-0.5 shrink-0" />
                <span>
                  Driver "{resolvedDriver.value ?? 'unknown'}" does not support session resume —
                  <code>continue_from</code> will fall back to injecting the upstream normalized
                  output as text.
                </span>
              </p>
            )}
          </div>
        )}

        {/* ── Dataflow bindings ── */}
        {/* Inputs render in both views so users can supply human-defined values
            in Production. Outputs stay debug-only via `showOutputs`. */}
        <div className="border-t border-tagma-border pt-2">
          <PortsEditor
            inputs={task.inputs}
            outputs={task.outputs}
            onChange={handleBindingsChange}
            upstreamCandidates={upstreamReport.candidates}
            drift={upstreamReport.drift}
            ambiguous={upstreamReport.ambiguous}
            onSyncFromUpstream={handleSyncInputsFromUpstream}
            syncNewCount={syncNewCount}
            onSyncFromDownstream={handleSyncOutputsFromDownstream}
            syncNewOutputCount={syncNewOutputCount}
            inferredView={inferredPromptPorts}
            inputsLabelTrailing={<ModifiedBadge visible={isFieldModified('inputs')} />}
            outputsLabelTrailing={<ModifiedBadge visible={isFieldModified('outputs')} />}
            showOutputs={isDebugView}
          />
        </div>

        {/* ── Advanced Section ── */}
        {isDebugView && (
          <div className="border-t border-tagma-border pt-2">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-[11px] text-tagma-muted hover:text-tagma-text transition-colors w-full"
            >
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Advanced
            </button>
          </div>
        )}

        {isDebugView && showAdvanced && (
          <>
            {/* Trigger */}
            <div>
              <label className="field-label">
                Trigger
                <span className="text-[10px] text-tagma-muted font-normal ml-1">
                  (from plugin registry)
                </span>
                <FieldHelpButton field="Trigger" scope="task" />
                <ModifiedBadge visible={isFieldModified('trigger')} />
              </label>
              <select
                className="field-input"
                value={task.trigger?.type ?? ''}
                onChange={(e) => handleTriggerTypeChange(e.target.value)}
              >
                <option value="">none</option>
                {triggerOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {task.trigger?.type === 'manual' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Message"
                  helpField="message"
                  helpScope="`manual` trigger plugin"
                  value={asStr(task.trigger.message)}
                  onChange={(v) => handleTriggerField('message', v)}
                  placeholder="Approval message..."
                />
                <TriggerField
                  label="Timeout"
                  helpField="timeout"
                  helpScope="`manual` trigger plugin"
                  value={asStr(task.trigger.timeout)}
                  onChange={(v) => handleTriggerField('timeout', v)}
                  placeholder="e.g. 5m"
                />
                <div>
                  <label className="text-[10px] text-tagma-muted">
                    Metadata
                    <FieldHelpButton field="metadata" scope="`manual` trigger plugin" />
                  </label>
                  <KeyValueEditor
                    value={asRecord(task.trigger.metadata)}
                    onChange={(meta) => {
                      const current = task.trigger ?? { type: 'manual' };
                      commitField({
                        trigger: {
                          ...current,
                          metadata: Object.keys(meta).length > 0 ? meta : undefined,
                        },
                      });
                    }}
                  />
                </div>
              </div>
            )}

            {task.trigger?.type === 'file' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Path *"
                  helpField="path"
                  helpScope="`file` trigger plugin"
                  value={asStr(task.trigger.path)}
                  onChange={(v) => handleTriggerField('path', v)}
                  placeholder="./path/to/watch"
                  onBrowse={(currentVal, setVal) => openFileBrowser('open', currentVal, setVal)}
                />
                <TriggerField
                  label="Timeout"
                  helpField="timeout"
                  helpScope="`file` trigger plugin"
                  value={asStr(task.trigger.timeout)}
                  onChange={(v) => handleTriggerField('timeout', v)}
                  placeholder="e.g. 5m"
                />
              </div>
            )}

            {/* Unknown plugin trigger — F10: prefer SchemaForm when a schema is
                known (either from the hand-written built-in fallback or a
                future server-provided descriptor). Fall back to KV editor for
                truly unknown plugins. */}
            {task.trigger &&
              !KNOWN_TRIGGER_TYPES.has(task.trigger.type) &&
              (() => {
                const triggerType = task.trigger.type;
                const schema = getBuiltinSchema('trigger', triggerType);
                const fieldValues = Object.fromEntries(
                  Object.entries(task.trigger).filter(([k]) => k !== 'type'),
                ) as Record<string, unknown>;
                return (
                  <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                    {schema ? (
                      <SchemaForm
                        schema={schema}
                        value={fieldValues}
                        onChange={(kv) =>
                          commitField({ trigger: { type: triggerType, ...kv } as TriggerConfig })
                        }
                        onBrowsePath={(currentValue, onSelect) =>
                          openFileBrowser('open', currentValue, onSelect)
                        }
                        helpScope={`\`${triggerType}\` trigger plugin`}
                      />
                    ) : (
                      <>
                        <p className="text-[10px] text-tagma-muted">
                          Custom trigger fields (plugin "{triggerType}" has no known schema —
                          falling back to KV editor):
                        </p>
                        <KeyValueEditor
                          value={fieldValues}
                          onChange={(kv) =>
                            commitField({ trigger: { type: triggerType, ...kv } as TriggerConfig })
                          }
                        />
                      </>
                    )}
                  </div>
                );
              })()}

            {/* Completion */}
            <div>
              <label className="field-label">
                Completion Check
                <span className="text-[10px] text-tagma-muted font-normal ml-1">
                  (from plugin registry)
                </span>
                <FieldHelpButton field="Completion Check" scope="task" />
                <ModifiedBadge visible={isFieldModified('completion')} />
              </label>
              <select
                className="field-input"
                value={effectiveCompletionType}
                onChange={(e) => handleCompletionTypeChange(e.target.value)}
              >
                <option value={DEFAULT_COMPLETION_TYPE}>{DEFAULT_COMPLETION_TYPE} (default)</option>
                {completionOptions
                  .filter((t) => t !== DEFAULT_COMPLETION_TYPE)
                  .map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
              </select>
            </div>

            {effectiveCompletionType === 'exit_code' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <div>
                  <label className="text-[10px] text-tagma-muted">
                    Expected Code
                    <FieldHelpButton field="expect" scope="`exit_code` completion plugin" />
                  </label>
                  <CopyableField
                    value={
                      task.completion?.expect !== undefined ? String(task.completion.expect) : ''
                    }
                    label="Copy expected completion code"
                  >
                    <input
                      type="text"
                      className="field-input font-mono text-[11px]"
                      value={
                        task.completion?.expect !== undefined ? String(task.completion.expect) : ''
                      }
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        handleCompletionField(
                          'expect',
                          v ? (v.includes(',') ? v.split(',').map(Number) : Number(v)) : undefined,
                        );
                      }}
                      placeholder="0 (default)"
                    />
                  </CopyableField>
                </div>
              </div>
            )}

            {task.completion && effectiveCompletionType === 'file_exists' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Path *"
                  helpField="path"
                  helpScope="`file_exists` completion plugin"
                  value={asStr(task.completion.path)}
                  onChange={(v) => handleCompletionField('path', v)}
                  placeholder="./path/to/check"
                  onBrowse={(currentVal, setVal) =>
                    openFileBrowser(
                      task.completion?.kind === 'dir' ? 'directory' : 'open',
                      currentVal,
                      setVal,
                    )
                  }
                />
                <div>
                  <label className="text-[10px] text-tagma-muted">
                    Kind
                    <FieldHelpButton field="kind" scope="`file_exists` completion plugin" />
                  </label>
                  <select
                    className="field-input"
                    value={asStr(task.completion.kind) ?? ''}
                    onChange={(e) => handleCompletionField('kind', e.target.value || undefined)}
                  >
                    <option value="">any (default)</option>
                    <option value="file">file</option>
                    <option value="dir">dir</option>
                    <option value="any">any</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-tagma-muted">
                    Min Size (bytes)
                    <FieldHelpButton field="min_size" scope="`file_exists` completion plugin" />
                  </label>
                  <CopyableField
                    value={
                      typeof task.completion.min_size === 'number' ? task.completion.min_size : ''
                    }
                    label="Copy minimum completion file size"
                  >
                    <input
                      type="number"
                      className="field-input font-mono text-[11px]"
                      value={
                        typeof task.completion.min_size === 'number' ? task.completion.min_size : ''
                      }
                      onChange={(e) =>
                        handleCompletionField(
                          'min_size',
                          e.target.value ? Number(e.target.value) : undefined,
                        )
                      }
                      placeholder="optional"
                    />
                  </CopyableField>
                </div>
              </div>
            )}

            {task.completion && effectiveCompletionType === 'output_check' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Check Command *"
                  helpField="check"
                  helpScope="`output_check` completion plugin"
                  value={asStr(task.completion.check)}
                  onChange={(v) => handleCompletionField('check', v)}
                  placeholder="shell command (exit 0 = pass)"
                />
                <TriggerField
                  label="Timeout"
                  helpField="timeout"
                  helpScope="`output_check` completion plugin"
                  value={asStr(task.completion.timeout)}
                  onChange={(v) => handleCompletionField('timeout', v)}
                  placeholder="30s (default)"
                />
              </div>
            )}

            {/* Unknown plugin completion — F10: prefer SchemaForm when a
                schema is known, fall back to KV editor otherwise. */}
            {task.completion &&
              !KNOWN_COMPLETION_TYPES.has(task.completion.type) &&
              (() => {
                const completionType = task.completion.type;
                const schema = getBuiltinSchema('completion', completionType);
                const fieldValues = Object.fromEntries(
                  Object.entries(task.completion).filter(([k]) => k !== 'type'),
                ) as Record<string, unknown>;
                return (
                  <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                    {schema ? (
                      <SchemaForm
                        schema={schema}
                        value={fieldValues}
                        onChange={(kv) =>
                          commitField({
                            completion: { type: completionType, ...kv } as CompletionConfig,
                          })
                        }
                        onBrowsePath={(currentValue, onSelect) =>
                          openFileBrowser('open', currentValue, onSelect)
                        }
                        helpScope={`\`${completionType}\` completion plugin`}
                      />
                    ) : (
                      <>
                        <p className="text-[10px] text-tagma-muted">
                          Custom completion fields (plugin "{completionType}" has no known schema —
                          falling back to KV editor):
                        </p>
                        <KeyValueEditor
                          value={fieldValues}
                          onChange={(kv) =>
                            commitField({
                              completion: { type: completionType, ...kv } as CompletionConfig,
                            })
                          }
                        />
                      </>
                    )}
                  </div>
                );
              })()}

            {/* Middlewares */}
            <MiddlewareEditor
              middlewares={task.middlewares ?? []}
              onChange={(mws) => commitField({ middlewares: mws })}
              onBrowsePath={(currentValue, onSelect) =>
                openFileBrowser('open', currentValue, onSelect)
              }
              labelTrailing={<ModifiedBadge visible={isFieldModified('middlewares')} />}
            />
          </>
        )}

        {/* Delete */}
        <div className="pt-4 border-t border-tagma-border">
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-danger flex items-center justify-center gap-1.5"
          >
            <Trash2 size={12} />
            Delete Task
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete task?"
          confirmLabel="Delete task"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDeleteTask(trackId, task.id);
          }}
          message={
            <>
              <p>
                Delete task <span className="font-mono text-tagma-accent">{qualifiedId}</span>?
              </p>
              {downstreamTasksThatDependOnMe.length > 0 ? (
                <div className="mt-2">
                  <p className="text-tagma-muted">
                    This will remove{' '}
                    <span className="text-tagma-warning">
                      {downstreamTasksThatDependOnMe.length}
                    </span>{' '}
                    downstream dependency reference
                    {downstreamTasksThatDependOnMe.length !== 1 ? 's' : ''}:
                  </p>
                  <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                    {downstreamTasksThatDependOnMe.map((d) => (
                      <li key={d.qualified} className="font-mono text-[11px] text-tagma-text/80">
                        &bull; {d.qualified}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-tagma-muted text-[11px]">
                  No downstream tasks depend on this task.
                </p>
              )}
            </>
          }
        />
      )}
      {fileBrowser &&
        createPortal(
          <FileExplorer
            mode={fileBrowser.mode}
            initialPath={fileBrowser.initialPath}
            onConfirm={(path) => {
              fileBrowser.onSelect(path);
              setFileBrowser(null);
            }}
            onCancel={() => setFileBrowser(null)}
          />,
          document.body,
        )}
    </div>
  );
}

/** Reusable small text field for trigger/completion sub-fields */
function TriggerField({
  label,
  value,
  onChange,
  placeholder,
  onBrowse,
  helpField,
  helpScope,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  onBrowse?: (currentValue: string, setVal: (v: string) => void) => void;
  /** Field key passed to the help button (defaults to `label`). */
  helpField?: string;
  /** Scope phrase for the help button (e.g. "`file` trigger plugin"). */
  helpScope?: string;
}) {
  const [val, setVal, blurVal] = useLocalField(value ?? '', onChange);
  return (
    <div>
      <label className="text-[10px] text-tagma-muted">
        {label}
        {helpScope && <FieldHelpButton field={helpField ?? label} scope={helpScope} />}
      </label>
      {onBrowse ? (
        <div className="flex gap-1">
          <CopyableField value={val} label={`Copy ${label}`} className="flex-1 min-w-0">
            <input
              type="text"
              className="field-input font-mono text-[11px]"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              onBlur={blurVal}
              placeholder={placeholder}
            />
          </CopyableField>
          <button
            type="button"
            onClick={() => onBrowse(val, setVal)}
            className="shrink-0 p-1.5 border border-tagma-border text-tagma-muted hover:text-tagma-accent hover:border-tagma-accent/40 transition-colors"
            title="Browse..."
            aria-label="Browse for file"
          >
            <FolderOpen size={13} />
          </button>
        </div>
      ) : (
        <CopyableField value={val} label={`Copy ${label}`}>
          <input
            type="text"
            className="field-input font-mono text-[11px]"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={blurVal}
            placeholder={placeholder}
          />
        </CopyableField>
      )}
    </div>
  );
}

/** Key-value pair editor for metadata and custom plugin fields */
function KeyValueEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (kv: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(value);

  const handleAdd = () => {
    const key = `key${entries.length + 1}`;
    onChange({ ...value, [key]: '' });
  };

  const handleRemove = (key: string) => {
    const { [key]: _, ...rest } = value;
    onChange(rest);
  };

  const handleKeyChange = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) return;
    const result: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      result[k === oldKey ? newKey : k] = v;
    }
    onChange(result);
  };

  const handleValueChange = (key: string, newValue: string) => {
    onChange({ ...value, [key]: newValue });
  };

  return (
    <div className="space-y-1.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <CopyableField value={k} label={`Copy ${k} key`} className="w-[90px] shrink-0">
            <input
              type="text"
              className="field-input font-mono text-[11px]"
              value={k}
              onChange={(e) => handleKeyChange(k, e.target.value)}
              placeholder="key"
            />
          </CopyableField>
          <CopyableField
            value={String(v ?? '')}
            label={`Copy ${k} value`}
            className="flex-1 min-w-0"
          >
            <input
              type="text"
              className="field-input font-mono text-[11px]"
              value={String(v ?? '')}
              onChange={(e) => handleValueChange(k, e.target.value)}
              placeholder="value"
            />
          </CopyableField>
          <button
            onClick={() => handleRemove(k)}
            className="text-tagma-muted hover:text-tagma-error transition-colors shrink-0"
            aria-label="Remove entry"
          >
            <X size={10} />
          </button>
        </div>
      ))}
      <button
        onClick={handleAdd}
        className="text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
      >
        + Add entry
      </button>
    </div>
  );
}
