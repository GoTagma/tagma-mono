import { useCallback, useMemo } from 'react';
import { AlertTriangle, Pin } from 'lucide-react';
import type {
  CommandConfig,
  RawPipelineConfig,
  HooksConfig,
  HookCommand,
  DiagnosticItem,
} from '../../api/client';
import { useLocalField } from '../../hooks/use-local-field';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { FieldHelpButton } from './FieldHelpButton';
import { ModifiedBadge } from './ModifiedBadge';
import { isPipelineFieldModified } from '../../utils/dirty-tracking';
import { CopyableField } from './CopyableField';
import { InspectorModelField, isBuiltinOpencodeDriver } from './InspectorModelField';

interface PipelineConfigPanelProps {
  config: RawPipelineConfig;
  drivers: string[];
  errors: DiagnosticItem[];
  onUpdate: (fields: Record<string, unknown>) => void;
  isPinned: boolean;
  onTogglePin: () => void;
  readOnly?: boolean;
}

const HOOK_KEYS: (keyof HooksConfig)[] = [
  'pipeline_start',
  'task_start',
  'task_success',
  'task_failure',
  'pipeline_complete',
  'pipeline_error',
];

const GATE_HOOKS: ReadonlySet<string> = new Set(['pipeline_start', 'task_start']);

