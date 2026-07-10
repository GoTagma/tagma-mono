import { describe, expect, test } from 'bun:test';
import type { TaskInputBindings, TaskOutputBindings, TaskPorts } from './types';
import {
  extractTaskBindingOutputs,
  extractTaskOutputs,
  resolveTaskBindingInputs,
  resolveTaskInputs,
  substituteInputs,
} from './ports';

function recordWithProtoKey(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ['__proto__']: value })) as Record<string, unknown>;
}

describe('dataflow records use own properties', () => {
  test('template substitution does not read inherited Object prototype fields', () => {
    const result = substituteInputs(
      '{{inputs.constructor}}/{{inputs.toString}}/{{inputs.__proto__}}',
      {},
    );

    expect(result.text).toBe('//');
    expect([...result.unresolved].sort()).toEqual(['__proto__', 'constructor', 'toString']);
  });

  test('binding inputs do not read inherited Object prototype fields', () => {
    const inputs: TaskInputBindings = {
      constructor: { required: true },
      payload: { from: 't.up.outputs.__proto__', required: true },
    };
    const upstream = new Map([
      [
        't.up',
        {
          outputs: {},
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);

    const result = resolveTaskBindingInputs({ inputs }, upstream, ['t.up']);

    expect(result.kind).toBe('blocked');
    if (result.kind !== 'blocked') return;
    expect(result.missingRequired).toEqual(['constructor', 'payload']);
  });

  test('legacy port inputs preserve an own __proto__ field', () => {
    const ports: TaskPorts = {
      inputs: [{ name: '__proto__', type: 'json', required: true }],
    };
    const upstream = new Map([['t.up', recordWithProtoKey({ safe: true })]]);

    const result = resolveTaskInputs({ ports }, upstream, ['t.up']);

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(Object.hasOwn(result.inputs, '__proto__')).toBe(true);
    expect(result.inputs.__proto__).toEqual({ safe: true });
  });

  test('binding output extraction preserves an own __proto__ field', () => {
    const bindings = recordWithProtoKey({
      from: 'json.__proto__',
      type: 'json',
    }) as TaskOutputBindings;

    const result = extractTaskBindingOutputs(
      bindings,
      JSON.stringify(recordWithProtoKey({ safe: true })),
      '',
      null,
    );

    expect(result.diagnostic).toBeNull();
    expect(Object.hasOwn(result.outputs, '__proto__')).toBe(true);
    expect(result.outputs.__proto__).toEqual({ safe: true });
  });

  test('legacy output extraction preserves an own __proto__ field', () => {
    const ports: TaskPorts = {
      outputs: [{ name: '__proto__', type: 'json' }],
    };

    const result = extractTaskOutputs(
      ports,
      JSON.stringify(recordWithProtoKey({ safe: true })),
      null,
    );

    expect(result.diagnostic).toBeNull();
    expect(Object.hasOwn(result.outputs, '__proto__')).toBe(true);
    expect(result.outputs.__proto__).toEqual({ safe: true });
  });
});
