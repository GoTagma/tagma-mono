import { expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  resolveOpencodePackageName,
  resolveOpencodeStagePaths,
} from '../scripts/fetch-opencode.mjs';
import { UPGRADE_FROM_OPENCODE_VERSION } from '../scripts/fetch-opencode-upgrade-fixture.mjs';

test('OpenCode package selection keeps x64 on the baseline build', () => {
  expect(resolveOpencodePackageName('linux', 'x64')).toBe('opencode-linux-x64-baseline');
  expect(resolveOpencodePackageName('win32', 'x64')).toBe('opencode-windows-x64-baseline');
  expect(resolveOpencodePackageName('darwin', 'arm64')).toBe('opencode-darwin-arm64');
  expect(() => resolveOpencodePackageName('linux', 'ia32')).toThrow('Unsupported opencode target');
  expect(() => resolveOpencodePackageName('../outside', 'x64')).toThrow(
    'Unsupported opencode target',
  );
});

test('OpenCode staging paths stay inside the explicit target root', () => {
  const paths = resolveOpencodeStagePaths('/tmp/tagma-opencode-stage', 'win32', 'x64');
  expect(paths.targetDir).toBe(join('/tmp/tagma-opencode-stage', 'win32-x64'));
  expect(paths.destBinary).toBe(join(paths.targetDir, 'bin', 'opencode.exe'));
  expect(paths.versionFile).toBe(join(paths.targetDir, 'version.txt'));
});

test('the native migration fixture remains pinned to the pre-upgrade runtime', () => {
  expect(UPGRADE_FROM_OPENCODE_VERSION).toBe('1.17.8');
});
