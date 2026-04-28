import { describe, expect, test } from 'bun:test';
import { OpenCodeDriver } from './opencode';

type BuildTask = Parameters<typeof OpenCodeDriver.buildCommand>[0];

function task(overrides: Partial<BuildTask> = {}): BuildTask {
  return {
    id: 't1',
    name: 't1',
    prompt: 'hello',
    ...overrides,
  } as BuildTask;
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
  sessionDriverMap: new Map(),
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
      const spec = await OpenCodeDriver.buildCommand(
        task({ model: 'opencode/test-model' }),
        track,
        ctx,
      );
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

  test('passes provider-specific reasoning variants through to opencode', async () => {
    const spec = await OpenCodeDriver.buildCommand(task({ reasoning_effort: 'max' }), track, ctx);

    const variantIndex = spec.args.indexOf('--variant');
    expect(variantIndex).toBeGreaterThan(-1);
    expect(spec.args[variantIndex + 1]).toBe('max');
  });

  test('does not resume sessions created by another driver', async () => {
    const crossDriverCtx = {
      ...ctx,
      sessionMap: new Map([['t.up', 'foreign-session']]),
      sessionDriverMap: new Map([['t.up', 'claude-code']]),
      normalizedMap: new Map([['t.up', 'previous text']]),
    } as unknown as Parameters<typeof OpenCodeDriver.buildCommand>[2];

    const spec = await OpenCodeDriver.buildCommand(
      task({ continue_from: 't.up' }),
      track,
      crossDriverCtx,
    );

    expect(spec.args).not.toContain('--session');
    expect(spec.args.at(-1)).toContain('[Previous Output]');
    expect(spec.args.at(-1)).toContain('previous text');
  });
});
