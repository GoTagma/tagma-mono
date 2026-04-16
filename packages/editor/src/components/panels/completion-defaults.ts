import type { CompletionConfig } from '../../api/client';

export const DEFAULT_COMPLETION_TYPE = 'exit_code';

export function getEffectiveCompletionType(
  completion: CompletionConfig | undefined,
): string {
  return completion?.type ?? DEFAULT_COMPLETION_TYPE;
}

export function isDefaultExitCodeCompletion(
  completion: CompletionConfig | undefined,
): boolean {
  if (!completion || completion.type !== DEFAULT_COMPLETION_TYPE) return false;
  const { type: _type, expect, ...rest } = completion as CompletionConfig & {
    expect?: unknown;
  };
  if (Object.keys(rest).length > 0) return false;
  return expect === undefined || expect === 0;
}

export function normalizeCompletionForEditor(
  completion: CompletionConfig | undefined,
): CompletionConfig | undefined {
  if (!completion) return undefined;
  return isDefaultExitCodeCompletion(completion) ? undefined : completion;
}
