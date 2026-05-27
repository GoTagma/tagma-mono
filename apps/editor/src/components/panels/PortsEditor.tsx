import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Plus, RefreshCw, X } from 'lucide-react';
import type {
  PortType,
  TaskInputBinding,
  TaskInputBindings,
  TaskOutputBinding,
  TaskOutputBindings,
} from '../../api/client';
import {
  buildUnifiedPortsView,
  type InferredPromptPortsView,
  type PortDrift,
  type UnifiedPortRow,
  type UpstreamOutputCandidate,
} from '../../utils/ports';
import { useLocalField } from '../../hooks/use-local-field';
import { FieldHelpButton } from './FieldHelpButton';
import { CopyableField } from './CopyableField';

const PORT_TYPES: PortType[] = ['string', 'number', 'boolean', 'enum', 'json'];

type InputRow = TaskInputBinding & { name: string };
type OutputRow = TaskOutputBinding & { name: string };
type BindingRow = InputRow | OutputRow;

interface PortsEditorProps {
  inputs: TaskInputBindings | undefined;
  outputs: TaskOutputBindings | undefined;
  onChange: (next: {
    inputs?: TaskInputBindings | undefined;
    outputs?: TaskOutputBindings | undefined;
  }) => void;

  /**
   * Direct-upstream outputs from the current pipeline, used to populate
   * the "suggestions" dropdown and to draw drift warnings on inputs that
   * were once in sync but no longer are. Empty when no upstream exists
   * or none of them declare outputs.
   */
  upstreamCandidates: readonly UpstreamOutputCandidate[];
  drift: readonly PortDrift[];
  ambiguous: readonly { readonly portName: string; readonly producers: readonly string[] }[];

  /**
   * Callback that writes a fully-synced `inputs` map derived
   * from the current upstream outputs. Only shown when there are
   * candidates the user hasn't imported yet.
   */
  onSyncFromUpstream: () => void;

  /**
   * How many upstream outputs would be imported by pressing "sync".
   * Used to label the button; zero hides the button entirely.
   */
  syncNewCount: number;

  /**
   * Callback that writes a fully-synced `outputs` map derived
   * from the inputs declared by direct downstream tasks. Symmetric to
   * `onSyncFromUpstream`: useful when the upstream hasn't declared
   * outputs yet but downstreams are already expecting them.
   */
  onSyncFromDownstream: () => void;

  /**
   * How many downstream-declared input names would be adopted as new
   * outputs by pressing "sync from downstream". Zero hides the button.
   */
  syncNewOutputCount: number;

  /**
   * Prompt tasks pass their runtime-inferred neighbor ports here so this
   * editor can render inferred/manual/overridden rows in the same surface.
   * Command tasks omit it and render only explicit bindings.
   */
  inferredView?: InferredPromptPortsView | null;
  /** Optional trailing element on the Inputs label (typically a <ModifiedBadge />). */
  inputsLabelTrailing?: React.ReactNode;
  /** Optional trailing element on the Outputs label. */
  outputsLabelTrailing?: React.ReactNode;
  /**
   * Whether to render the Outputs section. Production view hides outputs
   * (debug-only) but keeps inputs visible so users can edit nodes that
   * require human-defined input values without flipping to Debug view.
   */
  showOutputs?: boolean;
}

