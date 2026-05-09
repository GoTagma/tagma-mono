import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetShellCache,
  parseDuration,
  shellArgs,
  shellQuoteForActiveShell,
  UnsafeShellQuoteError,
  validatePath,
} from './utils';

test('parseDuration rejects timer values above the runtime-safe setTimeout limit', () => {
  expect(() => parseDuration('25d')).toThrow(/exceeds maximum supported timer value/);
  expect(() => parseDuration('999999999999999999999999d')).toThrow(
    /exceeds maximum supported timer value/,
  );
});

test('shellQuoteForActiveShell escapes single quotes per the active shell', () => {
  const previousShell = process.env.PIPELINE_SHELL;
  try {
    _resetShellCache();

    // POSIX: single-quote with the canonical close-reopen sequence.
    process.env.PIPELINE_SHELL = 'sh';
    expect(shellQuoteForActiveShell("it's")).toBe(`'it'\\''s'`);

    // PowerShell: doubled single-quote inside a single-quoted literal.
    // POSIX-style escaping here would parse as `'it'`, then `\''s'`,
    // which is two strings under PowerShell — completely wrong.
    process.env.PIPELINE_SHELL = 'powershell';
    expect(shellQuoteForActiveShell("it's")).toBe("'it''s'");

    // cmd.exe: refuse outright. The cmd.exe parser does not honour `\"`
    // (that's a C-runtime convention CommandLineToArgvW applies, not
    // something cmd's command processor accepts), `""` doubling still
    // expands `%VAR%` inside quotes, and `&|<>^` end the command outside
    // the wrap. Returning a "looks safe" wrapped string would silently
    // re-open the injection vector this filter exists to close, so we
    // throw and tell the caller to switch to PowerShell or argv form.
    process.env.PIPELINE_SHELL = 'cmd';
    expect(() => shellQuoteForActiveShell("it's")).toThrow(UnsafeShellQuoteError);
    expect(() => shellQuoteForActiveShell('a & calc')).toThrow(/cmd\.exe/);

    // Innocuous values pass through unquoted under any shell — no special
    // characters means there's nothing to escape and unquoted is more
    // readable in command logs. cmd.exe agrees with the others on this
    // path because the early-return predates the kind-specific branches.
    process.env.PIPELINE_SHELL = 'sh';
    expect(shellQuoteForActiveShell('shanghai')).toBe('shanghai');
    process.env.PIPELINE_SHELL = 'cmd';
    expect(shellQuoteForActiveShell('shanghai')).toBe('shanghai');
  } finally {
    if (previousShell === undefined) {
      delete process.env.PIPELINE_SHELL;
    } else {
      process.env.PIPELINE_SHELL = previousShell;
    }
    _resetShellCache();
  }
});

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

if (process.platform === 'win32') {
  test('Windows automatic shell does not prefer Git Bash over native shells', () => {
    const previousShell = process.env.PIPELINE_SHELL;
    try {
      delete process.env.PIPELINE_SHELL;
      _resetShellCache();
      const args = shellArgs('Get-ChildItem');
      expect(['-Command', '/c']).toContain(args[1]);
    } finally {
      if (previousShell === undefined) {
        delete process.env.PIPELINE_SHELL;
      } else {
        process.env.PIPELINE_SHELL = previousShell;
      }
      _resetShellCache();
    }
  });
}

test('validatePath rejects a future file under a symlinked parent outside the project root', () => {
  const root = join(
    tmpdir(),
    `tagma-core-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const outside = join(
    tmpdir(),
    `tagma-core-outside-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return;
    }

    expect(() => validatePath('link/future.txt', root)).toThrow(/escapes project root/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
