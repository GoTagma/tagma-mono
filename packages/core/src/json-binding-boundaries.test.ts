import { describe, expect, test } from 'bun:test';
import { extractTaskBindingOutputs, resolveTaskBindingInputs } from './ports';

describe('json binding boundaries', () => {
  test('json input bindings preserve an explicit null literal', () => {
    const result = resolveTaskBindingInputs(
      { inputs: { payload: { value: null, type: 'json', required: true } } },
      new Map(),
      [],
    );

    expect(result).toEqual({
      kind: 'ready',
      inputs: { payload: null },
      missingOptional: [],
    });
  });

  test('json output bindings preserve an explicit null literal', () => {
    const result = extractTaskBindingOutputs(
      { payload: { value: null, type: 'json' } },
      '',
      '',
      null,
    );

    expect(result).toEqual({ outputs: { payload: null }, diagnostic: null });
  });

  test('rejects circular and BigInt json input literals before execution', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const value of [circular, 1n]) {
      const result = resolveTaskBindingInputs(
        { inputs: { payload: { value, type: 'json', required: true } } },
        new Map(),
        [],
      );

      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') continue;
      expect(result.typeErrors[0]?.reason).toContain('JSON');
    }
  });

  test('rejects values that JSON serialization would silently rewrite or discard', () => {
    const sparse = new Array(2);
    sparse[1] = 'value';
    const invalidValues: unknown[] = [
      { nested: { value: undefined } },
      { nested: { value: () => 'hidden' } },
      { nested: { value: Symbol('hidden') } },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      [undefined, () => 'hidden', Symbol('hidden')],
      sparse,
      new Date('2026-07-10T00:00:00.000Z'),
    ];

    for (const value of invalidValues) {
      const result = resolveTaskBindingInputs(
        { inputs: { payload: { value, type: 'json', required: true } } },
        new Map(),
        [],
      );

      expect(result.kind).toBe('blocked');
      if (result.kind !== 'blocked') continue;
      expect(result.typeErrors[0]?.reason).toContain('JSON');
    }
  });

  test('accepts nested finite JSON values without changing their shape', () => {
    const value = {
      object: { text: 'ok', number: 1.5, enabled: false, empty: null },
      array: [1, 'two', true, null, { nested: [] }],
    };

    const result = resolveTaskBindingInputs(
      { inputs: { payload: { value, type: 'json', required: true } } },
      new Map(),
      [],
    );

    expect(result).toEqual({ kind: 'ready', inputs: { payload: value }, missingOptional: [] });
  });

  test('rejects circular json output literals with a diagnostic', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const result = extractTaskBindingOutputs(
      { payload: { value: circular, type: 'json' } },
      '',
      '',
      null,
    );

    expect(result.outputs).toEqual({});
    expect(result.diagnostic).toContain('JSON');
  });
});
