// Read-only track info panel shown in Run mode when the user clicks a
// track header. Mirrors the high-value content of TrackConfigPanel but
// skips all the mutation controls so the Run screen stays purely
// observational.

import { X, ShieldAlert, SkipForward, Ban, Layers } from 'lucide-react';
import type { RawTrackConfig, RawPipelineConfig, Permissions } from '../../api/client';

interface TrackInfoPanelProps {
  track: RawTrackConfig;
  config: RawPipelineConfig;
  onClose: () => void;
}

const ON_FAILURE_LABEL: Record<string, string> = {
  skip_downstream: 'skip_downstream (default)',
  stop_all: 'stop_all',
  ignore: 'ignore',
};

const ON_FAILURE_ICON: Record<string, React.ReactNode> = {
  skip_downstream: <SkipForward size={10} className="text-tagma-muted/60" />,
  stop_all: <ShieldAlert size={10} className="text-tagma-error/70" />,
  ignore: <Ban size={10} className="text-tagma-muted/60" />,
};

function permsLabel(perms: Permissions | undefined | null): string | null {
  if (!perms) return null;
  const parts: string[] = [];
  if (perms.read) parts.push('Read');
  if (perms.write) parts.push('Write');
  if (perms.execute) parts.push('Execute');
  return parts.length ? parts.join(' + ') : null;
}

function ConfigRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-[2px] text-[10px]">
      <span className="text-tagma-muted/70 w-[80px] shrink-0 font-mono tracking-tight">
        {label}
      </span>
      <span className="flex-1 min-w-0 break-words font-mono text-tagma-text/80">{children}</span>
    </div>
  );
}

export function TrackInfoPanel({ track, config, onClose }: TrackInfoPanelProps) {
  // Inheritance chain: track → pipeline → default. We surface the resolved
  // values with an explicit "(inherited)" marker so the user can see what
  // the track actually contributes vs what came from above.
  const driver = track.driver ?? config.driver ?? 'claude-code';
  const driverSource = track.driver ? 'track' : config.driver ? 'pipeline' : 'default';
  const model = track.model ?? config.model ?? null;
  const cwd = track.cwd ?? null;
  const agentProfile = track.agent_profile ?? null;
  const onFailure = track.on_failure ?? 'skip_downstream';

  const perms = track.permissions ?? null;
  const middlewares = track.middlewares ?? [];

  return (
    <div className="w-80 h-full bg-tagma-surface border-l border-tagma-border flex flex-col animate-slide-in-right">
      <div className="panel-header-sm">
        <div className="flex items-center gap-2 min-w-0">
          {track.color && (
            <span className="w-2 h-2 shrink-0" style={{ backgroundColor: track.color }} />
          )}
          <h2 className="panel-title-sm truncate">{track.name}</h2>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Basic identity */}
        <div>
          <label className="field-label">Track ID</label>
          <div
            className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5 truncate"
            title={track.id}
          >
            {track.id}
          </div>
        </div>

        {/* Core config */}
        <div>
          <label className="field-label">Configuration (read-only)</label>
          <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5">
            <ConfigRow label="Tasks">{track.tasks.length}</ConfigRow>
            <ConfigRow label="Driver">
              {driver}
              {driverSource !== 'track' && (
                <span className="text-tagma-muted/50 ml-1.5">(from {driverSource})</span>
              )}
            </ConfigRow>
            {model && <ConfigRow label="Model">{model}</ConfigRow>}
            {permsLabel(perms) && <ConfigRow label="Permissions">{permsLabel(perms)}</ConfigRow>}
            {cwd && <ConfigRow label="CWD">{cwd}</ConfigRow>}
            {agentProfile && <ConfigRow label="Profile">{agentProfile}</ConfigRow>}
          </div>
        </div>

        {/* On failure */}
        <div>
          <label className="field-label">On Failure</label>
          <div className="flex items-center gap-2 text-[11px] font-mono text-tagma-text bg-tagma-bg border border-tagma-border px-2.5 py-1.5">
            {ON_FAILURE_ICON[onFailure] ?? null}
            <span>{ON_FAILURE_LABEL[onFailure] ?? onFailure}</span>
          </div>
        </div>

        {/* Middlewares */}
        {middlewares.length > 0 && (
          <div>
            <label className="field-label flex items-center gap-1">
              <Layers size={9} /> Middlewares ({middlewares.length})
            </label>
            <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5 space-y-0.5">
              {middlewares.map((mw, i) => {
                const label = typeof mw.label === 'string' ? mw.label : undefined;
                const file = typeof mw.file === 'string' ? mw.file : undefined;
                return (
                  <ConfigRow key={`${mw.type}-${i}`} label={mw.type}>
                    {label ?? file ?? '—'}
                  </ConfigRow>
                );
              })}
            </div>
          </div>
        )}

        {/* Task list (clickable to jump selection) */}
        {track.tasks.length > 0 && (
          <div>
            <label className="field-label">Tasks in this track</label>
            <div className="border border-tagma-border/60 bg-tagma-bg/40 px-2.5 py-1.5 space-y-0.5">
              {track.tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-2 py-[2px] text-[10px] font-mono text-tagma-text/80 min-w-0"
                >
                  <span className="text-tagma-muted/60 truncate">
                    {track.id}.{task.id}
                  </span>
                  {task.name && task.name !== task.id && (
                    <span className="text-tagma-muted/40 truncate">— {task.name}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
