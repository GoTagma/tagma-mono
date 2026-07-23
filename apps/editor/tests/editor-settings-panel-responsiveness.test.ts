import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Editor Settings panel responsiveness', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', 'src', 'components', 'panels', 'EditorSettingsPanel.tsx'),
    'utf8',
  );

  test('uses a wider desktop dialog', () => {
    expect(source).toContain('max-w-[680px]');
  });

  test('does not disable ordinary settings while their save request is pending', () => {
    expect(source).toContain('const settingsInputsDisabled = !hasWorkspace || pythonSaving;');
    expect(source).not.toContain('disabled={!hasWorkspace || saving}');
    expect(source).toContain('disabled={settingsInputsDisabled}');
  });
});
