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
  test('runs default restricted tasks with a task-scoped allowlist policy', async () => {
    const spec = await OpenCodeDriver.buildCommand(task(), track, ctx);

    const agentIndex = spec.args.indexOf('--agent');
    expect(agentIndex).toBeGreaterThan(-1);
    const agentName = spec.args[agentIndex + 1];
    expect(agentName).toMatch(/^tagma-pipeline-task-[0-9a-f]{32}$/);
    const permission = JSON.parse(spec.env?.OPENCODE_PERMISSION ?? '{}');
    expect(permission).toEqual({
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      skill: 'allow',
      task: 'deny',
      external_directory: 'deny',
    });
    expect(permission.webfetch).toBeUndefined();
    expect(permission.todowrite).toBeUndefined();
    expect(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      default_agent: agentName,
      agent: {
        [agentName]: {
          mode: 'primary',
          permission,
        },
      },
    });
  });

  test('sets a deterministic task title so transient runs do not call the title model', async () => {
    const spec = await OpenCodeDriver.buildCommand(task(), track, ctx);

    expect(spec.args[spec.args.indexOf('--title') + 1]).toBe('Tagma task k.t1');
  });

  test('uses a fresh restricted agent identity for every task invocation', async () => {
    const first = await OpenCodeDriver.buildCommand(task(), track, ctx);
    const second = await OpenCodeDriver.buildCommand(task(), track, ctx);

    const firstAgent = first.args[first.args.indexOf('--agent') + 1];
    const secondAgent = second.args[second.args.indexOf('--agent') + 1];
    expect(firstAgent).not.toBe(secondAgent);
  });

  test('denies every read-like OpenCode tool when task read access is disabled', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      task({ permissions: { read: false, write: false, execute: false } }),
      track,
      ctx,
    );

    expect(JSON.parse(spec.env?.OPENCODE_PERMISSION ?? '{}')).toEqual({
      '*': 'deny',
      task: 'deny',
      external_directory: 'deny',
    });
  });

  test('allows only the capability families enabled on a partially restricted task', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      task({ permissions: { read: false, write: true, execute: true } }),
      track,
      ctx,
    );

    expect(JSON.parse(spec.env?.OPENCODE_PERMISSION ?? '{}')).toEqual({
      '*': 'deny',
      edit: 'allow',
      bash: 'allow',
      task: 'deny',
      external_directory: 'deny',
    });
  });

  test('does not copy ambient OpenCode config or permissions past the runtime env policy', async () => {
    const originalConfig = process.env.OPENCODE_CONFIG_CONTENT;
    const originalPermission = process.env.OPENCODE_PERMISSION;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: 'provider/existing-model',
      plugin: ['ambient-plugin'],
      agent: {
        'tagma-pipeline-task': {
          mode: 'primary',
          permission: { bash: 'allow', edit: 'allow', task: 'allow' },
        },
      },
    });
    process.env.OPENCODE_PERMISSION = JSON.stringify({ webfetch: 'allow' });

    try {
      const spec = await OpenCodeDriver.buildCommand(task(), track, ctx);
      const agentName = spec.args[spec.args.indexOf('--agent') + 1];
      const config = JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
      expect(Object.keys(config).sort()).toEqual(['agent', 'default_agent']);
      expect(config.default_agent).toBe(agentName);
      expect(config.agent[agentName]).toMatchObject({
        mode: 'primary',
        permission: {
          '*': 'deny',
          read: 'allow',
          glob: 'allow',
          grep: 'allow',
          list: 'allow',
          lsp: 'allow',
          skill: 'allow',
          task: 'deny',
          external_directory: 'deny',
        },
      });
      expect(JSON.parse(spec.env?.OPENCODE_PERMISSION ?? '{}')).not.toHaveProperty('webfetch');
    } finally {
      if (originalConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = originalConfig;
      if (originalPermission === undefined) delete process.env.OPENCODE_PERMISSION;
      else process.env.OPENCODE_PERMISSION = originalPermission;
    }
  });

  test('keeps unrestricted tasks on the user-selected OpenCode agent', async () => {
    const spec = await OpenCodeDriver.buildCommand(
      task({ permissions: { read: true, write: true, execute: true } }),
      track,
      ctx,
    );

    expect(spec.args).not.toContain('--agent');
    expect(spec.env).toBeUndefined();
  });

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

  test('reapplies a fresh restricted agent when resuming a Tagma OpenCode session', async () => {
    const resumeCtx = {
      ...ctx,
      sessionMap: new Map([['k.up', 'tagma-session']]),
      sessionDriverMap: new Map([['k.up', 'opencode']]),
    } as unknown as Parameters<typeof OpenCodeDriver.buildCommand>[2];

    const spec = await OpenCodeDriver.buildCommand(
      task({ continue_from: 'k.up' }),
      track,
      resumeCtx,
    );

    expect(spec.args).toContain('--session');
    expect(spec.args[spec.args.indexOf('--session') + 1]).toBe('tagma-session');
    expect(spec.args).not.toContain('--title');
    expect(spec.args[spec.args.indexOf('--agent') + 1]).toMatch(
      /^tagma-pipeline-task-[0-9a-f]{32}$/,
    );
    expect(JSON.parse(spec.env?.OPENCODE_PERMISSION ?? '{}')).toMatchObject({
      '*': 'deny',
      task: 'deny',
      external_directory: 'deny',
    });
  });
});

describe('OpenCodeDriver parseResult', () => {
  test('extracts NDJSON session id and normalized text', () => {
    const meta = OpenCodeDriver.parseResult!(
      [
        '{"type":"step_start","sessionID":"sess-1"}',
        '{"type":"text","part":{"text":"hello"}}',
        '{"type":"text","part":{"text":"world"}}',
      ].join('\n'),
    );

    expect(meta).toEqual({
      sessionId: 'sess-1',
      normalizedOutput: 'hello\nworld',
    });
  });

  test('preserves session id from opencode error events while forcing failure', () => {
    const meta = OpenCodeDriver.parseResult!(
      '{"type":"error","sessionID":"sess-error","message":"rate limited"}',
    );

    expect(meta).toEqual({
      sessionId: 'sess-error',
      forceFailure: true,
      forceFailureReason: 'opencode reported error: rate limited',
    });
  });

  test('fails a zero-token indeterminate finish instead of treating lifecycle JSON as output', () => {
    const meta = OpenCodeDriver.parseResult!(
      [
        '{"type":"step_start","sessionID":"sess-empty"}',
        '{"type":"step_finish","sessionID":"sess-empty","part":{"reason":"unknown","tokens":{"input":0,"output":0,"reasoning":0}}}',
      ].join('\n'),
    );

    expect(meta).toEqual({
      sessionId: 'sess-empty',
      normalizedOutput: '',
      forceFailure: true,
      forceFailureReason:
        'opencode ended without a determinate model response (finish reason: unknown; input/output/reasoning tokens: 0/0/0)',
    });
  });

  test('fails truncated or filtered model finishes even when partial text exists', () => {
    for (const reason of ['length', 'content-filter', 'error']) {
      const meta = OpenCodeDriver.parseResult!(
        [
          '{"type":"text","sessionID":"sess-partial","part":{"text":"partial"}}',
          JSON.stringify({ type: 'step_finish', part: { reason } }),
        ].join('\n'),
      );
      expect(meta).toMatchObject({
        sessionId: 'sess-partial',
        normalizedOutput: 'partial',
        forceFailure: true,
        forceFailureReason: `opencode model response did not complete normally (finish reason: ${reason})`,
      });
    }
  });
});
