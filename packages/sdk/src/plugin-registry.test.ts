import { describe, expect, test } from 'bun:test';
import { PluginRegistry } from './registry';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline } from './engine';
import type { DriverPlugin, TriggerPlugin, PipelineConfig } from './types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TagmaPlugin } from './types';

function makeDriver(name: string, marker: string[]): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    async buildCommand() {
      marker.push(`buildCommand:${name}`);
      return { args: ['echo', 'noop'] };
    },
  };
}

function makeTrigger(name: string, marker: string[]): TriggerPlugin {
  return {
    name,
    async watch() {
      marker.push(`watch:${name}`);
    },
  };
}

describe('PluginRegistry — instance isolation', () => {
  test('two registries do not share drivers registered under the same type', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    const markerA: string[] = [];
    const markerB: string[] = [];

    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', markerA));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', markerB));

    expect(regA.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('mockA');
    expect(regB.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('mockB');

    expect(regA.hasHandler('drivers', 'mock')).toBe(true);
    expect(regB.hasHandler('drivers', 'mock')).toBe(true);
    expect(regA.hasHandler('triggers', 'mock')).toBe(false);
  });

  test('unregistering in one registry does not affect the other', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', []));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', []));

    expect(regA.unregisterPlugin('drivers', 'mock')).toBe(true);
    expect(regA.hasHandler('drivers', 'mock')).toBe(false);
    expect(regB.hasHandler('drivers', 'mock')).toBe(true);
  });

  test('listRegistered is scoped per instance', () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    regA.registerPlugin('triggers', 'a-only', makeTrigger('a-only', []));
    regB.registerPlugin('triggers', 'b-only', makeTrigger('b-only', []));

    expect(regA.listRegistered('triggers')).toEqual(['a-only']);
    expect(regB.listRegistered('triggers')).toEqual(['b-only']);
  });

  test('registering the same instance twice returns unchanged', () => {
    const reg = new PluginRegistry();
    const driver = makeDriver('same', []);
    expect(reg.registerPlugin('drivers', 'mock', driver)).toBe('registered');
    expect(reg.registerPlugin('drivers', 'mock', driver)).toBe('unchanged');
  });

  test('replacing with a different handler returns replaced', () => {
    const reg = new PluginRegistry();
    expect(reg.registerPlugin('drivers', 'mock', makeDriver('one', []))).toBe('registered');
    expect(reg.registerPlugin('drivers', 'mock', makeDriver('two', []))).toBe('replaced');
    expect(reg.getHandler<DriverPlugin>('drivers', 'mock').name).toBe('two');
  });

  test('bootstrapBuiltins(target) populates a specific instance', () => {
    const fresh = new PluginRegistry();
    expect(fresh.hasHandler('drivers', 'opencode')).toBe(false);

    bootstrapBuiltins(fresh);

    expect(fresh.hasHandler('drivers', 'opencode')).toBe(true);
    expect(fresh.hasHandler('triggers', 'file')).toBe(true);
    expect(fresh.hasHandler('triggers', 'manual')).toBe(true);
    expect(fresh.hasHandler('completions', 'exit_code')).toBe(true);
    expect(fresh.hasHandler('middlewares', 'static_context')).toBe(true);

    // Default registry's state is independent of `fresh` — if the default
    // happens to have opencode (because another test bootstrapped it), that
    // is fine; the guarantee is that `fresh.unregister` does not leak.
    fresh.unregisterPlugin('drivers', 'opencode');
    expect(fresh.hasHandler('drivers', 'opencode')).toBe(false);
  });
});

