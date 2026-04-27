import { describe, expect, test } from 'bun:test';
import { OpenCodeDriver } from './opencode';

function task(model?: string): Parameters<typeof OpenCodeDriver.buildCommand>[0] {
  return {
    id: 't1',
    name: 't1',
    prompt: 'hello',
    ...(model ? { model } : {}),
  } as Parameters<typeof OpenCodeDriver.buildCommand>[0];
}

const track = {
  id: 'k',
  name: 'k',
  tasks: [],
} as unknown as Parameters<typeof OpenCodeDriver.buildCommand>[1];

const ctx = {
  workDir: process.cwd(),
  normalizedMap: new Map(),
  sessionMap: new Map(),
} as unknown as Parameters<typeof OpenCodeDriver.buildCommand>[2];

describe('OpenCodeDriver buildCommand', () => {
  test('does not probe the opencode binary when a model is explicit', async () => {
    const original = Bun.spawn;
    let called = false;
    Bun.spawn = (() => {
      called = true;
      throw new Error('probe should not run');
    }) as typeof Bun.spawn;

    try {
      const spec = await OpenCodeDriver.buildCommand(task('opencode/test-model'), track, ctx);
      expect(spec.args.slice(0, 4)).toEqual(['opencode', 'run', '--model', 'opencode/test-model']);
      expect(called).toBe(false);
    } finally {
      Bun.spawn = original;
    }
  });

  test('uses the static default model without running opencode models', async () => {
    const original = Bun.spawn;
    let called = false;
    Bun.spawn = (() => {
      called = true;
      throw new Error('probe should not run');
    }) as typeof Bun.spawn;

    try {
      const spec = await OpenCodeDriver.buildCommand(task(), track, ctx);
      expect(spec.args.slice(0, 4)).toEqual(['opencode', 'run', '--model', 'opencode/big-pickle']);
      expect(called).toBe(false);
    } finally {
      Bun.spawn = original;
    }
  });
});
