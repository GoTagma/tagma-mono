import { lstatSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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

export interface ChatPipelineTrialSandboxFixtureAnalysis {
  inputs: ChatPipelineTrialFixtureInput[];
  blockers: ChatPipelineTrialBlocker[];
}

export interface ChatPipelineTrialCaseFixtureGap {
  caseId: string;
  input: ChatPipelineTrialFixtureInput;
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
  | {
      mode: 'run-all';
      manualGatedTaskIds: string[];
      middlewareUnavailableTaskIds: string[];
      cwdUnavailableTaskIds: string[];
    }
  | {
      mode: 'targeted';
      targetTaskIds: string[];
      manualGatedTaskIds: string[];
      middlewareUnavailableTaskIds: string[];
      cwdUnavailableTaskIds: string[];
    }
  | {
      mode: 'skip';
      manualGatedTaskIds: string[];
      middlewareUnavailableTaskIds: string[];
      cwdUnavailableTaskIds: string[];
    };

export interface ChatPipelineLiveSmokeArtifactProjection {
  livePipelineDir: string;
  stagedPipelineDir: string;
  targetPipelineIsNew: boolean;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function directoryState(path: string): 'directory' | 'missing' | 'other' {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'other';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
  }

  // `lstat(path)` also reports ENOENT when an ancestor is a dangling symlink.
  // Walk to the nearest lexical entry so only a genuinely absent suffix below
  // a usable directory is classified as unpublished staged state.
  let candidate = path;
  while (true) {
    try {
      const entry = lstatSync(candidate);
      if (candidate === path) return 'other';
      if (entry.isSymbolicLink()) {
        try {
          return statSync(candidate).isDirectory() ? 'missing' : 'other';
        } catch {
          return 'other';
        }
      }
      return entry.isDirectory() ? 'missing' : 'other';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'other';
    }
    const parent = dirname(candidate);
    if (parent === candidate) return 'other';
    candidate = parent;
  }
}

function effectiveCwdIsStagedOnly(
  workDir: string,
  node: { track: { cwd?: string }; task: { cwd?: string } },
  projection: ChatPipelineLiveSmokeArtifactProjection | undefined,
): boolean {
  if (!projection?.targetPipelineIsNew) return false;
  const liveCwd = resolve(workDir, node.task.cwd ?? node.track.cwd ?? '.');
  if (!isPathWithin(liveCwd, projection.livePipelineDir) || directoryState(liveCwd) !== 'missing') {
    return false;
  }
  const stagedCwd = resolve(
    projection.stagedPipelineDir,
    relative(projection.livePipelineDir, liveCwd),
  );
  return (
    isPathWithin(stagedCwd, projection.stagedPipelineDir) &&
    directoryState(stagedCwd) === 'directory'
  );
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
 * workspace. A separately consented Live Smoke Test owns a run-scoped
 * automatic grant for manual triggers, matching the explicit grants used by
 * targeted Sandbox cases; ordinary pipeline runs still require human approval.
 * Manual task ids remain in the projection so execution and cache evidence can
 * bind those grants exactly. Tasks whose `static_context` source is missing from
 * the real workspace or differs
 * from the staged pipeline artifact are excluded the same way: running
 * them would use absent or stale promised context. An effective cwd that is
 * present only in the staged target pipeline is also excluded: it cannot be
 * spawned in the real workspace until publication, while an arbitrary missing
 * cwd without a staged directory mirror remains an executable pipeline error.
 * Fixture-backed data constraints from
 * {@link resolveChatPipelineDataReadiness} are intersected with all exclusions.
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
  const cwdUnavailableTaskIds = [...dag.nodes.entries()]
    .filter(([, node]) => effectiveCwdIsStagedOnly(workDir, node, projection))
    .map(([taskId]) => taskId)
    .sort();
  const exclusions = {
    manualGatedTaskIds,
    middlewareUnavailableTaskIds,
    cwdUnavailableTaskIds,
  };
  const gatedTaskIds = [
    ...new Set([...middlewareUnavailableTaskIds, ...cwdUnavailableTaskIds]),
  ].sort();
  if (dataReadiness.state === 'blocked') {
    return { mode: 'skip', ...exclusions };
  }
  if (gatedTaskIds.length === 0) {
    if (dataReadiness.state === 'fixture-backed') {
      return dataReadiness.baseline.mode === 'skip'
        ? { mode: 'skip', ...exclusions }
        : {
            mode: 'targeted',
            targetTaskIds: dataReadiness.baseline.targetTaskIds,
            ...exclusions,
          };
    }
    return { mode: 'run-all', ...exclusions };
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
    return { mode: 'skip', ...exclusions };
  }
  if (dataReadiness.state === 'runnable' && eligible.length === dag.nodes.size) {
    return { mode: 'run-all', ...exclusions };
  }
  return {
    mode: 'targeted',
    targetTaskIds: eligible,
    ...exclusions,
  };
}

export type ChatPipelineTrialRecordedPrerequisiteState = Exclude<
  ChatPipelineTrialReadiness,
  { state: 'runnable' }
>;

function inputIsReady(path: string, type: ChatPipelineTrialFixtureInput['type']): boolean {
  try {
    const stat = lstatSync(path);
    return type === 'directory' ? stat.isDirectory() : stat.isFile();
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

interface ResolvedChatPipelineTriggerInput {
  input: ChatPipelineTrialFixtureInput | null;
  blocker: ChatPipelineTrialBlocker | null;
  ready: boolean;
}

/**
 * Resolve every built-in file/directory trigger into both its real-workspace
 * coordinate and its isolated-case coordinate. Trial cases never inherit
 * arbitrary live workspace data, so a ready live path still needs an authored
 * fixture whenever a case executes the owning task. External paths cannot be
 * synthesized without writing outside the case workspace and fail closed.
 */
function resolveChatPipelineTriggerInputs(
  pipelineConfig: PipelineConfig,
  workDir: string,
  relativeYamlPath?: string,
): ResolvedChatPipelineTriggerInput[] {
  const resolved: ResolvedChatPipelineTriggerInput[] = [];
  for (const [taskId, { track, task }] of buildDag(pipelineConfig).nodes) {
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
    const ready = inputIsReady(inputPath, trigger.type);
    const workspaceRelativePath = relative(workDir, inputPath).replace(/\\/g, '/');

    // The isolated workspace root already exists and therefore needs no
    // synthetic directory entry. A file trigger at that coordinate is invalid
    // for fixture purposes and follows the unvirtualizable path below.
    if (!workspaceRelativePath && trigger.type === 'directory' && ready) {
      continue;
    }

    if (!workspaceRelativePath || !isPathWithin(inputPath, workDir)) {
      resolved.push({
        input: null,
        blocker: { kind: 'external-data-path', name: trigger.path, taskId },
        ready,
      });
      continue;
    }
    const fixturePath = relativeYamlPath
      ? chatPipelineTrialCasePathFromWorkspacePath(workspaceRelativePath, relativeYamlPath)
      : workspaceRelativePath;
    // Trial plans deliberately cannot address host-private .tagma paths. The
    // current pipeline namespace is translated above; another pipeline's
    // internal tree is not a valid input-fixture destination.
    if (fixturePath.toLowerCase().startsWith('.tagma/')) {
      resolved.push({
        input: null,
        blocker: { kind: 'external-data-path', name: trigger.path, taskId },
        ready,
      });
      continue;
    }
    resolved.push({
      input: {
        taskId,
        type: trigger.type,
        path: trigger.path,
        fixturePath,
      },
      blocker: null,
      ready,
    });
  }
  return resolved;
}

export function resolveChatPipelineSandboxFixtureInputs(
  pipelineConfig: PipelineConfig,
  workDir: string,
  relativeYamlPath?: string,
): ChatPipelineTrialSandboxFixtureAnalysis {
  const resolved = resolveChatPipelineTriggerInputs(pipelineConfig, workDir, relativeYamlPath);
  return {
    inputs: resolved.flatMap((item) => (item.input ? [item.input] : [])),
    blockers: resolved.flatMap((item) => (item.blocker ? [item.blocker] : [])),
  };
}

export function resolveChatPipelineDataReadiness(
  pipelineConfig: PipelineConfig,
  workDir: string,
  relativeYamlPath?: string,
): ChatPipelineTrialReadiness {
  const resolved = resolveChatPipelineTriggerInputs(pipelineConfig, workDir, relativeYamlPath);
  const unavailable = resolved.filter((item) => !item.ready);
  const inputs = unavailable.flatMap((item) => (item.input ? [item.input] : []));
  const blockers = unavailable.flatMap((item) => (item.blocker ? [item.blocker] : []));

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

export interface ChatPipelineTrialMissingBinaryRequirement {
  readonly name: string;
  readonly usedBy: readonly string[];
}

function requirementTaskId(dag: ReturnType<typeof buildDag>, usedBy: string): string | null {
  if (dag.nodes.has(usedBy)) return usedBy;
  for (const taskId of dag.nodes.keys()) {
    if (usedBy.startsWith(`${taskId}.`)) return taskId;
  }
  return null;
}

function targetTaskClosure(
  dag: ReturnType<typeof buildDag>,
  targetTaskIds: readonly string[],
): Set<string> {
  const closure = new Set<string>();
  const pending = [...targetTaskIds];
  while (pending.length > 0) {
    const taskId = pending.pop()!;
    if (closure.has(taskId)) continue;
    closure.add(taskId);
    const node = dag.nodes.get(taskId);
    if (node) pending.push(...node.dependsOn);
  }
  return closure;
}

/**
 * Resolves runtime blockers for one executable target closure. Missing
 * requirements with task-owned `usedBy` entries block only closures that run
 * those tasks. Hook, malformed, or otherwise unscoped requirements remain
 * global blockers. Required environment declarations are currently global
 * because requirements frontmatter does not carry task ownership for them.
 */
export function resolveChatPipelineTargetRuntimeReadiness(input: {
  pipelineConfig: PipelineConfig;
  targetTaskIds: readonly string[];
  missingBinaries: readonly ChatPipelineTrialMissingBinaryRequirement[];
  missingEnvironment: readonly string[];
}): Exclude<ChatPipelineTrialReadiness, { state: 'fixture-backed' }> {
  const dag = buildDag(input.pipelineConfig);
  const closure = targetTaskClosure(dag, input.targetTaskIds);
  const blockers: ChatPipelineTrialBlocker[] = input.missingEnvironment.map((name) => ({
    kind: 'environment' as const,
    name,
  }));

  for (const requirement of input.missingBinaries) {
    const taskIds = requirement.usedBy.map((usedBy) => requirementTaskId(dag, usedBy));
    const isGlobal = taskIds.length === 0 || taskIds.some((taskId) => taskId === null);
    if (isGlobal) {
      blockers.push({ kind: 'binary', name: requirement.name });
      continue;
    }
    for (const taskId of new Set(taskIds.filter((value): value is string => value !== null))) {
      if (closure.has(taskId)) {
        blockers.push({ kind: 'binary', name: requirement.name, taskId });
      }
    }
  }

  const unique = new Map<string, ChatPipelineTrialBlocker>();
  for (const blocker of blockers) {
    unique.set(`${blocker.kind}:${blocker.name}:${blocker.taskId ?? ''}`, blocker);
  }
  return unique.size > 0
    ? { state: 'blocked', blockers: [...unique.values()] }
    : { state: 'runnable' };
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

function comparableTrialCasePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function suppliedPathMatchesInput(path: string, input: ChatPipelineTrialFixtureInput): boolean {
  const suppliedPath = comparableTrialCasePath(path);
  const expectedPath = comparableTrialCasePath(input.fixturePath);
  return input.type === 'file'
    ? suppliedPath === expectedPath
    : suppliedPath.startsWith(`${expectedPath}/`);
}

function trialCaseSuppliesInput(
  testCase: ChatPipelineTrialPlan['cases'][number],
  input: ChatPipelineTrialFixtureInput,
  dag: ReturnType<typeof buildDag>,
): boolean {
  if (testCase.fixtures.some((fixture) => suppliedPathMatchesInput(fixture.path, input))) {
    return true;
  }
  // A generated input can satisfy a non-root trigger only: at least one
  // dependency runs before that trigger starts and can create the path. A root
  // trigger has no producer opportunity, so accepting generatedInputPaths there
  // would merely defer the error into an indefinite watcher wait.
  const inputNode = dag.nodes.get(input.taskId);
  return (
    !!inputNode &&
    inputNode.dependsOn.length > 0 &&
    (testCase.generatedInputPaths ?? []).some((path) => suppliedPathMatchesInput(path, input))
  );
}

/**
 * Return every case/input pair that would otherwise wait on data absent from
 * its fresh isolated workspace. Checking each case (rather than whether one
 * case somewhere in the plan has a fixture) prevents a later edge-case run
 * from hanging behind the same trigger. A pipeline-generated path is accepted
 * when an upstream task intentionally creates and asserts it.
 */
export function findUncoveredTrialCaseFixtureInputs(
  plan: ChatPipelineTrialPlan,
  inputs: readonly ChatPipelineTrialFixtureInput[],
  pipelineConfig: PipelineConfig,
): ChatPipelineTrialCaseFixtureGap[] {
  const dag = buildDag(pipelineConfig);
  return plan.cases.flatMap((testCase) =>
    inputs.flatMap((input) =>
      targetSelectionRunsTask(dag, testCase.targetTaskIds, input.taskId) &&
      !trialCaseSuppliesInput(testCase, input, dag)
        ? [{ caseId: testCase.id, input }]
        : [],
    ),
  );
}

export function findUncoveredTrialFixtureInputs(
  plan: ChatPipelineTrialPlan,
  inputs: readonly ChatPipelineTrialFixtureInput[],
  pipelineConfig: PipelineConfig,
): ChatPipelineTrialFixtureInput[] {
  const uncoveredTaskIds = new Set(
    findUncoveredTrialCaseFixtureInputs(plan, inputs, pipelineConfig).map(
      (item) => item.input.taskId,
    ),
  );
  return inputs.filter((input) => uncoveredTaskIds.has(input.taskId));
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

export function describeUncoveredTrialCaseFixtureInputs(
  gaps: readonly ChatPipelineTrialCaseFixtureGap[],
): string {
  return gaps
    .map(({ caseId, input }) =>
      input.type === 'file'
        ? `case ${caseId} needs the exact isolated fixture ${input.fixturePath} for ${input.taskId}`
        : `case ${caseId} needs at least one isolated file fixture below ${input.fixturePath}/ for ${input.taskId}`,
    )
    .join('; ');
}

export function describeTrialBlockers(blockers: readonly ChatPipelineTrialBlocker[]): string {
  return blockers.map((blocker) => `${blocker.kind}=${blocker.name}`).join('; ');
}
