import { expect, test } from 'bun:test';
import { parseRequirementsVerification } from '../src/utils/requirements-verification';

test('verification preserves platform labels and does not mix install commands into checks', () => {
  expect(
    parseRequirementsVerification(
      [
        '### `sh`',
        '- Linux: `install-example`',
        "Verify (macOS / Linux): `command -v 'sh'`",
        'Verify (Windows): `where.exe "sh"`',
      ].join('\r\n'),
    ),
  ).toEqual([
    { platform: 'macOS / Linux', command: "command -v 'sh'" },
    { platform: 'Windows', command: 'where.exe "sh"' },
  ]);
});

test('existing authored verification remains readable alongside platform-specific hints', () => {
  expect(
    parseRequirementsVerification(
      'Verify: `git --version` (check the installed version)\nVerify (Windows): `git --version`',
    ),
  ).toEqual([
    { platform: null, command: 'git --version' },
    { platform: 'Windows', command: 'git --version' },
  ]);
});

test('incomplete and multiline verification never becomes a runnable command hint', () => {
  expect(
    parseRequirementsVerification(
      'Verify: Use your platform command lookup.\nVerify (Windows): `\nraw text`\nVerify: `unclosed',
    ),
  ).toEqual([]);
});
