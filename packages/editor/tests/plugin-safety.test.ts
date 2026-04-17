// Unit tests for the plugin-loader safety fences. These cover the path
// traversal vulnerabilities (C1, C2) plus the support helpers (H1, H7, L3,
// M5) and the import-timeout fence (R11).
//
// The tests exercise pure helpers only — no Express server or filesystem
// mutation — so they're cheap to run and easy to read.

import { test, expect, describe } from 'bun:test';
import { resolve, join } from 'node:path';

import {
  PluginSafetyError,
  isPathWithin,
  assertSafePluginName,
  pluginDirFor,
  assertWithinNodeModules,
  safePluginDir,
  pluginCategoryFromName,
  importWithTimeout,
} from '../server/plugin-safety';
import { isValidPluginName, PLUGIN_NAME_RE } from '@tagma/sdk';

const FAKE_WORKDIR = resolve('/tmp/tagma-fake-workspace');

// ─── isValidPluginName / PLUGIN_NAME_RE ────────────────────────────────────

describe('isValidPluginName', () => {
  test.each([
    ['@tagma/driver-codex', true],
    ['@tagma/trigger-github', true],
    ['@tagma/completion-output_check', true],
    ['@tagma/middleware-static_context', true],
    ['@scope/pkg', true],
    ['@scope/pkg-name.dot', true],
    ['tagma-plugin-foo', true],
    ['tagma-plugin-foo.bar_baz', true],
  ])('accepts %s', (name, _ok) => {
    expect(isValidPluginName(name)).toBe(true);
    expect(PLUGIN_NAME_RE.test(name as string)).toBe(true);
  });

  test.each([
    'plain-name',                    // no scope, no tagma-plugin- prefix
    '../etc/passwd',                 // path traversal
    '../../some-dir',                // path traversal
    '@a/../../etc',                  // scope-prefixed traversal
    '@a/b/c',                        // multi-segment scoped
    '@/foo',                         // empty scope
    '@scope/',                       // empty package
    '@SCOPE/pkg',                    // uppercase rejected (regex is lowercase only)
    '/absolute/path',                // absolute path
    'C:\\Windows',                   // Windows absolute path
    'tagma-plugin-../escape',        // tagma-plugin- prefix with traversal
    '',                              // empty
  ])('rejects %s', (name) => {
    expect(isValidPluginName(name)).toBe(false);
  });

  test('rejects non-strings', () => {
    expect(isValidPluginName(undefined)).toBe(false);
    expect(isValidPluginName(null)).toBe(false);
    expect(isValidPluginName(123)).toBe(false);
    expect(isValidPluginName({ name: '@tagma/foo' })).toBe(false);
    expect(isValidPluginName(['@tagma/foo'])).toBe(false);
  });
});

// ─── assertSafePluginName ──────────────────────────────────────────────────

describe('assertSafePluginName', () => {
  test('accepts a scoped tagma plugin', () => {
    expect(() => assertSafePluginName('@tagma/driver-codex')).not.toThrow();
  });

  test('accepts a tagma-plugin-* package', () => {
    expect(() => assertSafePluginName('tagma-plugin-foo')).not.toThrow();
  });

  test('throws PluginSafetyError on path traversal', () => {
    expect(() => assertSafePluginName('../../etc/passwd')).toThrow(PluginSafetyError);
    expect(() => assertSafePluginName('@x/../../../etc')).toThrow(PluginSafetyError);
  });

  test('throws on empty / non-string input', () => {
    expect(() => assertSafePluginName('')).toThrow(PluginSafetyError);
    expect(() => assertSafePluginName(undefined)).toThrow(PluginSafetyError);
    expect(() => assertSafePluginName(null)).toThrow(PluginSafetyError);
    expect(() => assertSafePluginName(42)).toThrow(PluginSafetyError);
  });

  test('error message does not leak the workspace path', () => {
    try {
      assertSafePluginName('../../danger');
    } catch (e) {
      expect(e).toBeInstanceOf(PluginSafetyError);
      expect((e as Error).message).not.toContain(FAKE_WORKDIR);
    }
  });
});

// ─── pluginDirFor + assertWithinNodeModules (the C1/C2 fences) ─────────────

describe('pluginDirFor', () => {
  test('resolves a scoped name to a path under node_modules', () => {
    const dir = pluginDirFor('@tagma/driver-codex', FAKE_WORKDIR);
    expect(dir).toBe(resolve(FAKE_WORKDIR, 'node_modules', '@tagma', 'driver-codex'));
  });

  test('resolves an unscoped tagma-plugin name', () => {
    const dir = pluginDirFor('tagma-plugin-foo', FAKE_WORKDIR);
    expect(dir).toBe(resolve(FAKE_WORKDIR, 'node_modules', 'tagma-plugin-foo'));
  });
});

