import { describe, expect, test } from 'bun:test';
import { shouldShowRunErrorBanner } from '../src/components/run/RunView';

describe('RunView start errors', () => {
  test('history mode still surfaces a run start failure', () => {
    expect(
      shouldShowRunErrorBanner({
        showHistory: true,
        error: 'Configuration error: missing pipeline name',
      }),
    ).toBe(true);
  });

  test('does not render an empty error banner', () => {
    expect(shouldShowRunErrorBanner({ showHistory: true, error: null })).toBe(false);
  });
});
