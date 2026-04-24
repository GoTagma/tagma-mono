import { describe, expect, test } from 'bun:test';
import {
  extractInputReferences,
  extractTaskOutputs,
  resolveTaskInputs,
  substituteInputs,
} from './ports';
import type { Permissions, PortDef, TaskConfig } from './types';

const PERMS: Permissions = { read: true, write: false, execute: false };

function task(overrides: Partial<TaskConfig> & { id: string }): TaskConfig {
  return {
    name: overrides.id,
    permissions: PERMS,
    ...overrides,
  };
}

// ─── substituteInputs ────────────────────────────────────────────────

describe('substituteInputs', () => {
  test('replaces single placeholder with string value', () => {
    const { text, unresolved } = substituteInputs('hello {{inputs.name}}', { name: 'world' });
    expect(text).toBe('hello world');
    expect(unresolved).toEqual([]);
  });

  test('allows optional whitespace inside braces', () => {
    const { text } = substituteInputs('{{  inputs.name  }} / {{inputs.name}}', { name: 'x' });
    expect(text).toBe('x / x');
  });

  test('stringifies number / boolean values verbatim', () => {
    const { text } = substituteInputs(
      'n={{inputs.n}} b={{inputs.b}}',
      { n: 42, b: true },
    );
    expect(text).toBe('n=42 b=true');
  });

  test('JSON-stringifies object values', () => {
    const { text } = substituteInputs('payload={{inputs.p}}', {
      p: { a: 1, b: 'x' },
    });
    expect(text).toBe('payload={"a":1,"b":"x"}');
  });

  test('renders unknown placeholder empty and reports it', () => {
    const { text, unresolved } = substituteInputs('hello {{inputs.missing}}', {});
    expect(text).toBe('hello ');
    expect(unresolved).toEqual(['missing']);
  });

  test('renders null / undefined as empty and reports', () => {
    const { text, unresolved } = substituteInputs('a={{inputs.a}} b={{inputs.b}}', {
      a: null,
      b: undefined,
    });
    expect(text).toBe('a= b=');
    expect([...unresolved].sort()).toEqual(['a', 'b']);
  });

  test('leaves malformed placeholders alone', () => {
    const { text } = substituteInputs('{{inputs.a.b}} {{inputs.}}', { a: 'x' });
    expect(text).toBe('{{inputs.a.b}} {{inputs.}}');
  });

  test('handles circular objects without throwing', () => {
    const obj: Record<string, unknown> = { self: null };
    obj.self = obj;
    const { text, unresolved } = substituteInputs('{{inputs.x}}', { x: obj });
    expect(text).toBe('');
    expect(unresolved).toEqual(['x']);
  });
});

describe('extractInputReferences', () => {
  test('returns unique referenced names', () => {
    const refs = extractInputReferences(
      'get {{inputs.city}} for id={{inputs.id}} and {{inputs.city}} again',
    );
    expect(refs.sort()).toEqual(['city', 'id']);
  });

  test('returns empty for text without placeholders', () => {
    expect(extractInputReferences('no placeholders here')).toEqual([]);
  });
});

// ─── resolveTaskInputs ────────────────────────────────────────────────

const cityPort: PortDef = { name: 'city', type: 'string', required: true };
const idPort: PortDef = { name: 'id', type: 'number', required: true };

