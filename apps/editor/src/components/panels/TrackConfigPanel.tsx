import { useCallback, useMemo, useState } from 'react';
import { Trash2, AlertTriangle, ShieldAlert, Pin, Eye, ListTree } from 'lucide-react';
import type { RawTrackConfig, DiagnosticItem } from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { shouldShowTrackAgentFields } from '../../utils/track-inspector';
import { MiddlewareEditor } from './MiddlewareEditor';
import { InheritedValue, ResetButton, resolveScalar } from './InheritedValue';
import { ConfirmDialog } from './ConfirmDialog';
import { ModifiedBadge } from './ModifiedBadge';
import { findSavedTrack, isTrackFieldModified } from '../../utils/dirty-tracking';
import { FieldHelpButton } from './FieldHelpButton';
import { CopyableField } from './CopyableField';
import { InspectorModelField, isBuiltinOpencodeDriver } from './InspectorModelField';
import {
  buildTrackTaskListGroups,
  type TrackTaskListSort,
} from '../../utils/track-task-list';

interface TrackConfigPanelProps {
  track: RawTrackConfig;
  drivers: string[];
  errors: DiagnosticItem[];
  onUpdateTrack: (trackId: string, fields: Record<string, unknown>) => void;
  onDeleteTrack: (trackId: string) => void;
  isPinned: boolean;
  onTogglePin: () => void;
}

const ON_FAILURE_DESCRIPTIONS: Record<string, string> = {
  '': 'Skip downstream tasks in this track (default).',
  skip_downstream: 'Skip downstream tasks in this track (default).',
  ignore: 'Treat failure as success; downstream tasks proceed.',
  stop_all: '\u26a0 Skip ALL remaining tasks in the entire pipeline.',
};

