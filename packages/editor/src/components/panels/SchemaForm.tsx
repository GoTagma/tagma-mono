// ─────────────────────────────────────────────────────────────────────────────
// SchemaForm.tsx — F10: Plugin schema → form generator.
// ─────────────────────────────────────────────────────────────────────────────
//
// The SDK now exposes declarative `schema?: PluginSchema` metadata on
// TriggerPlugin / CompletionPlugin / MiddlewarePlugin (tagma-sdk
// plugins/types/src/index.ts). The editor's server reads each plugin's
// schema and forwards it through `/api/registry` as `triggerSchemas` /
// `completionSchemas` / `middlewareSchemas` keyed by plugin type.
//
// `getBuiltinSchema` below first consults the live registry from the store
// and, if the plugin type isn't declared there (legacy/third-party plugins
// without a schema), falls back to the hand-written table at the bottom of
// this file. The fallback exists so the editor keeps working offline and
// against older SDK releases that predate the schema field.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from 'react';
import { FolderOpen } from 'lucide-react';
import { useLocalField } from '../../hooks/use-local-field';
import { usePipelineStore } from '../../store/pipeline-store';
import type { PluginSchemaDescriptor } from '../../api/client';

// ── Schema types ────────────────────────────────────────────────────────────

export type SchemaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'path'
  | 'duration'
  | 'number-or-list';

export interface SchemaField {
  readonly key: string;
  readonly type: SchemaFieldType;
  readonly required?: boolean;
  readonly description?: string;
  readonly default?: unknown;
  readonly enum?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly placeholder?: string;
}

export interface PluginSchema {
  readonly description?: string;
  readonly fields: readonly SchemaField[];
}

// ── Built-in plugin schemas (hand-written fallback) ────────────────────────
// Matches the runtime validators in tagma-sdk/src/triggers/*.ts,
// tagma-sdk/src/completions/*.ts, tagma-sdk/src/middlewares/*.ts.

export const BUILTIN_TRIGGER_SCHEMAS: Record<string, PluginSchema> = {
  file: {
    fields: [
      {
        key: 'path',
        type: 'path',
        required: true,
        placeholder: './path/to/watch',
        description: 'File path to watch. Resolved relative to workDir.',
      },
      {
        key: 'timeout',
        type: 'duration',
        placeholder: 'e.g. 5m',
        description: 'Give up after this duration if the file does not appear.',
      },
    ],
  },
  manual: {
    fields: [
      {
        key: 'message',
        type: 'string',
        placeholder: 'Approval message...',
        description: 'Prompt shown to the approver.',
      },
      // NOTE: `options` and `metadata` are intentionally NOT schematized here —
      // they are handled by dedicated editors (OptionsField, KeyValueEditor)
      // in TaskConfigPanel because they are list/object types that the generic
      // form generator doesn't handle yet.
      {
        key: 'timeout',
        type: 'duration',
        placeholder: 'e.g. 5m',
        description: 'Auto-reject after this duration.',
      },
    ],
  },
};

export const BUILTIN_COMPLETION_SCHEMAS: Record<string, PluginSchema> = {
  exit_code: {
    fields: [
      {
        key: 'expect',
        type: 'number-or-list',
        default: 0,
        placeholder: '0 (default)',
        description: 'Expected exit code, or comma-separated list of codes.',
      },
    ],
  },
  file_exists: {
    fields: [
      {
        key: 'path',
        type: 'path',
        required: true,
        placeholder: './path/to/check',
        description: 'File or directory to check.',
      },
      {
        key: 'kind',
        type: 'enum',
        enum: ['any', 'file', 'dir'],
        default: 'any',
        description: 'Restrict to file, directory, or any.',
      },
      {
        key: 'min_size',
        type: 'number',
        min: 0,
        placeholder: 'optional',
        description: 'Minimum size in bytes (files only).',
      },
    ],
  },
  output_check: {
    fields: [
      {
        key: 'check',
        type: 'string',
        required: true,
        placeholder: 'shell command (exit 0 = pass)',
        description: 'Shell command — exit 0 means the check passed.',
      },
      {
        key: 'timeout',
        type: 'duration',
        default: '30s',
        placeholder: '30s (default)',
        description: 'Max duration before the check is aborted.',
      },
    ],
  },
};

