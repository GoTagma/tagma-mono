import { describe, expect, test } from 'bun:test';
import * as AppHelpers from '../src/App';
import { YAML_EDIT_LOCK_MESSAGE } from '../src/store/yaml-edit-lock-store';

describe('App run lock helpers', () => {
  test('blocks pipeline runs while OpenCode chat holds the YAML edit lock', () => {
    const helper = (AppHelpers as Record<string, unknown>).yamlEditLockRunBlockMessage;

    expect(helper).toBeFunction();
    expect((helper as (locked: boolean, reason: string | null) => string | null)(true, null)).toBe(
      YAML_EDIT_LOCK_MESSAGE,
    );
    expect(
      (helper as (locked: boolean, reason: string | null) => string | null)(
        true,
        'Chat is editing build.yaml',
      ),
    ).toBe('Chat is editing build.yaml');
  });

  test('allows pipeline runs when the YAML edit lock is inactive', () => {
    const helper = (AppHelpers as Record<string, unknown>).yamlEditLockRunBlockMessage as
      | ((locked: boolean, reason: string | null) => string | null)
      | undefined;

    expect(helper?.(false, 'Chat is editing build.yaml')).toBeNull();
  });
});
