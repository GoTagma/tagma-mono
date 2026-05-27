import { describe, expect, test } from 'bun:test';
import type { CompletionConfig } from '../src/api/client';
import {
  DEFAULT_COMPLETION_TYPE,
  getEffectiveCompletionType,
  isDefaultExitCodeCompletion,
  normalizeCompletionForEditor,
} from '../src/components/panels/completion-defaults';

describe('completion defaults', () => {
  test('renders exit_code as the effective default when completion is unset', () => {
    expect(getEffectiveCompletionType(undefined)).toBe(DEFAULT_COMPLETION_TYPE);
  });

  test('treats bare exit_code and exit_code expect=0 as the default completion', () => {
    expect(isDefaultExitCodeCompletion({ type: 'exit_code' } as CompletionConfig)).toBe(true);
    expect(isDefaultExitCodeCompletion({ type: 'exit_code', expect: 0 } as CompletionConfig)).toBe(
      true,
    );
  });

  test('keeps non-default completion configs explicit', () => {
    expect(isDefaultExitCodeCompletion({ type: 'exit_code', expect: 2 } as CompletionConfig)).toBe(
      false,
    );
    expect(
      isDefaultExitCodeCompletion({ type: 'file_exists', path: './out.txt' } as CompletionConfig),
    ).toBe(false);
  });

  test('normalizes default exit_code completions back to undefined for clean state and YAML', () => {
    expect(normalizeCompletionForEditor({ type: 'exit_code' } as CompletionConfig)).toBeUndefined();
    expect(
      normalizeCompletionForEditor({ type: 'exit_code', expect: 0 } as CompletionConfig),
    ).toBeUndefined();
    expect(
      normalizeCompletionForEditor({ type: 'exit_code', expect: 2 } as CompletionConfig),
    ).toEqual({
      type: 'exit_code',
      expect: 2,
    });
  });
});
