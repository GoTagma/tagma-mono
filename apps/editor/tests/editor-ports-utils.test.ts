import { describe, expect, test } from 'bun:test';
import { inferPromptPorts as sdkInferPromptPorts } from '@tagma/sdk/dataflow';
import {
  buildDownstreamPortsReport,
  buildInferredPromptPorts,
  buildUnifiedPortsView,
  buildUpstreamPortsReport,
  computeSyncedInputs,
  computeSyncedOutputs,
  diffPortShape,
  resolveUpstreamForInput,
} from '../src/utils/ports';
import type { DownstreamInputCandidate } from '../src/utils/ports';
import type { PortDef, RawPipelineConfig, RawTaskConfig } from '../src/api/client';

// ─── Small config builders ───────────────────────────────────────────

function task(id: string, overrides: Partial<RawTaskConfig> = {}): RawTaskConfig {
  return { id, prompt: 'x', ...overrides };
}

function pipe(tracks: { id: string; tasks: RawTaskConfig[] }[]): RawPipelineConfig {
  return {
    name: 'p',
    tracks: tracks.map((t) => ({ id: t.id, name: t.id, tasks: t.tasks })),
  };
}

// ─── buildUpstreamPortsReport ────────────────────────────────────────

describe('buildUpstreamPortsReport', () => {
  test('empty candidates / ambiguous / drift when task has no upstreams', () => {
    const config = pipe([{ id: 't', tasks: [task('solo')] }]);
    const report = buildUpstreamPortsReport(config, 't.solo');
    expect(report.candidates).toEqual([]);
    expect(report.ambiguous).toEqual([]);
    expect(report.unmatched).toEqual([]);
    expect(report.drift).toEqual([]);
  });

  test('collects direct-upstream outputs as candidates', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', {
            outputs: {
              city: { type: 'string' },
              id: { type: 'number' },
            },
          }),
          task('down', { depends_on: ['up'] }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.candidates.map((c) => c.port.name).sort()).toEqual(['city', 'id']);
    for (const c of report.candidates) expect(c.upstreamQid).toBe('t.up');
  });

  test('resolves cross-track qualified depends_on correctly', () => {
    const config = pipe([
      {
        id: 'ta',
        tasks: [task('up', { outputs: { v: { type: 'string' } } })],
      },
      {
        id: 'tb',
        tasks: [task('down', { depends_on: ['ta.up'] })],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 'tb.down');
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.upstreamQid).toBe('ta.up');
  });

  test('flags ambiguity when two upstreams export the same name', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('a', { outputs: { v: { type: 'string' } } }),
          task('b', { outputs: { v: { type: 'string' } } }),
          task('down', { depends_on: ['a', 'b'] }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.ambiguous).toEqual([{ portName: 'v', producers: ['t.a', 't.b'] }]);
  });

  test('detects unmatched inputs — declared but no upstream produces them', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', { outputs: { x: { type: 'string' } } }),
          task('down', {
            depends_on: ['up'],
            inputs: {
              city: { type: 'string', required: true },
            },
          }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.unmatched.map((p) => p.name)).toEqual(['city']);
  });

  test('detects drift: type changed on upstream since downstream was synced', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', { outputs: { n: { type: 'number' } } }),
          task('down', {
            depends_on: ['up'],
            inputs: {
              n: { type: 'string', required: true },
            },
          }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.drift).toHaveLength(1);
    const d = report.drift[0]!;
    expect(d.portName).toBe('n');
    expect(d.upstreamQid).toBe('t.up');
    expect(d.changes.some((c) => c.includes('type'))).toBe(true);
  });

  test('detects drift: description changed', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', {
            outputs: {
              x: { type: 'string', description: 'new meaning' },
            },
          }),
          task('down', {
            depends_on: ['up'],
            inputs: {
              x: { type: 'string', description: 'old meaning' },
            },
          }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.drift[0]!.changes).toContain('description changed');
  });

  test('detects drift: enum values changed', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', {
            outputs: {
              color: { type: 'enum', enum: ['red', 'green'] },
            },
          }),
          task('down', {
            depends_on: ['up'],
            inputs: {
              color: { type: 'enum', enum: ['red', 'blue'], required: true },
            },
          }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    expect(report.drift[0]!.changes).toContain('enum values changed');
  });

  test('explicit `from` bypasses name-match drift/ambiguity', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('a', { outputs: { v: { type: 'string' } } }),
          task('b', { outputs: { v: { type: 'string' } } }),
          task('down', {
            depends_on: ['a', 'b'],
            inputs: {
              v: { type: 'string', required: true, from: 't.a.outputs.v' },
            },
          }),
        ],
      },
    ]);
    const report = buildUpstreamPortsReport(config, 't.down');
    // Ambiguity is still reported at the *port-name* level (for the
    // editor to warn about), but no drift fires because `from` resolves
    // deterministically.
    expect(report.ambiguous.map((a) => a.portName)).toEqual(['v']);
    expect(report.drift).toEqual([]);
  });
});

