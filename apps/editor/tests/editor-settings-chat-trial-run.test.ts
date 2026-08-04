import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Editor Settings OpenCode Chat trial-run controls', () => {
  test('renders configurable task, production pipeline, and Trial execution budgets', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );

    expect(source).toContain('Default task timeout (minutes)');
    expect(source).toContain('Production pipeline timeout (minutes)');
    expect(source).toContain('Chat Trial timeout (minutes)');
    expect(source).toContain('value={settings.pipelineDefaultTaskTimeoutMinutes}');
    expect(source).toContain('value={settings.pipelineDefaultRunTimeoutMinutes}');
    expect(source).toContain('value={settings.opencodeChatTrialRunTimeoutMinutes}');
    expect(source).toContain('Explicit YAML timeouts take precedence');
  });

  test('renders the Trial Plan and repair limits next to the trial-run toggle', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );

    expect(source).toContain('Trial-run Chat pipeline changes');
    expect(source).toContain('AI-authored staged pipeline commands');
    expect(source).toContain('normal host command authority');
    expect(source).toContain('may modify files or external state');
    expect(source).toContain('checked={settings.opencodeChatTrialRunEnabled}');
    expect(source).toContain('Trial Plan attempts per revision:');
    expect(source).toContain('min={MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS}');
    expect(source).toContain('max={MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS}');
    expect(source).toContain('value={settings.opencodeChatTrialPlanMaxAttempts}');
    expect(source).toContain(`updateField('opencodeChatTrialPlanMaxAttempts', clamped)`);
    expect(source).toContain('Automatic repair attempts:');
    expect(source).toContain('value={settings.opencodeChatPipelineRepairMaxAttempts}');
    expect(source).toContain("updateField('opencodeChatPipelineRepairMaxAttempts', clamped)");
    const normalizedSource = source.replace(/\s+/g, ' ');
    expect(normalizedSource).toContain('does not run the pipeline this many times');
    expect(normalizedSource).toContain('default {DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS}');
    expect(normalizedSource).toContain(
      'each attempt is one hidden planner continuation for the same YAML revision.',
    );

    const toggleIndex = source.indexOf('checked={settings.opencodeChatTrialRunEnabled}');
    const trialPlanLimitIndex = source.indexOf('value={settings.opencodeChatTrialPlanMaxAttempts}');
    const repairLimitIndex = source.indexOf(
      'value={settings.opencodeChatPipelineRepairMaxAttempts}',
    );
    const memoryToggleIndex = source.indexOf('checked={settings.chatContextLimitEnabled}');
    expect(toggleIndex).toBeGreaterThan(-1);
    expect(trialPlanLimitIndex).toBeGreaterThan(toggleIndex);
    expect(repairLimitIndex).toBeGreaterThan(trialPlanLimitIndex);
    expect(memoryToggleIndex).toBeGreaterThan(repairLimitIndex);
    expect(source).toContain("updateField('opencodeChatTrialRunEnabled', v)");
  });

  test('gates trial runs and uses the configured shared repair budget with default 25', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

    expect(source).toContain('hasCurrentChatPipelineTrialConsent(settings)');
    expect(source).not.toContain('settings?.opencodeChatTrialRunEnabled ?? true');
    expect(source).toContain('settings?.opencodeChatPipelineRepairMaxAttempts ??');
    expect(source).toContain('DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS');
    expect(source).toContain('shouldTrialRunChatPipeline({');
    expect(source).toContain('chatPipelineVerificationSucceeded({');
    expect(source.match(/\{ repairAttempts: completedRepairAttempts \}/g)).toHaveLength(2);
    expect(source).toContain("trialRun.kind === 'plan-required'");
    expect(source).toContain('.sendInternalTrialPlanPrompt(');
    expect(source).toContain('shouldQueueTrialPlanPrompt({');
    expect(source).toContain('attemptsForRevision: planAttempts');
    expect(source).toContain('totalAttemptsForLogicalTurn: totalPlanAttemptsForTurn');
    expect(source).toContain('isValidChatPipelineTrialPlanAttempts(');
    expect(source).toContain('trialRun.planRequest.maxAttempts');
    expect(source).toContain('DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS');
    expect(source).toContain('promptsPerRevision: planMaxAttempts');
    expect(source).not.toContain('const MAX_CHAT_TRIAL_PLAN_PROMPTS = 2');
    expect(source).toContain('maxRepairAttempts: maxAttempts');
    expect(source).toContain('sessionCanContinue: finishedSessionCanContinue');
    expect(source).toContain('nextPlanAttempt,\n                      planMaxAttempts,');
    expect(source).not.toContain('maxPlanAttemptsForTurn');
    expect(source).toContain('beginChatTrialPlanningPrompt(planningAccumulator');
    expect(source).toContain('completeChatTrialPlanningPrompt(accumulator');
    expect(source).toContain('mergeChatTrialPlanToolTelemetry(planningAccumulator');
    expect(source).toContain('snapshotChatTrialPlanningTelemetry(planningAccumulator');
    expect(source).toContain('? { planningTelemetry }');
    expect(source).toContain('const finishedSessionCanContinue = canContinueChatSession(');
    expect(source).toContain('trialId: finishedTurn.id');
    expect(source).not.toContain('finishedSessionVisible');
    expect(source.match(/finishedSessionId [?][?] undefined/g)).toHaveLength(4);
    expect(source).toContain("trialRun.kind !== 'plan-required'");
    expect(source).not.toContain('const maxAttempts = 2;');
  });
});
