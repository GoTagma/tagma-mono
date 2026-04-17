import { useCallback, useRef } from 'react';
import { X, Plus } from 'lucide-react';
import type { MiddlewareConfig } from '../../api/client';
import { usePipelineStore } from '../../store/pipeline-store';
import { SchemaForm, getBuiltinSchema, type PluginSchema } from './SchemaForm';

interface MiddlewareEditorProps {
  middlewares: MiddlewareConfig[];
  onChange: (middlewares: MiddlewareConfig[] | undefined) => void;
  onBrowsePath?: (currentValue: string, onSelect: (path: string) => void) => void;
}

/**
 * M10: assign a stable identity to each middleware object so React can
 * track them across reorders / removals. Using array index used to
 * reassign DOM nodes on delete (item at index 2 became item at index 1),
 * which scrambled the per-item useLocalField state and stole input focus.
 *
 * We keep the stable ids in a WeakMap keyed by the middleware reference
 * — pure parents that copy on every keystroke would break this, but
 * MiddlewareEditor's own update/remove paths preserve the reference for
 * untouched items, which is the common case.
 */
let nextMiddlewareKey = 1;
function useMiddlewareKeys(middlewares: MiddlewareConfig[]): string[] {
  const keyMap = useRef(new WeakMap<MiddlewareConfig, string>()).current;
  return middlewares.map((m) => {
    let id = keyMap.get(m);
    if (!id) {
      id = `mw-${nextMiddlewareKey++}`;
      keyMap.set(m, id);
    }
    return id;
  });
}

export function MiddlewareEditor({ middlewares, onChange, onBrowsePath }: MiddlewareEditorProps) {
  const registry = usePipelineStore((s) => s.registry);
  const typeOptions = Array.from(new Set<string>(['static_context', ...registry.middlewares]));
  const keys = useMiddlewareKeys(middlewares);

  const handleAdd = useCallback(() => {
    onChange([...middlewares, { type: 'static_context', file: '' }]);
  }, [middlewares, onChange]);

  const handleRemove = useCallback(
    (index: number) => {
      const next = middlewares.filter((_, i) => i !== index);
      onChange(next.length > 0 ? next : undefined);
    },
    [middlewares, onChange],
  );

  const handleUpdate = useCallback(
    (index: number, patch: Partial<MiddlewareConfig>) => {
      const next = middlewares.map((m, i) => (i === index ? { ...m, ...patch } : m));
      onChange(next);
    },
    [middlewares, onChange],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="field-label mb-0">Middlewares</label>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1 text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
        >
          <Plus size={10} /> Add
        </button>
      </div>
      {middlewares.length === 0 && (
        <p className="text-[10px] text-tagma-muted">No middlewares. Click Add to create one.</p>
      )}
      <div className="space-y-2">
        {middlewares.map((m, i) => (
          <MiddlewareItem
            key={keys[i]}
            middleware={m}
            typeOptions={typeOptions}
            onUpdate={(patch) => handleUpdate(i, patch)}
            onRemove={() => handleRemove(i)}
            onBrowsePath={onBrowsePath}
          />
        ))}
      </div>
    </div>
  );
}

function MiddlewareItem({
  middleware,
  typeOptions,
  onUpdate,
  onRemove,
  onBrowsePath,
}: {
  middleware: MiddlewareConfig;
  typeOptions: string[];
  onUpdate: (patch: Partial<MiddlewareConfig>) => void;
  onRemove: () => void;
  onBrowsePath?: (currentValue: string, onSelect: (path: string) => void) => void;
}) {
  // F10: look up a schema for this middleware type. Falls back to a KV editor
  // for plugins with no known schema (see SchemaForm.tsx for discovery note).
  const schema: PluginSchema | null = getBuiltinSchema('middleware', middleware.type);
  const customEntries = Object.entries(middleware).filter(([k]) => k !== 'type');
  const fieldValues = Object.fromEntries(customEntries) as Record<string, unknown>;

  const handleSchemaChange = useCallback(
    (next: Record<string, unknown>) => {
      // Replace all non-type fields with the schema-form output so removed keys
      // are dropped rather than retained from the previous object.
      onUpdate({
        ...({ type: middleware.type } as MiddlewareConfig),
        ...next,
      });
    },
    [middleware.type, onUpdate],
  );

  return (
    <div className="bg-tagma-bg border border-tagma-border p-2 space-y-1.5 relative">
      <button
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 text-tagma-muted hover:text-tagma-error transition-colors"
        aria-label="Remove middleware"
      >
        <X size={10} />
      </button>
      <div>
        <label className="text-[10px] text-tagma-muted">Type</label>
        <select
          className="field-input text-[11px]"
          value={middleware.type}
          onChange={(e) => onUpdate({ type: e.target.value })}
        >
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {schema ? (
        <SchemaForm
          schema={schema}
          value={fieldValues}
          onChange={handleSchemaChange}
          onBrowsePath={onBrowsePath}
        />
      ) : (
        <div className="space-y-1">
          <p className="text-[10px] text-tagma-muted">
            Custom fields (plugin "{middleware.type}" has no known schema — falling back to KV
            editor):
          </p>
          <CustomFieldsEditor
            entries={customEntries as [string, unknown][]}
            onChange={(next) =>
              onUpdate({
                ...({ type: middleware.type } as MiddlewareConfig),
                ...Object.fromEntries(next),
              })
            }
          />
        </div>
      )}
    </div>
  );
}

/** Small KV editor shared by custom middleware plugins. */
function CustomFieldsEditor({
  entries,
  onChange,
}: {
  entries: [string, unknown][];
  onChange: (entries: [string, unknown][]) => void;
}) {
  const add = () => onChange([...entries, [`key${entries.length + 1}`, '']]);
  const remove = (i: number) => onChange(entries.filter((_, idx) => idx !== i));
  const updateKey = (i: number, key: string) =>
    onChange(entries.map((e, idx) => (idx === i ? [key, e[1]] : e)));
  const updateValue = (i: number, value: string) =>
    onChange(entries.map((e, idx) => (idx === i ? [e[0], value] : e)));

  return (
    <div className="space-y-1">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1">
          <input
            type="text"
            className="field-input font-mono text-[11px] w-[90px]"
            value={k}
            onChange={(e) => updateKey(i, e.target.value)}
            placeholder="key"
          />
          <input
            type="text"
            className="field-input font-mono text-[11px] flex-1"
            value={String(v ?? '')}
            onChange={(e) => updateValue(i, e.target.value)}
            placeholder="value"
          />
          <button
            onClick={() => remove(i)}
            className="text-tagma-muted hover:text-tagma-error transition-colors shrink-0"
            aria-label="Remove field"
          >
            <X size={10} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="text-[10px] text-tagma-accent hover:text-tagma-text transition-colors"
      >
        + Add field
      </button>
    </div>
  );
}
