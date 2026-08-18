import { lstatSync, readFileSync } from 'node:fs';
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
  kind: 'binary' | 'environment' | 'external-data-path' | 'service' | 'credential' | 'approval';
  name: string;
  taskId?: string;
}

export type ChatPipelineTrialReadiness =
  | { state: 'runnable' }
  | {
      state: 'fixture-backed';
      baseline: { mode: 'targeted'; targetTaskIds: string[] } | { mode: 'skip' };
      inputs: ChatPipelineTrialFixtureInput[];
    }
  | { state: 'blocked'; blockers: ChatPipelineTrialBlocker[] };

export type ChatPipelineLiveSmokeBaseline =
  | { mode: 'run-all'; manualGatedTaskIds: string[]; middlewareUnavailableTaskIds: string[] }
  | {
      mode: 'targeted';
      targetTaskIds: string[];
      manualGatedTaskIds: string[];
      middlewareUnavailableTaskIds: string[];
    }
  | { mode: 'skip'; manualGatedTaskIds: string[]; middlewareUnavailableTaskIds: string[] };

export interface ChatPipelineLiveSmokeArtifactProjection {
  livePipelineDir: string;
  stagedPipelineDir: string;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function projectedStaticContextMatches(
  liveFile: string,
  projection: ChatPipelineLiveSmokeArtifactProjection,
): boolean {
  if (!isPathWithin(liveFile, projection.livePipelineDir)) return isRegularFile(liveFile);
  const stagedFile = resolve(
    projection.stagedPipelineDir,
    relative(projection.livePipelineDir, liveFile),
  );
  if (!isPathWithin(stagedFile, projection.stagedPipelineDir)) return false;
  if (!isRegularFile(liveFile) || !isRegularFile(stagedFile)) return false;
  try {
    return readFileSync(liveFile).equals(readFileSync(stagedFile));
  } catch {
    return false;
  }
}

function missingStaticContextSources(
  workDir: string,
  node: {
    track: { cwd?: string; middlewares?: readonly unknown[] };
    task: { cwd?: string; prompt?: string; middlewares?: readonly unknown[] };
  },
  projection?: ChatPipelineLiveSmokeArtifactProjection,
  availabilityCache?: Map<string, boolean>,
): string[] {
  if (typeof node.task.prompt !== 'string') return [];
  const mws = node.task.middlewares ?? node.track.middlewares ?? [];
  const effectiveCwd = resolve(workDir, node.task.cwd ?? node.track.cwd ?? '.');
  const missing: string[] = [];
  for (const mw of mws) {
    const record = mw as { type?: unknown; file?: unknown };
    if (record.type !== 'static_context') continue;
    if (typeof record.file !== 'string' || record.file.trim().length === 0) continue;
    const resolvedFile = resolve(effectiveCwd, record.file);
    if (!isPathWithin(resolvedFile, workDir)) {
      missing.push(record.file);
      continue;
    }
    let available = availabilityCache?.get(resolvedFile);
    if (available === undefined) {
      available = projection
        ? projectedStaticContextMatches(resolvedFile, projection)
        : isRegularFile(resolvedFile);
      availabilityCache?.set(resolvedFile, available);
    }
    if (!available) missing.push(record.file);
  }
  return missing;
}

/**
 * Resolves which tasks the optional Live Smoke Test may execute in the real
 * workspace. Manual-trigger tasks are human approval boundaries: the Trial
 * never fabricates approval for them in the live smoke, so they and every
 * task that (transitively) depends on them are excluded from the baseline
 * and must be exercised through Sandbox cases instead. Tasks whose
 * `static_context` source is missing from the real workspace or differs
 * from the staged pipeline artifact are excluded the same way: running
 * them would use absent or stale promised context. Fixture-backed data
 * constraints from {@link resolveChatPipelineDataReadiness} are intersected
 * with both exclusions.
 */
export function resolveChatPipelineLiveSmokeBaseline(
  pipelineConfig: PipelineConfig,
  dataReadiness: ChatPipelineTrialReadiness,
  workDir: string,
  projection?: ChatPipelineLiveSmokeArtifactProjection,
): ChatPipelineLiveSmokeBaseline {
  const dag = buildDag(pipelineConfig);
  const manualGatedTaskIds = [...dag.nodes.entries()]
    .filter(([, node]) => node.task.trigger?.type === 'manual')
    .map(([taskId]) => taskId)
    .sort();
  const middlewareAvailability = new Map<string, boolean>();
  const middlewareUnavailableTaskIds = [...dag.nodes.entries()]
    .filter(
      ([, node]) =>
        missingStaticContextSources(workDir, node, projection, middlewareAvailability).length > 0,
    )
    .map(([taskId]) => taskId)
    .sort();
  const gatedTaskIds = [
    ...new Set([...manualGatedTaskIds, ...middlewareUnavailableTaskIds]),
  ].sort();
  if (dataReadiness.state === 'blocked') {
    return { mode: 'skip', manualGatedTaskIds, middlewareUnavailableTaskIds };
  }
  if (gatedTaskIds.length === 0) {
    if (dataReadiness.state === 'fixture-backed') {
      return dataReadiness.baseline.mode === 'skip'
        ? { mode: 'skip', manualGatedTaskIds, middlewareUnavailableTaskIds }
        : {
            mode: 'targeted',
            targetTaskIds: dataReadiness.baseline.targetTaskIds,
            manualGatedTaskIds,
            middlewareUnavailableTaskIds,
          };
    }
    return { mode: 'run-all', manualGatedTaskIds, middlewareUnavailableTaskIds };
  }

  const dependents = new Map<string, string[]>();
  for (const [taskId, node] of dag.nodes) {
    for (const dependency of node.dependsOn) {
      const list = dependents.get(dependency);
      if (list) list.push(taskId);
      else dependents.set(dependency, [taskId]);
    }
  }
  const gated = new Set(gatedTaskIds);
  const pending = [...gatedTaskIds];
  while (pending.length > 0) {
    const taskId = pending.pop()!;
    for (const dependent of dependents.get(taskId) ?? []) {
      if (gated.has(dependent)) continue;
      gated.add(dependent);
      pending.push(dependent);
    }
  }

  const eligible =
    dataReadiness.state === 'fixture-backed' && dataReadiness.baseline.mode === 'skip'
      ? []
      : [...dag.nodes.keys()].filter(
          (taskId) =>
            !gated.has(taskId) &&
            (dataReadiness.state !== 'fixture-backed' ||
              dataReadiness.baseline.mode !== 'targeted' ||
              dataReadiness.baseline.targetTaskIds.includes(taskId)),
        );
  if (eligible.length === 0) {
    return { mode: 'skip', manualGatedTaskIds, middlewareUnavailableTaskIds };
  }
  if (dataReadiness.state === 'runnable' && eligible.length === dag.nodes.size) {
    return { mode: 'run-all', manualGatedTaskIds, middlewareUnavailableTaskIds };
  }
  return {
    mode: 'targeted',
    targetTaskIds: eligible,
    manualGatedTaskIds,
    middlewareUnavailableTaskIds,
  };
}

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

function normalizedCasePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function pipelineCaseNamespace(relativeYamlPath: string): string | null {
  const normalized = normalizedCasePath(relativeYamlPath);
  const separator = normalized.lastIndexOf('/');
  return separator > 0 ? normalized.slice(0, separator) : null;
}

function pathUsesNamespace(path: string, namespace: string): boolean {
  const comparedPath = process.platform === 'win32' ? path.toLowerCase() : path;
  const comparedNamespace = process.platform === 'win32' ? namespace.toLowerCase() : namespace;
  return comparedPath === comparedNamespace || comparedPath.startsWith(`${comparedNamespace}/`);
}

export function chatPipelineTrialCasePathFromWorkspacePath(
  workspaceRelativePath: string,
  relativeYamlPath: string,
): string {
  const path = normalizedCasePath(workspaceRelativePath);
  const namespace = pipelineCaseNamespace(relativeYamlPath);
  const internalNamespace = namespace ? `.tagma/${namespace}` : null;
  return internalNamespace && pathUsesNamespace(path, internalNamespace)
    ? path.slice('.tagma/'.length)
    : path;
}

export function chatPipelineTrialWorkspacePathFromCasePath(
  caseRelativePath: string,
  relativeYamlPath: string,
): string {
  const path = normalizedCasePath(caseRelativePath);
  const namespace = pipelineCaseNamespace(relativeYamlPath);
  return namespace && pathUsesNamespace(path, namespace) ? `.tagma/${path}` : path;
}

export function resolveChatPipelineDataReadiness(
  pipelineConfig: PipelineConfig,
  workDir: string,
  relativeYamlPath?: string,
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
    const workspaceRelativePath = relative(workDir, inputPath).replace(/\\/g, '/');
    if (!workspaceRelativePath || !isPathWithin(inputPath, workDir)) {
      blockers.push({ kind: 'external-data-path', name: trigger.path, taskId });
      continue;
    }
    const fixturePath = relativeYamlPath
      ? chatPipelineTrialCasePathFromWorkspacePath(workspaceRelativePath, relativeYamlPath)
      : workspaceRelativePath;
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
      baseline: targetTaskIds.length > 0 ? { mode: 'targeted', targetTaskIds } : { mode: 'skip' },
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
