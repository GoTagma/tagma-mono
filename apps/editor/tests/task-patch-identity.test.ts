import { describe, expect, test } from 'bun:test';
import type { RawTaskConfig } from '@tagma/sdk';
import { mergeTaskPatch } from '../server/state.js';

// Regression lock for the "node type silently flips" bug:
// creating a Command Task (which starts with `command: ''` as a placeholder
// until the user fills it in) and then editing ANY unrelated field — bindings,
// name, timeout — must not drop the empty command field, because the client
// uses the shared command-presence classifier for Command-vs-Prompt mode.

describe('mergeTaskPatch — task type identity invariant', () => {
  test('empty Command Task keeps command when inputs are added', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: '' };
    const out = mergeTaskPatch(existing, {
      inputs: { input: { type: 'string', required: true } },
    });
    expect(out.command).toBe('');
    expect(out.prompt).toBeUndefined();
  });

  test('empty Command Task keeps command when name is edited', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: '' };
    const out = mergeTaskPatch(existing, { name: 'renamed' });
    expect(out.command).toBe('');
    expect(out.name).toBe('renamed');
    expect(out.prompt).toBeUndefined();
  });

  test('empty Prompt Task keeps prompt when unrelated field edited', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', prompt: '' };
    const out = mergeTaskPatch(existing, { timeout: '30s' });
    expect(out.prompt).toBe('');
    expect(out.timeout).toBe('30s');
    expect(out.command).toBeUndefined();
  });

  test('Command Task with content keeps command intact on unrelated edit', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: 'ls -la' };
    const out = mergeTaskPatch(existing, { cwd: './sub' });
    expect(out.command).toBe('ls -la');
    expect(out.cwd).toBe('./sub');
  });

  test('explicit prompt in patch switches the task from Command to Prompt', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: 'ls' };
    const out = mergeTaskPatch(existing, { prompt: 'say hi' });
    expect(out.prompt).toBe('say hi');
    expect(out.command).toBeUndefined();
  });

  test('explicit command in patch switches the task from Prompt to Command', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', prompt: 'p' };
    const out = mergeTaskPatch(existing, { command: 'ls' });
    expect(out.command).toBe('ls');
    expect(out.prompt).toBeUndefined();
  });

  test('clearing command to empty string keeps it a Command Task', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: 'ls' };
    const out = mergeTaskPatch(existing, { command: '' });
    expect(out.command).toBe('');
    expect(out.prompt).toBeUndefined();
  });

  test('clearing prompt to empty string keeps it a Prompt Task', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', prompt: 'hi' };
    const out = mergeTaskPatch(existing, { prompt: '' });
    expect(out.prompt).toBe('');
    expect(out.command).toBeUndefined();
  });

  test('still strips other empty optional fields so they stay out of YAML', () => {
    const existing: RawTaskConfig = { id: 't1', name: 'T1', command: 'ls', cwd: './x' };
    const out = mergeTaskPatch(existing, { cwd: '' });
    // command (type identity) must survive; cwd (optional) must be stripped.
    expect(out.command).toBe('ls');
    expect('cwd' in out).toBe(false);
  });
});
