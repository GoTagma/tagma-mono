import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  canonicalHotupdateManifestPayload,
  type HotupdateManifest,
  MANIFEST_CACHE_TTL_MS,
  compareVersions,
  fetchHotupdateManifest,
  pickOpencodeTarget,
  pickSidecarTarget,
  validateHotupdateManifest,
  verifyHotupdateManifestSignature,
} from '../server/update-manifest';

function opencodeManifestSection(): NonNullable<HotupdateManifest['opencode']> {
  return {
    version: '1.15.13',
    targets: [
      {
        platform: process.platform,
        arch: process.arch,
        url: 'https://example.com/opencode/current',
        sha256: 'd'.repeat(64),
        size: 321,
      },
    ],
  };
}

describe('hot-update manifest helpers', () => {
  test('selects the sidecar asset matching the current platform and arch', () => {
    const manifest: HotupdateManifest = {
      version: '0.2.2',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor-dist-0.2.2.tar.gz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: 'https://example.com/sidecar/current',
            sha256: 'b'.repeat(64),
            size: 456,
          },
          {
            platform: process.platform === 'win32' ? 'linux' : 'win32',
            arch: process.arch,
            url: 'https://example.com/sidecar/other',
            sha256: 'c'.repeat(64),
            size: 789,
          },
        ],
      },
      opencode: opencodeManifestSection(),
    };

    expect(pickSidecarTarget(manifest, process.platform, process.arch)).toEqual(
      manifest.sidecar!.targets[0],
    );
  });

  test('returns null when the manifest has no sidecar asset for the requested target', () => {
    const manifest: HotupdateManifest = {
      version: '0.2.2',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor-dist-0.2.2.tar.gz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      sidecar: {
        targets: [
          {
            platform: process.platform === 'win32' ? 'linux' : 'win32',
            arch: process.arch,
            url: 'https://example.com/sidecar/other',
            sha256: 'b'.repeat(64),
            size: 456,
          },
        ],
      },
      opencode: opencodeManifestSection(),
    };

    expect(pickSidecarTarget(manifest, process.platform, process.arch)).toBeNull();
  });

  test('selects the opencode asset matching the current platform and arch', () => {
    const manifest: HotupdateManifest = {
      version: '0.2.2',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor-dist-0.2.2.tar.gz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: {
        version: '1.15.13',
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: 'https://example.com/opencode/current',
            sha256: 'd'.repeat(64),
            size: 321,
          },
          {
            platform: process.platform === 'win32' ? 'linux' : 'win32',
            arch: process.arch,
            url: 'https://example.com/opencode/other',
            sha256: 'e'.repeat(64),
            size: 654,
          },
        ],
      },
    };

    expect(pickOpencodeTarget(manifest, process.platform, process.arch)).toEqual(
      manifest.opencode!.targets[0],
    );
  });

  test('verifies signed manifests against the configured Ed25519 public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const manifest: HotupdateManifest = {
      version: '0.2.2',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor-dist-0.2.2.tar.gz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: opencodeManifestSection(),
    };
    const signature = sign(
      null,
      Buffer.from(canonicalHotupdateManifestPayload(manifest), 'utf-8'),
      privatePem,
    ).toString('base64');

    const signed = { ...manifest, signature };
    expect(() =>
      verifyHotupdateManifestSignature(signed, 'https://example.com/manifest.json', publicPem),
    ).not.toThrow();
    expect(() =>
      verifyHotupdateManifestSignature(
        { ...signed, version: '0.2.3' },
        'https://example.com/manifest.json',
        publicPem,
      ),
    ).toThrow(/signature/i);
  });

  test('requires a signature key for network manifests', () => {
    const previous = process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY;
    delete process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY;
    const manifest: HotupdateManifest = {
      version: '0.2.2',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor-dist-0.2.2.tar.gz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: opencodeManifestSection(),
    };

    try {
      expect(() =>
        verifyHotupdateManifestSignature(manifest, 'https://example.com/manifest.json', undefined),
      ).toThrow(/public key|TAGMA_UPDATE_MANIFEST_PUBLIC_KEY|signature/i);
    } finally {
      if (previous === undefined) {
        delete process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY;
      } else {
        process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY = previous;
      }
    }
  });

  test('manifest cache TTL is short enough that fresh releases surface promptly', () => {
    // 5 minutes was too long: a user opens Settings, sees "no update", a new
    // release ships, they refresh — but cached "no update" sticks for the
    // remainder of the 5 minutes. Cap at 60s so bursts during a single
    // Settings session still dedupe but new releases are visible within a
    // minute.
    expect(MANIFEST_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);
    expect(MANIFEST_CACHE_TTL_MS).toBeGreaterThan(0);
  });

  test('compares semver prereleases correctly for update decisions', () => {
    expect(compareVersions('1.2.3-alpha.2', '1.2.3-alpha.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3-alpha.2')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-alpha.1', '1.2.3')).toBeLessThan(0);
    expect(compareVersions('1.2.3-alpha.1', '1.2.3-alpha.1')).toBe(0);
  });

  test('rejects unsafe versions and non-HTTPS network assets', () => {
    const good: HotupdateManifest = {
      version: '1.2.3-alpha.1',
      channel: 'alpha',
      dist: {
        url: 'https://example.com/editor.tgz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: opencodeManifestSection(),
    };

    expect(() =>
      validateHotupdateManifest(good, 'https://example.com/manifest.json'),
    ).not.toThrow();
    expect(() =>
      validateHotupdateManifest(
        { ...good, version: '../1.2.3' },
        'https://example.com/manifest.json',
      ),
    ).toThrow(/semver/i);
    expect(() =>
      validateHotupdateManifest(
        { ...good, dist: { ...good.dist, url: 'http://example.com/editor.tgz' } },
        'https://example.com/manifest.json',
      ),
    ).toThrow(/HTTPS/i);
    expect(() =>
      validateHotupdateManifest(
        { ...good, opencode: undefined },
        'https://example.com/manifest.json',
      ),
    ).toThrow(/opencode/i);
    expect(() =>
      validateHotupdateManifest(
        { ...good, opencode: { ...good.opencode!, version: '../1.15.13' } },
        'https://example.com/manifest.json',
      ),
    ).toThrow(/opencode|semver/i);
  });

  test('rejects unsafe minShellVersion values', () => {
    const good: HotupdateManifest = {
      version: '1.2.3',
      channel: 'stable',
      minShellVersion: '1.0.0',
      dist: {
        url: 'https://example.com/editor.tgz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: opencodeManifestSection(),
    };

    expect(() =>
      validateHotupdateManifest(good, 'https://example.com/manifest.json'),
    ).not.toThrow();
    expect(() =>
      validateHotupdateManifest(
        { ...good, minShellVersion: '../1.0.0' },
        'https://example.com/manifest.json',
      ),
    ).toThrow(/minShellVersion|semver/i);
  });

  test('caps fetched manifest JSON bodies before parsing', async () => {
    const previousFetch = globalThis.fetch;
    const oversized = JSON.stringify({
      version: '1.2.3',
      channel: 'stable',
      dist: {
        url: 'file:///tmp/editor.tgz',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      opencode: {
        version: '1.15.13',
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: 'file:///tmp/opencode',
            sha256: 'd'.repeat(64),
            size: 321,
          },
        ],
      },
      padding: 'x'.repeat(1024 * 1024 + 1),
    });

    globalThis.fetch = (async () =>
      new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    try {
      await expect(fetchHotupdateManifest('file:///tmp/manifest.json', true)).rejects.toThrow(
        /manifest.*too large|exceeds/i,
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