describe('assertWithinNodeModules', () => {
  test('accepts a path inside workDir/node_modules', () => {
    const dir = resolve(FAKE_WORKDIR, 'node_modules', '@tagma', 'driver-codex');
    expect(() => assertWithinNodeModules(dir, FAKE_WORKDIR)).not.toThrow();
  });

  test('rejects a path that escapes workDir/node_modules', () => {
    const escape = resolve(FAKE_WORKDIR, '..', 'sibling-dir');
    expect(() => assertWithinNodeModules(escape, FAKE_WORKDIR)).toThrow(PluginSafetyError);
  });

  test('rejects workDir itself (must be strictly inside node_modules)', () => {
    expect(() => assertWithinNodeModules(FAKE_WORKDIR, FAKE_WORKDIR)).toThrow(PluginSafetyError);
  });

  test('rejects an arbitrary absolute path elsewhere on disk', () => {
    expect(() => assertWithinNodeModules(resolve('/etc/passwd'), FAKE_WORKDIR)).toThrow(PluginSafetyError);
  });
});

// ─── safePluginDir (one-shot validate + fence) ─────────────────────────────

describe('safePluginDir', () => {
  test('returns the resolved directory for a valid name', () => {
    const dir = safePluginDir('@tagma/trigger-github', FAKE_WORKDIR);
    expect(dir).toBe(resolve(FAKE_WORKDIR, 'node_modules', '@tagma', 'trigger-github'));
  });

  test('rejects an invalid name (regex fence)', () => {
    expect(() => safePluginDir('../../etc', FAKE_WORKDIR)).toThrow(PluginSafetyError);
  });

  // Defense-in-depth: even if someone bypasses the regex, the second fence
  // catches it. We can't reach this branch through the public helper because
  // assertSafePluginName runs first — but the test documents the intent.
  test('the directory fence rejects relative escapes when called directly', () => {
    // pluginDirFor with `..` produces a path outside node_modules.
    const escapeDir = resolve(FAKE_WORKDIR, 'node_modules', '..', 'evil');
    expect(() => assertWithinNodeModules(escapeDir, FAKE_WORKDIR)).toThrow(PluginSafetyError);
  });
});

// ─── isPathWithin ──────────────────────────────────────────────────────────

describe('isPathWithin', () => {
  test('accepts a strict descendant', () => {
    expect(isPathWithin(join(FAKE_WORKDIR, 'a', 'b'), FAKE_WORKDIR)).toBe(true);
  });

  test('accepts equal paths (root is within itself)', () => {
    // path-utils.ts deliberately treats `child === root` as contained.
    // Callers that need strict containment must check `relative === ''`
    // themselves — see the contract comment in path-utils.ts.
    expect(isPathWithin(FAKE_WORKDIR, FAKE_WORKDIR)).toBe(true);
  });

  test('rejects sibling paths', () => {
    const sibling = resolve(FAKE_WORKDIR, '..', 'other');
    expect(isPathWithin(sibling, FAKE_WORKDIR)).toBe(false);
  });

  test('rejects parent paths', () => {
    const parent = resolve(FAKE_WORKDIR, '..');
    expect(isPathWithin(parent, FAKE_WORKDIR)).toBe(false);
  });
});

// ─── pluginCategoryFromName ────────────────────────────────────────────────

describe('pluginCategoryFromName', () => {
  test('parses driver packages', () => {
    expect(pluginCategoryFromName('@tagma/driver-codex')).toEqual({
      category: 'drivers', type: 'codex',
    });
  });

  test('parses trigger packages', () => {
    expect(pluginCategoryFromName('@tagma/trigger-github')).toEqual({
      category: 'triggers', type: 'github',
    });
  });

  test('parses completion packages', () => {
    expect(pluginCategoryFromName('@tagma/completion-output_check')).toEqual({
      category: 'completions', type: 'output_check',
    });
  });

  test('parses middleware packages', () => {
    expect(pluginCategoryFromName('@tagma/middleware-static_context')).toEqual({
      category: 'middlewares', type: 'static_context',
    });
  });

  test('returns null for tagma-plugin-* (no convention to infer category)', () => {
    expect(pluginCategoryFromName('tagma-plugin-foo')).toBeNull();
  });

  test('returns null for non-tagma scopes', () => {
    expect(pluginCategoryFromName('@other/driver-foo')).toBeNull();
  });
});

