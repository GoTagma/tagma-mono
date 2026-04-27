import { expect, test } from 'bun:test';
import { _resetShellCache, shellArgs } from './utils';

test('PIPELINE_SHELL override is evaluated per call instead of cached', () => {
  const previousShell = process.env.PIPELINE_SHELL;
  try {
    _resetShellCache();
    process.env.PIPELINE_SHELL = 'cmd';
    expect(shellArgs('echo hi').slice(0, 2)).toEqual(['cmd', '/c']);

    process.env.PIPELINE_SHELL = 'powershell';
    expect(shellArgs('echo hi').slice(0, 2)).toEqual(['powershell', '-Command']);
  } finally {
    if (previousShell === undefined) {
      delete process.env.PIPELINE_SHELL;
    } else {
      process.env.PIPELINE_SHELL = previousShell;
    }
    _resetShellCache();
  }
});
