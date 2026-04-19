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
} from 'lucide-react';
import type {
  RawTaskConfig,
  RawPipelineConfig,
  RawTrackConfig,
  TriggerConfig,
  CompletionConfig,
} from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { usePipelineStore } from '../../store/pipeline-store';
import { useDriverCapability } from '../../hooks/use-driver-capability';
import { MiddlewareEditor } from './MiddlewareEditor';
import {
  InheritedValue,
  ResetButton,
  resolveScalar,
  resolvePermissions,
  permsToString,
} from './InheritedValue';
import { ConfirmDialog } from './ConfirmDialog';
import { SchemaForm, getBuiltinSchema } from './SchemaForm';
import {
  DEFAULT_COMPLETION_TYPE,
  getEffectiveCompletionType,
  normalizeCompletionForEditor,
} from './completion-defaults';
import { FileExplorer } from '../FileExplorer';
import type { FileExplorerMode } from '../FileExplorer';

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
  errors: string[];
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
  const mode: 'prompt' | 'command' = task.command !== undefined ? 'command' : 'prompt';
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

  const openFileBrowser = useCallback(
    (mode: FileExplorerMode, currentValue: string, onSelect: (path: string) => void) => {
      setFileBrowser({ mode, initialPath: currentValue || undefined, onSelect });
    },
    [],
  );

  // H7: useLocalField exposes `serverChanged` / `discardLocal` / `acceptLocal`
  // as extras on the returned tuple so existing 3-element destructuring still
  // works. We grab the full result for the high-traffic fields (name, prompt,
  // command) so the user can resolve a server-vs-local conflict without
  // losing their in-progress edits when an external file change arrives.
  const nameField = useLocalField(task.name ?? '', (v) => commitField({ name: v }));
  const [name, setName, blurName] = nameField;
  const promptField = useLocalField(task.prompt ?? '', (v) => commitField({ prompt: v }));
  const [prompt, setPrompt, blurPrompt] = promptField;
  const commandField = useLocalField(task.command ?? '', (v) => commitField({ command: v }));
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
    <div
      className={`w-80 h-full bg-tagma-surface border-l flex flex-col animate-slide-in-right ${isPinned ? 'border-tagma-accent/50' : 'border-tagma-border'}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          Task Inspector
        </span>
        <button
          onClick={onTogglePin}
          className={`p-1 transition-colors ${isPinned ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text'}`}
          title={isPinned ? 'Unpin panel (allow switching)' : 'Pin panel (lock to this task)'}
          aria-label={isPinned ? 'Unpin panel' : 'Pin panel'}
        >
          <Pin size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {errors.length > 0 && (
          <div className="bg-tagma-error/8 border border-tagma-error/30 px-2.5 py-1.5 space-y-1">
            {errors.map((msg, i) => (
              <div
                key={i}
                className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono"
              >
                <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
                <span>{msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* ID (readonly) * */}
        <div>
          <label className="field-label">
            Task ID <span className="text-tagma-error">*</span>
          </label>
          <div
            className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5 truncate"
            title={qualifiedId}
          >
            {qualifiedId}
          </div>
        </div>

        {/* Name */}
        <div>
          <label className="field-label">Name</label>
          <FieldConflictBadge
            changed={nameField.serverChanged}
            onDiscard={nameField.discardLocal}
            onAccept={nameField.acceptLocal}
          />
          <input
            type="text"
            className="field-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={blurName}
            placeholder="Task name..."
          />
        </div>

        {/* Type (fixed at creation, not switchable) */}
        <div>
          <label className="field-label">Type</label>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] border border-tagma-border bg-tagma-bg text-tagma-muted">
            {mode === 'prompt' ? <MessageSquare size={11} /> : <Terminal size={11} />}
            <span>{mode === 'prompt' ? 'Prompt Task' : 'Command Task'}</span>
          </div>
        </div>

        {/* Prompt / Command */}
        <div>
          <label className="field-label">{mode === 'prompt' ? 'Prompt' : 'Command'}</label>
          <FieldConflictBadge
            changed={mode === 'prompt' ? promptField.serverChanged : commandField.serverChanged}
            onDiscard={mode === 'prompt' ? promptField.discardLocal : commandField.discardLocal}
            onAccept={mode === 'prompt' ? promptField.acceptLocal : commandField.acceptLocal}
          />
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
        </div>

        {/* AI-specific fields (only for prompt mode) */}
        {mode === 'prompt' && (
          <>
            {/* Driver */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">Driver</label>
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
                <label className="field-label">Model</label>
                <ResetButton
                  visible={!!task.model}
                  onReset={() => commitField({ model: undefined })}
                />
              </div>
              <input
                type="text"
                className="field-input font-mono text-[11px]"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={blurModel}
                placeholder="e.g. claude-sonnet-4-6"
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
                <label className="field-label">Reasoning Effort</label>
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
                <label className="field-label">Agent Profile</label>
                <ResetButton
                  visible={!!task.agent_profile}
                  onReset={() => commitField({ agent_profile: undefined })}
                />
              </div>
              <textarea
                className="field-input min-h-[60px] resize-y font-mono text-[11px]"
                value={agentProfile}
                onChange={(e) => setAgentProfile(e.target.value)}
                onBlur={blurAgentProfile}
                placeholder="Named profile or multi-line system prompt..."
              />
              {systemPromptUnsupported && (
                <p className="text-[10px] text-amber-400 mt-1 flex items-start gap-1">
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
                <label className="field-label">Permissions</label>
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
            <label className="field-label">Timeout</label>
            <ResetButton
              visible={!!task.timeout}
              onReset={() => commitField({ timeout: undefined })}
            />
          </div>
          <input
            type="text"
            className="field-input"
            value={timeout}
            onChange={(e) => setTimeout_(e.target.value)}
            onBlur={blurTimeout}
            placeholder="e.g. 5m, 30s"
          />
          <InheritedValue
            isOverridden={!!task.timeout}
            resolved={resolvedTimeout}
            trackName={trackName}
            pipelineName={pipelineConfig.name}
          />
        </div>

        {/* CWD */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Working Directory</label>
            <ResetButton visible={!!task.cwd} onReset={() => commitField({ cwd: undefined })} />
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              className="field-input font-mono text-[11px] flex-1 min-w-0"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onBlur={blurCwd}
              placeholder="./path (relative, inherited)"
            />
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
          <InheritedValue
            isOverridden={!!task.cwd}
            resolved={resolvedCwd}
            trackName={trackName}
            pipelineName={pipelineConfig.name}
          />
        </div>

        {/* Dependencies */}
        {dependencies.length > 0 && (
          <div>
            <label className="field-label">Dependencies</label>
            <div className="space-y-1">
              {dependencies.map((dep) => (
                <div
                  key={dep}
                  className="flex items-center gap-1.5 bg-tagma-bg border border-tagma-border px-2 py-1"
                >
                  <span className="text-[11px] font-mono text-tagma-text flex-1 truncate">
                    {dep}
                  </span>
                  <button
                    onClick={() => onRemoveDependency(trackId, task.id, dep)}
                    className="text-tagma-muted hover:text-tagma-error transition-colors"
                    aria-label="Remove dependency"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Continue From — shown whenever there's any upstream dependency (F7). */}
        {mode === 'prompt' && continueFromCandidates.length > 0 && (
          <div>
            <label className="field-label">
              Continue From
              <span className="text-[10px] text-tagma-muted font-normal ml-1">
                (resume session from an upstream task)
              </span>
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
              <p className="text-[10px] text-amber-400 mt-1 flex items-start gap-1">
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

        {/* ── Advanced Section ── */}
        <div className="border-t border-tagma-border pt-2">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-[11px] text-tagma-muted hover:text-tagma-text transition-colors w-full"
          >
            {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Advanced
          </button>
        </div>

        {showAdvanced && (
          <>
            {/* Trigger */}
            <div>
              <label className="field-label">
                Trigger
                <span className="text-[10px] text-tagma-muted font-normal ml-1">
                  (from plugin registry)
                </span>
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
                  value={asStr(task.trigger.message)}
                  onChange={(v) => handleTriggerField('message', v)}
                  placeholder="Approval message..."
                />
                <TriggerField
                  label="Timeout"
                  value={asStr(task.trigger.timeout)}
                  onChange={(v) => handleTriggerField('timeout', v)}
                  placeholder="e.g. 5m"
                />
                <div>
                  <label className="text-[10px] text-tagma-muted">Metadata</label>
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
                  value={asStr(task.trigger.path)}
                  onChange={(v) => handleTriggerField('path', v)}
                  placeholder="./path/to/watch"
                  onBrowse={(currentVal, setVal) => openFileBrowser('open', currentVal, setVal)}
                />
                <TriggerField
                  label="Timeout"
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
                  <label className="text-[10px] text-tagma-muted">Expected Code</label>
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
                </div>
              </div>
            )}

            {task.completion && effectiveCompletionType === 'file_exists' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Path *"
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
                  <label className="text-[10px] text-tagma-muted">Kind</label>
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
                  <label className="text-[10px] text-tagma-muted">Min Size (bytes)</label>
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
                </div>
              </div>
            )}

            {task.completion && effectiveCompletionType === 'output_check' && (
              <div className="pl-3 border-l-2 border-tagma-border space-y-2">
                <TriggerField
                  label="Check Command *"
                  value={asStr(task.completion.check)}
                  onChange={(v) => handleCompletionField('check', v)}
                  placeholder="shell command (exit 0 = pass)"
                />
                <TriggerField
                  label="Timeout"
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
                    <span className="text-amber-400">{downstreamTasksThatDependOnMe.length}</span>{' '}
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
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  onBrowse?: (currentValue: string, setVal: (v: string) => void) => void;
}) {
  const [val, setVal, blurVal] = useLocalField(value ?? '', onChange);
  return (
    <div>
      <label className="text-[10px] text-tagma-muted">{label}</label>
      {onBrowse ? (
        <div className="flex gap-1">
          <input
            type="text"
            className="field-input font-mono text-[11px] flex-1 min-w-0"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={blurVal}
            placeholder={placeholder}
          />
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
        <input
          type="text"
          className="field-input font-mono text-[11px]"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={blurVal}
          placeholder={placeholder}
        />
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
          <input
            type="text"
            className="field-input font-mono text-[11px] w-[90px]"
            value={k}
            onChange={(e) => handleKeyChange(k, e.target.value)}
            placeholder="key"
          />
          <input
            type="text"
            className="field-input font-mono text-[11px] flex-1"
            value={String(v ?? '')}
            onChange={(e) => handleValueChange(k, e.target.value)}
            placeholder="value"
          />
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
