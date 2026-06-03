import { describe, expect, test } from 'bun:test';
import { buildInstallPluginRequest } from '../src/api/client';

describe('plugin API client', () => {
  test('installPlugin includes a marketplace version pin when provided', async () => {
    const request = buildInstallPluginRequest('@scope/plugin-under-test', '1.2.3');

    expect(request.path).toBe('/plugins/install');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(String(request.options.body))).toEqual({
      name: '@scope/plugin-under-test',
      version: '1.2.3',
    });
  });

  test('installPlugin omits version for local latest-resolution installs', async () => {
    const request = buildInstallPluginRequest('@scope/plugin-under-test');

    expect(request.path).toBe('/plugins/install');
    expect(request.options.method).toBe('POST');
    expect(JSON.parse(String(request.options.body))).toEqual({
      name: '@scope/plugin-under-test',
    });
  });
});
