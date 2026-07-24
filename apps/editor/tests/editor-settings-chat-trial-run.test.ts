import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Editor Settings OpenCode Chat trial-run controls', () => {
  test('renders the repair limit next to the trial-run toggle and persists both settings', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'panels', 'EditorSettingsPanel.tsx'),
      'utf8',
    );

    expect(source).toContain('Trial-run Chat pipeline changes');
    expect(source).toContain('checked={settings.opencodeChatTrialRunEnabled}');
    expect(source).toContain('Automatic repair attempts:');
    expect(source).toContain('value={settings.opencodeChatPipelineRepairMaxAttempts}');
    expect(source).toContain("updateField('opencodeChatPipelineRepairMaxAttempts', clamped)");
    const normalizedSource = source.replace(/\s+/g, ' ');
    expect(normalizedSource).toContain('does not run the pipeline this many times');
    expect(normalizedSource).toContain(
      'Trial-plan authoring is separately limited to two attempts per YAML revision.',
    );

    const toggleIndex = source.indexOf('checked={settings.opencodeChatTrialRunEnabled}');
    const repairLimitIndex = source.indexOf(
      'value={settings.opencodeChatPipelineRepairMaxAttempts}',
    );
    const memoryToggleIndex = source.indexOf('checked={settings.chatContextLimitEnabled}');
    expect(toggleIndex).toBeGreaterThan(-1);
    expect(repairLimitIndex).toBeGreaterThan(toggleIndex);
    expect(memoryToggleIndex).toBeGreaterThan(repairLimitIndex);
    expect(source).toContain("updateField('opencodeChatTrialRunEnabled', v)");
  });

  test('gates trial runs and uses the configured shared repair budget with default 25', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

    expect(source).toContain('settings?.opencodeChatTrialRunEnabled ?? true');
    expect(source).toContain('settings?.opencodeChatPipelineRepairMaxAttempts ??');
    expect(source).toContain('DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS');
    expect(source).toContain('shouldTrialRunChatPipeline({');
    expect(source).toContain('chatPipelineVerificationSucceeded({');
    expect(source.match(/\{ repairAttempts: completedRepairAttempts \}/g)).toHaveLength(2);
    expect(source).toContain("trialRun.kind === 'plan-required'");
    expect(source).toContain('.sendInternalTrialPlanPrompt(');
    expect(source).toContain('planAttempts < MAX_CHAT_TRIAL_PLAN_PROMPTS');
    expect(source).toContain('totalPlanAttemptsForTurn < maxPlanAttemptsForTurn');
    expect(source).toContain('maxAttempts + 1');
    expect(source).toContain("trialRun.kind !== 'plan-required'");
    expect(source).not.toContain('const maxAttempts = 2;');
  });
});
