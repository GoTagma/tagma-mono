import { describe, expect, test } from 'bun:test';
import { buildBunTestArgs } from '../scripts/test-serial.mjs';

describe('editor serial test runner timeouts', () => {
  test('gives known process and disk integration files enough time under full-suite pressure', () => {
    for (const file of [
      'tests/editor-staging.test.ts',
      'tests/plugin-install-load.test.ts',
      'tests/workflow-integration.test.ts',
      'tests/workflow-run-route.test.ts',
    ]) {
      expect(buildBunTestArgs(file)).toEqual(['test', file, '--timeout', '30000']);
    }
  });

  test('preserves an explicit caller timeout instead of adding the slow-test default', () => {
    expect(buildBunTestArgs('tests/workflow-run-route.test.ts', ['--timeout=45000'])).toEqual([
      'test',
      'tests/workflow-run-route.test.ts',
      '--timeout=45000',
    ]);
  });
});
