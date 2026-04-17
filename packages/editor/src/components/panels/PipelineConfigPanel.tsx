import { useCallback, useMemo } from 'react';
import { X, AlertTriangle } from 'lucide-react';
import type { RawPipelineConfig, HooksConfig, HookCommand } from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { viewportH } from '../../utils/zoom';

interface PipelineConfigPanelProps {
  config: RawPipelineConfig;
  drivers: string[];
  errors: string[];
  onUpdate: (fields: Record<string, unknown>) => void;
  onClose: () => void;
  readOnly?: boolean;
}

const HOOK_KEYS: (keyof HooksConfig)[] = [
  'pipeline_start', 'task_start', 'task_success',
  'task_failure', 'pipeline_complete', 'pipeline_error',
];

const GATE_HOOKS: ReadonlySet<string> = new Set(['pipeline_start', 'task_start']);

export function PipelineConfigPanel({ config, drivers, errors, onUpdate, onClose, readOnly = false }: PipelineConfigPanelProps) {
  const [timeout, setTimeout_, blurTimeout] = useLocalField(config.timeout ?? '', (v) => onUpdate({ timeout: v || undefined }));
  const [model, setModel, blurModel] = useLocalField(config.model ?? '', (v) => onUpdate({ model: v || undefined }));

  const hooks = useMemo(() => config.hooks ?? {}, [config.hooks]);

  const commitHook = useCallback((key: keyof HooksConfig, value: HookCommand | undefined) => {
    if (readOnly) return;
    const next = { ...hooks };
    if (value !== undefined) {
      next[key] = value;
    } else {
      delete next[key];
    }
    onUpdate({ hooks: Object.keys(next).length > 0 ? next : undefined });
  }, [hooks, onUpdate, readOnly]);

  const maxH = useMemo(() => Math.floor(viewportH() * 0.8), []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-tagma-surface border border-tagma-border shadow-panel w-[480px] flex flex-col animate-fade-in" style={{ maxHeight: maxH }} onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <h2 className="panel-title">Pipeline Settings{readOnly ? ' (read-only)' : ''}</h2>
          <button onClick={onClose} className="p-1 text-tagma-muted hover:text-tagma-text transition-colors" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <fieldset disabled={readOnly} className="contents">
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
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

          {/* Driver & Timeout */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="field-label">Default Driver</label>
              <select className="field-input" value={config.driver ?? ''} onChange={(e) => onUpdate({ driver: e.target.value || undefined })}>
                <option value="">claude-code (default)</option>
                {drivers.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="field-label">Default Timeout</label>
              <input type="text" className="field-input" value={timeout} onChange={(e) => setTimeout_(e.target.value)} onBlur={blurTimeout} placeholder="e.g. 10m, 60s" />
            </div>
          </div>

          {/* Default Model & Reasoning Effort */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="field-label">Default Model</label>
              <input type="text" className="field-input font-mono text-[11px]" value={model} onChange={(e) => setModel(e.target.value)} onBlur={blurModel} placeholder="e.g. claude-sonnet-4-6, gpt-5-codex" />
              <p className="text-[10px] text-tagma-muted mt-1">Exact model name passed to the driver CLI. Inherited by tracks and tasks.</p>
            </div>
            <div className="w-[140px]">
              <label className="field-label">Reasoning Effort</label>
              <select className="field-input" value={config.reasoning_effort ?? ''} onChange={(e) => onUpdate({ reasoning_effort: e.target.value || undefined })}>
                <option value="">(unset)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
          </div>

          {/* Hooks */}
          <div>
            <label className="field-label">Hooks</label>
            <p className="text-[10px] text-tagma-muted mb-2">
              Shell commands to run at lifecycle events. One command per line; multiple lines are executed sequentially.
              Hooks tagged <span className="text-amber-400/80">gate</span> (<code>pipeline_start</code>, <code>task_start</code>) block the pipeline on non-zero exit.
            </p>
            <div className="space-y-3">
              {HOOK_KEYS.map((key) => (
                <HookField key={key} hookKey={key} value={hooks[key]} isGate={GATE_HOOKS.has(key)} onCommit={commitHook} />
              ))}
            </div>
          </div>

          <div className="border-t border-tagma-border" />

          {/* Summary */}
          <div>
            <label className="field-label">Summary</label>
            <div className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5 flex gap-4">
              <span>{config.tracks.length} track{config.tracks.length !== 1 ? 's' : ''}</span>
              <span>{config.tracks.reduce((sum, t) => sum + t.tasks.length, 0)} task{config.tracks.reduce((sum, t) => sum + t.tasks.length, 0) !== 1 ? 's' : ''}</span>
              {config.plugins && config.plugins.length > 0 && (
                <span>{config.plugins.length} plugin{config.plugins.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          </div>

          {/* Plugins (read-only listing) */}
          {config.plugins && config.plugins.length > 0 && (
            <div>
              <label className="field-label">Plugins</label>
              <div className="flex flex-col gap-1">
                {config.plugins.map((p) => (
                  <div key={p} className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1">
                    {p}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </fieldset>
      </div>
    </div>
  );
}

function hookToText(value: HookCommand | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.join('\n');
}

function textToHook(text: string): HookCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  if (lines.length === 1) return lines[0];
  return lines;
}

function HookField({ hookKey, value, isGate, onCommit }: {
  hookKey: keyof HooksConfig;
  value: HookCommand | undefined;
  isGate: boolean;
  onCommit: (key: keyof HooksConfig, value: HookCommand | undefined) => void;
}) {
  const [val, setVal, blurVal] = useLocalField(hookToText(value), (v) => onCommit(hookKey, textToHook(v)));
  const lineCount = val ? val.split('\n').length : 0;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-[10px] font-mono text-tagma-muted">{hookKey}</label>
        {isGate && (
          <span
            className="text-[9px] px-1 py-px bg-amber-500/10 text-amber-400/70 border border-amber-500/20 cursor-help"
            title="Gate hook: a non-zero exit code blocks the entire pipeline. Use carefully."
          >
            gate
          </span>
        )}
        {lineCount > 1 && <span className="text-[9px] text-tagma-muted">{lineCount} cmds</span>}
      </div>
      <textarea
        className="field-input w-full font-mono text-[11px] resize-y"
        style={{ minHeight: 28, height: lineCount > 1 ? lineCount * 20 + 12 : 28 }}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={blurVal}
        placeholder="shell command(s)..."
        rows={1}
      />
    </div>
  );
}
