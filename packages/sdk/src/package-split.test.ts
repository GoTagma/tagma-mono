import { describe, expect, test } from 'bun:test';
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
});
