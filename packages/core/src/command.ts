import type { CommandArgvConfig, CommandConfig, CommandShellConfig, SpawnSpec } from './types';
import { shellArgs } from './utils';

export function isCommandArgvConfig(value: CommandConfig): value is CommandArgvConfig {
  return typeof value === 'object' && value !== null && 'argv' in value;
}

export function isCommandShellConfig(value: CommandConfig): value is CommandShellConfig {
  return typeof value === 'object' && value !== null && 'shell' in value;
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
  if (command.argv.length === 0 || command.argv.some((arg) => arg.length === 0)) {
    throw new Error('command.argv must contain non-empty string arguments');
  }
  return { args: command.argv, cwd };
}

export function commandLabel(command: CommandConfig): string {
  if (typeof command === 'string') return command;
  if (isCommandShellConfig(command)) return command.shell;
  return JSON.stringify(command.argv);
}
