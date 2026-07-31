import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Editor Settings panel responsiveness', () => {
  // The settings UI is split across the modal shell, the shared controller,
  // and the shared sections; assert against all three joined.
  const source = [
    join(import.meta.dir, '..', 'src', 'components', 'panels', 'EditorSettingsPanel.tsx'),
    join(import.meta.dir, '..', 'src', 'components', 'settings', 'use-editor-settings-controller.tsx'),
    join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
  ]
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  test('uses a wider desktop dialog', () => {
    expect(source).toContain('max-w-[680px]');
  });

  test('does not disable ordinary settings while their save request is pending', () => {
    expect(source).toContain(
      'const settingsInputsDisabled = !hasWorkspace || pythonSaving || globalSaving;',
    );
    expect(source).not.toContain('disabled={!hasWorkspace || saving}');
    expect(source).toContain('disabled={settingsInputsDisabled}');
  });

  test('keeps global and workspace settings saves mutually exclusive', () => {
    expect(source).toContain(
      'const globalSettingsInputsDisabled =\n' +
        '    globalSaving || pythonSaving || saving || opencodeSettingsMutationBlocked;',
    );
    expect(source).toContain('disabled={globalSettingsInputsDisabled}');
    expect(source).toContain('!globalSettingsInputsDisabled');
    expect(source).toContain('globalSettingsInputsDisabled || !agentMaxStepsChanged');
    expect(source).toContain('workspaceSavingRef.current = nextSaving;');
    expect(source).toContain(
      'if (globalSavingRef.current || workspaceSavingRef.current || pythonSaving) return;',
    );
    expect(source).toContain('if (!settings || globalSavingRef.current) return;');
  });
});
