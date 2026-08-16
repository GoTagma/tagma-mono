import { describe, expect, test } from 'bun:test';
import type { YamlCompileResult } from '@tagma/sdk/yaml';

import { __compileLogTestHooks } from '../server/compile-log';

const { mergeCompileDiagnostics } = __compileLogTestHooks;

describe('compile log additional validation', () => {
  test('never turns an unrepresented base compiler failure into success', () => {
    const crashed: YamlCompileResult = {
      timestamp: '2026-08-16T00:00:00.000Z',
      sourceName: 'fixture.yaml',
      success: false,
      parseOk: true,
      validation: { errors: [], warnings: [] },
      summary: 'Validation crashed: fixture crash',
    };

    const merged = mergeCompileDiagnostics(crashed, [
      { path: 'pipeline', message: 'advisory context', severity: 'warning' },
    ]);

    expect(merged.success).toBe(false);
    expect(merged.summary).toContain('Validation crashed: fixture crash');
    expect(merged.validation.warnings).toEqual([{ path: 'pipeline', message: 'advisory context' }]);
  });

  test('does not let an existing warning suppress an added error with the same identity', () => {
    const validWithWarning: YamlCompileResult = {
      timestamp: '2026-08-16T00:00:00.000Z',
      sourceName: 'fixture.yaml',
      success: true,
      parseOk: true,
      validation: {
        errors: [],
        warnings: [{ path: 'tracks[0]', message: 'same diagnostic' }],
      },
      summary: 'Valid with 1 warning(s)',
    };

    const merged = mergeCompileDiagnostics(validWithWarning, [
      { path: 'tracks[0]', message: 'same diagnostic', severity: 'error' },
    ]);

    expect(merged.success).toBe(false);
    expect(merged.validation.errors).toEqual([{ path: 'tracks[0]', message: 'same diagnostic' }]);
    expect(merged.validation.warnings).toEqual([{ path: 'tracks[0]', message: 'same diagnostic' }]);
  });
});