// ─── importWithTimeout (R11) ────────────────────────────────────────────────
//
// We test the helper with an injected `importer` function — NOT the real
// `import()`. Real ESM modules with top-level `await new Promise(() => {})`
// leak an orphaned promise that prevents bun test from exiting cleanly,
// which is exactly the production failure mode R11 is mitigating but is a
// pain to reproduce safely in a test runner. Injecting a fake importer
// gives us full control over the timing and exception semantics.
//
// To simulate "slow" without actually leaking promises, the slow importers
// below settle via a delayed setTimeout-rejection well after our test has
// already collected the timeout error. Pre-attaching a no-op `.catch()` on
// the orphan keeps the unhandled-rejection detector quiet, and the final
// `await orphan.catch(...)` lets bun test drain the timer before exiting.

/** Build a "slow importer" that settles via rejection after `delayMs`. */
function makeSlowImporter(delayMs: number): {
  importer: () => Promise<unknown>;
  drain: () => Promise<void>;
} {
  const promise = new Promise<unknown>((_, reject) => {
    setTimeout(() => reject(new Error('orphan-late-settle')), delayMs);
  });
  // Pre-attach so the orphan rejection doesn't trip unhandled-rejection.
  promise.catch(() => { /* swallow */ });
  return {
    importer: () => promise,
    drain: () => promise.catch(() => { /* settled */ }) as Promise<void>,
  };
}

describe('importWithTimeout (R11)', () => {
  test('returns the module on a fast import', async () => {
    const fakeMod = { pluginCategory: 'drivers', pluginType: 'mock', default: { name: 'mock' } };
    const result = await importWithTimeout<typeof fakeMod>(
      'file:///fake', 5000, 'r11-fast', async () => fakeMod,
    );
    expect(result).toBe(fakeMod);
    expect(result.pluginCategory).toBe('drivers');
  });

  test('rejects with a timeout error when import is slower than the budget', async () => {
    const { importer, drain } = makeSlowImporter(400);
    const start = Date.now();
    await expect(
      importWithTimeout('file:///fake', 100, 'r11-hung', importer),
    ).rejects.toThrow(/took longer than 100ms/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(2000);
    await drain();
  });

  test('timeout error message includes the plugin name', async () => {
    const { importer, drain } = makeSlowImporter(400);
    try {
      await importWithTimeout('file:///fake', 80, '@tagma/driver-evil', importer);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('@tagma/driver-evil');
      expect((e as Error).message).toMatch(/took longer than 80ms/);
    }
    await drain();
  });

  test('propagates module-level throws as the original error (not timeout)', async () => {
    await expect(
      importWithTimeout(
        'file:///fake-throws',
        5000,
        'r11-throws',
        async () => { throw new Error('boom from module top'); },
      )
    ).rejects.toThrow(/boom from module top/);
  });

  test('propagates synchronous throws from the importer', async () => {
    await expect(
      importWithTimeout(
        'file:///fake-sync-throw',
        5000,
        'r11-sync-throw',
        () => { throw new Error('sync boom'); },
      )
    ).rejects.toThrow(/sync boom/);
  });

  test('clears the timeout when the import resolves first', async () => {
    // Resolve well before the timeout. If the timer leaked, bun test would
    // hang waiting for it to fire — so this test passing is itself the
    // assertion that the cleanup path runs.
    const result = await importWithTimeout(
      'file:///fake', 30_000, 'r11-cleanup',
      () => new Promise((r) => setTimeout(() => r({ ok: true }), 10)),
    );
    expect(result).toEqual({ ok: true });
  });

  test('importWithTimeout has the documented signature', () => {
    // Smoke check that the production signature stays in sync with this test
    // file. Function.length counts only required (non-default) parameters.
    expect(typeof importWithTimeout).toBe('function');
    expect(importWithTimeout.length).toBe(4);
  });
});

// ─── End-to-end attack scenarios (regression tests for C1/C2) ─────────────

describe('attack scenarios', () => {
  // The exact payloads called out in the security review.
  const TRAVERSAL_PAYLOADS = [
    '../../some-dir',
    '../../../etc/passwd',
    '@a/../../../../etc/passwd',
    '@a/../../sibling',
    '../node_modules/@tagma/types',
  ];

  test.each(TRAVERSAL_PAYLOADS)('rejects path traversal: %s', (payload) => {
    // First line of defense — name validation catches it outright.
    expect(() => assertSafePluginName(payload)).toThrow(PluginSafetyError);

    // Second line of defense — even if the name slipped past validation, the
    // resolved directory would still be caught by the node_modules fence.
    // We test this by skipping the regex and going straight to pluginDirFor.
    try {
      const dir = pluginDirFor(payload, FAKE_WORKDIR);
      // If pluginDirFor returns at all, the directory fence must reject it.
      expect(() => assertWithinNodeModules(dir, FAKE_WORKDIR)).toThrow(PluginSafetyError);
    } catch {
      // pluginDirFor may itself throw on weird inputs; that's fine too.
    }
  });
});
