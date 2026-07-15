import { describe, expect, test } from 'bun:test';
import { getOpencodeSettingsMutationBlockMessage } from '../src/components/panels/EditorSettingsPanel';

describe('Editor settings OpenCode runtime lock', () => {
  test('blocks restart-backed mutations for any unexpired lock in the current workspace', () => {
    const anotherYamlIsLocked = {
      active: false,
      workspaceActive: true,
    };
    const expiredActiveYamlLock = {
      active: true,
      workspaceActive: false,
    };

    expect(getOpencodeSettingsMutationBlockMessage(anotherYamlIsLocked)).toBe(
      'Wait for the active OpenCode chat to finish before changing OpenCode settings.',
    );
    expect(getOpencodeSettingsMutationBlockMessage(expiredActiveYamlLock)).toBeNull();
  });
});
