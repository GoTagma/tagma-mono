import { describe, expect, test } from 'bun:test';
import plugin, { ClaudeCodeDriver } from './index';
import manifest from '../package.json' with { type: 'json' };

describe('driver-claude-code plugin shape', () => {
  test('default export is a capability plugin matching package manifest', () => {
    expect(manifest.tagmaPlugin.category).toBe('drivers');
    expect(manifest.tagmaPlugin.type).toBe('claude-code');
    expect(plugin.name).toBe(manifest.name);
    expect(plugin.capabilities?.drivers?.[manifest.tagmaPlugin.type]).toBe(ClaudeCodeDriver);
  });

  test('capabilities exposes three boolean flags', () => {
    const driver = plugin.capabilities!.drivers!['claude-code'];
    expect(typeof driver.capabilities.sessionResume).toBe('boolean');
    expect(typeof driver.capabilities.systemPrompt).toBe('boolean');
    expect(typeof driver.capabilities.outputFormat).toBe('boolean');
  });

  test('buildCommand is a function', () => {
    expect(typeof plugin.capabilities!.drivers!['claude-code'].buildCommand).toBe('function');
  });

  test('buildCommand returns a SpawnSpec-shaped object', async () => {
    const task = {
      id: 't1',
      name: 't1',
      prompt: 'hello',
      permissions: { read: true, write: false, execute: false },
    } as unknown as Parameters<typeof plugin.buildCommand>[0];
    const track = { id: 'k', name: 'k', tasks: [] } as unknown as Parameters<
      typeof plugin.buildCommand
    >[1];
    const ctx = {
      workDir: process.cwd(),
      normalizedMap: new Map(),
      sessionMap: new Map(),
      sessionDriverMap: new Map(),
    } as unknown as Parameters<typeof plugin.buildCommand>[2];
    try {
      const spec = await ClaudeCodeDriver.buildCommand(task, track, ctx);
      expect(Array.isArray(spec.args)).toBe(true);
    } catch (err) {
      expect(String(err)).toMatch(/claude/i);
    }
  });

  test('passes an existing CLAUDE_CODE_GIT_BASH_PATH through to the child env on Windows', async () => {
    if (process.platform !== 'win32') return;

    const previous = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    process.env.CLAUDE_CODE_GIT_BASH_PATH = process.execPath;

    const task = {
      id: 't1',
      name: 't1',
      prompt: 'hello',
      permissions: { read: true, write: false, execute: false },
    } as unknown as Parameters<typeof plugin.buildCommand>[0];
    const track = { id: 'k', name: 'k', tasks: [] } as unknown as Parameters<
      typeof plugin.buildCommand
    >[1];
    const ctx = {
      workDir: process.cwd(),
      normalizedMap: new Map(),
      sessionMap: new Map(),
      sessionDriverMap: new Map(),
    } as unknown as Parameters<typeof plugin.buildCommand>[2];

    try {
      const spec = await ClaudeCodeDriver.buildCommand(task, track, ctx);
      expect(spec.env?.CLAUDE_CODE_GIT_BASH_PATH).toBe(process.execPath);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      else process.env.CLAUDE_CODE_GIT_BASH_PATH = previous;
    }
  });

  test('falls back to normalized text for sessions created by another driver', async () => {
    const task = {
      id: 't1',
      name: 't1',
      prompt: 'hello',
      continue_from: 't.up',
      permissions: { read: true, write: false, execute: false },
    } as unknown as Parameters<typeof plugin.buildCommand>[0];
    const track = { id: 'k', name: 'k', tasks: [] } as unknown as Parameters<
      typeof plugin.buildCommand
    >[1];
    const ctx = {
      workDir: process.cwd(),
      normalizedMap: new Map([['t.up', 'previous text']]),
      sessionMap: new Map([['t.up', 'foreign-session']]),
      sessionDriverMap: new Map([['t.up', 'opencode']]),
    } as unknown as Parameters<typeof plugin.buildCommand>[2];

    const spec = await ClaudeCodeDriver.buildCommand(task, track, ctx);

    expect(spec.args).not.toContain('--resume');
    expect(spec.stdin).toContain('[Previous Output]');
    expect(spec.stdin).toContain('previous text');
  });
});