// ─── resolveUpstreamForInput ─────────────────────────────────────────

describe('resolveUpstreamForInput', () => {
  const outputByUpstream = new Map<string, Map<string, PortDef>>([
    [
      't.a',
      new Map<string, PortDef>([['v', { name: 'v', type: 'string', description: 'from a' }]]),
    ],
    [
      't.b',
      new Map<string, PortDef>([
        ['v', { name: 'v', type: 'string', description: 'from b' }],
        ['only-b', { name: 'only-b', type: 'number' }],
      ]),
    ],
  ]);

  test('fully-qualified `from` picks the named producer', () => {
    const input: PortDef = { name: 'v', type: 'string', from: 't.b.outputs.v' };
    const hit = resolveUpstreamForInput(input, outputByUpstream);
    expect(hit).not.toBeNull();
    expect(hit!.upstreamQid).toBe('t.b');
    expect(hit!.port.description).toBe('from b');
  });

  test('short task output `from` picks the named producer', () => {
    const input: PortDef = { name: 'v', type: 'string', from: 'b.v' };
    const hit = resolveUpstreamForInput(input, outputByUpstream);
    expect(hit).not.toBeNull();
    expect(hit!.upstreamQid).toBe('t.b');
    expect(hit!.port.description).toBe('from b');
  });

  test('short task outputs namespace `from` picks the named producer', () => {
    const input: PortDef = { name: 'v', type: 'string', from: 'b.outputs.v' };
    const hit = resolveUpstreamForInput(input, outputByUpstream);
    expect(hit).not.toBeNull();
    expect(hit!.upstreamQid).toBe('t.b');
    expect(hit!.port.description).toBe('from b');
  });

  test('fully-qualified `from` returns null when port missing on that upstream', () => {
    const input: PortDef = { name: 'v', type: 'string', from: 't.a.outputs.nope' };
    expect(resolveUpstreamForInput(input, outputByUpstream)).toBeNull();
  });

  test('bare `from` acts as a name match, ambiguous → null', () => {
    const input: PortDef = { name: 'v', type: 'string', from: 'outputs.v' };
    expect(resolveUpstreamForInput(input, outputByUpstream)).toBeNull();
  });

  test('no `from` with a unique name resolves to the single upstream', () => {
    const input: PortDef = { name: 'only-b', type: 'number' };
    const hit = resolveUpstreamForInput(input, outputByUpstream);
    expect(hit).not.toBeNull();
    expect(hit!.upstreamQid).toBe('t.b');
  });
});

// ─── diffPortShape ───────────────────────────────────────────────────

describe('diffPortShape', () => {
  test('returns empty for identical shapes', () => {
    const a: PortDef = { name: 'x', type: 'string', description: 'hi' };
    expect(diffPortShape(a, a)).toEqual([]);
  });
  test('reports type change with before/after', () => {
    const a: PortDef = { name: 'x', type: 'string' };
    const b: PortDef = { name: 'x', type: 'number' };
    expect(diffPortShape(a, b)).toEqual(['type: string → number']);
  });
  test('reports description change', () => {
    const a: PortDef = { name: 'x', type: 'string', description: 'old' };
    const b: PortDef = { name: 'x', type: 'string', description: 'new' };
    expect(diffPortShape(a, b)).toContain('description changed');
  });
  test('reports enum change regardless of order', () => {
    const a: PortDef = { name: 'x', type: 'enum', enum: ['a', 'b'] };
    const b: PortDef = { name: 'x', type: 'enum', enum: ['b', 'c'] };
    expect(diffPortShape(a, b)).toContain('enum values changed');
  });
  test('enum reorder is NOT a change', () => {
    const a: PortDef = { name: 'x', type: 'enum', enum: ['a', 'b'] };
    const b: PortDef = { name: 'x', type: 'enum', enum: ['b', 'a'] };
    expect(diffPortShape(a, b)).toEqual([]);
  });
});

