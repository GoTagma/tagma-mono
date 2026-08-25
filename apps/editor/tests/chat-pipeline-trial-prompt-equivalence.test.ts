import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { DriverPlugin } from '@tagma/types';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
} from '../server/chat-yaml-staging';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import { CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS } from '../server/chat-pipeline-trial-plan';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const roots: string[] = [];

const captureDriver: DriverPlugin = {
  name: 'opencode',
  capabilities: {
    sessionResume: false,
    systemPrompt: false,
    outputFormat: false,
  },
  trial: {
    protocolVersion: 1,
    interaction: 'none',
    unattended: 'native',
    filesystem: 'temp-only',
    network: 'none',
    secrets: 'none',
    runtime: 'bounded',
  },
  async buildCommand(task) {
    return {
      args: [
        process.execPath,
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        task.prompt ?? '',
      ],
    };
  },
  parseResult(stdout) {
    return { normalizedOutput: stdout };
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Sandbox Trial sends prompt tasks the same business prompt as production', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-prompt-equivalence-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = ['pipeline:', '  name: Base', '  tracks: []', ''].join('\n');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml, 'utf8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: false,
    }),
    'utf8',
  );

  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);
  ws.registry.registerPlugin('drivers', 'opencode', captureDriver, { replace: true });

  const businessPrompt = 'How are you? Reply naturally and do not use tools.';
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Prompt Equivalence',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'answer',
              name: 'Answer',
              prompt: businessPrompt,
              driver: 'opencode',
              permissions: { read: false, write: false, execute: false },
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);

  const yamlHash = createHash('sha1').update(readFileSync(entry.stagedPath, 'utf8')).digest('hex');
  const caseId = 'same-business-prompt';
  writeFileSync(
    entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify({
      version: 8,
      yamlHash,
      summary: 'Verify the fixed prompt without modifying it.',
      goals: ['Keep the production prompt byte-equivalent in Sandbox Trial.'],
      coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
        dimension,
        status: 'not-applicable',
        caseIds: [],
        rationale: 'This focused case verifies prompt equivalence only.',
      })),
      findings: [],
      cases: [
        {
          id: caseId,
          title: 'Same business prompt',
          objective: 'Run the exact authored prompt.',
          runs: 1,
          targetTaskIds: ['main.answer'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.answer', status: 'success' }],
        },
      ],
    }),
    'utf8',
  );
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);

  // The full-check runner intentionally does not stage OpenCode. Runtime
  // readiness still validates the built-in driver's generated requirement,
  // even though this test replaces its execution plugin with a capture stub.
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'tagma-fake-opencode-'));
  roots.push(fakeBinDir);
  const fakeOpencodePath = join(
    fakeBinDir,
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
  );
  writeFileSync(
    fakeOpencodePath,
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n',
    process.platform === 'win32' ? undefined : { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${delimiter}${previousPath ?? ''}`;

  try {
    const result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'prompt_equivalence',
    });

    if (!result.success) {
      throw new Error(`Sandbox Trial failed before prompt comparison: ${result.summary}`);
    }
    expect(result.plan?.cases).toMatchObject([
      { id: 'host-fixed-prompt-repeat', runs: 2, targetTaskIds: ['main.answer'] },
    ]);
    const task = result.tasks.find((candidate) => candidate.taskId === 'main.answer');
    expect(task?.stdout).toBe(businessPrompt);
    expect(task?.stdout).not.toContain('Targeted Trial Case');
    expect(task?.stdout).not.toContain('Isolated workspace');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    discardChatYamlStage(ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }
});