export const BUILTIN_MIDDLEWARE_SCHEMAS: Record<string, PluginSchema> = {
  static_context: {
    fields: [
      {
        key: 'file',
        type: 'path',
        required: true,
        placeholder: './context.md',
        description: 'Markdown file to prepend to the prompt.',
      },
      {
        key: 'label',
        type: 'string',
        placeholder: 'Reference: filename',
        description: 'Optional display label used in the injected header.',
      },
    ],
  },
};

/**
 * Convert a wire-format PluginSchemaDescriptor (from `/api/registry`) into
 * the editor's internal PluginSchema shape. Unknown field types pass through
 * verbatim; callers downstream handle the fallback rendering.
 */
function fromWireDescriptor(wire: PluginSchemaDescriptor): PluginSchema | null {
  if (!wire.fields || !Array.isArray(wire.fields)) return null;
  const fields: SchemaField[] = wire.fields.map((f) => ({
    key: f.key,
    type: f.type as SchemaFieldType,
    required: f.required,
    description: f.description,
    default: f.default,
    enum: f.enum,
    min: f.min,
    max: f.max,
    placeholder: (f as { placeholder?: string }).placeholder,
  }));
  const description = typeof wire.description === 'string' ? wire.description : undefined;
  return { description, fields };
}

/**
 * Look up a schema for the given plugin kind + type, or `null` if unknown.
 * Prefers schemas exposed by the server's plugin registry (live, reflects
 * whatever the SDK declares), falling back to the hand-written table below
 * for offline use and legacy SDK versions that predate `PluginSchema`.
 */
export function getBuiltinSchema(
  kind: 'trigger' | 'completion' | 'middleware',
  type: string,
): PluginSchema | null {
  // 1. Prefer live server-provided schema from the pipeline store registry.
  const registry = usePipelineStore.getState().registry;
  const registryMap =
    kind === 'trigger'
      ? registry.triggerSchemas
      : kind === 'completion'
        ? registry.completionSchemas
        : registry.middlewareSchemas;
  if (registryMap && registryMap[type]) {
    const fromWire = fromWireDescriptor(registryMap[type]);
    if (fromWire) return fromWire;
  }

  // 2. Fall back to the hand-written table for offline/legacy support.
  const table =
    kind === 'trigger'
      ? BUILTIN_TRIGGER_SCHEMAS
      : kind === 'completion'
        ? BUILTIN_COMPLETION_SCHEMAS
        : BUILTIN_MIDDLEWARE_SCHEMAS;
  return table[type] ?? null;
}

// ── SchemaForm component ────────────────────────────────────────────────────

interface SchemaFormProps {
  schema: PluginSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onBrowsePath?: (currentValue: string, onSelect: (path: string) => void) => void;
}

/**
 * Generic form generator driven by a PluginSchema descriptor. Renders one
 * input per declared field. Values not covered by the schema are preserved
 * verbatim in the output object (so round-tripping unknown keys is lossless).
 */
export function SchemaForm({ schema, value, onChange, onBrowsePath }: SchemaFormProps) {
  const commit = useCallback(
    (key: string, next: unknown) => {
      const updated = { ...value };
      if (next === undefined || next === '' || next === null) {
        delete updated[key];
      } else {
        updated[key] = next;
      }
      onChange(updated);
    },
    [value, onChange],
  );

  return (
    <div className="space-y-2">
      {schema.description && (
        <p className="text-[10px] text-tagma-muted/80 leading-snug mb-1">{schema.description}</p>
      )}
      {schema.fields.map((field) => (
        <SchemaFieldRow
          key={field.key}
          field={field}
          value={value[field.key]}
          onChange={(next) => commit(field.key, next)}
          onBrowsePath={field.type === 'path' ? onBrowsePath : undefined}
        />
      ))}
    </div>
  );
}

// ── Field row ───────────────────────────────────────────────────────────────