export function PortsEditor({
  inputs,
  outputs,
  onChange,
  upstreamCandidates,
  drift,
  ambiguous,
  onSyncFromUpstream,
  syncNewCount,
  onSyncFromDownstream,
  syncNewOutputCount,
  inferredView,
  inputsLabelTrailing,
  outputsLabelTrailing,
  showOutputs = true,
}: PortsEditorProps) {
  const inputRows = useMemo(() => inputBindingsToRows(inputs), [inputs]);
  const outputRows = useMemo(() => outputBindingsToRows(outputs), [outputs]);
  const unifiedView = useMemo(
    () => buildUnifiedPortsView({ inputs, outputs, inferred: inferredView }),
    [inputs, outputs, inferredView],
  );

  const driftByName = useMemo(() => {
    const m = new Map<string, PortDrift>();
    for (const d of drift) m.set(d.portName, d);
    return m;
  }, [drift]);

  const ambiguousByName = useMemo(() => {
    const m = new Map<string, readonly string[]>();
    for (const a of ambiguous) m.set(a.portName, a.producers);
    return m;
  }, [ambiguous]);

  const writePorts = useCallback(
    (next: { inputs?: InputRow[]; outputs?: OutputRow[] }): void => {
      const nextInputs = next.inputs !== undefined ? next.inputs : inputRows.slice();
      const nextOutputs = next.outputs !== undefined ? next.outputs : outputRows.slice();
      onChange({
        inputs: inputRowsToBindings(nextInputs),
        outputs: outputRowsToBindings(nextOutputs),
      });
    },
    [inputRows, outputRows, onChange],
  );

  const addInput = () => {
    const name = freshPortName(inputRows, 'input');
    writePorts({ inputs: [...inputRows, { name, type: 'string', required: true }] });
  };
  const addOutput = () => {
    const name = freshPortName(outputRows, 'output');
    writePorts({ outputs: [...outputRows, { name, type: 'string' }] });
  };
  const removeInput = (name: string) =>
    writePorts({ inputs: inputRows.filter((p) => p.name !== name) });
  const removeOutput = (name: string) =>
    writePorts({ outputs: outputRows.filter((p) => p.name !== name) });
  const updateInput = (row: UnifiedPortRow, patch: Partial<InputRow>) =>
    writePorts({
      inputs: upsertInputRow(inputRows, seedInputRow(row), patch),
    });
  const updateOutput = (row: UnifiedPortRow, patch: Partial<OutputRow>) =>
    writePorts({
      outputs: upsertOutputRow(outputRows, seedOutputRow(row), patch),
    });
  const customizeInput = (row: UnifiedPortRow) =>
    writePorts({ inputs: upsertInputRow(inputRows, seedInputRow(row), {}) });
  const customizeOutput = (row: UnifiedPortRow) =>
    writePorts({ outputs: upsertOutputRow(outputRows, seedOutputRow(row), {}) });

  return (
    <div className="space-y-3">
      {/* ── Inputs ── */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="field-label mb-0">
            Inputs
            <FieldHelpButton field="inputs" scope="task" />
            {inputsLabelTrailing}
          </label>
          <div className="flex items-center gap-2">
            {syncNewCount > 0 && (
              <button
                onClick={onSyncFromUpstream}
                className="flex items-center gap-1 text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
                title="Import upstream outputs as inputs on this task"
              >
                <ArrowDownToLine size={10} />
                Sync {syncNewCount} from upstream
              </button>
            )}
            <button
              onClick={addInput}
              className="flex items-center gap-1 text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
            >
              <Plus size={10} /> Add
            </button>
          </div>
        </div>
        {unifiedView.inputs.length === 0 && (
          <p className="text-[10px] text-tagma-muted">
            No inputs. Reference values in{' '}
            <code className="text-tagma-text/80">{'{{inputs.name}}'}</code> to start.
          </p>
        )}
        <div className="space-y-2">
          {unifiedView.inputs.map((port) => (
            <PortRow
              key={`input-${port.name}-${port.status}`}
              kind="input"
              row={port}
              onUpdate={(patch) => updateInput(port, patch)}
              onRemove={() => removeInput(port.name)}
              onCustomize={() => customizeInput(port)}
              drift={driftByName.get(port.name)}
              ambiguousProducers={ambiguousByName.get(port.name)}
              upstreamCandidates={upstreamCandidates}
            />
          ))}
        </div>
      </div>

      {/* ── Outputs ── */}
      {showOutputs && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="field-label mb-0">
              Outputs
              <FieldHelpButton field="outputs" scope="task" />
              {outputsLabelTrailing}
            </label>
            <div className="flex items-center gap-2">
              {syncNewOutputCount > 0 && (
                <button
                  onClick={onSyncFromDownstream}
                  className="flex items-center gap-1 text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
                  title="Adopt downstream inputs as outputs on this task"
                >
                  <ArrowUpFromLine size={10} />
                  Sync {syncNewOutputCount} from downstream
                </button>
              )}
              <button
                onClick={addOutput}
                className="flex items-center gap-1 text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
              >
                <Plus size={10} /> Add
              </button>
            </div>
          </div>
          {unifiedView.outputs.length === 0 && (
            <p className="text-[10px] text-tagma-muted">
              No outputs. Declare what downstream tasks can read from this one — the engine injects
              an Output Format block so the model emits final-line JSON.
            </p>
          )}
          <div className="space-y-2">
            {unifiedView.outputs.map((port) => (
              <PortRow
                key={`output-${port.name}-${port.status}`}
                kind="output"
                row={port}
                onUpdate={(patch) => updateOutput(port, patch)}
                onRemove={() => removeOutput(port.name)}
                onCustomize={() => customizeOutput(port)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PortRow({
  kind,
  row,
  onUpdate,
  onRemove,
  onCustomize,
  drift,
  ambiguousProducers,
  upstreamCandidates,
}: {
  kind: 'input' | 'output';
  row: UnifiedPortRow;
  onUpdate: (patch: Partial<BindingRow>) => void;
  onRemove: () => void;
  onCustomize: () => void;
  drift?: PortDrift;
  ambiguousProducers?: readonly string[];
  upstreamCandidates?: readonly UpstreamOutputCandidate[];
}) {
  const port = rowToBindingRow(row);
  const enumValuesStr = (port.enum ?? []).join(', ');
  const isEditable = row.status === 'manual' || row.status === 'overridden';
  const canCustomize = row.status === 'inferred' || row.status === 'conflict';

  // Text fields are buffered locally (debounced commit on change, flush on
  // blur) so fast typing doesn't race with the round-trip through the
  // pipeline store. Without this, every keystroke triggered an immediate
  // store write → parent re-render → `value` reset, which dropped or
  // duplicated characters when typing quickly.
  const [name, setName, blurName] = useLocalField(port.name, (v) => onUpdate({ name: v }));
  const [description, setDescription, blurDescription] = useLocalField(
    port.description ?? '',
    (v) => onUpdate({ description: v || undefined }),
  );
  const [defaultStr, setDefaultStr, blurDefaultStr] = useLocalField(
    formatDefault(port.default),
    (v) => onUpdate({ default: parseDefaultLiteral(v, port.type ?? 'json') }),
  );
  const [valueStr, setValueStr, blurValueStr] = useLocalField(formatDefault(port.value), (v) =>
    onUpdate({ value: parseDefaultLiteral(v, port.type ?? 'json') }),
  );
  const [fromStr, setFromStr, blurFromStr] = useLocalField(port.from ?? '', (v) =>
    onUpdate({ from: v.trim() || undefined }),
  );
  const [enumStr, setEnumStr, blurEnumStr] = useLocalField(enumValuesStr, (v) => {
    const parts = v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    onUpdate({ enum: parts.length > 0 ? parts : undefined });
  });
  const [sourceModeOverride, setSourceModeOverride] = useState<SourceMode | null>(null);
  const sourceMode = sourceModeOverride ?? sourceModeForRow(row);

  // For inputs, show a compact producer picker. The editor rewrites
  // `from` when the user picks a specific upstream.producer.port so
  // runtime resolution is unambiguous.
  const fromOptions = useMemo(() => {
    if (kind !== 'input' || !upstreamCandidates) return [];
    return upstreamCandidates.filter((c) => c.port.name === port.name);
  }, [kind, upstreamCandidates, port.name]);

  return (
    <div
      className={`border p-2 space-y-1.5 relative ${
        row.status === 'conflict'
          ? 'bg-tagma-error/5 border-tagma-error/40'
          : 'bg-tagma-bg border-tagma-border'
      }`}
    >
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
        {canCustomize && (
          <button
            onClick={onCustomize}
            className="text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
            title={`Create a manual ${kind} binding from this row`}
          >
            Customize
          </button>
        )}
        {isEditable && (
          <button
            onClick={onRemove}
            className="text-tagma-muted hover:text-tagma-error transition-colors"
            aria-label={`Remove ${kind} binding`}
            title={row.status === 'overridden' ? 'Remove manual override' : `Remove ${kind}`}
          >
            <X size={10} />
          </button>
        )}
      </div>

      {/* Row 1: name + type */}
      <div className="flex items-end gap-1.5 pr-16">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <label className="text-[10px] text-tagma-muted">Name</label>
            <StatusBadge status={row.status} />
          </div>
          {isEditable ? (
            <CopyableField value={name} label={`Copy ${kind} name`}>
              <input
                type="text"
                className="field-input font-mono text-[11px]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={blurName}
                placeholder="e.g. city"
              />
            </CopyableField>
          ) : (
            <div className="field-input font-mono text-[11px] bg-tagma-surface/40">{row.name}</div>
          )}
        </div>
        <div className="w-[96px]">
          <label className="text-[10px] text-tagma-muted">Type</label>
          {isEditable ? (
            <select
              className="field-input text-[11px]"
              value={port.type ?? ''}
              onChange={(e) =>
                onUpdate({
                  type: e.target.value ? (e.target.value as PortType) : undefined,
                  // Clear enum when switching away from enum so stale values
                  // don't get shipped back via YAML round-trip.
                  ...(e.target.value !== 'enum' ? { enum: undefined } : {}),
                })
              }
            >
              <option value="">untyped</option>
              {PORT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : (
            <div className="field-input text-[11px] bg-tagma-surface/40">{port.type ?? 'json'}</div>
          )}
        </div>
      </div>

      {/* Row 2: description */}
      <div>
        <label className="text-[10px] text-tagma-muted">Description</label>
        {isEditable ? (
          <CopyableField value={description} label={`Copy ${kind} description`}>
            <input
              type="text"
              className="field-input text-[11px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={blurDescription}
              placeholder={
                kind === 'input'
                  ? 'What the downstream needs this for — shown to the model'
                  : 'What this value represents — shown to downstream tasks'
              }
            />
          </CopyableField>
        ) : (
          <div className="field-input text-[11px] bg-tagma-surface/40">
            {description || 'No description'}
          </div>
        )}
      </div>

      {/* Row 3 (enum only): comma-separated values */}
      {port.type === 'enum' && (
        <div>
          <label className="text-[10px] text-tagma-muted">
            Allowed values <span className="text-tagma-muted/60">(comma-separated)</span>
          </label>
          {isEditable ? (
            <CopyableField value={enumStr} label={`Copy ${kind} enum values`}>
              <input
                type="text"
                className="field-input font-mono text-[11px]"
                value={enumStr}
                onChange={(e) => setEnumStr(e.target.value)}
                onBlur={blurEnumStr}
                placeholder="low, medium, high"
              />
            </CopyableField>
          ) : (
            <div className="field-input font-mono text-[11px] bg-tagma-surface/40">
              {enumStr || 'none'}
            </div>
          )}
        </div>
      )}

      {/* Row 4: required / source */}
      <div className="grid grid-cols-1 gap-1.5">
        {kind === 'input' && (
          <label className="text-[10px] text-tagma-text flex items-center gap-1">
            <input
              type="checkbox"
              checked={(port as InputRow).required === true}
              disabled={!isEditable}
              onChange={(e) =>
                isEditable && onUpdate({ required: e.target.checked ? true : undefined })
              }
              className="accent-tagma-accent"
            />
            Required
          </label>
        )}
        <SourceEditor
          kind={kind}
          port={port}
          row={row}
          sourceMode={sourceMode}
          setSourceModeOverride={setSourceModeOverride}
          isEditable={isEditable}
          fromStr={fromStr}
          setFromStr={setFromStr}
          blurFromStr={blurFromStr}
          defaultStr={defaultStr}
          setDefaultStr={setDefaultStr}
          blurDefaultStr={blurDefaultStr}
          valueStr={valueStr}
          setValueStr={setValueStr}
          blurValueStr={blurValueStr}
          onUpdate={onUpdate}
        />
      </div>

      {kind === 'input' && isEditable && sourceMode === 'specific' && fromOptions.length > 0 && (
        <div>
          <label className="text-[10px] text-tagma-muted">Upstream candidates</label>
          <div className="flex flex-wrap gap-1">
            {fromOptions.map((c) => {
              const source = sourceForUpstreamCandidate(c, upstreamCandidates ?? []);
              return (
                <button
                  key={source}
                  type="button"
                  className="text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
                  onClick={() => onUpdate({ from: source })}
                >
                  {source}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {row.conflict && (
        <div className="flex items-start gap-1 text-[10px] text-tagma-warning">
          <AlertTriangle size={10} className="mt-0.5 shrink-0" />
          <span>{row.conflict.reason}</span>
        </div>
      )}

      {/* Ambiguity hint for inputs — fires when ≥2 upstreams export this name */}
      {kind === 'input' &&
        isEditable &&
        ambiguousProducers &&
        ambiguousProducers.length > 1 &&
        (!port.from || port.from === `outputs.${port.name}`) && (
          <div className="flex items-start gap-1 text-[10px] text-tagma-warning">
            <AlertTriangle size={10} className="mt-0.5 shrink-0" />
            <span>
              Ambiguous: {ambiguousProducers.join(', ')} all export <code>{port.name}</code>. Pick a
              producer in the From field above.
            </span>
          </div>
        )}

      {/* Drift hint — the upstream changed since this input was synced */}
      {kind === 'input' && drift && (
        <div className="flex items-start gap-1 text-[10px] text-tagma-warning">
          <RefreshCw size={10} className="mt-0.5 shrink-0" />
          <span>
            Upstream{' '}
            <code>
              {drift.upstreamQid}.{drift.portName}
            </code>{' '}
            changed: {drift.changes.join('; ')}
          </span>
        </div>
      )}
    </div>
  );
}

type SourceMode = 'auto' | 'specific' | 'literal' | 'default' | 'json' | 'stream';

function StatusBadge({ status }: { status: UnifiedPortRow['status'] }) {
  const className =
    status === 'conflict'
      ? 'border-tagma-error/50 text-tagma-error bg-tagma-error/10'
      : status === 'inferred'
        ? 'border-tagma-info/45 text-tagma-info bg-tagma-info/10'
        : status === 'overridden'
          ? 'border-tagma-warning/45 text-tagma-warning bg-tagma-warning/10'
          : 'border-tagma-border text-tagma-muted bg-tagma-surface/50';
  return (
    <span className={`px-1.5 py-0.5 border text-[9px] uppercase tracking-wide ${className}`}>
      {status}
    </span>
  );
}

function SourceEditor({
  kind,
  port,
  row,
  sourceMode,
  setSourceModeOverride,
  isEditable,
  fromStr,
  setFromStr,
  blurFromStr,
  defaultStr,
  setDefaultStr,
  blurDefaultStr,
  valueStr,
  setValueStr,
  blurValueStr,
  onUpdate,
}: {
  kind: 'input' | 'output';
  port: BindingRow;
  row: UnifiedPortRow;
  sourceMode: SourceMode;
  setSourceModeOverride: (mode: SourceMode | null) => void;
  isEditable: boolean;
  fromStr: string;
  setFromStr: (value: string) => void;
  blurFromStr: () => void;
  defaultStr: string;
  setDefaultStr: (value: string) => void;
  blurDefaultStr: () => void;
  valueStr: string;
  setValueStr: (value: string) => void;
  blurValueStr: () => void;
  onUpdate: (patch: Partial<BindingRow>) => void;
}) {
  const changeSourceMode = (mode: SourceMode) => {
    setSourceModeOverride(mode);
    if (kind === 'input') {
      if (mode === 'auto') {
        onUpdate({ from: undefined, value: undefined, default: undefined });
      } else if (mode === 'specific') {
        onUpdate({ value: undefined, default: undefined });
      } else if (mode === 'literal') {
        onUpdate({ from: undefined, default: undefined });
      } else if (mode === 'default') {
        onUpdate({ from: undefined, value: undefined });
      }
      return;
    }

    if (mode === 'json') {
      onUpdate({ from: undefined, value: undefined, default: undefined });
    } else if (mode === 'stream') {
      const source = port.from && isStreamLikeSource(port.from) ? port.from : 'stdout';
      onUpdate({ from: source, value: undefined, default: undefined });
      setFromStr(source);
    } else if (mode === 'literal') {
      onUpdate({ from: undefined, default: undefined });
    } else if (mode === 'default') {
      onUpdate({ from: undefined, value: undefined });
    }
  };

  if (!isEditable) {
    return (
      <div>
        <div className="flex items-center justify-between mb-0.5">
          <label className="text-[10px] text-tagma-muted">Source</label>
          <span className="text-[10px] text-tagma-muted">{row.source.label}</span>
        </div>
        <div className="field-input font-mono text-[11px] bg-tagma-surface/40">
          {row.source.detail ?? row.source.label}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[10px] text-tagma-muted">Source</label>
        <span className="text-[10px] text-tagma-muted truncate">
          {row.source.label}
          {row.source.detail ? `: ${row.source.detail}` : ''}
        </span>
      </div>
      <select
        className="field-input text-[11px]"
        value={sourceMode}
        onChange={(e) => changeSourceMode(e.target.value as SourceMode)}
      >
        {kind === 'input' ? (
          <>
            <option value="auto">Auto by name</option>
            <option value="specific">Specific upstream output</option>
            <option value="literal">Literal value</option>
            <option value="default">Default value</option>
          </>
        ) : (
          <>
            <option value="json">JSON field</option>
            <option value="stream">stdout / stderr / normalizedOutput</option>
            <option value="literal">Literal value</option>
            <option value="default">Default value</option>
          </>
        )}
      </select>

      {sourceMode === 'specific' && (
        <CopyableField value={fromStr} label={`Copy ${kind} source`}>
          <input
            type="text"
            className="field-input font-mono text-[11px]"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            onBlur={blurFromStr}
            placeholder="build.path or build.outputs.path"
          />
        </CopyableField>
      )}

      {sourceMode === 'json' && (
        <CopyableField value={fromStr} label={`Copy ${kind} JSON source`}>
          <input
            type="text"
            className="field-input font-mono text-[11px]"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            onBlur={blurFromStr}
            placeholder={`json.${port.name}`}
          />
        </CopyableField>
      )}

      {sourceMode === 'stream' && (
        <div className="space-y-1">
          <CopyableField value={fromStr} label={`Copy ${kind} stream source`}>
            <input
              type="text"
              className="field-input font-mono text-[11px]"
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
              onBlur={blurFromStr}
              placeholder="stdout"
            />
          </CopyableField>
          <div className="flex flex-wrap gap-1">
            {['stdout', 'stderr', 'normalizedOutput'].map((source) => (
              <button
                key={source}
                type="button"
                className="text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
                onClick={() => {
                  setFromStr(source);
                  onUpdate({ from: source, value: undefined, default: undefined });
                }}
              >
                {source}
              </button>
            ))}
          </div>
        </div>
      )}

      {sourceMode === 'literal' && (
        <CopyableField value={valueStr} label={`Copy ${kind} literal value`}>
          <input
            type="text"
            className="field-input font-mono text-[11px]"
            value={valueStr}
            onChange={(e) => setValueStr(e.target.value)}
            onBlur={blurValueStr}
            placeholder="literal override"
          />
        </CopyableField>
      )}

      {sourceMode === 'default' && (
        <CopyableField value={defaultStr} label={`Copy ${kind} default value`}>
          <input
            type="text"
            className="field-input font-mono text-[11px]"
            value={defaultStr}
            onChange={(e) => setDefaultStr(e.target.value)}
            onBlur={blurDefaultStr}
            placeholder="fallback value"
          />
        </CopyableField>
      )}
    </div>
  );
}

function sourceModeForRow(row: UnifiedPortRow): SourceMode {
  if (row.kind === 'input') {
    if (row.source.kind === 'literal_value') return 'literal';
    if (row.source.kind === 'default_value') return 'default';
    if (row.source.kind === 'specific_upstream' || row.source.kind === 'conflict') {
      return 'specific';
    }
    return 'auto';
  }

  if (row.source.kind === 'literal_value') return 'literal';
  if (row.source.kind === 'default_value') return 'default';
  if (row.source.kind === 'output_stream' || row.source.kind === 'output_source') return 'stream';
  return 'json';
}

function isStreamLikeSource(source: string): boolean {
  return source === 'stdout' || source === 'stderr' || source === 'normalizedOutput';
}

function rowToBindingRow(row: UnifiedPortRow): BindingRow {
  const binding = row.binding ?? {};
  return cleanRow({
    name: row.name,
    type: row.type,
    ...(row.description ? { description: row.description } : {}),
    ...(row.enum ? { enum: [...row.enum] } : {}),
    ...(row.kind === 'input' && row.required !== undefined ? { required: row.required } : {}),
    ...binding,
  } as BindingRow);
}

function seedInputRow(row: UnifiedPortRow): InputRow {
  const binding = row.binding ?? {};
  return cleanRow({
    name: row.name,
    type: row.type,
    ...(row.description ? { description: row.description } : {}),
    ...(row.enum ? { enum: [...row.enum] } : {}),
    required: row.required ?? true,
    ...binding,
  } as InputRow);
}

function seedOutputRow(row: UnifiedPortRow): OutputRow {
  const binding = row.binding ?? {};
  return cleanRow({
    name: row.name,
    type: row.type,
    ...(row.description ? { description: row.description } : {}),
    ...(row.enum ? { enum: [...row.enum] } : {}),
    ...binding,
  } as OutputRow);
}

function upsertInputRow(
  rows: readonly InputRow[],
  seed: InputRow,
  patch: Partial<InputRow>,
): InputRow[] {
  const next = cleanRow({ ...seed, ...patch });
  const index = rows.findIndex((row) => row.name === seed.name);
  if (index < 0) return [...rows, next];
  return rows.map((row, i) => (i === index ? next : row));
}

function upsertOutputRow(
  rows: readonly OutputRow[],
  seed: OutputRow,
  patch: Partial<OutputRow>,
): OutputRow[] {
  const next = cleanRow({ ...seed, ...patch });
  const index = rows.findIndex((row) => row.name === seed.name);
  if (index < 0) return [...rows, next];
  return rows.map((row, i) => (i === index ? next : row));
}

const RESERVED_INPUT_SOURCE_FIELDS = new Set(['stdout', 'stderr', 'normalizedOutput', 'exitCode']);

function sourceForUpstreamCandidate(
  candidate: UpstreamOutputCandidate,
  candidates: readonly UpstreamOutputCandidate[],
): string {
  const taskId = bareTaskId(candidate.upstreamQid);
  const bareTaskIdIsUnique =
    candidates.filter((other) => bareTaskId(other.upstreamQid) === taskId).length === 1;
  if (!bareTaskIdIsUnique || RESERVED_INPUT_SOURCE_FIELDS.has(candidate.port.name)) {
    return `${candidate.upstreamQid}.outputs.${candidate.port.name}`;
  }
  return `${taskId}.${candidate.port.name}`;
}

function bareTaskId(qid: string): string {
  const dot = qid.lastIndexOf('.');
  return dot >= 0 ? qid.slice(dot + 1) : qid;
}

function inputBindingsToRows(bindings: TaskInputBindings | undefined): InputRow[] {
  return Object.entries(bindings ?? {}).map(([name, binding]) => ({ name, ...binding }));
}

function outputBindingsToRows(bindings: TaskOutputBindings | undefined): OutputRow[] {
  return Object.entries(bindings ?? {}).map(([name, binding]) => ({ name, ...binding }));
}

function inputRowsToBindings(rows: readonly InputRow[]): TaskInputBindings | undefined {
  const entries = rows
    .map((row) => {
      const { name, ...binding } = cleanRow(row);
      return [name.trim(), cleanBinding(binding)] as const;
    })
    .filter(([name]) => name.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function outputRowsToBindings(rows: readonly OutputRow[]): TaskOutputBindings | undefined {
  const entries = rows
    .map((row) => {
      const {
        name,
        required: _required,
        ...binding
      } = cleanRow(row as OutputRow & { required?: boolean });
      return [name.trim(), cleanBinding(binding)] as const;
    })
    .filter(([name]) => name.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function cleanRow<T extends BindingRow>(row: T): T {
  const next = { ...row } as Record<string, unknown>;
  if (next.type !== 'enum') delete next.enum;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  return next as T;
}

function cleanBinding<T extends TaskInputBinding | TaskOutputBinding>(binding: T): T {
  const next = { ...binding } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  return next as T;
}

function freshPortName(existing: readonly { readonly name: string }[], prefix: string): string {
  const taken = new Set(existing.map((p) => p.name));
  for (let i = 1; i < 1000; i++) {
    const name = `${prefix}${i}`;
    if (!taken.has(name)) return name;
  }
  return prefix;
}

function formatDefault(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Permissive parser: the default field is a free-text input and users
 * expect to type `42`, `true`, or `"hello"` and have that land as the
 * right kind of literal. We try a JSON parse first (handles numbers,
 * booleans, quoted strings, objects) and fall back to the raw string
 * for everything else. Empty string clears the default so the binding
 * becomes "truly optional with no value".
 */
function parseDefaultLiteral(raw: string, type: PortType): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // For string-typed bindings, be conservative: the user probably typed
  // text, not JSON. But do unwrap quoted strings so round-trips work.
  if (type === 'string') {
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}