// ─── computeSyncedInputs ─────────────────────────────────────────────

describe('computeSyncedInputs', () => {
  function cand(
    upstreamQid: string,
    name: string,
    type: PortDef['type'] = 'string',
    extra: Partial<PortDef> = {},
  ): { upstreamQid: string; port: PortDef } {
    return { upstreamQid, port: { name, type, ...extra } };
  }

  test('no candidates → returns existing unchanged (cloned)', () => {
    const existing: PortDef[] = [{ name: 'k', type: 'string' }];
    const out = computeSyncedInputs(existing, []);
    expect(out).toEqual(existing);
    // Cloned so editor mutations don't leak
    expect(out).not.toBe(existing);
  });

  test('empty on both sides → undefined', () => {
    expect(computeSyncedInputs(undefined, [])).toBeUndefined();
  });

  test('imports upstream outputs as inputs with type + description copied', () => {
    const out = computeSyncedInputs(undefined, [
      cand('t.up', 'city', 'string', { description: 'Target city' }),
    ])!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'city',
      type: 'string',
      description: 'Target city',
      from: 'up.city',
    });
  });

  test('upgrades a legacy loose auto source to the concrete upstream producer', () => {
    const existing: PortDef[] = [
      { name: 'city', type: 'string', required: true, from: 'outputs.city' },
    ];
    const out = computeSyncedInputs(existing, [cand('t.up', 'city')])!;

    expect(out[0]!.from).toBe('up.city');
  });

  test('default-imports as required: true', () => {
    const out = computeSyncedInputs(undefined, [cand('t.up', 'city')])!;
    expect(out[0]!.required).toBe(true);
  });

  test('preserves existing required / default / from on a re-sync', () => {
    const existing: PortDef[] = [
      { name: 'city', type: 'string', required: false, default: 'Shanghai', from: 't.other.city' },
    ];
    const out = computeSyncedInputs(existing, [cand('t.up', 'city', 'string')])!;
    expect(out[0]!.required).toBe(false);
    expect(out[0]!.default).toBe('Shanghai');
    expect(out[0]!.from).toBe('t.other.city');
  });

  test('adds explicit `from` when two upstreams export the same name', () => {
    const out = computeSyncedInputs(undefined, [cand('t.a', 'v'), cand('t.b', 'v')])!;
    expect(out).toHaveLength(1);
    // Binding points at the first producer; user can flip it in the UI.
    expect(out[0]!.from).toBe('a.v');
  });

  test('uses fully-qualified output source when short task ids would be ambiguous', () => {
    const out = computeSyncedInputs(undefined, [cand('a.up', 'v'), cand('b.up', 'v')])!;
    expect(out).toHaveLength(1);
    expect(out[0]!.from).toBe('a.up.outputs.v');
  });

  test('does NOT delete a user-authored input that has no upstream match', () => {
    const existing: PortDef[] = [{ name: 'local-only', type: 'string', default: 'hi' }];
    const out = computeSyncedInputs(existing, [cand('t.up', 'city')])!;
    const names = out.map((p) => p.name).sort();
    expect(names).toEqual(['city', 'local-only']);
  });

  test('enum candidates copy the enum array by value (no shared reference)', () => {
    const candidate = cand('t.up', 'color', 'enum', { enum: ['red', 'green'] });
    const out = computeSyncedInputs(undefined, [candidate])!;
    expect(out[0]!.enum).toEqual(['red', 'green']);
    // Mutating the candidate's enum must not leak into the output.
    (candidate.port.enum as string[]).push('blue');
    expect(out[0]!.enum).toEqual(['red', 'green']);
  });
});

// ─── buildDownstreamPortsReport ──────────────────────────────────────

