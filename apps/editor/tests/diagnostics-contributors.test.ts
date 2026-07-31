import { describe, expect, test } from 'bun:test';

import { createDiagnosticsContributorRegistry } from '../shared/diagnostics-contributors.js';
import {
  collectRendererDiagnosticsContributors,
  registerRendererDiagnosticsContributor,
} from '../src/diagnostics/renderer-diagnostics-contributors.js';
import {
  collectServerDiagnosticsContributors,
  registerServerDiagnosticsContributor,
} from '../server/diagnostics-contributors.js';

describe('diagnostics contributor registry', () => {
  test('is lazy, bounded, sanitized, and isolates contributor failures', () => {
    const registry = createDiagnosticsContributorRegistry<{ workspace: string }>();
    let calls = 0;
    registry.register('feature.chat', (context) => {
      calls += 1;
      return {
        workspace: context.workspace,
        accessToken: 'must-not-leak',
        values: Array.from({ length: 150 }, (_, index) => index),
      };
    });
    registry.register('feature.broken', () => {
      throw new Error('snapshot failed');
    });

    expect(calls).toBe(0);
    const snapshot = registry.collect({ workspace: 'D:\\repo' });

    expect(calls).toBe(1);
    expect(snapshot['feature.chat']).toMatchObject({
      workspace: 'D:\\repo',
      accessToken: '[REDACTED]',
    });
    expect((snapshot['feature.chat'] as { values: unknown[] }).values).toHaveLength(101);
    expect(snapshot['feature.broken']).toMatchObject({
      error: { name: 'Error', message: 'snapshot failed' },
    });
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak');
  });

  test('supports replacement and ownership-safe unregister without affecting app state', () => {
    const registry = createDiagnosticsContributorRegistry<void>();
    const unregisterOld = registry.register('feature.runtime', () => ({ version: 1 }));
    const unregisterNew = registry.register('feature.runtime', () => ({ version: 2 }));

    unregisterOld();
    expect(registry.collect(undefined)).toEqual({
      'feature.runtime': { version: 2 },
    });

    unregisterNew();
    expect(registry.collect(undefined)).toEqual({});
  });

  test('ignores invalid ids instead of throwing on a normal feature startup path', () => {
    const registry = createDiagnosticsContributorRegistry<void>();

    expect(() => registry.register('', () => ({ should: 'not-register' }))).not.toThrow();
    expect(registry.collect(undefined)).toEqual({});
  });

  test('provides stable renderer and server extension points for future features', () => {
    const removeRenderer = registerRendererDiagnosticsContributor(
      'future.renderer-feature',
      ({ workspaceKey }) => ({ workspaceKey, state: 'ready' }),
    );
    const removeServer = registerServerDiagnosticsContributor(
      'future.server-feature',
      ({ workspaceKey }) => ({ workspaceKey, queueDepth: 2 }),
    );
    try {
      expect(
        collectRendererDiagnosticsContributors({
          workspaceKey: 'D:\\repo',
          capturedAt: 123,
        }),
      ).toMatchObject({
        'future.renderer-feature': { workspaceKey: 'D:\\repo', state: 'ready' },
      });
      expect(
        collectServerDiagnosticsContributors({
          workspaceKey: 'D:\\repo',
          workspace: null,
        }),
      ).toMatchObject({
        'future.server-feature': { workspaceKey: 'D:\\repo', queueDepth: 2 },
      });
    } finally {
      removeRenderer();
      removeServer();
    }
  });
});
