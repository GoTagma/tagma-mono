import { describe, expect, test } from 'bun:test';
import {
  extractInputReferences,
  extractTaskBindingOutputs,
  extractTaskOutputs,
  inferPromptPorts,
  resolveTaskBindingInputs,
  resolveTaskInputs,
  substituteInputs,
} from './dataflow';
import type { Permissions, PortDef, TaskConfig, TaskPorts } from '@tagma/types';

const PERMS: Permissions = { read: true, write: false, execute: false };

function task(
  overrides: Partial<TaskConfig> & { id: string; ports?: TaskPorts },
): TaskConfig & { readonly ports?: TaskPorts } {
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
    const { text } = substituteInputs('n={{inputs.n}} b={{inputs.b}}', { n: 42, b: true });
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

// ─── resolveTaskBindingInputs ────────────────────────────────────────

describe('resolveTaskBindingInputs', () => {
  test('defaults missing from/value bindings to same-name upstream outputs', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { type: 'string', required: true },
        id: { type: 'number', required: true },
      },
    });
    const upstream = new Map([
      [
        't.up',
        {
          outputs: { city: 'Shanghai', id: '42' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.up']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ city: 'Shanghai', id: 42 });
  });

  test('reports ambiguity for default same-name binding matches', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { type: 'string', required: true },
      },
    });
    const upstream = new Map([
      [
        't.a',
        {
          outputs: { city: 'Shanghai' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
      [
        't.b',
        {
          outputs: { city: 'Beijing' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.a', 't.b']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.ambiguous).toEqual([{ input: 'city', producers: ['t.a', 't.b'] }]);
  });

  test('coerces typed unified inputs from upstream outputs', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        id: { from: 't.up.outputs.id', type: 'number', required: true },
        enabled: { value: 'true', type: 'boolean' },
      },
    });
    const upstream = new Map([
      [
        't.up',
        {
          outputs: { id: '42' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.up']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ id: 42, enabled: true });
  });

  test('blocks typed unified input coercion failures', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        id: { from: 't.up.outputs.id', type: 'number', required: true },
      },
    });
    const upstream = new Map([
      [
        't.up',
        {
          outputs: { id: 'not-a-number' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.up']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.typeErrors).toEqual([{ input: 'id', reason: 'expected number, got string' }]);
  });

  test('resolves literal values and defaults without requiring ports', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { value: 'Shanghai' },
        mode: { from: 't.up.outputs.missing', default: 'quick' },
      },
    });
    const res = resolveTaskBindingInputs(t, new Map(), ['t.up']);
    expect(res).toEqual({
      kind: 'ready',
      inputs: { city: 'Shanghai', mode: 'quick' },
      missingOptional: [],
    });
  });

  test('resolves values from a direct upstream output and stdout', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { from: 't.up.outputs.city' },
        raw: { from: 't.up.stdout' },
      },
    });
    const upstream = new Map([
      [
        't.up',
        {
          outputs: { city: 'Shanghai' },
          stdout: 'raw text\n',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.up']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({ city: 'Shanghai', raw: 'raw text\n' });
  });

  test('resolves short task output and stream sources from direct upstreams', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { from: 'up.city' },
        explicitCity: { from: 'up.outputs.city' },
        raw: { from: 'up.stdout' },
      },
    });
    const upstream = new Map([
      [
        't.up',
        {
          outputs: { city: 'Shanghai' },
          stdout: 'raw text\n',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.up']);
    expect(res.kind).toBe('ready');
    if (res.kind !== 'ready') return;
    expect(res.inputs).toEqual({
      city: 'Shanghai',
      explicitCity: 'Shanghai',
      raw: 'raw text\n',
    });
  });

  test('short task sources are ambiguous when multiple direct upstreams share the task id', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { from: 'up.city', required: true },
      },
    });
    const upstream = new Map([
      [
        'a.up',
        {
          outputs: { city: 'Shanghai' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
      [
        'b.up',
        {
          outputs: { city: 'Beijing' },
          stdout: '',
          stderr: '',
          normalizedOutput: null,
          exitCode: 0,
        },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['a.up', 'b.up']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.ambiguous).toEqual([{ input: 'city', producers: ['a.up', 'b.up'] }]);
  });

  test('blocks required missing bindings with a readable reason', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        city: { from: 't.up.outputs.city', required: true },
      },
    });
    const res = resolveTaskBindingInputs(t, new Map(), ['t.up']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.missingRequired).toEqual(['city']);
    expect(res.reason).toContain('missing required binding input(s): city');
  });

  test('detects ambiguous loose output name matches', () => {
    const t = task({
      id: 'downstream',
      command: 'echo',
      inputs: {
        val: { from: 'outputs.val', required: true },
      },
    });
    const upstream = new Map([
      [
        't.a',
        { outputs: { val: 'a' }, stdout: '', stderr: '', normalizedOutput: null, exitCode: 0 },
      ],
      [
        't.b',
        { outputs: { val: 'b' }, stdout: '', stderr: '', normalizedOutput: null, exitCode: 0 },
      ],
    ]);
    const res = resolveTaskBindingInputs(t, upstream, ['t.a', 't.b']);
    expect(res.kind).toBe('blocked');
    if (res.kind !== 'blocked') return;
    expect(res.ambiguous[0]).toEqual({ input: 'val', producers: ['t.a', 't.b'] });
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
    const r = extractTaskOutputs({ outputs }, '{"city":"Shanghai","temp":"not-a-number"}', null);
    expect(r.outputs).toEqual({ city: 'Shanghai' });
    expect(r.diagnostic).toContain('"temp"');
  });

  test('reports diagnostic when no JSON can be parsed', () => {
    const r = extractTaskOutputs({ outputs }, 'plain text output\nnothing json\n', null);
    expect(r.outputs).toEqual({});
    expect(r.diagnostic).toContain('could not find a final-line JSON object');
  });
});

// ─── extractTaskBindingOutputs ───────────────────────────────────────

describe('extractTaskBindingOutputs', () => {
  test('coerces typed unified outputs from final-line JSON', () => {
    const r = extractTaskBindingOutputs(
      {
        id: { type: 'number' },
        ok: { from: 'json.success', type: 'boolean' },
      },
      'log\n{"id":"42","success":"true"}\n',
      '',
      null,
    );
    expect(r.outputs).toEqual({ id: 42, ok: true });
    expect(r.diagnostic).toBeNull();
  });

  test('diagnoses typed unified output coercion failures', () => {
    const r = extractTaskBindingOutputs(
      {
        id: { type: 'number' },
      },
      '{"id":"nope"}',
      '',
      null,
    );
    expect(r.outputs).toEqual({});
    expect(r.diagnostic).toContain('"id": expected number, got string');
  });

  test('extracts loose outputs from final-line JSON by default', () => {
    const r = extractTaskBindingOutputs(
      {
        city: {},
        temp: { from: 'json.temperature' },
      },
      'log\n{"city":"Shanghai","temperature":23}\n',
      '',
      null,
    );
    expect(r.outputs).toEqual({ city: 'Shanghai', temp: 23 });
    expect(r.diagnostic).toBeNull();
  });

  test('can publish whole stdout and normalizedOutput as named outputs', () => {
    const r = extractTaskBindingOutputs(
      {
        raw: { from: 'stdout' },
        normalized: { from: 'normalizedOutput' },
      },
      'raw text\n',
      '',
      'normalized text',
    );
    expect(r.outputs).toEqual({ raw: 'raw text\n', normalized: 'normalized text' });
  });

  test('uses defaults for missing loose outputs without failing extraction', () => {
    const r = extractTaskBindingOutputs(
      {
        city: { default: 'Unknown' },
      },
      'not json\n',
      '',
      null,
    );
    expect(r.outputs).toEqual({ city: 'Unknown' });
    expect(r.diagnostic).toBeNull();
  });
});

// ─── inferPromptPorts ───────────────────────────────────────────────

describe('inferPromptPorts', () => {
  test('inputs are taken from direct-upstream Command outputs', () => {
    const r = inferPromptPorts({
      upstreams: [
        {
          taskId: 't.up',
          outputs: [
            { name: 'city', type: 'string' },
            { name: 'id', type: 'number' },
          ],
        },
      ],
      downstreams: [],
    });
    expect(r.inputConflicts).toEqual([]);
    expect(r.outputConflicts).toEqual([]);
    expect(r.ports.inputs).toHaveLength(2);
    expect(r.ports.inputs?.map((p) => p.name).sort()).toEqual(['city', 'id']);
    // Inferred inputs default to required: the LLM wouldn't see a real
    // value if the upstream failed to produce one.
    expect(r.ports.inputs?.every((p) => p.required === true)).toBe(true);
    expect(r.ports.outputs).toBeUndefined();
  });

  test('outputs are taken from direct-downstream Command inputs', () => {
    const r = inferPromptPorts({
      upstreams: [],
      downstreams: [
        {
          taskId: 't.down',
          inputs: [
            { name: 'greeting', type: 'string', required: true },
            { name: 'target', type: 'string', default: 'world' },
          ],
        },
      ],
    });
    expect(r.outputConflicts).toEqual([]);
    expect(r.ports.outputs?.map((p) => p.name).sort()).toEqual(['greeting', 'target']);
    // Outputs drop input-only fields (required, default, from).
    for (const p of r.ports.outputs ?? []) {
      expect(p).not.toHaveProperty('required');
      expect(p).not.toHaveProperty('default');
      expect(p).not.toHaveProperty('from');
    }
    expect(r.ports.inputs).toBeUndefined();
  });

  test('Prompt neighbors (outputs undefined) contribute nothing', () => {
    const r = inferPromptPorts({
      upstreams: [
        { taskId: 't.up', outputs: undefined }, // Prompt upstream
      ],
      downstreams: [
        { taskId: 't.down', inputs: undefined }, // Prompt downstream
      ],
    });
    expect(r.ports).toEqual({});
    expect(r.inputConflicts).toEqual([]);
    expect(r.outputConflicts).toEqual([]);
  });

  test('two upstreams with the same output name produce an input conflict', () => {
    const r = inferPromptPorts({
      upstreams: [
        { taskId: 't.a', outputs: [{ name: 'city', type: 'string' }] },
        { taskId: 't.b', outputs: [{ name: 'city', type: 'string' }] },
      ],
      downstreams: [],
    });
    expect(r.inputConflicts).toHaveLength(1);
    expect(r.inputConflicts[0]!.portName).toBe('city');
    expect(r.inputConflicts[0]!.producers.map((p) => p.taskId).sort()).toEqual(['t.a', 't.b']);
    expect(r.inputConflicts[0]!.reason).toMatch(/cannot disambiguate/);
  });

  test('two downstreams with compatible input types merge silently', () => {
    const r = inferPromptPorts({
      upstreams: [],
      downstreams: [
        {
          taskId: 't.d1',
          inputs: [{ name: 'date', type: 'string', required: true }],
        },
        {
          taskId: 't.d2',
          inputs: [{ name: 'date', type: 'string', required: false }],
        },
      ],
    });
    expect(r.outputConflicts).toEqual([]);
    expect(r.ports.outputs).toHaveLength(1);
    expect(r.ports.outputs![0]!.name).toBe('date');
    expect(r.ports.outputs![0]!.type).toBe('string');
  });

  test('two downstreams with incompatible input types produce an output conflict', () => {
    const r = inferPromptPorts({
      upstreams: [],
      downstreams: [
        { taskId: 't.d1', inputs: [{ name: 'date', type: 'string' }] },
        { taskId: 't.d2', inputs: [{ name: 'date', type: 'number' }] },
      ],
    });
    expect(r.outputConflicts).toHaveLength(1);
    expect(r.outputConflicts[0]!.portName).toBe('date');
    expect(r.outputConflicts[0]!.reason).toMatch(/conflicting type requirements/);
  });

  test('enum ports with differing value sets are incompatible', () => {
    const r = inferPromptPorts({
      upstreams: [],
      downstreams: [
        {
          taskId: 't.d1',
          inputs: [{ name: 'bucket', type: 'enum', enum: ['a', 'b'] }],
        },
        {
          taskId: 't.d2',
          inputs: [{ name: 'bucket', type: 'enum', enum: ['a', 'c'] }],
        },
      ],
    });
    expect(r.outputConflicts).toHaveLength(1);
  });

  test('enum ports with identical value sets merge', () => {
    const r = inferPromptPorts({
      upstreams: [],
      downstreams: [
        {
          taskId: 't.d1',
          inputs: [{ name: 'bucket', type: 'enum', enum: ['a', 'b'] }],
        },
        {
          taskId: 't.d2',
          inputs: [{ name: 'bucket', type: 'enum', enum: ['b', 'a'] }], // different order, same set
        },
      ],
    });
    expect(r.outputConflicts).toEqual([]);
    expect(r.ports.outputs).toHaveLength(1);
  });

  test('description and enum propagate from the first occurrence', () => {
    const r = inferPromptPorts({
      upstreams: [
        {
          taskId: 't.up',
          outputs: [
            {
              name: 'kind',
              type: 'enum',
              enum: ['hot', 'cold'],
              description: 'Weather kind',
            },
          ],
        },
      ],
      downstreams: [],
    });
    const port = r.ports.inputs![0]!;
    expect(port.description).toBe('Weather kind');
    expect(port.enum).toEqual(['hot', 'cold']);
  });
});