describe('buildDownstreamPortsReport', () => {
  test('collects inputs declared by direct downstreams', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up'),
          task('down', {
            depends_on: ['up'],
            inputs: {
              city: { type: 'string', required: true },
              id: { type: 'number' },
            },
          }),
        ],
      },
    ]);
    const report = buildDownstreamPortsReport(config, 't.up');
    expect(report.candidates.map((c) => c.port.name).sort()).toEqual(['city', 'id']);
    for (const c of report.candidates) expect(c.downstreamQid).toBe('t.down');
    expect(report.conflicting).toEqual([]);
  });

  test('uses explicit from output name instead of downstream input alias', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up'),
          task('down', {
            depends_on: ['up'],
            inputs: {
              hnSources: { type: 'json', from: 't.up.outputs.sources' },
            },
          }),
        ],
      },
    ]);

    const report = buildDownstreamPortsReport(config, 't.up');

    expect(report.candidates.map((c) => c.port.name)).toEqual(['sources']);
    expect(report.candidates[0]!.port.type).toBe('json');
    expect(report.conflicting).toEqual([]);
  });

  test('does not project loose downstream inputs onto every upstream in multi-dependency tasks', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('health'),
          task('controls'),
          task('fetch', {
            depends_on: ['health', 'controls'],
            inputs: {
              limit: { type: 'number', from: 'controls' },
            },
          }),
        ],
      },
    ]);

    const report = buildDownstreamPortsReport(config, 't.health');

    expect(report.candidates).toEqual([]);
    expect(report.conflicting).toEqual([]);
  });

  test('only projects explicit downstream input sources onto the targeted upstream', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('health'),
          task('controls'),
          task('fetch', {
            depends_on: ['health', 'controls'],
            inputs: {
              limit: { type: 'number', from: 'controls.limit' },
            },
          }),
        ],
      },
    ]);

    expect(buildDownstreamPortsReport(config, 't.health').candidates).toEqual([]);
    expect(
      buildDownstreamPortsReport(config, 't.controls').candidates.map((c) => c.port.name),
    ).toEqual(['limit']);
  });

  test('skips explicit from bindings that target a different upstream', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up'),
          task('other'),
          task('down', {
            depends_on: ['up', 'other'],
            inputs: {
              payload: { type: 'json', from: 't.other.outputs.payload' },
            },
          }),
        ],
      },
    ]);

    const report = buildDownstreamPortsReport(config, 't.up');

    expect(report.candidates).toEqual([]);
    expect(report.conflicting).toEqual([]);
  });

  test('resolves cross-track bare refs (depends_on: "up")', () => {
    const config = pipe([
      { id: 'a', tasks: [task('up', { outputs: {} })] },
      {
        id: 'b',
        tasks: [
          task('down', {
            depends_on: ['up'],
            inputs: { v: { type: 'string' } },
          }),
        ],
      },
    ]);
    const report = buildDownstreamPortsReport(config, 'a.up');
    expect(report.candidates.map((c) => c.port.name)).toEqual(['v']);
    expect(report.candidates[0]!.downstreamQid).toBe('b.down');
  });

  test('flags shape conflicts when two downstreams declare the same name differently', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up'),
          task('d1', {
            depends_on: ['up'],
            inputs: { v: { type: 'string' } },
          }),
          task('d2', {
            depends_on: ['up'],
            inputs: { v: { type: 'number' } },
          }),
        ],
      },
    ]);
    const report = buildDownstreamPortsReport(config, 't.up');
    expect(report.conflicting.map((c) => c.portName)).toEqual(['v']);
    expect([...report.conflicting[0]!.consumers].sort()).toEqual(['t.d1', 't.d2']);
  });

  test('empty when task has no downstreams', () => {
    const config = pipe([{ id: 't', tasks: [task('solo')] }]);
    const report = buildDownstreamPortsReport(config, 't.solo');
    expect(report.candidates).toEqual([]);
    expect(report.conflicting).toEqual([]);
  });
});

// ─── computeSyncedOutputs ────────────────────────────────────────────

describe('computeSyncedOutputs', () => {
  function downCand(
    downstreamQid: string,
    name: string,
    type: PortDef['type'] = 'string',
    extra: Partial<PortDef> = {},
  ): DownstreamInputCandidate {
    return { downstreamQid, port: { name, type, ...extra } as PortDef };
  }

  test('no existing outputs + no candidates → undefined', () => {
    expect(computeSyncedOutputs(undefined, [])).toBeUndefined();
  });

  test('adopts new names from downstream inputs', () => {
    const out = computeSyncedOutputs(undefined, [
      downCand('t.d', 'city'),
      downCand('t.d', 'id', 'number'),
    ])!;
    expect(out.map((p) => p.name).sort()).toEqual(['city', 'id']);
  });

  test('preserves existing outputs untouched (idempotent)', () => {
    const existing: PortDef[] = [{ name: 'city', type: 'string', description: 'authored by user' }];
    const out = computeSyncedOutputs(existing, [downCand('t.d', 'city')])!;
    expect(out.length).toBe(1);
    expect(out[0]!.description).toBe('authored by user');
  });

  test('drops input-only fields (required / default / from) when copying', () => {
    const out = computeSyncedOutputs(undefined, [
      downCand('t.d', 'v', 'string', { required: true, default: 'x', from: 'x' }),
    ])!;
    expect(out[0]).toEqual({ name: 'v', type: 'string' });
  });

  test('on name collision across downstreams, first-encountered shape wins', () => {
    const out = computeSyncedOutputs(undefined, [
      downCand('t.d1', 'v', 'string'),
      downCand('t.d2', 'v', 'number'),
    ])!;
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe('string');
  });

  test('copies enum by value', () => {
    const cand = downCand('t.d', 'color', 'enum', { enum: ['a', 'b'] });
    const out = computeSyncedOutputs(undefined, [cand])!;
    (cand.port.enum as string[]).push('c');
    expect(out[0]!.enum).toEqual(['a', 'b']);
  });
});

