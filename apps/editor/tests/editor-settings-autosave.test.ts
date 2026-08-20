import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  DEFAULT_EDITOR_SETTINGS,
  readEditorSettings,
  writeEditorSettings,
} from '../server/plugins/loader.js';
import type { WorkspaceState } from '../server/workspace-state.js';
import {
  CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
  CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
  hasCurrentChatPipelineTrialLiveSmokeTestConsent,
} from '../shared/chat-pipeline-trial-consent.js';

interface MinimalWs {
  workDir: string;
}

let tmp: string;
let ws: MinimalWs;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tagma-autosave-'));
  ws = { workDir: tmp };
  mkdirSync(resolve(tmp, '.tagma'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('EditorSettings autosave + viewMode fields', () => {
  test('DEFAULT_EDITOR_SETTINGS includes autosave defaults and production viewMode', () => {
    expect(DEFAULT_EDITOR_SETTINGS.autoSaveEnabled).toBe(true);
    expect(DEFAULT_EDITOR_SETTINGS.autoSaveIntervalSec).toBe(30);
    expect(DEFAULT_EDITOR_SETTINGS.viewMode).toBe('production');
    expect(DEFAULT_EDITOR_SETTINGS.pythonAgent.enabled).toBe(false);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatModel).toBe(null);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatReasoningEffort).toBeNull();
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialRunEnabled).toBe(true);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialRunConsentVersion).toBe(
      CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    );
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialLiveSmokeTestConsentVersion).toBe(0);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialPlanMaxAttempts).toBe(2);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatPipelineRepairMaxAttempts).toBe(25);
    expect(DEFAULT_EDITOR_SETTINGS.pipelineDefaultTaskTimeoutMinutes).toBe(120);
    expect(DEFAULT_EDITOR_SETTINGS.pipelineDefaultRunTimeoutMinutes).toBe(480);
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatTrialRunTimeoutMinutes).toBe(1_440);
    expect(DEFAULT_EDITOR_SETTINGS.chatContextLimitEnabled).toBe(false);
    expect(DEFAULT_EDITOR_SETTINGS.chatContextRounds).toBe(0);
  });

  test('readEditorSettings returns defaults when file is missing', () => {
    const s = readEditorSettings(ws as unknown as WorkspaceState);
    expect(s.autoSaveEnabled).toBe(true);
    expect(s.autoSaveIntervalSec).toBe(30);
    expect(s.viewMode).toBe('production');
    expect(s.pythonAgent.enabled).toBe(false);
    expect(s.opencodeChatModel).toBe(null);
    expect(s.opencodeChatReasoningEffort).toBeNull();
    expect(s.opencodeChatTrialRunEnabled).toBe(true);
    expect(s.opencodeChatTrialRunConsentVersion).toBe(CHAT_PIPELINE_TRIAL_CONSENT_VERSION);
    expect(s.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(s.opencodeChatTrialLiveSmokeTestConsentVersion).toBe(0);
    expect(s.opencodeChatTrialPlanMaxAttempts).toBe(2);
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(25);
    expect(s.pipelineDefaultTaskTimeoutMinutes).toBe(120);
    expect(s.pipelineDefaultRunTimeoutMinutes).toBe(480);
    expect(s.opencodeChatTrialRunTimeoutMinutes).toBe(1_440);
    expect(s.chatContextLimitEnabled).toBe(false);
    expect(s.chatContextRounds).toBe(0);
  });

  test('readEditorSettings preserves valid stored values', () => {
    writeFileSync(
      resolve(tmp, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        autoSaveEnabled: false,
        autoSaveIntervalSec: 120,
        viewMode: 'debug',
        pythonAgent: {
          enabled: true,
          interpreterCommand: 'py',
          interpreterArgs: ['-3.13'],
          interpreterVersion: '3.13',
          venvPath: '.tagma/.python-agent/venv',
          configuredAt: '2026-05-12T12:00:00.000Z',
        },
        opencodeChatModel: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
        opencodeChatReasoningEffort: 'max',
        opencodeChatTrialRunEnabled: false,
        opencodeChatTrialPlanMaxAttempts: 3,
        opencodeChatPipelineRepairMaxAttempts: 5,
        pipelineDefaultTaskTimeoutMinutes: 180,
        pipelineDefaultRunTimeoutMinutes: 720,
        opencodeChatTrialRunTimeoutMinutes: 2_880,
        chatContextLimitEnabled: true,
        chatContextRounds: 0,
      }),
    );
    const s = readEditorSettings(ws as unknown as WorkspaceState);
    expect(s.autoSaveEnabled).toBe(false);
    expect(s.autoSaveIntervalSec).toBe(120);
    expect(s.viewMode).toBe('debug');
    expect(s.pythonAgent).toEqual({
      enabled: true,
      interpreterCommand: 'py',
      interpreterArgs: ['-3.13'],
      interpreterVersion: '3.13',
      venvPath: '.tagma/.python-agent/venv',
      configuredAt: '2026-05-12T12:00:00.000Z',
    });
    expect(s.opencodeChatModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
    expect(s.opencodeChatReasoningEffort).toBe('max');
    expect(s.opencodeChatTrialRunEnabled).toBe(false);
    expect(s.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(s.opencodeChatTrialLiveSmokeTestConsentVersion).toBe(0);
    expect(s.opencodeChatTrialPlanMaxAttempts).toBe(3);
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(5);
    expect(s.pipelineDefaultTaskTimeoutMinutes).toBe(180);
    expect(s.pipelineDefaultRunTimeoutMinutes).toBe(720);
    expect(s.opencodeChatTrialRunTimeoutMinutes).toBe(2_880);
    expect(s.chatContextLimitEnabled).toBe(true);
    expect(s.chatContextRounds).toBe(0);
  });

  test('readEditorSettings falls back to production viewMode for malformed values', () => {
    writeFileSync(
      resolve(tmp, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        autoSaveEnabled: 'yes',
        autoSaveIntervalSec: 'fast',
        viewMode: 'beast-mode',
        pythonAgent: {
          enabled: 'yes',
          interpreterCommand: '',
          interpreterArgs: ['-3.13', 42],
          interpreterVersion: 313,
          venvPath: '../outside',
          configuredAt: 123,
        },
        opencodeChatModel: {
          providerID: '',
          modelID: 123,
        },
        opencodeChatReasoningEffort: '   ',
        opencodeChatTrialRunEnabled: 'no',
        opencodeChatTrialPlanMaxAttempts: 0,
        opencodeChatPipelineRepairMaxAttempts: -1,
        pipelineDefaultTaskTimeoutMinutes: 5,
        pipelineDefaultRunTimeoutMinutes: 'forever',
        opencodeChatTrialRunTimeoutMinutes: 99_999,
        chatContextLimitEnabled: 'yes',
        chatContextRounds: -1,
      }),
    );
    const s = readEditorSettings(ws as unknown as WorkspaceState);
    expect(s.autoSaveEnabled).toBe(true);
    expect(s.autoSaveIntervalSec).toBe(30);
    expect(s.viewMode).toBe('production');
    expect(s.pythonAgent).toEqual(DEFAULT_EDITOR_SETTINGS.pythonAgent);
    expect(s.opencodeChatModel).toBe(null);
    expect(s.opencodeChatReasoningEffort).toBeNull();
    expect(s.opencodeChatTrialRunEnabled).toBe(false);
    expect(s.opencodeChatTrialRunConsentVersion).toBe(0);
    expect(s.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(s.opencodeChatTrialLiveSmokeTestConsentVersion).toBe(0);
    expect(s.opencodeChatTrialPlanMaxAttempts).toBe(2);
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(25);
    expect(s.pipelineDefaultTaskTimeoutMinutes).toBe(120);
    expect(s.pipelineDefaultRunTimeoutMinutes).toBe(480);
    expect(s.opencodeChatTrialRunTimeoutMinutes).toBe(1_440);
    expect(s.chatContextLimitEnabled).toBe(false);
    expect(s.chatContextRounds).toBe(0);
  });

  test('legacy autoSimplifyTrackInspector is ignored — viewMode falls back to production', () => {
    // Pre-existing settings files from before viewMode was introduced may
    // still carry this field; readEditorSettings should ignore it and
    // default viewMode to production.
    writeFileSync(
      resolve(tmp, '.tagma', 'editor-settings.json'),
      JSON.stringify({ autoSimplifyTrackInspector: true }),
    );
    const s = readEditorSettings(ws as unknown as WorkspaceState);
    expect(s.viewMode).toBe('production');
  });

  test('legacy or stale enabled state does not authorize real-workspace trial execution', () => {
    const settingsPath = resolve(tmp, '.tagma', 'editor-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ opencodeChatTrialRunEnabled: true }));
    expect(readEditorSettings(ws as unknown as WorkspaceState)).toMatchObject({
      opencodeChatTrialRunEnabled: false,
      opencodeChatTrialRunConsentVersion: 0,
    });

    writeFileSync(
      settingsPath,
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION + 1,
      }),
    );
    expect(readEditorSettings(ws as unknown as WorkspaceState)).toMatchObject({
      opencodeChatTrialRunEnabled: false,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION + 1,
    });
  });

  test('a first patch over a corrupt settings file does not grant missing consent', () => {
    writeFileSync(resolve(tmp, '.tagma', 'editor-settings.json'), '{not-json');

    const next = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialLiveSmokeTestEnabled: true,
    });

    expect(next).toMatchObject({
      opencodeChatTrialRunEnabled: false,
      opencodeChatTrialRunConsentVersion: 0,
      opencodeChatTrialLiveSmokeTestEnabled: false,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    });
  });

  test('explicitly enabling trial execution stamps the current consent version', () => {
    const next = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialRunEnabled: true,
    });
    expect(next).toMatchObject({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    });
    expect(
      JSON.parse(readFileSync(resolve(tmp, '.tagma', 'editor-settings.json'), 'utf-8')),
    ).toMatchObject({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    });
  });

  test('live smoke consent is current only while Sandbox Trial consent is current', () => {
    const settingsPath = resolve(tmp, '.tagma', 'editor-settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        opencodeChatTrialRunEnabled: false,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialLiveSmokeTestEnabled: true,
        opencodeChatTrialLiveSmokeTestConsentVersion:
          CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
      }),
    );
    const sandboxDisabled = readEditorSettings(ws as unknown as WorkspaceState);
    expect(sandboxDisabled.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(hasCurrentChatPipelineTrialLiveSmokeTestConsent(sandboxDisabled)).toBe(false);

    writeFileSync(
      settingsPath,
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialLiveSmokeTestEnabled: true,
        opencodeChatTrialLiveSmokeTestConsentVersion:
          CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
      }),
    );
    const bothCurrent = readEditorSettings(ws as unknown as WorkspaceState);
    expect(bothCurrent.opencodeChatTrialLiveSmokeTestEnabled).toBe(true);
    expect(hasCurrentChatPipelineTrialLiveSmokeTestConsent(bothCurrent)).toBe(true);

    writeFileSync(
      settingsPath,
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialLiveSmokeTestEnabled: true,
        opencodeChatTrialLiveSmokeTestConsentVersion:
          CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION + 1,
      }),
    );
    const staleLiveConsent = readEditorSettings(ws as unknown as WorkspaceState);
    expect(staleLiveConsent.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(staleLiveConsent.opencodeChatTrialLiveSmokeTestConsentVersion).toBe(
      CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION + 1,
    );
  });

  test('first sparse write can enable Live Smoke without dropping the default Sandbox consent', () => {
    const next = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialLiveSmokeTestEnabled: true,
    });
    expect(next).toMatchObject({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: true,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    });
    expect(
      JSON.parse(readFileSync(resolve(tmp, '.tagma', 'editor-settings.json'), 'utf-8')),
    ).toMatchObject({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: true,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    });
  });

  test('first unrelated sparse write materializes defaults for a later Live Smoke opt-in', () => {
    const first = writeEditorSettings(ws as unknown as WorkspaceState, {
      autoSaveEnabled: false,
    });
    expect(first).toMatchObject({
      autoSaveEnabled: false,
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    });

    const live = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialLiveSmokeTestEnabled: true,
    });
    expect(live).toMatchObject({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialLiveSmokeTestEnabled: true,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    });
  });

  test('writeEditorSettings persists autosave fields and viewMode', () => {
    const next = writeEditorSettings(ws as unknown as WorkspaceState, {
      autoSaveEnabled: false,
      autoSaveIntervalSec: 60,
      viewMode: 'debug',
      pythonAgent: {
        enabled: true,
        interpreterCommand: 'python',
        interpreterArgs: [],
        interpreterVersion: '3.13.7',
        venvPath: '.tagma/.python-agent/venv',
        configuredAt: '2026-05-12T12:00:00.000Z',
      },
      opencodeChatModel: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      },
      opencodeChatReasoningEffort: 'xhigh',
      opencodeChatTrialRunEnabled: false,
      opencodeChatTrialLiveSmokeTestEnabled: false,
      opencodeChatTrialPlanMaxAttempts: 3,
      opencodeChatPipelineRepairMaxAttempts: 4,
      pipelineDefaultTaskTimeoutMinutes: 240,
      pipelineDefaultRunTimeoutMinutes: 960,
      opencodeChatTrialRunTimeoutMinutes: 4_320,
      chatContextLimitEnabled: true,
      chatContextRounds: 12,
    });
    expect(next.autoSaveEnabled).toBe(false);
    expect(next.autoSaveIntervalSec).toBe(60);
    expect(next.viewMode).toBe('debug');
    expect(next.pythonAgent.enabled).toBe(true);
    expect(next.pythonAgent.interpreterVersion).toBe('3.13.7');
    expect(next.opencodeChatModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
    expect(next.opencodeChatReasoningEffort).toBe('xhigh');
    expect(next.opencodeChatTrialRunEnabled).toBe(false);
    expect(next.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(next.opencodeChatTrialPlanMaxAttempts).toBe(3);
    expect(next.opencodeChatPipelineRepairMaxAttempts).toBe(4);
    expect(next.pipelineDefaultTaskTimeoutMinutes).toBe(240);
    expect(next.pipelineDefaultRunTimeoutMinutes).toBe(960);
    expect(next.opencodeChatTrialRunTimeoutMinutes).toBe(4_320);
    expect(next.chatContextLimitEnabled).toBe(true);
    expect(next.chatContextRounds).toBe(12);
    const onDisk = JSON.parse(
      readFileSync(resolve(tmp, '.tagma', 'editor-settings.json'), 'utf-8'),
    );
    expect(onDisk.autoSaveEnabled).toBe(false);
    expect(onDisk.autoSaveIntervalSec).toBe(60);
    expect(onDisk.viewMode).toBe('debug');
    expect(onDisk.pythonAgent.enabled).toBe(true);
    expect(onDisk.opencodeChatModel).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    });
    expect(onDisk.opencodeChatReasoningEffort).toBe('xhigh');
    expect(onDisk.opencodeChatTrialRunEnabled).toBe(false);
    expect(onDisk.opencodeChatTrialLiveSmokeTestEnabled).toBe(false);
    expect(onDisk.opencodeChatTrialPlanMaxAttempts).toBe(3);
    expect(onDisk.opencodeChatPipelineRepairMaxAttempts).toBe(4);
    expect(onDisk.pipelineDefaultTaskTimeoutMinutes).toBe(240);
    expect(onDisk.pipelineDefaultRunTimeoutMinutes).toBe(960);
    expect(onDisk.opencodeChatTrialRunTimeoutMinutes).toBe(4_320);
    expect(onDisk.chatContextLimitEnabled).toBe(true);
    expect(onDisk.chatContextRounds).toBe(12);
  });

  test('writeEditorSettings clamps automatic pipeline repair attempts to a finite range', () => {
    const belowRange = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatPipelineRepairMaxAttempts: -3,
    });
    expect(belowRange.opencodeChatPipelineRepairMaxAttempts).toBe(0);

    const aboveRange = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatPipelineRepairMaxAttempts: 99,
    });
    expect(aboveRange.opencodeChatPipelineRepairMaxAttempts).toBe(50);

    const fractional = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatPipelineRepairMaxAttempts: 3.9,
    });
    expect(fractional.opencodeChatPipelineRepairMaxAttempts).toBe(3);
  });

  test('writeEditorSettings clamps Trial Plan attempts to the supported finite range', () => {
    const belowRange = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialPlanMaxAttempts: 0,
    });
    expect(belowRange.opencodeChatTrialPlanMaxAttempts).toBe(1);

    const aboveRange = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialPlanMaxAttempts: 99,
    });
    expect(aboveRange.opencodeChatTrialPlanMaxAttempts).toBe(3);

    const fractional = writeEditorSettings(ws as unknown as WorkspaceState, {
      opencodeChatTrialPlanMaxAttempts: 2.9,
    });
    expect(fractional.opencodeChatTrialPlanMaxAttempts).toBe(2);
  });

  test('writeEditorSettings clamps execution budgets and keeps outer lifecycles above tasks', () => {
    const clamped = writeEditorSettings(ws as unknown as WorkspaceState, {
      pipelineDefaultTaskTimeoutMinutes: 2_000,
      pipelineDefaultRunTimeoutMinutes: 10,
      opencodeChatTrialRunTimeoutMinutes: 10,
    });

    expect(clamped.pipelineDefaultTaskTimeoutMinutes).toBe(1_440);
    expect(clamped.pipelineDefaultRunTimeoutMinutes).toBe(1_470);
    expect(clamped.opencodeChatTrialRunTimeoutMinutes).toBe(1_470);

    const fractional = writeEditorSettings(ws as unknown as WorkspaceState, {
      pipelineDefaultTaskTimeoutMinutes: 60.9,
      pipelineDefaultRunTimeoutMinutes: 90.9,
      opencodeChatTrialRunTimeoutMinutes: 120.9,
    });
    expect(fractional.pipelineDefaultTaskTimeoutMinutes).toBe(60);
    expect(fractional.pipelineDefaultRunTimeoutMinutes).toBe(90);
    expect(fractional.opencodeChatTrialRunTimeoutMinutes).toBe(120);
  });
});
