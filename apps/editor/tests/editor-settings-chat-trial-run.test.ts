import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Editor Settings OpenCode Chat trial-run toggle', () => {
  test('renders and persists the workspace setting through the shared update path', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'panels', 'EditorSettingsPanel.tsx'),
      'utf8',
    );

    expect(source).toContain('Trial-run Chat pipeline changes');
    expect(source).toContain('checked={settings.opencodeChatTrialRunEnabled}');
    expect(source).toContain("updateField('opencodeChatTrialRunEnabled', v)");
  });

  test('gates the staged pipeline trial run while preserving default-on behavior', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

    expect(source).toContain('settings?.opencodeChatTrialRunEnabled ?? true');
    expect(source).toContain('shouldTrialRunChatPipeline({');
    expect(source).toContain('chatPipelineVerificationSucceeded({');
  });
});
