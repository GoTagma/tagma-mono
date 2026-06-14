import { describe, expect, test } from 'bun:test';
import type { DriverPlugin, MiddlewarePlugin } from './types';
import { PluginRegistry, readPluginManifest, validatePluginConfig } from './registry';

function driver(name: string): DriverPlugin {
  return {
    name,
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    buildCommand() {
      return { args: ['echo', name] };
    },
  };
}

function middleware(name: string): MiddlewarePlugin {
  return {
    name,
    enhanceDoc(doc) {
      return doc;
    },
  };
}

describe('readPluginManifest', () => {
  test('preserves trimmed editor and desktop version gates', () => {
    expect(
      readPluginManifest({
        tagmaPlugin: {
          category: 'drivers',
          type: 'opencode',
          minEditorVersion: ' 0.2.0 ',
          minDesktopVersion: ' 0.5.17 ',
        },
      }),
    ).toEqual({
      category: 'drivers',
      type: 'opencode',
      minEditorVersion: '0.2.0',
      minDesktopVersion: '0.5.17',
    });
  });

  test('rejects empty optional version gates', () => {
    expect(() =>
      readPluginManifest({
        tagmaPlugin: {
          category: 'drivers',
          type: 'opencode',
          minDesktopVersion: ' ',
        },
      }),
    ).toThrow(/minDesktopVersion must be a non-empty string/);
  });
});

describe('validatePluginConfig', () => {
  test('validates command fields used by command-backed plugins', () => {
    const schema = {
      fields: {
        check: { type: 'command' as const, required: true },
      },
    };

    expect(validatePluginConfig(schema, { type: 'x', check: 'grep PASS' }, 'completion')).toEqual(
      [],
    );
    expect(
      validatePluginConfig(schema, { type: 'x', check: { argv: ['grep', 'PASS'] } }, 'completion'),
    ).toEqual([]);
    expect(
      validatePluginConfig(schema, { type: 'x', check: { shell: 'grep PASS' } }, 'completion'),
    ).toEqual([]);
  });

  test('rejects malformed command fields before runtime execution', () => {
    const schema = {
      fields: {
        check: { type: 'command' as const, required: true },
      },
    };

    expect(validatePluginConfig(schema, { type: 'x' }, 'completion')).toContain(
      'completion.check is required',
    );
    expect(validatePluginConfig(schema, { type: 'x', check: 42 }, 'completion')).toContain(
      'completion.check must be a non-empty shell string, { shell: string }, or { argv: string[] }',
    );
    expect(validatePluginConfig(schema, { type: 'x', check: '' }, 'completion')).toContain(
      'completion.check shell string must not be empty',
    );
    expect(
      validatePluginConfig(schema, { type: 'x', check: { argv: [] } }, 'completion'),
    ).toContain('completion.check.argv must contain at least one argument');
    expect(
      validatePluginConfig(schema, { type: 'x', check: { shell: 'x', argv: ['x'] } }, 'completion'),
    ).toContain(
      'completion.check must be a non-empty shell string, { shell: string }, or { argv: string[] }',
    );
  });
});

describe('PluginRegistry', () => {
  test('registerTagmaPlugin validates all capabilities before mutating the registry', () => {
    const registry = new PluginRegistry();
    const valid = driver('valid-driver');

    expect(() =>
      registry.registerTagmaPlugin({
        name: '@scope/mixed-plugin',
        capabilities: {
          drivers: { valid },
          middlewares: { broken: { name: 'broken-middleware' } as MiddlewarePlugin },
        },
      }),
    ).toThrow(/middlewares plugin "broken-middleware" must export enhanceDoc/);

    expect(registry.hasHandler('drivers', 'valid')).toBe(false);
  });

  test('registerTagmaPlugin reports replaced and unchanged capability results', () => {
    const registry = new PluginRegistry();
    const first = driver('first-driver');
    const second = driver('second-driver');

    expect(
      registry.registerTagmaPlugin({
        name: '@scope/driver-plugin',
        capabilities: { drivers: { test: first } },
      }),
    ).toEqual([{ category: 'drivers', type: 'test', result: 'registered' }]);
    expect(
      registry.registerTagmaPlugin({
        name: '@scope/driver-plugin',
        capabilities: { drivers: { test: first } },
      }),
    ).toEqual([{ category: 'drivers', type: 'test', result: 'unchanged' }]);
    expect(
      registry.registerTagmaPlugin(
        {
          name: '@scope/driver-plugin',
          capabilities: { drivers: { test: second } },
        },
        { replace: true },
      ),
    ).toEqual([{ category: 'drivers', type: 'test', result: 'replaced' }]);
    expect(registry.getHandler<DriverPlugin>('drivers', 'test')).toBe(second);
  });

  test('registerTagmaPlugin handles multiple capability categories together', () => {
    const registry = new PluginRegistry();
    const d = driver('driver');
    const m = middleware('middleware');

    expect(
      registry.registerTagmaPlugin({
        name: '@scope/multi-plugin',
        capabilities: {
          drivers: { d },
          middlewares: { m },
        },
      }),
    ).toEqual([
      { category: 'drivers', type: 'd', result: 'registered' },
      { category: 'middlewares', type: 'm', result: 'registered' },
    ]);
    expect(registry.getHandler<DriverPlugin>('drivers', 'd')).toBe(d);
    expect(registry.getHandler<MiddlewarePlugin>('middlewares', 'm')).toBe(m);
  });
});