describe('resolveTaskInputs', () => {
  test('no declared inputs → ready with empty map', () => {
    const t = task({ id: 'downstream', command: 'echo' });
    const res = resolveTaskInputs(t, new Map(), []);
    expect(res).toEqual({ kind: 'ready', inputs: {}, missingOptional: [] });
  });

  test('matches inputs by name across upstream outputs', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      ports: { inputs: [cityPort, idPort] },
    });
    const upstream = new Map<string, Record<string, unknown>>([
      ['t.prompt', { city: 'Shanghai' }],
      ['t.other', { id: 42 }],
    ]);
    const res = resolveTaskInputs(t, upstream, ['t.prompt', 't.other']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ city: 'Shanghai', id: 42 });
  });

  test('required missing blocks with a readable reason', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      ports: { inputs: [cityPort, idPort] },
    });
    const res = resolveTaskInputs(t, new Map(), ['t.x']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect([...res.missingRequired].sort()).toEqual(['city', 'id']);
    expect(res.reason).toMatch(/city.*id|id.*city/);
  });

  test('optional missing yields ready but reports missingOptional', () => {
    const optional: PortDef = { name: 'note', type: 'string' };
    const t = task({
      id: 'downstream',
      command: 'echo',
      ports: { inputs: [optional] },
    });
    const res = resolveTaskInputs(t, new Map(), []);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({});
    expect(res.missingOptional).toEqual(['note']);
  });

  test('applies default for missing optional', () => {
    const optional: PortDef = { name: 'note', type: 'string', default: 'n/a' };
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [optional] },
    });
    const res = resolveTaskInputs(t, new Map(), []);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ note: 'n/a' });
  });

  test('ambiguous multi-upstream match blocks unless disambiguated', () => {
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [cityPort] },
    });
    const upstream = new Map<string, Record<string, unknown>>([
      ['t.a', { city: 'Shanghai' }],
      ['t.b', { city: 'Beijing' }],
    ]);
    const res = resolveTaskInputs(t, upstream, ['t.a', 't.b']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.ambiguous.length).toBe(1);
    expect(res.ambiguous[0]!.port).toBe('city');
    expect([...res.ambiguous[0]!.producers].sort()).toEqual(['t.a', 't.b']);
  });

  test('explicit fully-qualified "from" wins over name-match ambiguity', () => {
    const explicit: PortDef = {
      name: 'city',
      type: 'string',
      required: true,
      from: 't.b.city',
    };
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [explicit] },
    });
    const upstream = new Map<string, Record<string, unknown>>([
      ['t.a', { city: 'Shanghai' }],
      ['t.b', { city: 'Beijing' }],
    ]);
    const res = resolveTaskInputs(t, upstream, ['t.a', 't.b']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ city: 'Beijing' });
  });

  test('coerces numeric strings to number type', () => {
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [idPort] },
    });
    const upstream = new Map<string, Record<string, unknown>>([['t.a', { id: '42' }]]);
    const res = resolveTaskInputs(t, upstream, ['t.a']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs.id).toBe(42);
  });

  test('flags type-coercion failures as blocked', () => {
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [idPort] },
    });
    const upstream = new Map<string, Record<string, unknown>>([['t.a', { id: 'nope' }]]);
    const res = resolveTaskInputs(t, upstream, ['t.a']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.typeErrors.length).toBe(1);
    expect(res.typeErrors[0]!.port).toBe('id');
  });

  test('enforces enum membership', () => {
    const colorPort: PortDef = {
      name: 'color',
      type: 'enum',
      enum: ['red', 'green'],
      required: true,
    };
    const t = task({
      id: 'd',
      command: 'echo',
      ports: { inputs: [colorPort] },
    });
    const upstream = new Map<string, Record<string, unknown>>([['t.a', { color: 'blue' }]]);
    const res = resolveTaskInputs(t, upstream, ['t.a']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.typeErrors[0]!.port).toBe('color');
  });
});

// ─── extractTaskOutputs ──────────────────────────────────────────────

describe('extractTaskOutputs', () => {
  const outputs = [
    { name: 'city', type: 'string' as const },
    { name: 'temp', type: 'number' as const },
  ];

  test('no declared outputs → empty map, null diagnostic', () => {
    const r = extractTaskOutputs(undefined, 'anything', null);
    expect(r.outputs).toEqual({});
    expect(r.diagnostic).toBeNull();
  });

  test('parses last-line JSON object as source record', () => {
    const stdout = 'some log\nmore log\n{"city":"Shanghai","temp":23}\n';
    const r = extractTaskOutputs({ outputs }, stdout, null);
    expect(r.outputs).toEqual({ city: 'Shanghai', temp: 23 });
    expect(r.diagnostic).toBeNull();
  });

  test('falls back to whole-source JSON when last line is a closing brace', () => {
    const stdout = '{\n  "city": "Shanghai",\n  "temp": 23\n}\n';
    const r = extractTaskOutputs({ outputs }, stdout, null);
    expect(r.outputs).toEqual({ city: 'Shanghai', temp: 23 });
  });

  test('prefers normalizedOutput over stdout when provided', () => {
    const stdout = '{"city":"Wrong","temp":0}';
    const normalized = '{"city":"Shanghai","temp":23}';
    const r = extractTaskOutputs({ outputs }, stdout, normalized);
    expect(r.outputs).toEqual({ city: 'Shanghai', temp: 23 });
  });

  test('reports missing keys as diagnostic, keeps resolved keys', () => {
    const r = extractTaskOutputs({ outputs }, '{"city":"Shanghai"}', null);
    expect(r.outputs).toEqual({ city: 'Shanghai' });
    expect(r.diagnostic).toContain('missing key "temp"');
  });

  test('reports coercion failure and skips bad port', () => {
    const r = extractTaskOutputs(
      { outputs },
      '{"city":"Shanghai","temp":"not-a-number"}',
      null,
    );
    expect(r.outputs).toEqual({ city: 'Shanghai' });
    expect(r.diagnostic).toContain('"temp"');
  });

  test('reports diagnostic when no JSON can be parsed', () => {
    const r = extractTaskOutputs({ outputs }, 'plain text output\nnothing json\n', null);
    expect(r.outputs).toEqual({});
    expect(r.diagnostic).toContain('could not find a final-line JSON object');
  });
});