export function TrackConfigPanel({
  track,
  drivers,
  errors,
  onUpdateTrack,
  onDeleteTrack,
  isPinned,
  onTogglePin,
}: TrackConfigPanelProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [taskListSort, setTaskListSort] = useState<TrackTaskListSort>('execution');
  // Read pipeline-level config from the store so we can resolve the inheritance
  // chain (track → pipeline). App.tsx doesn't need to thread anything new.
  const pipelineConfig = usePipelineStore((s) => s.config);
  const savedConfig = usePipelineStore((s) => s.savedConfig);
  const selectTask = usePipelineStore((s) => s.selectTask);
  const savedTrack = useMemo(() => findSavedTrack(savedConfig, track.id), [savedConfig, track.id]);
  const isFieldModified = useCallback(
    (key: keyof RawTrackConfig) => isTrackFieldModified(savedTrack, track, key),
    [savedTrack, track],
  );
  const viewMode = useEditorSettingsStore((s) => s.settings?.viewMode ?? 'production');
  const showAgentFields = useMemo(
    () => shouldShowTrackAgentFields(viewMode, track),
    [viewMode, track],
  );
  const taskListGroups = useMemo(
    () => buildTrackTaskListGroups(track, taskListSort),
    [taskListSort, track],
  );

  const commit = useCallback(
    (fields: Record<string, unknown>) => {
      onUpdateTrack(track.id, fields);
    },
    [track.id, onUpdateTrack],
  );

  // Pipeline-level inheritance (pipeline only carries driver/timeout today).
  const resolvedDriver = useMemo(
    () => resolveScalar(track.driver, undefined, pipelineConfig.driver, 'opencode'),
    [track.driver, pipelineConfig.driver],
  );
  const resolvedModel = useMemo(
    () => resolveScalar(track.model, undefined, pipelineConfig.model, undefined),
    [track.model, pipelineConfig.model],
  );
  const resolvedReasoning = useMemo(
    () =>
      resolveScalar(track.reasoning_effort, undefined, pipelineConfig.reasoning_effort, undefined),
    [track.reasoning_effort, pipelineConfig.reasoning_effort],
  );
  const resolvedAgentProfile = useMemo(
    () => resolveScalar(track.agent_profile, undefined, undefined),
    [track.agent_profile],
  );
  const resolvedCwd = useMemo(
    () => resolveScalar(track.cwd, undefined, undefined, '.'),
    [track.cwd],
  );

  const [name, setName, blurName] = useLocalField(track.name ?? '', (v) => commit({ name: v }));
  // driver uses direct commit (no local field needed for select)
  const [color, setColor, blurColor] = useLocalField(track.color ?? '', (v) =>
    commit({ color: v || undefined }),
  );
  const [agentProfile, setAgentProfile, blurAgentProfile] = useLocalField(
    track.agent_profile ?? '',
    (v) => commit({ agent_profile: v || undefined }),
  );
  const [cwd, setCwd, blurCwd] = useLocalField(track.cwd ?? '', (v) =>
    commit({ cwd: v || undefined }),
  );
  const [model, setModel, blurModel] = useLocalField(track.model ?? '', (v) =>
    commit({ model: v || undefined }),
  );

  const handleOnFailureChange = useCallback(
    (on_failure: string) => {
      commit({ on_failure: on_failure || undefined });
    },
    [commit],
  );

  const handleLocateSelf = useCallback(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('tagma:focus-track', { detail: track.id }));
    });
  }, [track.id]);

  const handleTaskListSelect = useCallback(
    (qualifiedId: string) => {
      if (!qualifiedId) return;
      selectTask(qualifiedId);
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qualifiedId }));
      });
    },
    [selectTask],
  );

  const handlePermToggle = useCallback(
    (key: 'read' | 'write' | 'execute') => {
      const current = track.permissions ?? { read: false, write: false, execute: false };
      const next = { ...current, [key]: !current[key] };
      // If all are falsy, remove permissions entirely
      if (!next.read && !next.write && !next.execute) {
        commit({ permissions: undefined });
      } else {
        commit({ permissions: next });
      }
    },
    [track.permissions, commit],
  );

  return (
    <div className="h-full bg-tagma-bg flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          Track Inspector
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleLocateSelf}
            className="p-1 text-tagma-muted hover:text-tagma-accent transition-colors"
            title="Locate track on canvas"
            aria-label="Locate track on canvas"
          >
            <Eye size={12} />
          </button>
          <button
            onClick={onTogglePin}
            className={`p-1 transition-colors ${isPinned ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text'}`}
            title={isPinned ? 'Unpin panel (allow switching)' : 'Pin panel (lock to this track)'}
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

        <div className="border border-tagma-border bg-tagma-surface/60 px-2.5 py-2 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="field-label mb-0 flex items-center gap-1">
              <ListTree size={10} />
              Task List
            </label>
            <div className="inline-flex border border-tagma-border">
              <button
                type="button"
                onClick={() => setTaskListSort('execution')}
                className={`px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider transition-colors ${
                  taskListSort === 'execution'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                title="Sort tasks by execution order within each group"
              >
                Run
              </button>
              <button
                type="button"
                onClick={() => setTaskListSort('alphabetical')}
                className={`px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider border-l border-tagma-border transition-colors ${
                  taskListSort === 'alphabetical'
                    ? 'bg-tagma-accent/10 text-tagma-accent'
                    : 'text-tagma-muted hover:text-tagma-text'
                }`}
                title="Sort tasks alphabetically within each group"
              >
                A-Z
              </button>
            </div>
          </div>
          <select
            className="field-input font-mono text-[10px]"
            value=""
            onChange={(e) => handleTaskListSelect(e.target.value)}
            aria-label="Task List"
            disabled={track.tasks.length === 0}
          >
            <option value="">
              {track.tasks.length === 0
                ? 'No tasks in this track'
                : `Select task (${track.tasks.length})`}
            </option>
            {taskListGroups.map((group) => (
              <optgroup key={group.kind} label={`${group.label} (${group.tasks.length})`}>
                {group.tasks.map((task) => (
                  <option key={task.qualifiedId} value={task.qualifiedId}>
                    {task.label} - {task.id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* ID (readonly) * */}
        <div>
          <label className="field-label">
            Track ID <span className="text-tagma-error">*</span>
          </label>
          <div
            className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1 truncate"
            title={track.id}
          >
            {track.id}
          </div>
        </div>

        {/* Name * */}
        <div>
          <label className="field-label">
            Name <span className="text-tagma-error">*</span>
            <FieldHelpButton field="Name" scope="track" />
            <ModifiedBadge visible={isFieldModified('name')} />
          </label>
          <CopyableField value={name} label="Copy track name">
            <input
              type="text"
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={blurName}
              placeholder="Track name..."
            />
          </CopyableField>
        </div>

        {/* Color */}
        <div>
          <label className="field-label">
            Color
            <FieldHelpButton field="Color" scope="track" />
            <ModifiedBadge visible={isFieldModified('color')} />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color || '#d4845a'}
              onChange={(e) => setColor(e.target.value)}
              onBlur={blurColor}
              className="w-8 h-8 border border-tagma-border bg-tagma-bg cursor-pointer p-0.5"
            />
            <CopyableField value={color} label="Copy track color" className="flex-1">
              <input
                type="text"
                className="field-input"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                onBlur={blurColor}
                placeholder="#hex or empty"
              />
            </CopyableField>
          </div>
        </div>

        <div className="border-t border-tagma-border" />

        {showAgentFields && (
          <>
            {/* Driver */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Driver
                  <FieldHelpButton field="Driver" scope="track" />
                  <ModifiedBadge visible={isFieldModified('driver')} />
                </label>
                <ResetButton
                  visible={!!track.driver}
                  onReset={() => commit({ driver: undefined })}
                />
              </div>
              <select
                className="field-input"
                value={track.driver ?? ''}
                onChange={(e) => commit({ driver: e.target.value || undefined })}
              >
                <option value="">(inherited)</option>
                {drivers.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <InheritedValue
                isOverridden={!!track.driver}
                resolved={resolvedDriver}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Model */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Model
                  <FieldHelpButton field="Model" scope="track" />
                  <ModifiedBadge visible={isFieldModified('model')} />
                </label>
                <ResetButton visible={!!track.model} onReset={() => commit({ model: undefined })} />
              </div>
              <InspectorModelField
                value={model}
                onChange={setModel}
                onBlur={blurModel}
                copyLabel="Copy track model"
                placeholder={
                  isBuiltinOpencodeDriver(resolvedDriver.value)
                    ? 'e.g. opencode/big-pickle, anthropic/claude-sonnet-4-5'
                    : 'e.g. claude-sonnet-4-6'
                }
                enableOpencodeModels={isBuiltinOpencodeDriver(resolvedDriver.value)}
              />
              <InheritedValue
                isOverridden={!!track.model}
                resolved={resolvedModel}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Reasoning Effort */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Reasoning Effort
                  <FieldHelpButton field="Reasoning Effort" scope="track" />
                  <ModifiedBadge visible={isFieldModified('reasoning_effort')} />
                </label>
                <ResetButton
                  visible={!!track.reasoning_effort}
                  onReset={() => commit({ reasoning_effort: undefined })}
                />
              </div>
              <select
                className="field-input"
                value={track.reasoning_effort ?? ''}
                onChange={(e) => commit({ reasoning_effort: e.target.value || undefined })}
              >
                <option value="">(inherited)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <InheritedValue
                isOverridden={!!track.reasoning_effort}
                resolved={resolvedReasoning}
                pipelineName={pipelineConfig.name}
              />
            </div>

            {/* Agent Profile */}
            <div>
              <div className="flex items-center justify-between">
                <label className="field-label">
                  Agent Profile
                  <FieldHelpButton field="Agent Profile" scope="track" />
                  <ModifiedBadge visible={isFieldModified('agent_profile')} />
                </label>
                <ResetButton
                  visible={!!track.agent_profile}
                  onReset={() => commit({ agent_profile: undefined })}
                />
              </div>
              <CopyableField
                value={agentProfile}
                label="Copy track agent profile"
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
              <InheritedValue
                isOverridden={!!track.agent_profile}
                resolved={resolvedAgentProfile}
                pipelineName={pipelineConfig.name}
              />
            </div>
          </>
        )}

        {/* CWD */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">
              Working Directory
              <FieldHelpButton field="Working Directory" scope="track" />
              <ModifiedBadge visible={isFieldModified('cwd')} />
            </label>
            <ResetButton visible={!!track.cwd} onReset={() => commit({ cwd: undefined })} />
          </div>
          <CopyableField value={cwd} label="Copy track working directory">
            <input
              type="text"
              className="field-input font-mono text-[11px]"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onBlur={blurCwd}
              placeholder="./path (relative, inherited)"
            />
          </CopyableField>
          <InheritedValue
            isOverridden={!!track.cwd}
            resolved={resolvedCwd}
            pipelineName={pipelineConfig.name}
          />
        </div>

        <div className="border-t border-tagma-border" />

        {showAgentFields && (
          <div>
            <div className="flex items-center justify-between">
              <label className="field-label">
                Permissions
                <FieldHelpButton field="Permissions" scope="track" />
                <ModifiedBadge visible={isFieldModified('permissions')} />
              </label>
              <ResetButton
                visible={!!track.permissions}
                onReset={() => commit({ permissions: undefined })}
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
                      checked={!!track.permissions?.[key]}
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
          </div>
        )}

        {/* On Failure */}
        <div>
          <label className="field-label">
            On Failure
            <FieldHelpButton field="On Failure" scope="track" />
            <ModifiedBadge visible={isFieldModified('on_failure')} />
          </label>
          <select
            className="field-input"
            value={track.on_failure ?? ''}
            onChange={(e) => handleOnFailureChange(e.target.value)}
          >
            <option value="">skip_downstream (default)</option>
            <option value="skip_downstream">skip_downstream</option>
            <option value="stop_all">stop_all</option>
            <option value="ignore">ignore</option>
          </select>
          <p
            className={`text-[10px] mt-1 ${(track.on_failure ?? '') === 'stop_all' ? 'text-tagma-warning' : 'text-tagma-muted'}`}
          >
            {ON_FAILURE_DESCRIPTIONS[track.on_failure ?? '']}
          </p>
        </div>

        <div className="border-t border-tagma-border" />

        {/* Task count (readonly) */}
        <div>
          <label className="field-label">
            Tasks <span className="text-tagma-error">*</span>
          </label>
          <div className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1">
            {track.tasks.length} task{track.tasks.length !== 1 ? 's' : ''}
          </div>
        </div>

        {showAgentFields && (
          <MiddlewareEditor
            middlewares={track.middlewares ?? []}
            onChange={(mws) => commit({ middlewares: mws })}
            labelTrailing={<ModifiedBadge visible={isFieldModified('middlewares')} />}
          />
        )}

        {/* Delete */}
        <div className="pt-4 border-t border-tagma-border">
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn-danger flex items-center justify-center gap-1.5"
          >
            <Trash2 size={12} />
            Delete Track
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete track?"
          confirmLabel="Delete track"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDeleteTrack(track.id);
          }}
          message={
            <>
              <p>
                Delete track <span className="font-mono text-tagma-accent">{track.id}</span>?
              </p>
              <p className="text-tagma-muted mt-2">
                This will remove <span className="text-tagma-warning">{track.tasks.length}</span>{' '}
                task
                {track.tasks.length !== 1 ? 's' : ''} and any cross-track dependency references to
                them.
              </p>
              {track.tasks.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                  {track.tasks.map((t) => (
                    <li key={t.id} className="font-mono text-[11px] text-tagma-text/80">
                      &bull; {track.id}.{t.id}
                    </li>
                  ))}
                </ul>
              )}
            </>
          }
        />
      )}
    </div>
  );
}
