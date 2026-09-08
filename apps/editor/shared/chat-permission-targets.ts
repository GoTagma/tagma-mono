import { redactDiagnosticText } from './diagnostics';

export const CHAT_PERMISSION_TARGET_LIMIT = 8;
export const CHAT_PERMISSION_TARGET_MAX_BYTES = 512;

/** Display evidence only. Never resolve these labels as filesystem or permission authority. */
export interface ChatPermissionTargetSummary {
  readonly targets: readonly string[];
  readonly omitted: number;
}

export function isChatPermissionTargetSummary(
  value: unknown,
): value is ChatPermissionTargetSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'omitted,targets' ||
    !Number.isSafeInteger(record.omitted) ||
    (record.omitted as number) < 0 ||
    (record.omitted as number) > 256 ||
    !Array.isArray(record.targets) ||
    record.targets.length > CHAT_PERMISSION_TARGET_LIMIT ||
    Object.keys(record.targets).length !== record.targets.length
  )
    return false;
  return record.targets.every(
    (target) =>
      typeof target === 'string' &&
      target.length > 0 &&
      new TextEncoder().encode(target).byteLength <= CHAT_PERMISSION_TARGET_MAX_BYTES &&
      !Array.from(target).some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      }) &&
      !/[\u200e\u200f\u202a-\u202e\u2066-\u2069\\:]/u.test(target) &&
      !target.startsWith('/') &&
      target
        .split('/')
        .every((part) => part !== '' && part !== '.' && part !== '..' && part !== '~') &&
      redactDiagnosticText(target) === target,
  );
}
