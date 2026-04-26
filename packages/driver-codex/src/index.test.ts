import { describe, expect, test } from 'bun:test';
import plugin, { CodexDriver } from './index';
import manifest from '../package.json' with { type: 'json' };

describe('driver-codex plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('drivers');
    expect(manifest.tagmaPlugin.type).toBe('codex');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.drivers?.[manifest.tagmaPlugin.type]).toBe(CodexDriver);
  });

  test('capabilities exposes three boolean flags', () => {
    const driver = plugin.capabilities!.drivers!.codex;
    expect(typeof driver.capabilities.sessionResume).toBe('boolean');
    expect(typeof driver.capabilities.systemPrompt).toBe('boolean');
    expect(typeof driver.capabilities.outputFormat).toBe('boolean');
  });

  test('buildCommand is a function', () => {
    expect(typeof plugin.capabilities!.drivers!.codex.buildCommand).toBe('function');
  });

  test('buildCommand returns a SpawnSpec-shaped object (when codex is available)', async () => {
    const task = {
      id: 't1',
      name: 't1',
      prompt: 'hello',
      permissions: { read: true, write: false, execute: false },
    } as unknown as Parameters<typeof plugin.buildCommand>[0];
    const track = { id: 'k', name: 'k', tasks: [] } as unknown as Parameters<typeof plugin.buildCommand>[1];
    const ctx = { workDir: process.cwd(), normalizedMap: new Map(), sessionMap: new Map() } as unknown as Parameters<typeof plugin.buildCommand>[2];
    try {
      const spec = await CodexDriver.buildCommand(task, track, ctx);
      expect(Array.isArray(spec.args)).toBe(true);
    } catch (err) {
      // Acceptable: `codex` CLI not installed on this machine — preflight throws.
      expect(String(err)).toMatch(/codex/i);
    }
  });
});
