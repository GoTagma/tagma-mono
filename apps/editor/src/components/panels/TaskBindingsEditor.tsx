import { Plus, Trash2 } from 'lucide-react';
import type {
  TaskInputBinding,
  TaskInputBindings,
  TaskOutputBinding,
  TaskOutputBindings,
} from '../../api/client';
import { CopyableField } from './CopyableField';

interface TaskBindingsEditorProps {
  inputs: TaskInputBindings | undefined;
  outputs: TaskOutputBindings | undefined;
  onChange: (next: {
    inputs?: TaskInputBindings | undefined;
    outputs?: TaskOutputBindings | undefined;
  }) => void;
}

type BindingKind = 'inputs' | 'outputs';

export function TaskBindingsEditor({ inputs, outputs, onChange }: TaskBindingsEditorProps) {
  const inputEntries = Object.entries(inputs ?? {});
  const outputEntries = Object.entries(outputs ?? {});

  const writeInputs = (entries: [string, TaskInputBinding][]) => {
    const nextInputs = entriesToMap(entries);
    onChange({ inputs: nextInputs, outputs });
  };

  const writeOutputs = (entries: [string, TaskOutputBinding][]) => {
    const nextOutputs = entriesToMap(entries);
    onChange({ inputs, outputs: nextOutputs });
  };

  return (
    <div className="space-y-3">
      <BindingSection
        kind="inputs"
        entries={inputEntries}
        emptyText="No lightweight input bindings."
        onAdd={() => writeInputs([...inputEntries, [freshName(inputs, 'input'), {}]])}
        onRemove={(index) => writeInputs(inputEntries.filter((_, i) => i !== index))}
        onRename={(index, name) =>
          writeInputs(inputEntries.map((entry, i) => (i === index ? [name, entry[1]] : entry)))
        }
        onPatch={(index, patch) =>
          writeInputs(
            inputEntries.map((entry, i) =>
              i === index ? [entry[0], cleanBinding({ ...entry[1], ...patch })] : entry,
            ),
          )
        }
      />

      <BindingSection
        kind="outputs"
        entries={outputEntries}
        emptyText="No lightweight output bindings."
        onAdd={() => writeOutputs([...outputEntries, [freshName(outputs, 'output'), {}]])}
        onRemove={(index) => writeOutputs(outputEntries.filter((_, i) => i !== index))}
        onRename={(index, name) =>
          writeOutputs(outputEntries.map((entry, i) => (i === index ? [name, entry[1]] : entry)))
        }
        onPatch={(index, patch) =>
          writeOutputs(
            outputEntries.map((entry, i) =>
              i === index ? [entry[0], cleanBinding({ ...entry[1], ...patch })] : entry,
            ),
          )
        }
      />
    </div>
  );
}

function BindingSection<T extends TaskInputBinding | TaskOutputBinding>({
  kind,
  entries,
  emptyText,
  onAdd,
  onRemove,
  onRename,
  onPatch,
}: {
  kind: BindingKind;
  entries: [string, T][];
  emptyText: string;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onRename: (index: number, name: string) => void;
  onPatch: (index: number, patch: Partial<T>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium text-tagma-text">
            {kind === 'inputs' ? 'Lightweight Inputs' : 'Lightweight Outputs'}
          </div>
          <div className="text-[10px] text-tagma-muted">
            {kind === 'inputs'
              ? 'Bind values for {{inputs.name}} without declaring a typed contract.'
              : 'Publish named values without typed port coercion.'}
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="icon-btn h-6 w-6"
          title={kind === 'inputs' ? 'Add input binding' : 'Add output binding'}
        >
          <Plus size={12} />
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="text-[10px] text-tagma-muted border border-dashed border-tagma-border px-2 py-2">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map(([name, binding], index) => (
            <div key={`${kind}-${index}`} className="border border-tagma-border p-2 space-y-2">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <CopyableField value={name} label={`Copy ${kind} binding name`}>
                  <input
                    className="field-input text-xs"
                    value={name}
                    placeholder="name"
                    onChange={(e) => onRename(index, e.target.value)}
                  />
                </CopyableField>
                <button
                  type="button"
                  className="icon-btn h-7 w-7 text-tagma-muted hover:text-tagma-error"
                  title="Remove binding"
                  onClick={() => onRemove(index)}
                >
                  <Trash2 size={12} />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <CopyableField value={binding.from ?? ''} label={`Copy ${kind} source`}>
                  <input
                    className="field-input text-xs"
                    value={binding.from ?? ''}
                    placeholder={kind === 'inputs' ? 'from: build.path' : 'from: json.path'}
                    onChange={(e) =>
                      onPatch(index, { from: e.target.value || undefined } as Partial<T>)
                    }
                  />
                </CopyableField>
                <div className="grid grid-cols-2 gap-2">
                  <CopyableField value={formatValue(binding.value)} label={`Copy ${kind} value`}>
                    <input
                      className="field-input text-xs"
                      value={formatValue(binding.value)}
                      placeholder="value"
                      onChange={(e) =>
                        onPatch(index, { value: parseValue(e.target.value) } as Partial<T>)
                      }
                    />
                  </CopyableField>
                  <CopyableField
                    value={formatValue(binding.default)}
                    label={`Copy ${kind} default`}
                  >
                    <input
                      className="field-input text-xs"
                      value={formatValue(binding.default)}
                      placeholder="default"
                      onChange={(e) =>
                        onPatch(index, { default: parseValue(e.target.value) } as Partial<T>)
                      }
                    />
                  </CopyableField>
                </div>
                {kind === 'inputs' && (
                  <label className="inline-flex items-center gap-2 text-[11px] text-tagma-muted">
                    <input
                      type="checkbox"
                      checked={(binding as TaskInputBinding).required === true}
                      onChange={(e) =>
                        onPatch(index, {
                          required: e.target.checked ? true : undefined,
                        } as unknown as Partial<T>)
                      }
                    />
                    Required
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function entriesToMap<T extends TaskInputBinding | TaskOutputBinding>(
  entries: [string, T][],
): Record<string, T> | undefined {
  const cleaned = entries.filter(([name]) => name.trim().length > 0);
  if (cleaned.length === 0) return undefined;
  return Object.fromEntries(cleaned.map(([name, binding]) => [name.trim(), binding]));
}

function freshName(existing: Record<string, unknown> | undefined, base: string): string {
  const names = new Set(Object.keys(existing ?? {}));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseValue(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function cleanBinding<T extends TaskInputBinding | TaskOutputBinding>(binding: T): T {
  const next = { ...binding } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === '') delete next[key];
  }
  return next as T;
}
