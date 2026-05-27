import { describe, expect, test } from 'bun:test';
import {
  computeBundlePendingRestart,
  computeBundleSkew,
  type BundleSkew,
} from '../src/components/VersionStatusBar';
import type { EditorInfo, SidecarInfo } from '../src/api/client';

function editor(overrides: Partial<EditorInfo> = {}): EditorInfo {
  return {
    bundledVersion: '0.4.20',
    userInstalledVersion: null,
    activeVersion: '0.4.20',
    latestVersion: '0.4.20',
    updateAvailable: false,
    canUpdate: true,
    pendingRestart: false,
    minShellVersion: null,
    shellCompatible: true,
    channel: 'alpha',
    manifestUrl: 'https://example.com/editor-updates/alpha/manifest.json',
    releaseNotesUrl: null,
    ...overrides,
  };
}

function sidecar(overrides: Partial<SidecarInfo> = {}): SidecarInfo {
  return {
    bundledVersion: '0.4.20',
    userInstalledVersion: null,
    activeVersion: '0.4.20',
    activeSource: 'bundled',
    latestVersion: '0.4.20',
    updateAvailable: false,
    canUpdate: true,
    pendingRestart: false,
    minShellVersion: null,
    shellCompatible: true,
    channel: 'alpha',
    manifestUrl: 'https://example.com/editor-updates/alpha/manifest.json',
    releaseNotesUrl: null,
    platform: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

describe('computeBundleSkew', () => {
  test('returns null when both components are on the same active version', () => {
    expect(computeBundleSkew(editor(), sidecar())).toBeNull();
  });

  test('returns null when either side is unknown', () => {
    expect(computeBundleSkew(editor({ activeVersion: null }), sidecar())).toBeNull();
    expect(computeBundleSkew(editor(), sidecar({ activeVersion: null }))).toBeNull();
  });

  test('returns active-version skew when activeVersions disagree', () => {
    const result = computeBundleSkew(
      editor({ activeVersion: '0.4.24' }),
      sidecar({ activeVersion: '0.4.20' }),
    );
    const expected: BundleSkew = {
      kind: 'active',
      editorVersion: '0.4.24',
      sidecarVersion: '0.4.20',
    };
    expect(result).toEqual(expected);
  });

  test('returns user-installed skew when both user pointers exist and disagree', () => {
    // Bundle update activated editor pointer but crashed before sidecar
    // pointer flipped — both userInstalledVersion fields are non-null and
    // they disagree. activeVersion may still match in this window because
    // the runtime hasn't restarted yet.
    const result = computeBundleSkew(
      editor({
        userInstalledVersion: '0.4.24',
        activeVersion: '0.4.20',
      }),
      sidecar({
        userInstalledVersion: '0.4.23',
        activeVersion: '0.4.20',
      }),
    );
    const expected: BundleSkew = {
      kind: 'user-installed',
      editorVersion: '0.4.24',
      sidecarVersion: '0.4.23',
    };
    expect(result).toEqual(expected);
  });

  test('does not flag skew when only one user pointer is set', () => {
    // Single-side hot update isn't skew — the other side is just on bundled.
    expect(
      computeBundleSkew(
        editor({ userInstalledVersion: '0.4.24' }),
        sidecar({ userInstalledVersion: null }),
      ),
    ).toBeNull();
    expect(
      computeBundleSkew(
        editor({ userInstalledVersion: null }),
        sidecar({ userInstalledVersion: '0.4.24' }),
      ),
    ).toBeNull();
  });

  test('prefers active-version skew over user-installed skew when both fire', () => {
    // The user-visible runtime is what activeVersion reflects, so the
    // active-version label is more accurate to surface to the user.
    const result = computeBundleSkew(
      editor({
        userInstalledVersion: '0.4.24',
        activeVersion: '0.4.24',
      }),
      sidecar({
        userInstalledVersion: '0.4.23',
        activeVersion: '0.4.23',
      }),
    );
    expect(result).toEqual({
      kind: 'active',
      editorVersion: '0.4.24',
      sidecarVersion: '0.4.23',
    });
  });
});

describe('computeBundlePendingRestart', () => {
  test('returns true when either bundle component is staged ahead of the running process', () => {
    expect(computeBundlePendingRestart(editor({ pendingRestart: true }), sidecar())).toBe(true);
    expect(computeBundlePendingRestart(editor(), sidecar({ pendingRestart: true }))).toBe(true);
  });

  test('returns false when both components are already active', () => {
    expect(computeBundlePendingRestart(editor(), sidecar())).toBe(false);
  });
});
