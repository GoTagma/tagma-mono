import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildChatPipelineTrialCaseReuseFingerprint,
  hashChatPipelineTrialReusableSupportTree,
} from '../server/chat-pipeline-trial-reuse';

function pipeline(verifyPrompt = 'Verify the report', corpusCommand = 'printf corpus'): never {
  return {
    name: 'Fact Checker',
    max_concurrency: 4,
    tracks: [
      {
        id: 'retrieval',
        name: 'Retrieval',
        cwd: '/workspace/.tagma/fact-checker',
        on_failure: 'skip_downstream',
        permissions: { read: true, write: false, execute: false },
        driver: 'opencode',
        tasks: [
          {
            id: 'corpus',
            name: 'Corpus',
            command: corpusCommand,
            cwd: '/workspace/.tagma/fact-checker',
            depends_on: [],
            permissions: { read: true, write: false, execute: false },
            driver: 'opencode',
          },
        ],
      },
      {
        id: 'verification',
        name: 'Verification',
        cwd: '/workspace/.tagma/fact-checker',
        on_failure: 'skip_downstream',
        permissions: { read: true, write: false, execute: false },
        driver: 'opencode',
        tasks: [
          {
            id: 'verify',
            name: 'Verify',
            prompt: verifyPrompt,
            cwd: '/workspace/.tagma/fact-checker',
            depends_on: ['retrieval.corpus'],
            permissions: { read: true, write: false, execute: false },
            driver: 'opencode',
          },
        ],
      },
    ],
  } as never;
}

const corpusCase = {
  id: 'corpus',
  title: 'Corpus command',
  objective: 'Build deterministic corpus evidence.',
  runs: 1,
  targetTaskIds: ['retrieval.corpus'],
  fixtures: [{ path: 'fact-checker/sources.yaml', content: 'sources: []\n' }],
  generatedInputPaths: [],
  expectations: [
    { type: 'task-status' as const, taskId: 'retrieval.corpus', status: 'success' as const },
  ],
};

const common = {
  relativeYamlPath: 'fact-checker/fact-checker.yaml',
  supportTreeHash: 'support-v1',
  trialabilityReportHash: 'trialability-v1',
  trialMode: 'sandbox' as const,
  runtimeMode: 'broker' as const,
};

test('reuses a command-only case when an unrelated prompt task changes', () => {
  const first = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: pipeline('Verify v1'),
    testCase: corpusCase,
  });
  const second = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: pipeline('Verify v2'),
    testCase: corpusCase,
  });

  expect(first).not.toBeNull();
  expect(second).toBe(first);
});

test('invalidates reuse when the command closure, fixture, or support tree changes', () => {
  const original = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: pipeline(),
    testCase: corpusCase,
  });
  const commandChanged = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: pipeline('Verify the report', 'printf revised'),
    testCase: corpusCase,
  });
  const fixtureChanged = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: pipeline(),
    testCase: {
      ...corpusCase,
      fixtures: [{ path: 'fact-checker/sources.yaml', content: 'sources: [changed]\n' }],
    },
  });
  const supportChanged = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    supportTreeHash: 'support-v2',
    pipelineConfig: pipeline(),
    testCase: corpusCase,
  });

  expect(original).not.toBe(commandChanged);
  expect(original).not.toBe(fixtureChanged);
  expect(original).not.toBe(supportChanged);
});

test('invalidates reuse when inherited pipeline permissions change', () => {
  const firstPipeline = structuredClone(pipeline()) as {
    permissions?: { read: boolean; write: boolean; execute: boolean };
    tracks: Array<{
      permissions?: unknown;
      tasks: Array<{ permissions?: unknown }>;
    }>;
  };
  delete firstPipeline.tracks[0]!.permissions;
  delete firstPipeline.tracks[0]!.tasks[0]!.permissions;
  firstPipeline.permissions = { read: true, write: false, execute: true };
  const secondPipeline = structuredClone(firstPipeline);
  secondPipeline.permissions = { read: true, write: false, execute: false };

  const first = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: firstPipeline as never,
    testCase: corpusCase,
  });
  const second = buildChatPipelineTrialCaseReuseFingerprint({
    ...common,
    pipelineConfig: secondPipeline as never,
    testCase: corpusCase,
  });

  expect(first).not.toBe(second);
});

test('support hashing ignores generated requirement timestamps but binds user-owned files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-reuse-support-'));
  try {
    const yamlPath = join(root, 'fact-checker.yaml');
    writeFileSync(yamlPath, 'pipeline:\n  name: Fact Checker\n', 'utf8');
    writeFileSync(
      join(root, 'fact-checker.requirements.md'),
      '---\ngeneratedAt: 2026-01-01T00:00:00.000Z\nenv: []\n---\n',
      'utf8',
    );
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'sources.yaml'), 'sources: []\n', 'utf8');
    const first = hashChatPipelineTrialReusableSupportTree(yamlPath);

    writeFileSync(
      join(root, 'fact-checker.requirements.md'),
      '---\ngeneratedAt: 2027-02-02T00:00:00.000Z\nenv: []\n---\n',
      'utf8',
    );
    expect(hashChatPipelineTrialReusableSupportTree(yamlPath)).toBe(first);

    writeFileSync(join(root, 'config', 'sources.yaml'), 'sources: [changed]\n', 'utf8');
    expect(hashChatPipelineTrialReusableSupportTree(yamlPath)).not.toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('never reuses a case whose selected closure contains a prompt task', () => {
  expect(
    buildChatPipelineTrialCaseReuseFingerprint({
      ...common,
      pipelineConfig: pipeline(),
      testCase: { ...corpusCase, targetTaskIds: ['verification.verify'] },
    }),
  ).toBeNull();
});
