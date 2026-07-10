import { describe, expect, test } from 'bun:test';
import * as AppHelpers from '../src/App';

describe('App run lock helpers', () => {
  test('allows pipeline runs while OpenCode chat holds the YAML edit lock', () => {
    const helper = (AppHelpers as Record<string, unknown>).yamlEditLockRunBlockMessage;

    expect(helper).toBeFunction();
    expect(
      (helper as (locked: boolean, reason: string | null) => string | null)(true, null),
    ).toBeNull();
    expect(
      (helper as (locked: boolean, reason: string | null) => string | null)(
        true,
        'Chat is editing build.yaml',
      ),
    ).toBeNull();
  });

  test('allows pipeline runs when the YAML edit lock is inactive', () => {
    const helper = (AppHelpers as Record<string, unknown>).yamlEditLockRunBlockMessage as
      ((locked: boolean, reason: string | null) => string | null) | undefined;

    expect(helper?.(false, 'Chat is editing build.yaml')).toBeNull();
  });
});
