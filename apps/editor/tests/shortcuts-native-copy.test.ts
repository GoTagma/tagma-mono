import { describe, expect, test } from 'bun:test';
import { shouldUseNativeCopy } from '../src/hooks/use-shortcuts';

describe('global shortcuts native copy handling', () => {
  test('leaves Ctrl+C alone when document text is selected', () => {
    expect(
      shouldUseNativeCopy({
        key: 'c',
        ctrlKey: true,
        metaKey: false,
        selectedText: 'conversation history',
      }),
    ).toBe(true);
  });

  test('uses editor copy when Ctrl+C has no document text selection', () => {
    expect(
      shouldUseNativeCopy({
        key: 'c',
        ctrlKey: true,
        metaKey: false,
        selectedText: '',
      }),
    ).toBe(false);
  });
});
