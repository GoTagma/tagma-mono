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
    expect(DEFAULT_EDITOR_SETTINGS.opencodeChatPipelineRepairMaxAttempts).toBe(25);
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
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(25);
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
        opencodeChatPipelineRepairMaxAttempts: 5,
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
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(5);
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
        opencodeChatPipelineRepairMaxAttempts: -1,
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
    expect(s.opencodeChatTrialRunEnabled).toBe(true);
    expect(s.opencodeChatPipelineRepairMaxAttempts).toBe(25);
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
      opencodeChatPipelineRepairMaxAttempts: 4,
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
    expect(next.opencodeChatPipelineRepairMaxAttempts).toBe(4);
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
    expect(onDisk.opencodeChatPipelineRepairMaxAttempts).toBe(4);
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
});
