import { useCallback, useMemo, useState } from 'react';
import { Trash2, AlertTriangle, ShieldAlert, Pin } from 'lucide-react';
import type { RawTrackConfig } from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { usePipelineStore } from '../../store/pipeline-store';
import { MiddlewareEditor } from './MiddlewareEditor';
import { InheritedValue, ResetButton, resolveScalar } from './InheritedValue';
import { ConfirmDialog } from './ConfirmDialog';

interface TrackConfigPanelProps {
  track: RawTrackConfig;
  drivers: string[];
  errors: string[];
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

export function TrackConfigPanel({ track, drivers, errors, onUpdateTrack, onDeleteTrack, isPinned, onTogglePin }: TrackConfigPanelProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Read pipeline-level config from the store so we can resolve the inheritance
  // chain (track → pipeline). App.tsx doesn't need to thread anything new.
  const pipelineConfig = usePipelineStore((s) => s.config);

  const commit = useCallback((fields: Record<string, unknown>) => {
    onUpdateTrack(track.id, fields);
  }, [track.id, onUpdateTrack]);

  // Pipeline-level inheritance (pipeline only carries driver/timeout today).
  const resolvedDriver = useMemo(
    () => resolveScalar(track.driver, undefined, pipelineConfig.driver, 'claude-code'),
    [track.driver, pipelineConfig.driver],
  );
  const resolvedModelTier = useMemo(
    () => resolveScalar(track.model_tier, undefined, undefined, 'medium'),
    [track.model_tier],
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
  const [color, setColor, blurColor] = useLocalField(track.color ?? '', (v) => commit({ color: v || undefined }));
  const [agentProfile, setAgentProfile, blurAgentProfile] = useLocalField(track.agent_profile ?? '', (v) => commit({ agent_profile: v || undefined }));
  const [cwd, setCwd, blurCwd] = useLocalField(track.cwd ?? '', (v) => commit({ cwd: v || undefined }));

  const handleModelTierChange = useCallback((model_tier: string) => {
    commit({ model_tier: model_tier || undefined });
  }, [commit]);

  const handleOnFailureChange = useCallback((on_failure: string) => {
    commit({ on_failure: on_failure || undefined });
  }, [commit]);

  const handlePermToggle = useCallback((key: 'read' | 'write' | 'execute') => {
    const current = track.permissions ?? { read: false, write: false, execute: false };
    const next = { ...current, [key]: !current[key] };
    // If all are falsy, remove permissions entirely
    if (!next.read && !next.write && !next.execute) {
      commit({ permissions: undefined });
    } else {
      commit({ permissions: next });
    }
  }, [track.permissions, commit]);

  return (
    <div className={`w-80 h-full bg-tagma-surface border-l flex flex-col animate-slide-in-right ${isPinned ? 'border-tagma-accent/50' : 'border-tagma-border'}`}
      onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">Track Inspector</span>
        <button
          onClick={onTogglePin}
          className={`p-1 transition-colors ${isPinned ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text'}`}
          title={isPinned ? 'Unpin panel (allow switching)' : 'Pin panel (lock to this track)'}
        >
          <Pin size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {errors.length > 0 && (
          <div className="bg-tagma-error/8 border border-tagma-error/30 px-2.5 py-1.5 space-y-1">
            {errors.map((msg, i) => (
              <div key={i} className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
                <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
                <span>{msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* ID (readonly) * */}
        <div>
          <label className="field-label">Track ID <span className="text-tagma-error">*</span></label>
          <div className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5 truncate" title={track.id}>{track.id}</div>
        </div>

        {/* Name * */}
        <div>
          <label className="field-label">Name <span className="text-tagma-error">*</span></label>
          <input type="text" className="field-input" value={name} onChange={(e) => setName(e.target.value)} onBlur={blurName} placeholder="Track name..." />
        </div>

        {/* Color */}
        <div>
          <label className="field-label">Color</label>
          <div className="flex items-center gap-2">
            <input type="color" value={color || '#d4845a'} onChange={(e) => setColor(e.target.value)} onBlur={blurColor}
              className="w-8 h-8 border border-tagma-border bg-tagma-bg cursor-pointer p-0.5" />
            <input type="text" className="field-input flex-1" value={color} onChange={(e) => setColor(e.target.value)} onBlur={blurColor} placeholder="#hex or empty" />
          </div>
        </div>

        <div className="border-t border-tagma-border" />

        {/* Driver */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Driver</label>
            <ResetButton visible={!!track.driver} onReset={() => commit({ driver: undefined })} />
          </div>
          <select className="field-input" value={track.driver ?? ''} onChange={(e) => commit({ driver: e.target.value || undefined })}>
            <option value="">(inherited)</option>
            {drivers.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <InheritedValue isOverridden={!!track.driver} resolved={resolvedDriver} pipelineName={pipelineConfig.name} />
        </div>

        {/* Model Tier */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Model Tier</label>
            <ResetButton visible={!!track.model_tier} onReset={() => commit({ model_tier: undefined })} />
          </div>
          <select className="field-input" value={track.model_tier ?? ''} onChange={(e) => handleModelTierChange(e.target.value)}>
            <option value="">(inherited)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <InheritedValue isOverridden={!!track.model_tier} resolved={resolvedModelTier} pipelineName={pipelineConfig.name} />
        </div>

        {/* Agent Profile */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Agent Profile</label>
            <ResetButton visible={!!track.agent_profile} onReset={() => commit({ agent_profile: undefined })} />
          </div>
          <textarea className="field-input min-h-[60px] resize-y font-mono text-[11px]" value={agentProfile} onChange={(e) => setAgentProfile(e.target.value)} onBlur={blurAgentProfile}
            placeholder="Named profile or multi-line system prompt..." />
          <InheritedValue isOverridden={!!track.agent_profile} resolved={resolvedAgentProfile} pipelineName={pipelineConfig.name} />
        </div>

        {/* CWD */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Working Directory</label>
            <ResetButton visible={!!track.cwd} onReset={() => commit({ cwd: undefined })} />
          </div>
          <input type="text" className="field-input font-mono text-[11px]" value={cwd} onChange={(e) => setCwd(e.target.value)} onBlur={blurCwd} placeholder="./path (relative, inherited)" />
          <InheritedValue isOverridden={!!track.cwd} resolved={resolvedCwd} pipelineName={pipelineConfig.name} />
        </div>

        <div className="border-t border-tagma-border" />

        {/* Permissions */}
        <div>
          <div className="flex items-center justify-between">
            <label className="field-label">Permissions</label>
            <ResetButton visible={!!track.permissions} onReset={() => commit({ permissions: undefined })} />
          </div>
          <div className="flex gap-3">
            {(['read', 'write', 'execute'] as const).map((key) => {
              const isExecute = key === 'execute';
              return (
                <label key={key} className="flex items-center gap-1.5 cursor-pointer"
                  title={isExecute ? 'Allows arbitrary shell execution (Bash, bypassPermissions on claude-code). Enable only in trusted workdirs.' : undefined}>
                  <input type="checkbox" checked={!!track.permissions?.[key]}
                    onChange={() => handlePermToggle(key)}
                    className="accent-tagma-accent" />
                  <span className={`text-[11px] capitalize ${isExecute ? 'text-tagma-error' : 'text-tagma-text'}`}>{key}</span>
                  {isExecute && <ShieldAlert size={10} className="text-tagma-error" />}
                </label>
              );
            })}
          </div>
        </div>

        {/* On Failure */}
        <div>
          <label className="field-label">On Failure</label>
          <select className="field-input" value={track.on_failure ?? ''} onChange={(e) => handleOnFailureChange(e.target.value)}>
            <option value="">skip_downstream (default)</option>
            <option value="skip_downstream">skip_downstream</option>
            <option value="stop_all">stop_all</option>
            <option value="ignore">ignore</option>
          </select>
          <p className={`text-[10px] mt-1 ${(track.on_failure ?? '') === 'stop_all' ? 'text-amber-400' : 'text-tagma-muted'}`}>
            {ON_FAILURE_DESCRIPTIONS[track.on_failure ?? '']}
          </p>
        </div>

        <div className="border-t border-tagma-border" />

        {/* Task count (readonly) */}
        <div>
          <label className="field-label">Tasks <span className="text-tagma-error">*</span></label>
          <div className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5">{track.tasks.length} task{track.tasks.length !== 1 ? 's' : ''}</div>
        </div>

        {/* Middlewares */}
        <MiddlewareEditor middlewares={track.middlewares ?? []}
          onChange={(mws) => commit({ middlewares: mws })} />

        {/* Delete */}
        <div className="pt-4 border-t border-tagma-border">
          <button onClick={() => setConfirmDelete(true)} className="btn-danger flex items-center justify-center gap-1.5">
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
                This will remove <span className="text-amber-400">{track.tasks.length}</span> task
                {track.tasks.length !== 1 ? 's' : ''} and any cross-track dependency references to them.
              </p>
              {track.tasks.length > 0 && (
                <ul className="mt-1 max-h-32 overflow-y-auto space-y-0.5">
                  {track.tasks.map((t) => (
                    <li key={t.id} className="font-mono text-[11px] text-tagma-text/80">&bull; {track.id}.{t.id}</li>
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