describe('buildInferredPromptPorts', () => {
  test('infers prompt inputs and outputs from neighboring unified bindings', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', { command: 'emit', outputs: { city: { type: 'string' } } }),
          task('p', { prompt: 'Use {{inputs.city}}', depends_on: ['up'] }),
          task('down', {
            command: 'consume {{inputs.summary}}',
            depends_on: ['p'],
            inputs: { summary: { type: 'string', required: true } },
          }),
        ],
      },
    ]);

    const view = buildInferredPromptPorts(config, 't.p');
    expect(view.ports.inputs?.map((p) => p.name)).toEqual(['city']);
    expect(view.ports.outputs?.map((p) => p.name)).toEqual(['summary']);
  });

  test('treats object command configs as command tasks for prompt inference', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', { command: { shell: 'emit' }, outputs: { city: { type: 'string' } } }),
          task('p', { prompt: 'Use {{inputs.city}}', depends_on: ['up'] }),
          task('down', {
            command: { argv: ['consume', '{{inputs.summary}}'] },
            depends_on: ['p'],
            inputs: { summary: { type: 'string', required: true } },
          }),
        ],
      },
    ]);

    const view = buildInferredPromptPorts(config, 't.p');
    expect(view.ports.inputs?.map((p) => p.name)).toEqual(['city']);
    expect(view.ports.outputs?.map((p) => p.name)).toEqual(['summary']);
  });

  test('infers prompt output names from explicit downstream prompt output sources', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('p', { prompt: 'Generate answer' }),
          task('down', {
            command: 'consume {{inputs.result}}',
            depends_on: ['p'],
            inputs: { result: { from: 't.p.outputs.answer', type: 'string' } },
          }),
        ],
      },
    ]);

    const view = buildInferredPromptPorts(config, 't.p');
    expect(view.ports.outputs?.map((p) => p.name)).toEqual(['answer']);
  });

  test('infers prompt output names from short downstream prompt output sources', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('p', { prompt: 'Generate answer' }),
          task('down', {
            command: 'consume {{inputs.result}}',
            depends_on: ['p'],
            inputs: { result: { from: 'p.answer', type: 'string' } },
          }),
        ],
      },
    ]);

    const view = buildInferredPromptPorts(config, 't.p');
    expect(view.ports.outputs?.map((p) => p.name)).toEqual(['answer']);
  });

  test('describes ambiguous prompt inputs as aliasable with explicit sources', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('weather', { command: 'emit', outputs: { city: { type: 'string' } } }),
          task('profile', { command: 'emit', outputs: { city: { type: 'string' } } }),
          task('p', { prompt: 'Use city', depends_on: ['weather', 'profile'] }),
        ],
      },
    ]);

    const view = buildInferredPromptPorts(config, 't.p');
    expect(view.inputConflicts[0]?.reason).toMatch(/declare explicit input aliases/);
    expect(view.inputConflicts[0]?.reason).toContain('from');
  });

  test('matches SDK prompt inference for ports and conflict metadata', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('a', { command: 'emit', outputs: { city: { type: 'string' } } }),
          task('b', { command: 'emit', outputs: { city: { type: 'number' } } }),
          task('p', { prompt: 'Use {{inputs.city}}', depends_on: ['a', 'b'] }),
          task('d1', {
            command: 'consume {{inputs.summary}}',
            depends_on: ['p'],
            inputs: { summary: { type: 'string' } },
          }),
          task('d2', {
            command: 'consume {{inputs.summary}}',
            depends_on: ['p'],
            inputs: { summary: { type: 'number' } },
          }),
        ],
      },
    ]);
    const upstreams = [
      { taskId: 't.a', outputs: [{ name: 'city', type: 'string' as const }] },
      { taskId: 't.b', outputs: [{ name: 'city', type: 'number' as const }] },
    ];
    const downstreams = [
      { taskId: 't.d1', inputs: [{ name: 'summary', type: 'string' as const }] },
      { taskId: 't.d2', inputs: [{ name: 'summary', type: 'number' as const }] },
    ];

    const view = buildInferredPromptPorts(config, 't.p');
    const sdk = sdkInferPromptPorts({ upstreams, downstreams });
    const withoutReason = <T extends { reason: string }>(items: readonly T[]) =>
      items.map(({ reason: _reason, ...rest }) => rest);

    expect(view.ports).toEqual(sdk.ports);
    expect(withoutReason(view.inputConflicts)).toEqual(withoutReason(sdk.inputConflicts));
    expect(withoutReason(view.outputConflicts)).toEqual(withoutReason(sdk.outputConflicts));
  });
});

