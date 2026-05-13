import { afterEach, describe, expect, test } from 'bun:test';
import { _resetShellCache } from './utils';
import {
  commandLabel,
  commandToSpawnSpec,
  isCommandArgvConfig,
  isCommandShellConfig,
} from './command';

const previousShell = process.env.PIPELINE_SHELL;

afterEach(() => {
  if (previousShell === undefined) {
    delete process.env.PIPELINE_SHELL;
  } else {
    process.env.PIPELINE_SHELL = previousShell;
  }
  _resetShellCache();
});

describe('command config helpers', () => {
  test('distinguishes argv and shell object commands', () => {
    expect(isCommandArgvConfig({ argv: ['node', '--version'] })).toBe(true);
    expect(isCommandArgvConfig({ shell: 'node --version' })).toBe(false);
    expect(isCommandShellConfig({ shell: 'node --version' })).toBe(true);
    expect(isCommandShellConfig({ argv: ['node', '--version'] })).toBe(false);
  });

  test('argv commands become spawn specs without shell wrapping', () => {
    const spec = commandToSpawnSpec({ argv: ['node', '--version'] }, '/tmp/work');

    expect(spec).toEqual({ args: ['node', '--version'], cwd: '/tmp/work' });
    expect(commandLabel({ argv: ['node', '--version'] })).toBe('["node","--version"]');
  });

  test('shell commands use the configured shell and reject empty commands', () => {
    process.env.PIPELINE_SHELL = 'powershell';
    _resetShellCache();

    expect(commandToSpawnSpec({ shell: 'Write-Output ok' }, 'C:\\work').args).toEqual([
      'powershell',
      '-Command',
      'Write-Output ok',
    ]);
    expect(commandLabel({ shell: 'Write-Output ok' })).toBe('Write-Output ok');
    expect(() => commandToSpawnSpec('', '/tmp/work')).toThrow(/command must not be empty/);
    expect(() => commandToSpawnSpec({ shell: '   ' }, '/tmp/work')).toThrow(
      /command\.shell must not be empty/,
    );
  });

  test('argv commands must contain non-empty arguments', () => {
    expect(() => commandToSpawnSpec({ argv: [] }, '/tmp/work')).toThrow(
      /command\.argv must contain non-empty string arguments/,
    );
    expect(() => commandToSpawnSpec({ argv: ['node', ''] }, '/tmp/work')).toThrow(
      /command\.argv must contain non-empty string arguments/,
    );
  });
});