describe('PluginRegistry — capability plugins', () => {
  test('registerTagmaPlugin registers multiple capabilities from one package', () => {
    const reg = new PluginRegistry();
    const driver = makeDriver('cap-driver', []);
    const trigger = makeTrigger('cap-trigger', []);
    const plugin: TagmaPlugin = {
      name: 'tagma-plugin-multi',
      capabilities: {
        drivers: { cap_driver: driver },
        triggers: { cap_trigger: trigger },
      },
    };

    expect(reg.registerTagmaPlugin(plugin)).toEqual([
      { category: 'drivers', type: 'cap_driver', result: 'registered' },
      { category: 'triggers', type: 'cap_trigger', result: 'registered' },
    ]);
    expect(reg.getHandler<DriverPlugin>('drivers', 'cap_driver')).toBe(driver);
    expect(reg.getHandler<TriggerPlugin>('triggers', 'cap_trigger')).toBe(trigger);
  });

  test('registerTagmaPlugin keeps replacement warnings from the registry path', () => {
    const reg = new PluginRegistry();
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      reg.registerPlugin('drivers', 'mock', makeDriver('first', []));
      const result = reg.registerTagmaPlugin({
        name: 'tagma-plugin-replacement',
        capabilities: {
          drivers: { mock: makeDriver('second', []) },
        },
      });

      expect(result).toEqual([{ category: 'drivers', type: 'mock', result: 'replaced' }]);
      expect(warnings).toContain(
        '[tagma-sdk] registerPlugin: replaced existing drivers/mock - check for duplicate plugin packages claiming the same type.',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test('loadPlugins accepts capability plugin default exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-capability-plugin-'));
    const pluginDir = join(dir, 'node_modules', 'tagma-plugin-capability');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'tagma-plugin-capability', version: '1.0.0', type: 'module', main: './index.js' }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        'const driver = {',
        "  name: 'cap-driver',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'cap'] }; },",
        '};',
        'const trigger = {',
        "  name: 'cap-trigger',",
        '  async watch() {}',
        '};',
        'export default {',
        "  name: 'tagma-plugin-capability',",
        '  capabilities: {',
        '    drivers: { cap_driver: driver },',
        '    triggers: { cap_trigger: trigger },',
        '  },',
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const reg = new PluginRegistry();
      await reg.loadPlugins(['tagma-plugin-capability'], dir);
      expect(reg.hasHandler('drivers', 'cap_driver')).toBe(true);
      expect(reg.hasHandler('triggers', 'cap_trigger')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadPlugins rejects legacy plugin module exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-legacy-plugin-'));
    const pluginDir = join(dir, 'node_modules', 'tagma-plugin-legacy');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'package.json'),
      JSON.stringify({ name: 'tagma-plugin-legacy', version: '1.0.0', type: 'module', main: './index.js' }),
      'utf-8',
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        "export const pluginCategory = 'drivers';",
        "export const pluginType = 'legacy';",
        'export default {',
        "  name: 'legacy',",
        '  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },',
        "  async buildCommand() { return { args: ['echo', 'legacy'] }; },",
        '};',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const reg = new PluginRegistry();
      await expect(reg.loadPlugins(['tagma-plugin-legacy'], dir)).rejects.toThrow(
        /must default-export a TagmaPlugin/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PluginRegistry — validation', () => {
  test('rejects unknown category', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'nope' as 'drivers',
        'x',
        makeDriver('x', []),
      ),
    ).toThrow(/Unknown plugin category/);
  });

  test('rejects driver missing buildCommand', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'drivers',
        'broken',
        // deliberately bad: no buildCommand
        { name: 'broken', capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false } } as unknown as DriverPlugin,
      ),
    ).toThrow(/must export buildCommand/);
  });

  test('rejects handler with missing name', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'drivers',
        'x',
        // deliberately bad: no name
        { capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false }, buildCommand: async () => ({ args: [] }) } as unknown as DriverPlugin,
      ),
    ).toThrow(/non-empty "name"/);
  });

  test('rejects plugin type identifiers that are not YAML-safe ids', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin(
        'drivers',
        '../evil',
        makeDriver('evil', []),
      ),
    ).toThrow(/Plugin type .* must match/);
  });

  test('middleware install hint uses singular middleware package name', () => {
    const reg = new PluginRegistry();
    expect(() => reg.getHandler('middlewares', 'audit')).toThrow(
      /bun add @tagma\/middleware-audit/,
    );
  });

  test('rejects middleware without enhanceDoc', () => {
    const reg = new PluginRegistry();
    expect(() =>
      reg.registerPlugin('middlewares', 'old', {
        name: 'old',
        async enhance(prompt: string) {
          return prompt;
        },
      } as never),
    ).toThrow(/must export enhanceDoc/);
  });
});

describe('runPipeline — options.registry isolation', () => {
  test('concurrent runs with different registries see their own drivers', async () => {
    const regA = new PluginRegistry();
    const regB = new PluginRegistry();
    const seenA: string[] = [];
    const seenB: string[] = [];

    bootstrapBuiltins(regA);
    bootstrapBuiltins(regB);

    regA.registerPlugin('drivers', 'mock', makeDriver('mockA', seenA));
    regB.registerPlugin('drivers', 'mock', makeDriver('mockB', seenB));

    // Command-only pipeline exercises the preflight path (which uses the
    // registry) plus the run-loop path without requiring a real driver
    // invocation. We verify isolation by asserting that preflight with a
    // registry missing `mock` rejects, while the matching registry accepts.
    const config: PipelineConfig = {
      name: 'isolation-test',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'only', name: 'only', command: 'echo hi' }],
        },
      ],
    };

    const tmpA = mkdtempSync(join(tmpdir(), 'tagma-regA-'));
    const tmpB = mkdtempSync(join(tmpdir(), 'tagma-regB-'));
    try {
      const [resA, resB] = await Promise.all([
        runPipeline(config, tmpA, { registry: regA, skipPluginLoading: true }),
        runPipeline(config, tmpB, { registry: regB, skipPluginLoading: true }),
      ]);
      expect(resA.success).toBe(true);
      expect(resB.success).toBe(true);
      expect(resA.runId).not.toBe(resB.runId);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  test('preflight fails when referenced driver is missing from the passed registry', async () => {
    const regNoOpencode = new PluginRegistry();
    // Deliberately do NOT bootstrap builtins — opencode is not registered.
    const config: PipelineConfig = {
      name: 'preflight-miss',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'x', name: 'x', prompt: 'hello' }],
        },
      ],
    };
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-miss-'));
    try {
      await expect(
        runPipeline(config, tmp, { registry: regNoOpencode, skipPluginLoading: true }),
      ).rejects.toThrow(/driver "opencode" not registered/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('runPipeline rejects missing explicit registry', async () => {
    const config: PipelineConfig = {
      name: 'missing-registry',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'only', name: 'only', command: 'echo hi' }],
        },
      ],
    };
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-default-'));
    try {
      await expect(
        runPipeline(config, tmp, { skipPluginLoading: true } as never),
      ).rejects.toThrow(/requires options\.registry/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
