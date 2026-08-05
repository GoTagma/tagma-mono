import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PipelineConfig } from '@tagma/sdk';

import {
  findUncoveredTrialFixtureInputs,
  resolveChatPipelineDataReadiness,
  resolveChatPipelineRuntimeReadiness,
} from '../server/chat-pipeline-trial-readiness';
import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';

function pipelineWithMissingInput(): PipelineConfig {
  return {
    name: 'Prerequisite readiness',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'ingest',
            name: 'Ingest',
            command: { argv: ['node', '-e', ''] },
            trigger: { type: 'file', path: 'input/article.md' },
          },
          {
            id: 'verify',
            name: 'Verify',
            command: { argv: ['node', '-e', ''] },
            depends_on: ['ingest'],
          },
          {
            id: 'independent',
            name: 'Independent',
            command: { argv: ['node', '-e', ''] },
          },
        ],
      },
    ],
  } as PipelineConfig;
}

function trialPlan(fixtures: Array<{ path: string; content: string }>): ChatPipelineTrialPlan {
  return {
    version: 3,
    yamlHash: 'a'.repeat(40),
    summary: 'Exercise the missing input through an isolated case.',
    goals: ['Run the selected task and all upstream prerequisites.'],
    coverage: [],
    findings: [],
    cases: [
      {
        id: 'representative-input',
        title: 'Representative input',
        objective: 'Verify downstream behavior without changing the live workspace.',
        runs: 1,
        targetTaskIds: ['main.verify'],
        fixtures,
        expectations: [],
      },
    ],
  };
}

describe('chat pipeline Trial readiness', () => {
  test('models unavailable local data as fixture-backed without suppressing runnable roots', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-trial-readiness-'));
    try {
      const readiness = resolveChatPipelineDataReadiness(pipelineWithMissingInput(), workDir);

      expect(readiness).toEqual({
        state: 'fixture-backed',
        baseline: { mode: 'targeted', targetTaskIds: ['main.independent'] },
        inputs: [
          {
            taskId: 'main.ingest',
            type: 'file',
            path: 'input/article.md',
            fixturePath: 'input/article.md',
          },
        ],
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('requires every fixture-backed input in a case whose target closure runs its task', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-trial-readiness-'));
    try {
      const config = pipelineWithMissingInput();
      const readiness = resolveChatPipelineDataReadiness(config, workDir);
      if (readiness.state !== 'fixture-backed') throw new Error('fixture readiness expected');

      expect(findUncoveredTrialFixtureInputs(trialPlan([]), readiness.inputs, config)).toEqual(
        readiness.inputs,
      );
      expect(
        findUncoveredTrialFixtureInputs(
          trialPlan([{ path: 'input/article.md', content: 'Representative claim.' }]),
          readiness.inputs,
          config,
        ),
      ).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('models non-virtualizable runtime requirements as blockers', () => {
    expect(
      resolveChatPipelineRuntimeReadiness({
        missingBinaries: ['fact-cli'],
        missingEnvironment: ['FACT_API_KEY'],
      }),
    ).toEqual({
      state: 'blocked',
      blockers: [
        { kind: 'binary', name: 'fact-cli' },
        { kind: 'environment', name: 'FACT_API_KEY' },
      ],
    });
  });
});
