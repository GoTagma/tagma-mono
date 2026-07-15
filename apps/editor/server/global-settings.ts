import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_OPENCODE_AGENT_MAX_STEPS,
  clampOpencodeAgentMaxSteps,
  isValidOpencodeAgentMaxSteps,
} from '../shared/opencode-agent-step-limit.js';
import { atomicWriteFileSync } from './path-utils.js';

/**
 * Machine-wide editor preferences shared by every Tagma workspace. This is
 * deliberately separate from `<workspace>/.tagma/editor-settings.json`:
 * changing an OpenCode safety cap should not need to be repeated for every
 * project on the same machine.
 */
export interface GlobalSettings {
  opencodeAgentMaxSteps: number;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  opencodeAgentMaxSteps: DEFAULT_OPENCODE_AGENT_MAX_STEPS,
};

const GLOBAL_SETTINGS_FILENAME = 'global-settings.json';

function defaultGlobalSettingsDir(): string {
  const override = process.env.TAGMA_GLOBAL_SETTINGS_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.tagma');
}

function settingsPath(globalDir: string): string {
  return join(globalDir, GLOBAL_SETTINGS_FILENAME);
}

export function parseGlobalSettingsPatch(value: unknown): Partial<GlobalSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const patch: Partial<GlobalSettings> = {};
  if (typeof raw.opencodeAgentMaxSteps === 'number' && Number.isFinite(raw.opencodeAgentMaxSteps)) {
    patch.opencodeAgentMaxSteps = raw.opencodeAgentMaxSteps;
  }
  return patch;
}

export function readGlobalSettings(globalDir = defaultGlobalSettingsDir()): GlobalSettings {
  const path = settingsPath(globalDir);
  if (!existsSync(path)) return { ...DEFAULT_GLOBAL_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }
    const raw = parsed as Record<string, unknown>;
    return {
      opencodeAgentMaxSteps: isValidOpencodeAgentMaxSteps(raw.opencodeAgentMaxSteps)
        ? raw.opencodeAgentMaxSteps
        : DEFAULT_GLOBAL_SETTINGS.opencodeAgentMaxSteps,
    };
  } catch (error) {
    console.error('[global-settings] failed to read global-settings.json:', error);
    return { ...DEFAULT_GLOBAL_SETTINGS };
  }
}

export function writeGlobalSettings(
  patch: Partial<GlobalSettings>,
  globalDir = defaultGlobalSettingsDir(),
): GlobalSettings {
  mkdirSync(globalDir, { recursive: true });
  const path = settingsPath(globalDir);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // A valid save repairs a corrupt file while retaining no unsafe data.
    }
  }

  const next: Record<string, unknown> = { ...existing };
  if (patch.opencodeAgentMaxSteps !== undefined && Number.isFinite(patch.opencodeAgentMaxSteps)) {
    next.opencodeAgentMaxSteps = clampOpencodeAgentMaxSteps(patch.opencodeAgentMaxSteps);
  }
  atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return readGlobalSettings(globalDir);
}