export function PipelineConfigPanel({
  config,
  drivers,
  errors,
  onUpdate,
  isPinned,
  onTogglePin,
  readOnly = false,
}: PipelineConfigPanelProps) {
  const isDebugView =
    useEditorSettingsStore((s) => s.settings?.viewMode ?? 'production') === 'debug';
  const savedConfig = usePipelineStore((s) => s.savedConfig);
  const isFieldModified = useCallback(
    (key: keyof RawPipelineConfig) => isPipelineFieldModified(savedConfig, config, key),
    [savedConfig, config],
  );
  const [timeout, setTimeout_, blurTimeout] = useLocalField(config.timeout ?? '', (v) =>
    onUpdate({ timeout: v || undefined }),
  );
  const [model, setModel, blurModel] = useLocalField(config.model ?? '', (v) =>
    onUpdate({ model: v || undefined }),
  );

  const hooks = useMemo(() => config.hooks ?? {}, [config.hooks]);

  const commitHook = useCallback(
    (key: keyof HooksConfig, value: HookCommand | undefined) => {
      if (readOnly) return;
      const next = { ...hooks };
      if (value !== undefined) {
        next[key] = value;
      } else {
        delete next[key];
      }
      onUpdate({ hooks: Object.keys(next).length > 0 ? next : undefined });
    },
    [hooks, onUpdate, readOnly],
  );

  const bodyPadding = 'px-4 py-3 space-y-3';

  const body = (
    <fieldset disabled={readOnly} className="contents">
      <div className={`flex-1 overflow-y-auto ${bodyPadding}`}>
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

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label">
              Default Timeout
              <FieldHelpButton field="Default Timeout" scope="pipeline" />
              <ModifiedBadge visible={isFieldModified('timeout')} />
            </label>
            <CopyableField value={timeout} label="Copy default timeout">
              <input
                type="text"
                className="field-input"
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                onBlur={blurTimeout}
                placeholder="e.g. 10m, 60s"
              />
            </CopyableField>
          </div>
          <div className="sm:col-span-2">
            <label className="field-label">
              Default Driver
              <FieldHelpButton field="Default Driver" scope="pipeline" />
              <ModifiedBadge visible={isFieldModified('driver')} />
            </label>
            <select
              className="field-input"
              value={config.driver ?? ''}
              onChange={(e) => onUpdate({ driver: e.target.value || undefined })}
            >
              <option value="">opencode (default)</option>
              {drivers.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="field-label">
              Default Model
              <FieldHelpButton field="Default Model" scope="pipeline" />
              <ModifiedBadge visible={isFieldModified('model')} />
            </label>
            <InspectorModelField
              value={model}
              onChange={setModel}
              onBlur={blurModel}
              copyLabel="Copy default model"
              placeholder={
                isBuiltinOpencodeDriver(config.driver || 'opencode')
                  ? 'e.g. opencode/big-pickle, anthropic/claude-sonnet-4-5'
                  : 'e.g. claude-sonnet-4-6, gpt-5-codex'
              }
              enableOpencodeModels={isBuiltinOpencodeDriver(config.driver || 'opencode')}
            />
            <p className="text-[10px] text-tagma-muted mt-1">
              Exact model name passed to the driver CLI. Inherited by tracks and tasks.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="field-label">
              Reasoning Effort
              <FieldHelpButton field="Reasoning Effort" scope="pipeline" />
              <ModifiedBadge visible={isFieldModified('reasoning_effort')} />
            </label>
            <select
              className="field-input"
              value={config.reasoning_effort ?? ''}
              onChange={(e) => onUpdate({ reasoning_effort: e.target.value || undefined })}
            >
              <option value="">(unset)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>
        </div>

        {isDebugView && (
          <div>
            <label className="field-label">
              Hooks
              <FieldHelpButton field="hooks" scope="pipeline" />
              <ModifiedBadge visible={isFieldModified('hooks')} />
            </label>
            <p className="text-[10px] text-tagma-muted mb-2">
              Shell commands to run at lifecycle events. One command per line; multiple lines are
              executed sequentially. Hooks tagged{' '}
              <span className="text-tagma-warning/80">gate</span> (<code>pipeline_start</code>,{' '}
              <code>task_start</code>) block the pipeline on non-zero exit.
            </p>
            <div className="space-y-3">
              {HOOK_KEYS.map((key) => (
                <HookField
                  key={key}
                  hookKey={key}
                  value={hooks[key]}
                  isGate={GATE_HOOKS.has(key)}
                  onCommit={commitHook}
                />
              ))}
            </div>
          </div>
        )}

        {isDebugView && (
          <>
            <div className="border-t border-tagma-border" />

            <div>
              <label className="field-label">Summary</label>
              <div className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1.5 flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  {config.tracks.length} track{config.tracks.length !== 1 ? 's' : ''}
                </span>
                <span>
                  {config.tracks.reduce((sum, t) => sum + t.tasks.length, 0)} task
                  {config.tracks.reduce((sum, t) => sum + t.tasks.length, 0) !== 1 ? 's' : ''}
                </span>
                {config.plugins && config.plugins.length > 0 && (
                  <span>
                    {config.plugins.length} plugin{config.plugins.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>

            {config.plugins && config.plugins.length > 0 && (
              <div>
                <label className="field-label">Plugins</label>
                <div className="flex flex-col gap-1">
                  {config.plugins.map((p) => (
                    <div
                      key={p}
                      className="text-[11px] font-mono text-tagma-muted bg-tagma-bg border border-tagma-border px-2.5 py-1"
                    >
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </fieldset>
  );

  return (
    <div className="h-full bg-tagma-bg flex flex-col" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
        <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
          Pipeline Inspector{readOnly ? ' (read-only)' : ''}
        </span>
        <button
          onClick={onTogglePin}
          className={`p-1 transition-colors ${isPinned ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text'}`}
          title={isPinned ? 'Unpin panel (allow switching)' : 'Pin panel (lock to this pipeline)'}
          aria-label={isPinned ? 'Unpin panel' : 'Pin panel'}
        >
          <Pin size={12} />
        </button>
      </div>
      {body}
    </div>
  );
}

function commandToHookText(value: CommandConfig): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function hookToText(value: HookCommand | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(commandToHookText).join('\n');
  return commandToHookText(value);
}

function textToHook(text: string): HookCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const parsed = lines.map((line): CommandConfig => {
    if (!line.startsWith('{')) return line;
    try {
      const value = JSON.parse(line) as CommandConfig;
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        (('shell' in value && typeof value.shell === 'string') ||
          ('argv' in value && Array.isArray(value.argv)))
      ) {
        return value;
      }
    } catch {
      /* keep as shell text */
    }
    return line;
  });
  if (parsed.length === 1) return parsed[0];
  return parsed;
}

function HookField({
  hookKey,
  value,
  isGate,
  onCommit,
}: {
  hookKey: keyof HooksConfig;
  value: HookCommand | undefined;
  isGate: boolean;
  onCommit: (key: keyof HooksConfig, value: HookCommand | undefined) => void;
}) {
  const [val, setVal, blurVal] = useLocalField(hookToText(value), (v) =>
    onCommit(hookKey, textToHook(v)),
  );
  const lineCount = val ? val.split('\n').length : 0;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <label className="text-[10px] font-mono text-tagma-muted">{hookKey}</label>
        <FieldHelpButton field={hookKey} scope="pipeline `hooks` block" />
        {isGate && (
          <span
            className="text-[9px] px-1 py-px bg-tagma-warning/10 text-tagma-warning/70 border border-tagma-warning/20 cursor-help"
            title="Gate hook: a non-zero exit code blocks the entire pipeline. Use carefully."
          >
            gate
          </span>
        )}
        {lineCount > 1 && <span className="text-[9px] text-tagma-muted">{lineCount} cmds</span>}
      </div>
      <CopyableField
        value={val}
        label={`Copy ${hookKey} hook`}
        buttonClassName="top-2 translate-y-0"
      >
        <textarea
          className="field-input font-mono text-[11px] resize-y"
          style={{ minHeight: 28, height: lineCount > 1 ? lineCount * 20 + 12 : 28 }}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={blurVal}
          placeholder="shell command(s)..."
          rows={1}
        />
      </CopyableField>
    </div>
  );
}
