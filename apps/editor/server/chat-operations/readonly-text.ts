import type { ChatOperationV2AdmissionRequest } from './admission.js';
import type { ChatReadSnapshot } from './snapshots.js';

const encoder = new TextEncoder();

export type ChatOperationV2ReadonlyTextPurpose = 'discussion' | 'diagnosis';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(',')}}`;
}

/**
 * Seals the exact provider-independent authority for a read-only Chat invocation.
 * Diagnosis may be request-only when no canvas snapshot was submitted. When a snapshot exists,
 * the canonical bytes bind it exactly; discussion never receives snapshot authority.
 */
export function buildReadonlyTextCanonicalRequestBytes(input: {
  readonly purpose: ChatOperationV2ReadonlyTextPurpose;
  readonly request: ChatOperationV2AdmissionRequest;
  readonly readSnapshot: ChatReadSnapshot | null;
}): Uint8Array {
  if (input.purpose === 'discussion' && input.readSnapshot !== null) {
    throw new TypeError('Discussion cannot receive a read snapshot.');
  }
  return encoder.encode(
    canonicalJson({
      purpose: input.purpose,
      request: input.request,
      access:
        input.readSnapshot === null
          ? { kind: 'none' }
          : { kind: 'sealed_snapshot_only', snapshot: input.readSnapshot },
    }),
  );
}
