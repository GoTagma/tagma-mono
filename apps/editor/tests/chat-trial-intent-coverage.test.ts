import { expect, test } from 'bun:test';
import type { PipelineConfig } from '@tagma/sdk';

import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';
import { missingExplicitResilienceEvidence } from '../server/chat-trial-intent-coverage';

function plan(cases: ChatPipelineTrialPlan['cases']): ChatPipelineTrialPlan {
  return {
    version: 11,
    yamlHash: 'a'.repeat(40),
    summary: 'Exercise a document workflow.',
    goals: ['Produce a usable report.'],
    coverage: [],
    findings: [],
    cases,
  };
}

const normal = {
  id: 'normal',
  title: 'Ordinary document',
  objective: 'Produce a report from a normal document.',
  runs: 1,
  targetTaskIds: ['audit.report'],
  fixtures: [{ path: 'input.md', content: 'A factual statement.' }],
  expectations: [
    { type: 'task-status' as const, taskId: 'audit.report', status: 'success' as const },
    { type: 'path-exists' as const, path: 'report.md' },
    { type: 'file-not-contains' as const, path: 'report.md', text: 'UNVERIFIED' },
    { type: 'file-not-contains' as const, path: 'report.md', text: 'Quote not located in source' },
  ],
};

test('ordinary success does not discharge an explicit timeout recovery promise', () => {
  expect(
    missingExplicitResilienceEvidence(
      'When web search times out, continue and produce an audit report with unverified claims.',
      plan([normal]),
    ),
  ).toContain('timeout-recovery');
  expect(
    missingExplicitResilienceEvidence(
      'Handle web-search timeouts by still producing a truthful audit.',
      plan([normal]),
    ),
  ).toContain('timeout-recovery');
});

test('an external failure recovery promise needs a separate controlled branch', () => {
  const intent = 'If the provider is unavailable, still write a degraded report.';
  expect(missingExplicitResilienceEvidence(intent, plan([normal]))).toContain('failure-recovery');
  const baseline = {
    ...normal,
    expectations: [
      ...normal.expectations,
      { type: 'file-not-contains' as const, path: 'report.md', text: 'Provider unavailable' },
    ],
  };
  const failureCase = {
    ...normal,
    id: 'provider-offline',
    title: 'Provider unavailable',
    objective: 'Simulate provider failure and still write a degraded report.',
    environment: [{ name: 'AUDIT_TEST_FAULT', value: 'unavailable' }],
    expectations: [
      ...normal.expectations.filter((item) => item.type !== 'file-not-contains'),
      { type: 'file-contains' as const, path: 'report.md', text: 'Provider unavailable' },
    ],
  };
  expect(missingExplicitResilienceEvidence(intent, plan([baseline, failureCase]))).toEqual([]);
});

test('a controlled failure case with downstream output evidence covers timeout recovery', () => {
  const timeoutCase = {
    ...normal,
    id: 'timeout',
    title: 'Search timeout fallback',
    objective: 'Force a search timeout and verify that the final report still appears.',
    environment: [{ name: 'AUDIT_TEST_FAULT', value: 'timeout' }],
    expectations: [
      ...normal.expectations.filter((item) => item.type !== 'file-not-contains'),
      { type: 'file-contains' as const, path: 'report.md', text: 'UNVERIFIED' },
    ],
  };
  expect(
    missingExplicitResilienceEvidence(
      'If the remote verifier times out, continue to a report marked unverified.',
      plan([normal, timeoutCase]),
    ),
  ).not.toContain('timeout-recovery');
});

test('fault labels and output markers without a contrasting normal case are not proof', () => {
  const timeoutCase = {
    ...normal,
    id: 'timeout',
    title: 'Search timeout fallback',
    objective: 'Force a search timeout and produce a report.',
    environment: [{ name: 'AUDIT_TEST_FAULT', value: 'timeout' }],
    expectations: [
      { type: 'task-status' as const, taskId: 'audit.report', status: 'success' as const },
      { type: 'file-contains' as const, path: 'report.md', text: 'UNVERIFIED' },
    ],
  };
  expect(
    missingExplicitResilienceEvidence(
      'If search times out, continue and mark the report unverified.',
      plan([timeoutCase]),
    ),
  ).toContain('timeout-recovery');
  expect(
    missingExplicitResilienceEvidence(
      'If search times out, continue and mark the report unverified.',
      plan([
        { ...normal, fixtures: [{ path: 'input.md', content: 'Different input.' }] },
        timeoutCase,
      ]),
    ),
  ).toContain('timeout-recovery');
});

