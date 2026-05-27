import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapDevEnv } from '../server/dev-bootstrap';

const keys = [
  'TAGMA_EDITOR_BUNDLED_VERSION',
  'TAGMA_SIDECAR_BUNDLED_VERSION',
  'TAGMA_SIDECAR_ACTIVE_VERSION',
  'TAGMA_SIDECAR_ACTIVE_SOURCE',
  'TAGMA_EDITOR_UPDATE_CHANNEL',
  'TAGMA_SIDECAR_UPDATE_CHANNEL',
  'TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_BUNDLED_VERSION',
] as const;

const originalEnv = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));

function clearBootstrapEnv(): void {
  for (const key of keys) delete process.env[key];
}

function restoreBootstrapEnv(): void {
  for (const key of keys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreBootstrapEnv();
});

describe('bootstrapDevEnv', () => {
  test('fills missing desktop and update metadata from the electron package', () => {
    clearBootstrapEnv();
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', 'electron', 'package.json'), 'utf-8'),
    ) as {
      version: string;
      tagma: {
        channel: string;
        updateManifestBaseUrl: string;
        bundledOpencodeVersion: string;
      };
    };

    bootstrapDevEnv();

    expect(process.env.TAGMA_EDITOR_BUNDLED_VERSION).toBe(pkg.version);
    expect(process.env.TAGMA_SIDECAR_BUNDLED_VERSION).toBe(pkg.version);
    expect(process.env.TAGMA_SIDECAR_ACTIVE_VERSION).toBe(pkg.version);
    expect(process.env.TAGMA_SIDECAR_ACTIVE_SOURCE).toBe('dev');
    expect(process.env.TAGMA_EDITOR_UPDATE_CHANNEL).toBe(pkg.tagma.channel);
    expect(process.env.TAGMA_SIDECAR_UPDATE_CHANNEL).toBe(pkg.tagma.channel);
    expect(process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL).toBe(pkg.tagma.updateManifestBaseUrl);
    expect(process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL).toBe(
      pkg.tagma.updateManifestBaseUrl,
    );
    expect(process.env.TAGMA_OPENCODE_BUNDLED_VERSION).toBe(pkg.tagma.bundledOpencodeVersion);
  });

  test('preserves explicit environment overrides', () => {
    clearBootstrapEnv();
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '9.9.9';
    process.env.TAGMA_SIDECAR_ACTIVE_SOURCE = 'packaged';
    process.env.TAGMA_OPENCODE_BUNDLED_VERSION = '8.8.8';

    bootstrapDevEnv();

    expect(process.env.TAGMA_EDITOR_BUNDLED_VERSION).toBe('9.9.9');
    expect(process.env.TAGMA_SIDECAR_ACTIVE_SOURCE).toBe('packaged');
    expect(process.env.TAGMA_OPENCODE_BUNDLED_VERSION).toBe('8.8.8');
  });
});
