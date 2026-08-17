import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getOpencodeSettingsMutationBlockMessage } from '../src/components/settings/use-editor-settings-controller';

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

  test('explains the lock in the Python AI Agent section, not just OpenCode agents', () => {
    const sections = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );
    const pythonSection = sections.slice(sections.indexOf("show('python-agent')"));
    expect(pythonSection).toContain(
      '{opencodeSettingsMutationBlockMessage && (\n' +
        '            <div className="pt-1 text-caption text-tagma-muted/70">\n' +
        '              {opencodeSettingsMutationBlockMessage}\n' +
        '            </div>\n' +
        '          )}',
    );
  });
});