test('empty result and unlocated source promises need distinct observable branches', () => {
  const intent =
    'When there are no testable claims, still produce a no-claims report. If a claim cannot be located in the original source, list it explicitly in the report.';
  expect(missingExplicitResilienceEvidence(intent, plan([normal]))).toEqual([
    'empty-result',
    'unlocated-source',
  ]);
  const emptyCase = {
    ...normal,
    id: 'empty',
    title: 'No testable claims',
    objective: 'A nonempty opinion-only document produces zero claims and a report.',
    fixtures: [{ path: 'input.md', content: 'I think this is wonderful.' }],
    expectations: [
      ...normal.expectations.filter((item) => item.type !== 'file-not-contains'),
      {
        type: 'json-pointer-equals' as const,
        path: 'claims.json',
        pointer: '',
        expectedJson: '[]',
      },
      { type: 'file-contains' as const, path: 'report.md', text: 'No testable claims' },
    ],
  };
  const unlocatedCase = {
    ...normal,
    id: 'unlocated',
    title: 'Claim without source span',
    objective: 'Inject an unlocated quote and preserve the report.',
    environment: [{ name: 'AUDIT_TEST_FAULT', value: 'unlocated' }],
    expectations: [
      ...normal.expectations.filter((item) => item.type !== 'file-not-contains'),
      { type: 'file-contains' as const, path: 'report.md', text: 'Quote not located in source' },
    ],
  };
  expect(
    missingExplicitResilienceEvidence(intent, plan([normal, emptyCase, unlocatedCase])),
  ).toEqual([]);
});

test('normal requests and mere timeout limits do not demand fallback cases', () => {
  expect(
    missingExplicitResilienceEvidence(
      'Create a command pipeline with a 10 minute timeout.',
      plan([normal]),
    ),
  ).toEqual([]);
  expect(missingExplicitResilienceEvidence('Write a Markdown report.', plan([normal]))).toEqual([]);
  expect(
    missingExplicitResilienceEvidence('If the provider fails, report the error.', plan([normal])),
  ).toEqual([]);
  expect(
    missingExplicitResilienceEvidence(
      'Set a ten minute timeout. Write a report from an ordinary input.',
      plan([normal]),
    ),
  ).toEqual([]);
  expect(
    missingExplicitResilienceEvidence(
      'When no testable claims are found. Still produce a report.',
      plan([normal]),
    ),
  ).toContain('empty-result');
});

test('document fact-checking requires boundary and source-preservation evidence without enumerated fallbacks', () => {
  const intent = `Create a document fact-checking pipeline. Extract claims from the draft,
    verify claims against the web, and generate an annotated original draft with sources.
    Ensure headless OpenCode timeouts.`;
  const fixture = {
    ...normal,
    fixtures: [
      {
        path: 'input.md',
        content:
          '# Energy Brief\nRenewable generation was 92 percent in 2024.\nThe plant opened in 2015.\nA final paragraph remains unchanged.',
      },
    ],
  };
  expect(missingExplicitResilienceEvidence(intent, plan([fixture]))).toEqual([
    'timeout-recovery',
    'empty-result',
    'unlocated-source',
    'source-preservation',
  ]);
  const markerOnly = {
    ...fixture,
    expectations: [
      ...fixture.expectations,
      { type: 'file-contains' as const, path: 'report.md', text: '# Energy Brief' },
      {
        type: 'file-contains' as const,
        path: 'report.md',
        text: 'Renewable generation was 92 percent in 2024.',
      },
      { type: 'file-contains' as const, path: 'report.md', text: 'The plant opened in 2015.' },
      {
        type: 'file-contains' as const,
        path: 'report.md',
        text: 'A final paragraph remains unchanged.',
      },
    ],
  };
  expect(missingExplicitResilienceEvidence(intent, plan([markerOnly]))).toContain(
    'source-preservation',
  );
  const preserved = {
    ...fixture,
    expectations: [
      ...fixture.expectations,
      {
        type: 'file-preserves-lines' as const,
        path: 'report.md',
        sourcePath: 'input.md',
        text: fixture.fixtures[0]!.content,
      },
    ],
  };
  expect(missingExplicitResilienceEvidence(intent, plan([preserved]))).not.toContain(
    'source-preservation',
  );
});

test('a named fault switch is insufficient when the targeted task closure never reads it', () => {
  const timeoutCase = {
    ...normal,
    id: 'timeout',
    title: 'Search timeout fallback',
    objective: 'Force a timeout and produce an unverified report.',
    environment: [{ name: 'AUDIT_TEST_FAULT', value: 'timeout' }],
    expectations: [
      ...normal.expectations.filter((item) => item.type !== 'file-not-contains'),
      { type: 'file-contains' as const, path: 'report.md', text: 'UNVERIFIED' },
    ],
  };
  const config = (command: string) =>
    ({
      name: 'Audit',
      tracks: [
        {
          id: 'audit',
          name: 'Audit',
          tasks: [{ id: 'report', name: 'Report', command }],
        },
      ],
    }) as PipelineConfig;
  const intent = 'If verification times out, continue to an unverified report.';
  expect(
    missingExplicitResilienceEvidence(
      intent,
      plan([normal, timeoutCase]),
      config('echo UNVERIFIED > report.md'),
    ),
  ).toContain('timeout-recovery');
  expect(
    missingExplicitResilienceEvidence(
      intent,
      plan([normal, timeoutCase]),
      config(
        'if [ "$AUDIT_TEST_FAULT" = timeout ]; then echo UNVERIFIED > report.md; else echo VERIFIED > report.md; fi',
      ),
    ),
  ).toEqual([]);
});
