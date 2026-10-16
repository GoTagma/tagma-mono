import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTagma, type PipelineConfig, type RunEventPayload } from '@tagma/sdk';
import type { TaskState } from '@tagma/types';
import { serializePipeline } from '@tagma/sdk/yaml';
import {
  evaluateTrialCoreContentExpectations,
  observeTrialSourceTextRelations,
  type TrialSourceTextObservation,
} from '../server/chat-pipeline-trial-run';
import type { ChatPipelineTrialExpectation } from '../server/chat-pipeline-trial-plan';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const relation: Extract<ChatPipelineTrialExpectation, { type: 'file-source-text-occurrence' }> = {
  type: 'file-source-text-occurrence',
  path: 'proof/report.md',
  sourcePath: 'proof/source.json',
  sourcePointer: '/text',
  producerTaskId: 'derive.emit',
  consumerTaskId: 'present.render',
  present: true,
};

async function execute(layout: 'direct' | 'transitive' | 'qualified') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-source-dependencies-')));
  roots.push(root);
  mkdirSync(join(root, '.tagma', 'proof'), { recursive: true });
  const command = (code: string) => ({ argv: [process.execPath, '-e', code] });
  const config: PipelineConfig = {
    name: 'Computed source through SDK dependency references',
    tracks: [
      {
        id: 'derive',
        name: 'Derive',
        cwd: '.tagma/proof',
        tasks: [
          {
            id: 'emit',
            name: 'Emit computed source',
            command: command(
              "const fs=require('node:fs');fs.writeFileSync('source.json',JSON.stringify({text:'Derived quantity '+(3+4)}));",
            ),
            completion: { type: 'file_exists', path: 'source.json' },
          },
        ],
      },
      ...(layout === 'transitive'
        ? [
            {
              id: 'middle',
              name: 'Intermediate gate',
              cwd: '.tagma/proof',
              tasks: [
                {
                  id: 'gate',
                  name: 'Intermediate gate',
                  depends_on: ['emit'],
                  command: command('void 0'),
                },
              ],
            },
          ]
        : []),
      {
        id: 'present',
        name: 'Present',
        cwd: '.tagma/proof',
        tasks: [
          {
            id: 'render',
            name: 'Render actual source',
            depends_on: [
              layout === 'qualified' ? 'derive.emit' : layout === 'direct' ? 'emit' : 'gate',
            ],
            command: command(
              "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync('source.json','utf8'));fs.writeFileSync('report.md','# Computed result\\n'+s.text);",
            ),
            completion: { type: 'file_exists', path: 'report.md' },
          },
        ],
      },
    ],
  };
  const runId = 'run_source_reference_' + layout;
  const observations = new Map<string, TrialSourceTextObservation>();
  const actual = await createTagma().runYaml(serializePipeline(config), {
    cwd: root,
    runId,
    skipPluginLoading: true,
    onEvent: (event: RunEventPayload) =>
      observeTrialSourceTextRelations(
        event,
        runId,
        root,
        'proof/proof.yaml',
        { expectations: [relation] },
        observations,
      ),
  });
  expect(actual.kind).toBe('pipeline');
  if (actual.kind !== 'pipeline') throw new Error('Actual local pipeline required');
  expect(actual.result.success).toBe(true);
  expect([...actual.result.states.values()].every((state) => state.status === 'success')).toBe(
    true,
  );
  const assess = (result = actual.result) =>
    evaluateTrialCoreContentExpectations(
      root,
      'proof/proof.yaml',
      { expectations: [relation] },
      [0],
      result,
      1,
      observations,
    )[0]!;
  return { actual: actual.result, assess };
}

for (const layout of ['direct', 'transitive'] as const) {
  test('actual source relation accepts SDK unique global bare dependency: ' + layout, async () => {
    const h = await execute(layout);
    const assessment = h.assess();
    expect(assessment.passed).toBe(true);
    expect(assessment.sourceTextEvidence).toMatchObject({
      producerCompletionObserved: true,
      consumerStartObserved: true,
      producerStatus: 'success',
      consumerStatus: 'success',
      producerResultPresent: true,
      consumerResultPresent: true,
    });
    expect(assessment.sourceTextEvidence!.finalSourceSha256).toBe(
      assessment.sourceTextEvidence!.capturedSourceSha256,
    );
  });
}

test('source dependency resolution preserves qualified identity local precedence ambiguity and missing-edge fences', async () => {
  const h = await execute('qualified');
  expect(h.assess().passed).toBe(true);
  const consumer = h.actual.states.get('present.render')!;
  const producer = h.actual.states.get('derive.emit')!;
  const withGraph = (
    depends_on: string[],
    extra: readonly (readonly [string, TaskState])[] = [],
  ) => {
    const states = new Map(h.actual.states);
    states.set('present.render', { ...consumer, config: { ...consumer.config, depends_on } });
    for (const [id, state] of extra) states.set(id, state);
    return { ...h.actual, states };
  };
  // Counterfeit graph metadata cannot establish a dependency on a successful but unrelated producer.
  const localShadow = ['present.emit', { ...producer, trackConfig: consumer.trackConfig }] as const;
  expect(h.assess(withGraph(['emit'], [localShadow])).passed).toBe(false);
  const globalAmbiguity = [
    'other.emit',
    {
      ...producer,
      trackConfig: { ...producer.trackConfig, id: 'other' },
    },
  ] as const;
  expect(h.assess(withGraph(['emit'], [globalAmbiguity])).passed).toBe(false);
  expect(h.assess(withGraph(['derive.emit'], [globalAmbiguity])).passed).toBe(true);
  for (const reference of ['missing', 'missing.emit', 'present.render']) {
    expect(h.assess(withGraph([reference])).passed).toBe(false);
  }
  expect(h.assess().passed).toBe(true);
});
