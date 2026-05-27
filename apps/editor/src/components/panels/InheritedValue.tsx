import { RotateCcw } from 'lucide-react';
import type { RawPipelineConfig, Permissions } from '../../api/client';

/**
 * Result of resolving an inheritable field through the task → track → pipeline → default chain.
 * `source` indicates where the effective value came from. `value` is undefined only when no level
 * set the field (the SDK default will apply silently).
 */
export interface ResolvedValue {
  value: string | undefined;
  source: 'task' | 'track' | 'pipeline' | 'default';
}

/** Resolve a simple scalar field (driver/model/agent_profile/cwd/timeout). */
export function resolveScalar(
  taskValue: string | undefined,
  trackValue: string | undefined,
  pipelineValue: string | undefined,
  defaultValue?: string,
): ResolvedValue {
  if (taskValue !== undefined && taskValue !== '') return { value: taskValue, source: 'task' };
  if (trackValue !== undefined && trackValue !== '') return { value: trackValue, source: 'track' };
  if (pipelineValue !== undefined && pipelineValue !== '')
    return { value: pipelineValue, source: 'pipeline' };
  return { value: defaultValue, source: 'default' };
}

/**
 * Resolve permissions. Pipeline doesn't carry permissions today, so the chain is task → track → default.
 * Default is `read-only` (SDK default behaviour).
 */
export function resolvePermissions(
  taskPerms: Permissions | undefined,
  trackPerms: Permissions | undefined,
): { value: Permissions; source: ResolvedValue['source'] } {
  if (taskPerms) return { value: taskPerms, source: 'task' };
  if (trackPerms) return { value: trackPerms, source: 'track' };
  return { value: { read: true, write: false, execute: false }, source: 'default' };
}

export function permsToString(p: Permissions | undefined): string {
  if (!p) return 'none';
  const parts = [p.read && 'read', p.write && 'write', p.execute && 'execute'].filter(
    Boolean,
  ) as string[];
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function sourceLabel(
  source: ResolvedValue['source'],
  trackName?: string,
  pipelineName?: string,
): string {
  switch (source) {
    case 'task':
      return 'task-level';
    case 'track':
      return trackName ? `track "${trackName}"` : 'track';
    case 'pipeline':
      return pipelineName ? `pipeline "${pipelineName}"` : 'pipeline';
    case 'default':
      return 'SDK default';
  }
}

interface InheritedValueProps {
  /** Whether the task (or track) currently sets this field locally. When true, shows nothing. */
  isOverridden: boolean;
  /** The resolved effective value. */
  resolved: ResolvedValue | { value: string | undefined; source: ResolvedValue['source'] };
  /** Optional track name for a nicer "from track X" message. */
  trackName?: string;
  /** Optional pipeline name. */
  pipelineName?: string;
  /** Optional label prefix, e.g. "resolves to". Defaults to "resolves to". */
  prefix?: string;
  /** Display value override (for permissions or other non-string fields). */
  displayValue?: string;
}

/**
 * Small gray helper line showing what value an inheritable field will actually use
 * and which level of the chain it came from. Shows nothing when the field is set locally
 * (use the presence of a reset button to communicate override state in that case).
 */
export function InheritedValue({
  isOverridden,
  resolved,
  trackName,
  pipelineName,
  prefix = 'resolves to',
  displayValue,
}: InheritedValueProps) {
  if (isOverridden) return null;
  const shown = displayValue ?? resolved.value;
  if (shown === undefined || shown === '') {
    return (
      <p className="text-[10px] text-tagma-muted mt-1 italic">
        &rarr; not set (uses {sourceLabel(resolved.source, trackName, pipelineName)})
      </p>
    );
  }
  return (
    <p className="text-[10px] text-tagma-muted mt-1">
      &rarr; {prefix}: <span className="font-mono text-tagma-text/80">{shown}</span>
      <span className="ml-1">(from {sourceLabel(resolved.source, trackName, pipelineName)})</span>
    </p>
  );
}

interface ResetButtonProps {
  /** Called when clicked. Should clear the local override (e.g. commit `{ field: undefined }`). */
  onReset: () => void;
  /** When false the button is hidden (nothing to reset). */
  visible: boolean;
  title?: string;
}

/** Small ↺ button used next to inheritable fields to clear a task/track level override. */
export function ResetButton({
  onReset,
  visible,
  title = 'Reset to inherited value',
}: ResetButtonProps) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onReset}
      title={title}
      className="text-tagma-muted hover:text-tagma-accent transition-colors p-0.5"
      aria-label="Reset to inherited value"
    >
      <RotateCcw size={11} />
    </button>
  );
}

// Re-export commonly-needed pipeline type for helpers that resolve through it.
export type { RawPipelineConfig };
