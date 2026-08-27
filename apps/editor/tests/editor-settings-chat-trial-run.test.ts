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

  test('wires the workspace budgets into production runs and Chat Trial', () => {
    const runSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'routes', 'run.ts'),
      'utf8',
    );
    const trialSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'chat-pipeline-trial-run.ts'),
      'utf8',
    );

    expect(runSource.match(/editorSettings\.pipelineDefaultTaskTimeoutMinutes/g)).toHaveLength(2);
    expect(runSource.match(/editorSettings\.pipelineDefaultRunTimeoutMinutes/g)).toHaveLength(2);
    expect(runSource.match(/defaultPipelineTimeoutMs:/g)).toHaveLength(3);
    expect(trialSource).toContain('editorSettings.pipelineDefaultTaskTimeoutMinutes');
    expect(trialSource).toContain('editorSettings.opencodeChatTrialRunTimeoutMinutes');
    expect(trialSource).toContain('defaultTaskTimeoutMs: input.taskTimeoutMs');
    expect(trialSource).not.toContain('CHAT_PIPELINE_TRIAL_TASK_TIMEOUT_MS');
    expect(trialSource).not.toContain('CHAT_PIPELINE_TRIAL_TIMEOUT_MS');
  });

  test('renders Sandbox Trial and its independently consented Live Smoke Test', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'settings', 'EditorSettingsSections.tsx'),
      'utf8',
    );
    const consentSource = readFileSync(
      join(import.meta.dir, '..', 'shared', 'chat-pipeline-trial-consent.ts'),
      'utf8',
    );

    expect(source).toContain('Sandbox Trial');
    expect(source).toContain('fresh temporary copies');
    expect(source).toContain('no inherited stdin/TTY');
    expect(source).toContain('synthetic secrets');
    expect(source).toContain('application-level rather than OS-enforced');
    expect(source).toContain('explicitly selected manual-trigger tasks');
    expect(source).toContain('Live Smoke Test');
    expect(source).toContain('baseline in the real workspace');
    expect(source).toContain('automatically grants its manual triggers');
    expect(source).toContain('normal host command authority');
    expect(source).toContain('real credentials and network access');
    expect(source).toContain('may mutate external state');
    expect(consentSource).toContain('CHAT_PIPELINE_TRIAL_CONSENT_VERSION = 3');
    expect(consentSource).toContain('CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION = 2');
    expect(source).toContain('checked={settings.opencodeChatTrialRunEnabled}');
    expect(source).toContain('checked={settings.opencodeChatTrialLiveSmokeTestEnabled}');
    expect(source).toContain(
      'disabled={settingsInputsDisabled || !settings.opencodeChatTrialRunEnabled}',
    );
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
    const liveSmokeIndex = source.indexOf(
      'checked={settings.opencodeChatTrialLiveSmokeTestEnabled}',
    );
    const trialPlanLimitIndex = source.indexOf('value={settings.opencodeChatTrialPlanMaxAttempts}');
    const repairLimitIndex = source.indexOf(
      'value={settings.opencodeChatPipelineRepairMaxAttempts}',
    );
    const memoryToggleIndex = source.indexOf('checked={settings.chatContextLimitEnabled}');
    expect(toggleIndex).toBeGreaterThan(-1);
    expect(liveSmokeIndex).toBeGreaterThan(toggleIndex);
    expect(trialPlanLimitIndex).toBeGreaterThan(liveSmokeIndex);
    expect(repairLimitIndex).toBeGreaterThan(trialPlanLimitIndex);
    expect(memoryToggleIndex).toBeGreaterThan(repairLimitIndex);
    expect(source).toContain(`updateField('opencodeChatTrialLiveSmokeTestEnabled', v)`);
    expect(source).toContain("updateField('opencodeChatTrialRunEnabled', v)");
  });

  test('freezes the configured repair budget and Trial consent in Host-owned V2 execution', () => {
    const indexSource = readFileSync(join(import.meta.dir, '..', 'server', 'index.ts'), 'utf8');
    const admissionSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'chat-operations', 'host-admission.ts'),
      'utf8',
    );
    const orchestratorSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'chat-operations', 'orchestrator.ts'),
      'utf8',
    );
    const authoringRuntimeSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'chat-operations', 'authoring-runtime.ts'),
      'utf8',
    );
    const trialSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'chat-pipeline-trial-run.ts'),
      'utf8',
    );
    const settingsSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'plugins', 'loader.ts'),
      'utf8',
    );
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

    expect(indexSource).toContain('const editorSettings = readEditorSettings(workspace);');
    expect(indexSource).toContain(
      'repairMaxAttempts: editorSettings.opencodeChatPipelineRepairMaxAttempts',
    );
    expect(admissionSource).toContain(
      'isValidChatPipelineRepairAttempts(authority.repairMaxAttempts)',
    );
    expect(admissionSource).toContain('repairMaxAttempts: authority.repairMaxAttempts');
    expect(orchestratorSource).toContain('repairMaxAttempts: input.repairMaxAttempts');
    expect(settingsSource).toContain(
      'opencodeChatPipelineRepairMaxAttempts: DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS',
    );
    expect(authoringRuntimeSource).toContain(
      'return await trialRunChatYamlStage(this.workspace, {',
    );
    expect(authoringRuntimeSource).toContain('trustedOperationV2: true');
    expect(trialSource).toContain('hasCurrentChatPipelineTrialConsent(editorSettings)');
    expect(trialSource).toContain('stage.trialPlanMaxAttempts');
    expect(appSource).not.toContain('hasCurrentChatPipelineTrialConsent');
    expect(appSource).not.toContain('shouldTrialRunChatPipeline');
  });
});
