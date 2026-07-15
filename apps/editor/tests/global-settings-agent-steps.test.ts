import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GLOBAL_SETTINGS,
  parseGlobalSettingsPatch,
  readGlobalSettings,
  writeGlobalSettings,
} from '../server/global-settings.js';
import { buildOpencodeSeedOptions } from '../server/opencode-seed-options.js';
import type { WorkspaceState } from '../server/workspace-state.js';

let globalDir: string;

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), 'tagma-global-settings-'));
});

afterEach(() => {
  rmSync(globalDir, { recursive: true, force: true });
});

describe('global OpenCode agent step limit', () => {
  test('defaults to 25 when the global settings file is missing', () => {
    expect(DEFAULT_GLOBAL_SETTINGS.opencodeAgentMaxSteps).toBe(25);
    expect(readGlobalSettings(globalDir)).toEqual({ opencodeAgentMaxSteps: 25 });
  });

  test('persists repeated user changes and returns the latest value after every reload', () => {
    for (const value of [40, 12, 64, 25]) {
      expect(writeGlobalSettings({ opencodeAgentMaxSteps: value }, globalDir)).toEqual({
        opencodeAgentMaxSteps: value,
      });
      expect(readGlobalSettings(globalDir).opencodeAgentMaxSteps).toBe(value);
    }

    const onDisk = JSON.parse(readFileSync(join(globalDir, 'global-settings.json'), 'utf8'));
    expect(onDisk.opencodeAgentMaxSteps).toBe(25);
  });

  test('preserves unknown future keys while clamping finite numeric writes', () => {
    writeFileSync(
      join(globalDir, 'global-settings.json'),
      JSON.stringify({ futureSetting: 'keep-me', opencodeAgentMaxSteps: 25 }),
      'utf8',
    );

    expect(writeGlobalSettings({ opencodeAgentMaxSteps: 5000.9 }, globalDir)).toEqual({
      opencodeAgentMaxSteps: 1000,
    });
    const onDisk = JSON.parse(readFileSync(join(globalDir, 'global-settings.json'), 'utf8'));
    expect(onDisk.futureSetting).toBe('keep-me');
    expect(onDisk.opencodeAgentMaxSteps).toBe(1000);
  });

  test('falls back safely for malformed stored values', () => {
    for (const value of [2, 1001, 3.5, '25', null]) {
      writeFileSync(
        join(globalDir, 'global-settings.json'),
        JSON.stringify({ opencodeAgentMaxSteps: value }),
        'utf8',
      );
      expect(readGlobalSettings(globalDir).opencodeAgentMaxSteps).toBe(25);
    }
  });

  test('accepts only finite numeric API patches', () => {
    expect(parseGlobalSettingsPatch({ opencodeAgentMaxSteps: 40 })).toEqual({
      opencodeAgentMaxSteps: 40,
    });
    expect(parseGlobalSettingsPatch({ opencodeAgentMaxSteps: '40' })).toEqual({});
    expect(parseGlobalSettingsPatch({ opencodeAgentMaxSteps: Number.NaN })).toEqual({});
    expect(parseGlobalSettingsPatch([])).toEqual({});
  });

  test('feeds the latest global value into every OpenCode seed entry point', () => {
    const workDir = join(globalDir, 'workspace');
    mkdirSync(join(workDir, '.tagma'), { recursive: true });
    writeFileSync(
      join(workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        pythonAgent: {
          enabled: true,
          interpreterCommand: 'python',
          interpreterArgs: [],
          interpreterVersion: '3.13',
          venvPath: '.tagma/.python-agent/venv',
          configuredAt: null,
        },
      }),
      'utf8',
    );
    const ws = { workDir } as WorkspaceState;

    writeGlobalSettings({ opencodeAgentMaxSteps: 48 }, globalDir);
    expect(buildOpencodeSeedOptions(ws, globalDir)).toEqual({
      agentMaxSteps: 48,
      pythonToolsEnabled: true,
    });

    writeGlobalSettings({ opencodeAgentMaxSteps: 17 }, globalDir);
    expect(buildOpencodeSeedOptions(ws, globalDir).agentMaxSteps).toBe(17);
  });
});
