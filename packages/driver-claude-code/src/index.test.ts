import { describe, expect, test } from 'bun:test';
import plugin from './index';
import manifest from '../package.json' with { type: 'json' };

describe('driver-claude-code plugin shape', () => {
  test('manifest declares drivers/claude-code and matches plugin.name', () => {
    expect(manifest.tagmaPlugin.category).toBe('drivers');
    expect(manifest.tagmaPlugin.type).toBe('claude-code');
    expect(plugin.name).toBe(manifest.tagmaPlugin.type);
  });

  test('capabilities exposes three boolean flags', () => {
    expect(typeof plugin.capabilities.sessionResume).toBe('boolean');
    expect(typeof plugin.capabilities.systemPrompt).toBe('boolean');
    expect(typeof plugin.capabilities.outputFormat).toBe('boolean');
  });

  test('buildCommand is a function', () => {
    expect(typeof plugin.buildCommand).toBe('function');
  });

  test('buildCommand returns a SpawnSpec-shaped object', async () => {
    const task = {
      id: 't1',
      name: 't1',
      prompt: 'hello',
      permissions: { read: true, write: false, execute: false },
    } as unknown as Parameters<typeof plugin.buildCommand>[0];
    const track = { id: 'k', name: 'k', tasks: [] } as unknown as Parameters<typeof plugin.buildCommand>[1];
    const ctx = { workDir: process.cwd(), normalizedMap: new Map(), sessionMap: new Map() } as unknown as Parameters<typeof plugin.buildCommand>[2];
    try {
      const spec = await plugin.buildCommand(task, track, ctx);
      expect(Array.isArray(spec.args)).toBe(true);
    } catch (err) {
      expect(String(err)).toMatch(/claude/i);
    }
  });
});
