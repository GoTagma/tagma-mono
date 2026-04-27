import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginRegistry, InMemoryApprovalGateway } from '@tagma/core';
import { bunRuntime } from '@tagma/runtime-bun';
import { createTagma } from './index';

describe('Phase 6 package split', () => {
  test('sdk composes the core registry and bun runtime packages', () => {
    const runtime = bunRuntime();
    const tagma = createTagma({ runtime, builtins: false });

    expect(tagma.registry).toBeInstanceOf(PluginRegistry);
    expect(typeof runtime.runCommand).toBe('function');
    expect(new InMemoryApprovalGateway().pending()).toEqual([]);
  });

  test('sdk does not retain runtime/core compatibility source wrappers', () => {
    const sdkRoot = join(import.meta.dir, '..');
    for (const file of ['engine.ts', 'runtime.ts', 'runner.ts', 'logger.ts', 'types.ts']) {
      expect(existsSync(join(sdkRoot, file))).toBe(false);
    }
    expect(existsSync(join(sdkRoot, 'runtime', 'bun-process-runner.ts'))).toBe(false);

    const pkg = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(pkg.exports['./runner']).toBeUndefined();
    expect(pkg.exports['./pipeline-runner']).toBeDefined();
    expect(pkg.exports['./logger']).toBeUndefined();
    expect(pkg.exports['./runtime/adapters/stdin-approval']).toBeUndefined();
    expect(pkg.exports['./runtime/adapters/websocket-approval']).toBeUndefined();
  });
});