function SchemaFieldRow({
  field,
  value,
  onChange,
  onBrowsePath,
}: {
  field: SchemaField;
  value: unknown;
  onChange: (next: unknown) => void;
  onBrowsePath?: (currentValue: string, onSelect: (path: string) => void) => void;
}) {
  const label = field.key;
  const defaultStr =
    field.default !== undefined && field.default !== null ? String(field.default) : undefined;

  return (
    <div>
      <label className="text-[10px] text-tagma-muted flex items-center gap-1">
        <span>
          {label}
          {field.required && <span className="text-tagma-error ml-0.5">*</span>}
        </span>
        {field.description && (
          <span className="text-tagma-muted/60" title={field.description}>
            &nbsp;(?)
          </span>
        )}
      </label>
      <SchemaFieldInput
        field={field}
        value={value}
        onChange={onChange}
        defaultStr={defaultStr}
        onBrowsePath={onBrowsePath}
      />
      {field.description && (
        <p className="text-[9px] text-tagma-muted/80 mt-0.5 leading-snug">{field.description}</p>
      )}
    </div>
  );
}

function SchemaFieldInput({
  field,
  value,
  onChange,
  defaultStr,
  onBrowsePath,
}: {
  field: SchemaField;
  value: unknown;
  onChange: (next: unknown) => void;
  defaultStr: string | undefined;
  onBrowsePath?: (currentValue: string, onSelect: (path: string) => void) => void;
}) {
  const strValue = value == null ? '' : String(value);

  // Every text-like input uses useLocalField so edits don't thrash the store.
  // For 'number-or-list' we keep the original string when any token fails to
  // parse as a number — silently dropping bad tokens used to swallow user
  // typos like "1, two, 3" → [1,3] with no feedback.
  const [localStr, setLocalStr, blurStr] = useLocalField(strValue, (v) => {
    if (field.type === 'number') {
      if (v === '') {
        onChange(undefined);
        return;
      }
      const n = Number(v);
      onChange(Number.isNaN(n) ? v : n);
      return;
    }
    if (field.type === 'number-or-list') {
      if (v === '') {
        onChange(undefined);
        return;
      }
      if (v.includes(',')) {
        const tokens = v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const parsed = tokens.map((s) => Number(s));
        if (parsed.some((n) => Number.isNaN(n))) {
          onChange(v); // preserve raw string so the validation error surfaces
          return;
        }
        onChange(parsed);
        return;
      }
      const n = Number(v);
      onChange(Number.isNaN(n) ? v : n);
      return;
    }
    onChange(v === '' ? undefined : v);
  });

  switch (field.type) {
    case 'enum':
      return (
        <select
          className="field-input text-[11px]"
          value={strValue}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">{defaultStr ? `${defaultStr} (default)` : '—'}</option>
          {field.enum?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    case 'boolean':
      return (
        <label className="flex items-center gap-1.5 text-[11px] text-tagma-text">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked ? true : undefined)}
          />
          <span className="text-tagma-muted">{strValue === 'true' ? 'enabled' : 'disabled'}</span>
        </label>
      );
    case 'number':
      return (
        <input
          type="number"
          className="field-input font-mono text-[11px]"
          value={localStr}
          min={field.min}
          max={field.max}
          onChange={(e) => setLocalStr(e.target.value)}
          onBlur={blurStr}
          placeholder={field.placeholder ?? defaultStr}
        />
      );
    case 'path':
      return (
        <div className="flex gap-1">
          <input
            type="text"
            className="field-input font-mono text-[11px] flex-1 min-w-0"
            value={localStr}
            onChange={(e) => setLocalStr(e.target.value)}
            onBlur={blurStr}
            placeholder={field.placeholder ?? defaultStr}
          />
          {onBrowsePath && (
            <button
              type="button"
              onClick={() => onBrowsePath(localStr, (path) => setLocalStr(path))}
              className="shrink-0 p-1.5 border border-tagma-border text-tagma-muted hover:text-tagma-accent hover:border-tagma-accent/40 transition-colors"
              title="Browse..."
              aria-label="Browse for file"
            >
              <FolderOpen size={13} />
            </button>
          )}
        </div>
      );
    case 'string':
    case 'duration':
    case 'number-or-list':
    default:
      return (
        <input
          type="text"
          className="field-input font-mono text-[11px]"
          value={localStr}
          onChange={(e) => setLocalStr(e.target.value)}
          onBlur={blurStr}
          placeholder={field.placeholder ?? defaultStr}
        />
      );
  }
}
