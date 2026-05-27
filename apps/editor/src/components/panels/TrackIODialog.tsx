import { useEffect, useMemo, useState } from 'react';
import { X as XIcon } from 'lucide-react';
import type { RawPipelineConfig } from '../../api/client';
import {
  collectPipelineInputs,
  collectPipelineOutputs,
  collectTrackInputs,
  collectTrackOutputs,
  type PortIORow,
} from '../../utils/ports';

interface TrackIODialogProps {
  config: RawPipelineConfig;
  onClose: () => void;
}

type DisplayMode = 'all' | 'by-track';
type ScopeMode = 'all' | 'by-node';

export function TrackIODialog({ config, onClose }: TrackIODialogProps) {
  const tracks = config.tracks;
  const [mode, setMode] = useState<DisplayMode>('all');
  const [trackId, setTrackId] = useState<string>(() => tracks[0]?.id ?? '');
  const [scope, setScope] = useState<ScopeMode>('all');
  const [taskId, setTaskId] = useState<string>('');

  // Pipeline-boundary I/O — used by the All mode and unaffected by track
  // selection.
  const pipelineInputs = useMemo(() => collectPipelineInputs(config), [config]);
  const pipelineOutputs = useMemo(() => collectPipelineOutputs(config), [config]);

  // Track-boundary I/O for the currently selected track. Only computed
  // when the user is in by-track mode to avoid wasted work.
  const trackInputs = useMemo(
    () => (mode === 'by-track' && trackId ? collectTrackInputs(config, trackId) : []),
    [mode, trackId, config],
  );
  const trackOutputs = useMemo(
    () => (mode === 'by-track' && trackId ? collectTrackOutputs(config, trackId) : []),
    [mode, trackId, config],
  );

  // Keep trackId pointing at a real track once the user enters by-track.
  useEffect(() => {
    if (mode !== 'by-track') return;
    if (!tracks.some((t) => t.id === trackId) && tracks[0]?.id) {
      setTrackId(tracks[0].id);
    }
  }, [mode, trackId, tracks]);

  // Nodes available for the by-node picker: only tasks in the selected
  // track that expose at least one track-boundary input or output (the
  // OR rule the user confirmed).
  const nodesForTrack = useMemo(() => {
    if (mode !== 'by-track' || !trackId) return [];
    const ioQids = new Set<string>();
    for (const r of trackInputs) ioQids.add(r.qid);
    for (const r of trackOutputs) ioQids.add(r.qid);
    const track = tracks.find((t) => t.id === trackId);
    if (!track) return [];
    return (track.tasks ?? []).filter((t) => t.id && ioQids.has(`${trackId}.${t.id}`));
  }, [mode, trackId, trackInputs, trackOutputs, tracks]);

  // Keep the by-node selection valid as the available nodes change.
  useEffect(() => {
    if (scope !== 'by-node') return;
    const ids = nodesForTrack.map((t) => t.id);
    if (!ids.includes(taskId)) setTaskId(ids[0] ?? '');
  }, [scope, nodesForTrack, taskId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const filteredInputs = useMemo(
    () => filterRows(mode === 'all' ? pipelineInputs : trackInputs, mode, scope, taskId),
    [mode, scope, taskId, pipelineInputs, trackInputs],
  );
  const filteredOutputs = useMemo(
    () => filterRows(mode === 'all' ? pipelineOutputs : trackOutputs, mode, scope, taskId),
    [mode, scope, taskId, pipelineOutputs, trackOutputs],
  );

  const selectClass =
    'text-[11px] bg-tagma-bg border border-tagma-border px-2 py-1 text-tagma-text focus:border-tagma-accent outline-none';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[640px] max-h-[80vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 className="panel-title">Track I/O</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-tagma-border flex flex-wrap items-center gap-3">
          <FilterField label="Display">
            <select
              className={selectClass}
              value={mode}
              onChange={(e) => setMode(e.target.value as DisplayMode)}
            >
              <option value="all">All</option>
              <option value="by-track">By Track</option>
            </select>
          </FilterField>

          {mode === 'by-track' && (
            <>
              <FilterField label="Track">
                <select
                  className={selectClass}
                  value={trackId}
                  onChange={(e) => setTrackId(e.target.value)}
                  disabled={tracks.length === 0}
                >
                  {tracks.length === 0 ? (
                    <option value="">No tracks</option>
                  ) : (
                    tracks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))
                  )}
                </select>
              </FilterField>
              <FilterField label="Scope">
                <select
                  className={selectClass}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as ScopeMode)}
                >
                  <option value="all">All</option>
                  <option value="by-node">By Node</option>
                </select>
              </FilterField>
              {scope === 'by-node' && (
                <FilterField label="Node">
                  <select
                    className={selectClass}
                    value={taskId}
                    onChange={(e) => setTaskId(e.target.value)}
                    disabled={nodesForTrack.length === 0}
                  >
                    {nodesForTrack.length === 0 ? (
                      <option value="">No nodes with track I/O</option>
                    ) : (
                      nodesForTrack.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name ? `${t.id} — ${t.name}` : t.id}
                        </option>
                      ))
                    )}
                  </select>
                </FilterField>
              )}
            </>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          <Section
            title="Inputs"
            rows={filteredInputs}
            mode={mode}
            emptyText={
              mode === 'all'
                ? 'No pipeline-level inputs.'
                : 'No track-boundary inputs (this track is fully self-contained on the input side).'
            }
          />
          <Section
            title="Outputs"
            rows={filteredOutputs}
            mode={mode}
            emptyText={
              mode === 'all'
                ? 'No pipeline-level outputs.'
                : 'No track-boundary outputs (every output is consumed inside this track).'
            }
          />
        </div>

        <div className="px-4 py-3 border-t border-tagma-border flex justify-end">
          <button onClick={onClose} className="btn-primary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function filterRows(
  rows: readonly PortIORow[],
  mode: DisplayMode,
  scope: ScopeMode,
  taskId: string,
): PortIORow[] {
  if (mode === 'all' || scope === 'all') return [...rows];
  if (!taskId) return [];
  return rows.filter((r) => r.taskId === taskId);
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] font-mono uppercase tracking-wider text-tagma-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function Section({
  title,
  rows,
  mode,
  emptyText,
}: {
  title: string;
  rows: PortIORow[];
  mode: DisplayMode;
  emptyText: string;
}) {
  return (
    <div className="border-b border-tagma-border/60 last:border-b-0">
      <div className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-tagma-muted bg-tagma-bg/40 border-b border-tagma-border/30">
        {title} ({rows.length})
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-[11px] font-mono text-tagma-muted/70">{emptyText}</div>
      ) : (
        <ul>
          {rows.map((row, i) => (
            <li
              key={`${row.qid}::${row.port.name}::${i}`}
              className="px-4 py-2 border-t border-tagma-border/30 first:border-t-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
                  <span className="text-[12px] font-mono font-semibold text-tagma-text">
                    {row.port.name}
                  </span>
                  <span className="text-[10px] font-mono text-tagma-muted/70 shrink-0">
                    {row.port.type}
                  </span>
                  {row.port.required && (
                    <span className="text-[9px] font-mono uppercase tracking-wider text-tagma-warning/80 bg-tagma-warning/8 px-1 py-px shrink-0">
                      required
                    </span>
                  )}
                  {row.port.default !== undefined && (
                    <span className="text-[9px] font-mono uppercase tracking-wider text-tagma-muted/70 bg-tagma-bg/60 px-1 py-px shrink-0">
                      default
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-mono text-tagma-muted/70 shrink-0 truncate max-w-[40%] text-right">
                  {mode === 'all' ? `${row.trackName}/${row.taskId}` : row.taskId}
                </span>
              </div>
              {row.port.description && (
                <div className="mt-1 text-[11px] text-tagma-muted/80">{row.port.description}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
