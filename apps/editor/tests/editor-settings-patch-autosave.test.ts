import { describe, expect, test } from 'bun:test';
import { parseEditorSettingsPatch } from '../server/routes/workspace.js';

describe('parseEditorSettingsPatch', () => {
  test('accepts boolean autoSaveEnabled', () => {
    expect(parseEditorSettingsPatch({ autoSaveEnabled: false })).toEqual({
      autoSaveEnabled: false,
    });
  });

  test('rejects non-boolean autoSaveEnabled', () => {
    expect(parseEditorSettingsPatch({ autoSaveEnabled: 'yes' })).toEqual({});
    expect(parseEditorSettingsPatch({ autoSaveEnabled: 1 })).toEqual({});
  });

  test('accepts valid viewMode values', () => {
    expect(parseEditorSettingsPatch({ viewMode: 'debug' })).toEqual({ viewMode: 'debug' });
    expect(parseEditorSettingsPatch({ viewMode: 'production' })).toEqual({
      viewMode: 'production',
    });
  });

  test('rejects invalid viewMode values', () => {
    expect(parseEditorSettingsPatch({ viewMode: 'beast-mode' })).toEqual({});
    expect(parseEditorSettingsPatch({ viewMode: 1 })).toEqual({});
    expect(parseEditorSettingsPatch({ viewMode: true })).toEqual({});
  });

  test('drops legacy autoSimplifyTrackInspector field', () => {
    // Stale clients may still send this field; the validator should drop
    // it (rather than 4xx) so the rest of the patch still applies.
    expect(parseEditorSettingsPatch({ autoSimplifyTrackInspector: true })).toEqual({});
    expect(
      parseEditorSettingsPatch({
        viewMode: 'debug',
        autoSimplifyTrackInspector: true,
      }),
    ).toEqual({ viewMode: 'debug' });
  });

  test('passes finite autoSaveIntervalSec through (clamping is the loader job)', () => {
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: 120 })).toEqual({
      autoSaveIntervalSec: 120,
    });
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: 1 })).toEqual({
      autoSaveIntervalSec: 1,
    });
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: 99999 })).toEqual({
      autoSaveIntervalSec: 99999,
    });
  });

  test('ignores non-finite autoSaveIntervalSec', () => {
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: 'fast' })).toEqual({});
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: Number.NaN })).toEqual({});
    expect(parseEditorSettingsPatch({ autoSaveIntervalSec: Number.POSITIVE_INFINITY })).toEqual({});
  });

  test('passes finite chatContextRounds through (clamping is the loader job)', () => {
    expect(parseEditorSettingsPatch({ chatContextRounds: 12 })).toEqual({
      chatContextRounds: 12,
    });
    expect(parseEditorSettingsPatch({ chatContextRounds: 0 })).toEqual({
      chatContextRounds: 0,
    });
    expect(parseEditorSettingsPatch({ chatContextRounds: 99999 })).toEqual({
      chatContextRounds: 99999,
    });
  });

  test('ignores non-finite chatContextRounds', () => {
    expect(parseEditorSettingsPatch({ chatContextRounds: '12' })).toEqual({});
    expect(parseEditorSettingsPatch({ chatContextRounds: Number.NaN })).toEqual({});
    expect(parseEditorSettingsPatch({ chatContextRounds: Number.POSITIVE_INFINITY })).toEqual({});
  });

  test('accepts boolean chatContextLimitEnabled', () => {
    expect(parseEditorSettingsPatch({ chatContextLimitEnabled: true })).toEqual({
      chatContextLimitEnabled: true,
    });
    expect(parseEditorSettingsPatch({ chatContextLimitEnabled: false })).toEqual({
      chatContextLimitEnabled: false,
    });
    expect(parseEditorSettingsPatch({ chatContextLimitEnabled: 'yes' })).toEqual({});
  });

  test('accepts only boolean opencodeChatTrialRunEnabled', () => {
    expect(parseEditorSettingsPatch({ opencodeChatTrialRunEnabled: true })).toEqual({
      opencodeChatTrialRunEnabled: true,
    });
    expect(parseEditorSettingsPatch({ opencodeChatTrialRunEnabled: false })).toEqual({
      opencodeChatTrialRunEnabled: false,
    });
    expect(parseEditorSettingsPatch({ opencodeChatTrialRunEnabled: 'yes' })).toEqual({});
    expect(parseEditorSettingsPatch({ opencodeChatTrialRunEnabled: 1 })).toEqual({});
  });

  test('keeps existing fields working', () => {
    expect(parseEditorSettingsPatch({ autoInstallDeclaredPlugins: true })).toEqual({
      autoInstallDeclaredPlugins: true,
    });
    expect(parseEditorSettingsPatch({ chatDirtyConflictPolicy: 'prefer-user' })).toEqual({
      chatDirtyConflictPolicy: 'prefer-user',
    });
    expect(parseEditorSettingsPatch({ chatDirtyConflictPolicy: 'bogus' })).toEqual({});
  });

  test('accepts valid python agent settings patches', () => {
    expect(
      parseEditorSettingsPatch({
        pythonAgent: {
          enabled: true,
          interpreterCommand: 'py',
          interpreterArgs: ['-3.13'],
          interpreterVersion: '3.13',
          venvPath: '.tagma/.python-agent/venv',
          configuredAt: '2026-05-12T12:00:00.000Z',
        },
      }),
    ).toEqual({
      pythonAgent: {
        enabled: true,
        interpreterCommand: 'py',
        interpreterArgs: ['-3.13'],
        interpreterVersion: '3.13',
        venvPath: '.tagma/.python-agent/venv',
        configuredAt: '2026-05-12T12:00:00.000Z',
      },
    });
  });

  test('rejects malformed python agent settings patches', () => {
    expect(parseEditorSettingsPatch({ pythonAgent: true })).toEqual({});
    expect(
      parseEditorSettingsPatch({
        pythonAgent: {
          enabled: 'yes',
          interpreterCommand: 'py',
        },
      }),
    ).toEqual({});
  });

  test('accepts opencode chat model patches', () => {
    expect(
      parseEditorSettingsPatch({
        opencodeChatModel: {
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
      }),
    ).toEqual({
      opencodeChatModel: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      },
    });
    expect(parseEditorSettingsPatch({ opencodeChatModel: null })).toEqual({
      opencodeChatModel: null,
    });
  });

  test('rejects malformed opencode chat model patches', () => {
    expect(parseEditorSettingsPatch({ opencodeChatModel: true })).toEqual({});
    expect(
      parseEditorSettingsPatch({ opencodeChatModel: { providerID: '', modelID: 'x' } }),
    ).toEqual({});
    expect(
      parseEditorSettingsPatch({ opencodeChatModel: { providerID: 'x', modelID: 42 } }),
    ).toEqual({});
  });

  test('accepts opencode chat reasoning effort patches', () => {
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'low' })).toEqual({
      opencodeChatReasoningEffort: 'low',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'medium' })).toEqual({
      opencodeChatReasoningEffort: 'medium',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'high' })).toEqual({
      opencodeChatReasoningEffort: 'high',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'max' })).toEqual({
      opencodeChatReasoningEffort: 'max',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'xhigh' })).toEqual({
      opencodeChatReasoningEffort: 'xhigh',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 'thinking' })).toEqual({
      opencodeChatReasoningEffort: 'thinking',
    });
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: null })).toEqual({
      opencodeChatReasoningEffort: null,
    });
  });

  test('rejects malformed opencode chat reasoning effort patches', () => {
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: '' })).toEqual({});
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: '   ' })).toEqual({});
    expect(parseEditorSettingsPatch({ opencodeChatReasoningEffort: 1 })).toEqual({});
  });

  test('returns empty patch when body is an array', () => {
    expect(parseEditorSettingsPatch([])).toEqual({});
    expect(parseEditorSettingsPatch([{ autoSaveEnabled: false }])).toEqual({});
  });

  test('combines multiple fields into one patch', () => {
    expect(
      parseEditorSettingsPatch({
        autoSaveEnabled: false,
        autoSaveIntervalSec: 60,
        autoInstallDeclaredPlugins: true,
        viewMode: 'debug',
        pythonAgent: {
          enabled: false,
          interpreterCommand: null,
          interpreterArgs: [],
          interpreterVersion: null,
          venvPath: null,
          configuredAt: null,
        },
      }),
    ).toEqual({
      autoSaveEnabled: false,
      autoSaveIntervalSec: 60,
      autoInstallDeclaredPlugins: true,
      viewMode: 'debug',
      pythonAgent: {
        enabled: false,
        interpreterCommand: null,
        interpreterArgs: [],
        interpreterVersion: null,
        venvPath: null,
        configuredAt: null,
      },
    });
  });
});
