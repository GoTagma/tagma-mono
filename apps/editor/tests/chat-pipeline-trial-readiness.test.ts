import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PipelineConfig } from '@tagma/sdk';

import {
  chatPipelineTrialCasePathFromWorkspacePath,
  chatPipelineTrialWorkspacePathFromCasePath,
  findUncoveredTrialFixtureInputs,
  resolveChatPipelineDataReadiness,
  resolveChatPipelineRuntimeReadiness,
  resolveChatPipelineTargetRuntimeReadiness,
} from '../server/chat-pipeline-trial-readiness';
import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';

function pipelineWithMissingInput(
  cwd?: string,
  trigger: { type: 'file' | 'directory'; path: string } = {
    type: 'file',
    path: 'input/article.md',
  },
): PipelineConfig {
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
            ...(cwd ? { cwd } : {}),
            command: { argv: ['node', '-e', ''] },
            trigger,
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
    version: 6,
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

  test('uses the isolated case namespace for a missing input inside the pipeline folder', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-trial-readiness-'));
    try {
      const config = pipelineWithMissingInput('.tagma/pipeline');
      const readiness = resolveChatPipelineDataReadiness(config, workDir, 'pipeline/pipeline.yaml');
      if (readiness.state !== 'fixture-backed') throw new Error('fixture readiness expected');

      expect(readiness.inputs).toEqual([
        {
          taskId: 'main.ingest',
          type: 'file',
          path: 'input/article.md',
          fixturePath: 'pipeline/input/article.md',
        },
      ]);
      expect(
        findUncoveredTrialFixtureInputs(
          trialPlan([{ path: 'pipeline/input/article.md', content: 'Representative claim.' }]),
          readiness.inputs,
          config,
        ),
      ).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('covers a missing pipeline directory with a descendant fixture', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-trial-readiness-'));
    try {
      const config = pipelineWithMissingInput('.tagma/pipeline', {
        type: 'directory',
        path: 'input/articles',
      });
      const readiness = resolveChatPipelineDataReadiness(config, workDir, 'pipeline/pipeline.yaml');
      if (readiness.state !== 'fixture-backed') throw new Error('fixture readiness expected');

      expect(readiness.inputs[0]?.fixturePath).toBe('pipeline/input/articles');
      expect(
        findUncoveredTrialFixtureInputs(
          trialPlan([
            {
              path: 'pipeline/input/articles/claim.md',
              content: 'Representative claim.',
            },
          ]),
          readiness.inputs,
          config,
        ),
      ).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('maps only the current pipeline namespace between case and workspace paths', () => {
    const relativeYamlPath = 'pipeline/pipeline.yaml';

    expect(
      chatPipelineTrialCasePathFromWorkspacePath(
        '.tagma/pipeline/input/article.md',
        relativeYamlPath,
      ),
    ).toBe('pipeline/input/article.md');
    expect(
      chatPipelineTrialCasePathFromWorkspacePath(
        '.tagma/pipeline-other/input/article.md',
        relativeYamlPath,
      ),
    ).toBe('.tagma/pipeline-other/input/article.md');
    expect(
      chatPipelineTrialWorkspacePathFromCasePath('pipeline/output/report.json', relativeYamlPath),
    ).toBe('.tagma/pipeline/output/report.json');
    expect(
      chatPipelineTrialWorkspacePathFromCasePath(
        'pipeline-other/output/report.json',
        relativeYamlPath,
      ),
    ).toBe('pipeline-other/output/report.json');
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

  test('scopes missing binaries to target closures while retaining global blockers', () => {
    const config = {
      name: 'Scoped runtime requirements',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            { id: 'blocked', name: 'Blocked', command: 'fact-cli run' },
            {
              id: 'downstream',
              name: 'Downstream',
              command: 'echo downstream',
              depends_on: ['blocked'],
            },
            { id: 'independent', name: 'Independent', command: 'echo independent' },
          ],
        },
      ],
    } as PipelineConfig;
    const taskRequirement = {
      name: 'fact-cli',
      usedBy: ['main.blocked.completion.output_check'],
    };

    expect(
      resolveChatPipelineTargetRuntimeReadiness({
        pipelineConfig: config,
        targetTaskIds: ['main.independent'],
        missingBinaries: [taskRequirement],
        missingEnvironment: [],
      }),
    ).toEqual({ state: 'runnable' });
    expect(
      resolveChatPipelineTargetRuntimeReadiness({
        pipelineConfig: config,
        targetTaskIds: ['main.downstream'],
        missingBinaries: [taskRequirement],
        missingEnvironment: [],
      }),
    ).toEqual({
      state: 'blocked',
      blockers: [{ kind: 'binary', name: 'fact-cli', taskId: 'main.blocked' }],
    });
    expect(
      resolveChatPipelineTargetRuntimeReadiness({
        pipelineConfig: config,
        targetTaskIds: ['main.independent'],
        missingBinaries: [{ name: 'hook-cli', usedBy: ['hooks.pipeline_start'] }],
        missingEnvironment: [],
      }),
    ).toEqual({
      state: 'blocked',
      blockers: [{ kind: 'binary', name: 'hook-cli' }],
    });
  });
});
