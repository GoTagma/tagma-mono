import type { CommandArgvConfig, CommandConfig, CommandShellConfig, SpawnSpec } from './types';
import { shellArgs } from './utils';

const COMMAND_SHAPE_ERROR =
  'command must be a non-empty shell string, { shell: string }, or { argv: string[] }';

function commandRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isCommandArgvConfig(value: unknown): value is CommandArgvConfig {
  const raw = commandRecord(value);
  return (
    raw !== null &&
    'argv' in raw &&
    !('shell' in raw) &&
    Array.isArray(raw.argv) &&
    raw.argv.every((arg) => typeof arg === 'string')
  );
}

export function isCommandShellConfig(value: unknown): value is CommandShellConfig {
  const raw = commandRecord(value);
  return raw !== null && 'shell' in raw && !('argv' in raw) && typeof raw.shell === 'string';
}

export function commandToSpawnSpec(command: CommandConfig, cwd: string): SpawnSpec {
  if (typeof command === 'string') {
    if (command.trim().length === 0) throw new Error('command must not be empty');
    return { args: shellArgs(command), cwd };
  }
  if (isCommandShellConfig(command)) {
    if (command.shell.trim().length === 0) throw new Error('command.shell must not be empty');
    return { args: shellArgs(command.shell), cwd };
  }
  if (isCommandArgvConfig(command)) {
    if (command.argv.length === 0 || command.argv.some((arg) => arg.length === 0)) {
      throw new Error('command.argv must contain non-empty string arguments');
    }
    return { args: command.argv, cwd };
  }
  throw new Error(COMMAND_SHAPE_ERROR);
}

export function commandLabel(command: CommandConfig): string {
  if (typeof command === 'string') return command;
  if (isCommandShellConfig(command)) return command.shell;
  if (isCommandArgvConfig(command)) return JSON.stringify(command.argv);
  throw new Error(COMMAND_SHAPE_ERROR);
}