describe('buildUnifiedPortsView', () => {
  test('combines inferred prompt ports and explicit overrides into one editable view', () => {
    const config = pipe([
      {
        id: 't',
        tasks: [
          task('up', {
            command: 'emit',
            outputs: {
              city: { type: 'string', description: 'Detected city' },
            },
          }),
          task('p', {
            prompt: 'Summarize {{inputs.city}}',
            depends_on: ['up'],
            inputs: {
              city: { type: 'string', description: 'User-facing city name' },
              localNote: { type: 'string', value: 'keep it short' },
            },
          }),
          task('down', {
            command: 'consume {{inputs.report}}',
            depends_on: ['p'],
            inputs: {
              report: { type: 'string', required: true },
            },
          }),
        ],
      },
    ]);

    const inferred = buildInferredPromptPorts(config, 't.p');
    const view = buildUnifiedPortsView({
      inputs: config.tracks[0]!.tasks[1]!.inputs,
      outputs: config.tracks[0]!.tasks[1]!.outputs,
      inferred,
    });

    expect(view.inputs.map((row) => [row.name, row.status, row.source.kind])).toEqual([
      ['city', 'overridden', 'auto_by_name'],
      ['localNote', 'manual', 'literal_value'],
    ]);
    expect(view.outputs.map((row) => [row.name, row.status, row.source.label])).toEqual([
      ['report', 'inferred', 'Expected by downstream'],
    ]);
  });

  test('describes user-friendly sources instead of raw from/default/value columns', () => {
    const view = buildUnifiedPortsView({
      inputs: {
        city: { type: 'string' },
        profileCity: { type: 'string', from: 'profile.city' },
        tone: { type: 'enum', enum: ['brief', 'full'], default: 'brief' },
        literal: { type: 'number', value: 3 },
      },
      outputs: {
        report: { type: 'string' },
        stdoutText: { type: 'string', from: 'stdout' },
      },
    });

    expect(view.inputs.map((row) => [row.name, row.source.kind, row.source.label])).toEqual([
      ['city', 'auto_by_name', 'Auto by name'],
      ['profileCity', 'specific_upstream', 'Specific upstream output'],
      ['tone', 'default_value', 'Default value'],
      ['literal', 'literal_value', 'Literal value'],
    ]);
    expect(view.outputs.map((row) => [row.name, row.source.kind, row.source.detail])).toEqual([
      ['report', 'output_json', 'json.report'],
      ['stdoutText', 'output_stream', 'stdout'],
    ]);
  });

  test('keeps prompt inference conflicts in the same rows as normal ports', () => {
    const view = buildUnifiedPortsView({
      inferred: {
        ports: {},
        inputConflicts: [
          {
            portName: 'city',
            producers: [
              { taskId: 't.weather', type: 'string' },
              { taskId: 't.profile', type: 'string' },
            ],
            reason: 'input "city" is produced by multiple upstream Commands',
          },
        ],
        outputConflicts: [],
        upstreamIds: ['t.weather', 't.profile'],
        downstreamIds: [],
      },
    });

    expect(view.inputs).toHaveLength(1);
    expect(view.inputs[0]).toMatchObject({
      name: 'city',
      kind: 'input',
      status: 'conflict',
      source: {
        kind: 'conflict',
        label: 'Needs explicit source',
      },
    });
  });
});
