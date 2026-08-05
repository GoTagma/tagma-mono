import { lstatSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import type { PipelineConfig } from '@tagma/sdk';
import { buildDag } from '@tagma/sdk/config';

import type { ChatPipelineTrialPlan } from './chat-pipeline-trial-plan.js';
import { isPathWithin } from './path-utils.js';

export interface ChatPipelineTrialFixtureInput {
  taskId: string;
  type: 'file' | 'directory';
  path: string;
  fixturePath: string;
}

export interface ChatPipelineTrialBlocker {
  kind:
    | 'binary'
    | 'environment'
    | 'external-data-path'
    | 'service'
    | 'credential'
    | 'approval';
  name: string;
  taskId?: string;
}

export type ChatPipelineTrialReadiness =
  | { state: 'runnable' }
  | {
      state: 'fixture-backed';
      baseline:
        | { mode: 'targeted'; targetTaskIds: string[] }
        | { mode: 'skip' };
      inputs: ChatPipelineTrialFixtureInput[];
    }
  | { state: 'blocked'; blockers: ChatPipelineTrialBlocker[] };

export type ChatPipelineTrialRecordedPrerequisiteState = Exclude<
  ChatPipelineTrialReadiness,
  { state: 'runnable' }
>;

function inputIsReady(path: string, type: ChatPipelineTrialFixtureInput['type']): boolean {
  try {
    const stat = lstatSync(path);
    return type === 'directory' ? stat.isDirectory() : !stat.isDirectory();
  } catch {
    return false;
  }
}

export function resolveChatPipelineDataReadiness(
  pipelineConfig: PipelineConfig,
  workDir: string,
): ChatPipelineTrialReadiness {
  const roots = [...buildDag(pipelineConfig).nodes.values()].filter(
    (node) => node.dependsOn.length === 0,
  );
  const inputs: ChatPipelineTrialFixtureInput[] = [];
  const blockers: ChatPipelineTrialBlocker[] = [];
  for (const { track, task } of roots) {
    const trigger = task.trigger;
    if (
      (trigger?.type !== 'file' && trigger?.type !== 'directory') ||
      typeof trigger.path !== 'string' ||
      trigger.path.trim().length === 0
    ) {
      continue;
    }

    const taskWorkDir = resolve(workDir, task.cwd ?? track.cwd ?? '.');
    const inputPath = resolve(taskWorkDir, trigger.path);
    if (inputIsReady(inputPath, trigger.type)) {
      continue;
    }

    const taskId = `${track.id}.${task.id}`;
    const fixturePath = relative(workDir, inputPath).replace(/\\/g, '/');
    if (!fixturePath || !isPathWithin(inputPath, workDir)) {
      blockers.push({ kind: 'external-data-path', name: trigger.path, taskId });
      continue;
    }
    inputs.push({
      taskId,
      type: trigger.type,
      path: trigger.path,
      fixturePath,
    });
  }

  if (blockers.length > 0) return { state: 'blocked', blockers };
  if (inputs.length > 0) {
    const dag = buildDag(pipelineConfig);
    const fixtureTaskIds = new Set(inputs.map((input) => input.taskId));
    const fixtureDependent = new Map<string, boolean>();
    const dependsOnFixture = (taskId: string): boolean => {
      const cached = fixtureDependent.get(taskId);
      if (cached !== undefined) return cached;
      if (fixtureTaskIds.has(taskId)) {
        fixtureDependent.set(taskId, true);
        return true;
      }
      const dependent = dag.nodes.get(taskId)?.dependsOn.some(dependsOnFixture) ?? false;
      fixtureDependent.set(taskId, dependent);
      return dependent;
    };
    const targetTaskIds = [...dag.nodes.keys()].filter((taskId) => !dependsOnFixture(taskId));
    return {
      state: 'fixture-backed',
      baseline:
        targetTaskIds.length > 0
          ? { mode: 'targeted', targetTaskIds }
          : { mode: 'skip' },
      inputs,
    };
  }
  return { state: 'runnable' };
}

export function resolveChatPipelineRuntimeReadiness(input: {
  missingBinaries: readonly string[];
  missingEnvironment: readonly string[];
}): ChatPipelineTrialReadiness {
  const blockers: ChatPipelineTrialBlocker[] = [
    ...input.missingBinaries.map((name) => ({ kind: 'binary' as const, name })),
    ...input.missingEnvironment.map((name) => ({ kind: 'environment' as const, name })),
  ];
  return blockers.length > 0 ? { state: 'blocked', blockers } : { state: 'runnable' };
}

function targetSelectionRunsTask(
  dag: ReturnType<typeof buildDag>,
  targetTaskIds: readonly string[],
  requiredTaskId: string,
): boolean {
  const pending = [...targetTaskIds];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const taskId = pending.pop()!;
    if (taskId === requiredTaskId) return true;
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const node = dag.nodes.get(taskId);
    if (node) pending.push(...node.dependsOn);
  }
  return false;
}

export function findUncoveredTrialFixtureInputs(
  plan: ChatPipelineTrialPlan,
  inputs: readonly ChatPipelineTrialFixtureInput[],
  pipelineConfig: PipelineConfig,
): ChatPipelineTrialFixtureInput[] {
  const dag = buildDag(pipelineConfig);
  return inputs.filter((input) => {
    const expectedPath = input.fixturePath.replace(/\\/g, '/').replace(/^\.\//, '');
    return !plan.cases.some((testCase) => {
      if (!targetSelectionRunsTask(dag, testCase.targetTaskIds, input.taskId)) return false;
      return testCase.fixtures.some((fixture) => {
        const fixturePath = fixture.path.replace(/\\/g, '/').replace(/^\.\//, '');
        return input.type === 'file'
          ? fixturePath === expectedPath
          : fixturePath.startsWith(`${expectedPath}/`);
      });
    });
  });
}

export function describeTrialFixtureInputs(
  inputs: readonly ChatPipelineTrialFixtureInput[],
): string {
  return inputs.map((input) => `${input.taskId} (${input.type}: ${input.path})`).join(', ');
}

export function describeUncoveredTrialFixtureInputs(
  inputs: readonly ChatPipelineTrialFixtureInput[],
): string {
  return inputs
    .map((input) =>
      input.type === 'file'
        ? `${input.taskId} needs the exact isolated fixture ${input.fixturePath}`
        : `${input.taskId} needs at least one isolated file fixture below ${input.fixturePath}/`,
    )
    .join('; ');
}

export function describeTrialBlockers(blockers: readonly ChatPipelineTrialBlocker[]): string {
  return blockers.map((blocker) => `${blocker.kind}=${blocker.name}`).join('; ');
}
