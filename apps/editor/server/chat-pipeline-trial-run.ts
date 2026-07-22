import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  createTagma,
  DEFAULT_TASK_TIMEOUT_MS,
  type EngineResult,
  type PipelineConfig,
  type RawPipelineConfig,
} from '@tagma/sdk';
import { InMemoryApprovalGateway, type ApprovalEvent } from '@tagma/sdk/approval';
import { loadPipeline, validateConfig } from '@tagma/sdk/yaml';
import { generateRunId } from '@tagma/sdk/utils';

import {
  compileChatYamlStage,
  listChatYamlStage,
  samePipelineRelativePath,
} from './chat-yaml-staging.js';
import {
  readChatPipelineTrialPlan,
  type ChatPipelineTrialExpectation,
  type ChatPipelineTrialPlan,
  type ChatPipelineTrialPlanCase,
  type ChatPipelineTrialPlanRequest,
} from './chat-pipeline-trial-plan.js';
import { buildPythonAgentRunEnv, pythonAgentVenvBinDir } from './python-agent.js';
import { runPreflight } from './preflight-requirements.js';
import { assertSafePluginName } from './plugin-safety.js';
import {
  classifyServerError,
  isPluginBlocked,
  loadPluginFromWorkDir,
  readEditorSettings,
  unloadPluginFromRegistry,
} from './plugins/loader.js';
import { withWorkspacePluginMutationLock } from './plugins/locks.js';
import { atomicWriteFileSync, errorMessage, isPathWithin } from './path-utils.js';
import { buildPipelineSecretEnv } from './secrets.js';
import { MAX_LOG_RUNS } from './state.js';
import { normalizeRunTargetTaskIds, runtimeWithInjectedEnv } from './routes/run-session.js';
import type { WorkspaceState } from './workspace-state.js';

const TRIAL_CACHE_VERSION = 2;
const CHAT_PIPELINE_TRIAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TRIAL_STREAM_BYTES = 4 * 1024;
const MAX_TRIAL_SUMMARY_BYTES = 32 * 1024;
const MAX_TRIAL_TASK_RESULTS = 32;
const MAX_TRIAL_CASE_COPY_BYTES = 16 * 1024 * 1024;
const MAX_TRIAL_CASE_COPY_FILES = 256;
const MAX_TRIAL_ASSERTION_FILE_BYTES = 2 * 1024 * 1024;
const TRIAL_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

export type ChatPipelineTrialRunKind =
  | 'passed'
  | 'failed'
  | 'plan-required'
  | 'plan-failed'
  | 'compile-failed'
  | 'preflight-failed'
  | 'setup-failed'
  | 'aborted'
  | 'timed-out'
  | 'busy';

export interface ChatPipelineTrialTaskResult {
  caseId: string | null;
  runNumber: number;
  taskId: string;
  status: string;
  exitCode: number | null;
  failureKind: string | null;
  stdout: string;
  stderr: string;
}

export interface ChatPipelineTrialExpectationResult {
  type: ChatPipelineTrialExpectation['type'] | 'case-execution';
  passed: boolean;
  detail: string;
}

export interface ChatPipelineTrialCaseResult {
  id: string;
  title: string;
  objective: string;
  success: boolean;
  runIds: string[];
  tasks: ChatPipelineTrialTaskResult[];
  expectations: ChatPipelineTrialExpectationResult[];
}

export interface ChatPipelineTrialPlanSummary {
  summary: string;
  goals: string[];
  coverage: ChatPipelineTrialPlan['coverage'];
  findings: ChatPipelineTrialPlan['findings'];
  cases: Array<
    Pick<ChatPipelineTrialPlanCase, 'id' | 'title' | 'objective' | 'runs' | 'targetTaskIds'>
  >;
}

export interface ChatPipelineTrialRunResult {
  version: typeof TRIAL_CACHE_VERSION;
  success: boolean;
  kind: ChatPipelineTrialRunKind;
  ran: boolean;
  runId: string | null;
  summary: string;
  durationMs: number;
  totalTaskCount: number;
  omittedTaskCount: number;
  tasks: ChatPipelineTrialTaskResult[];
  planRequest?: ChatPipelineTrialPlanRequest;
  plan?: ChatPipelineTrialPlanSummary;
  cases: ChatPipelineTrialCaseResult[];
}

export interface ChatPipelineTrialRunInput {
  stageId: string;
  relativePath: string;
  trialId: string;
}

interface CachedTrialResult {
  version: typeof TRIAL_CACHE_VERSION;
  contentHash: string;
  result: ChatPipelineTrialRunResult;
}

const inFlightByCachePath = new Map<string, Promise<ChatPipelineTrialRunResult>>();
const activeTrialByWorkspace = new Map<string, string>();
const activeTrialIdentityByWorkspace = new Map<
  string,
  {
    stageId: string;
    trialId: string;
    controller: AbortController;
    abortState: { timedOut: boolean; userAborted: boolean };
  }
>();

export function cancelChatPipelineTrial(
  ws: WorkspaceState,
  input: { stageId: string; trialId: string },
): boolean {
  const active = activeTrialIdentityByWorkspace.get(ws.key);
  if (!active || active.stageId !== input.stageId || active.trialId !== input.trialId) {
    return false;
  }
  active.abortState.userAborted = true;
  active.controller.abort('user stopped chat trial run');
  return true;
}

function validateTrialId(value: string): string {
  const trialId = value.trim();
  if (!TRIAL_ID_RE.test(trialId)) {
    throw new Error('trialId must contain only letters, digits, underscores, or hyphens.');
  }
  return trialId;
}

function trialCachePath(
  rootDir: string,
  trialId: string,
  relativePath: string,
  verificationHash: string,
) {
  const digest = createHash('sha256')
    .update(`${trialId}\0${relativePath}\0${verificationHash}`)
    .digest('hex');
  return join(rootDir, '.trial-runs', `${digest}.json`);
}

function readCachedTrial(path: string, contentHash: string): ChatPipelineTrialRunResult | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CachedTrialResult>;
    if (
      parsed.version !== TRIAL_CACHE_VERSION ||
      parsed.contentHash !== contentHash ||
      !parsed.result ||
      parsed.result.version !== TRIAL_CACHE_VERSION
    ) {
      return null;
    }
    return parsed.result;
  } catch {
    return null;
  }
}

function writeCachedTrial(
  path: string,
  contentHash: string,
  result: ChatPipelineTrialRunResult,
): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(
    path,
    JSON.stringify({
      version: TRIAL_CACHE_VERSION,
      contentHash,
      result,
    } satisfies CachedTrialResult) + '\n',
  );
}

function isWorkspaceRunBusy(ws: WorkspaceState): boolean {
  if (ws.runSessionStarting || ws.runSessionStartToken !== null || ws.runSessions.size > 0) {
    return true;
  }
  const workflow = ws.workflowRunSession as { done?: boolean } | null;
  return !!workflow && workflow.done !== true;
}

function boundedTrialText(value: string): string {
  const redacted = redactTrialText(value);
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.length <= MAX_TRIAL_STREAM_BYTES) return redacted;
  const marker = '\n…[truncated]…\n';
  const markerBytes = new TextEncoder().encode(marker);
  const budget = Math.max(0, MAX_TRIAL_STREAM_BYTES - markerBytes.length);
  const head = Math.floor(budget / 3);
  const tail = budget - head;
  const decoder = new TextDecoder();
  return decoder.decode(bytes.slice(0, head)) + marker + decoder.decode(bytes.slice(-tail));
}

function redactTrialText(value: string): string {
  return value
    .replace(
      /((?:[\x22']?authorization[\x22']?)\s*:\s*[\x22']?\s*bearer\s+)[^\x22'\s,;&}\]]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:(?:[\x22']|--)?(?:api[_-]?key|apikey|token|secret|password|session[_-]?id|sessionid)(?:[\x22'])?)\s*(?::|=|\s)\s*[\x22']?)[^\x22'\s,;&}\]]+/gi,
      '$1[REDACTED]',
    );
}

function resultForSetupFailure(
  kind: Exclude<
    ChatPipelineTrialRunKind,
    'passed' | 'failed' | 'timed-out' | 'plan-required' | 'plan-failed'
  >,
  message: string,
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind,
    ran: false,
    runId: null,
    summary: boundedTrialText(message),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    tasks: [],
    cases: [],
  };
}

function resultForAborted(
  result: ChatPipelineTrialRunResult,
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    ...result,
    success: false,
    kind: 'aborted',
    summary: boundedTrialText('Trial run stopped by the user.'),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function trialPlanSummary(plan: ChatPipelineTrialPlan): ChatPipelineTrialPlanSummary {
  return {
    summary: boundedTrialText(plan.summary),
    goals: plan.goals.map((goal) => boundedTrialText(goal)),
    coverage: plan.coverage.map((item) => ({
      ...item,
      caseIds: [...item.caseIds],
      rationale: boundedTrialText(item.rationale),
    })),
    findings: plan.findings.map((item) => ({
      ...item,
      summary: boundedTrialText(item.summary),
      evidence: boundedTrialText(item.evidence),
    })),
    cases: plan.cases.map((item) => ({
      id: item.id,
      title: boundedTrialText(item.title),
      objective: boundedTrialText(item.objective),
      runs: item.runs,
      targetTaskIds: [...item.targetTaskIds],
    })),
  };
}

function resultForPlanRequest(
  request: ChatPipelineTrialPlanRequest,
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind: 'plan-required',
    ran: false,
    runId: null,
    summary: boundedTrialText(`Targeted trial plan required: ${request.message}`),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    tasks: [],
    planRequest: request,
    cases: [],
  };
}

function resultForPlanFailure(
  plan: ChatPipelineTrialPlan,
  diagnostics: readonly string[],
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind: 'plan-failed',
    ran: false,
    runId: null,
    summary: boundedTrialText(
      ['Trial plan found pipeline defects or blocked coverage before execution.', ...diagnostics]
        .filter(Boolean)
        .join('\n'),
    ),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    tasks: [],
    plan: trialPlanSummary(plan),
    cases: [],
  };
}

function planBlockingDiagnostics(plan: ChatPipelineTrialPlan): string[] {
  return [
    ...plan.findings
      .filter((item) => item.severity === 'blocking')
      .map((item) => `${item.summary}: ${item.evidence}`),
    ...plan.coverage
      .filter((item) => item.status === 'blocked')
      .map((item) => `${item.dimension} is blocked: ${item.rationale}`),
  ];
}

function casePath(workDir: string, relativePath: string): string {
  const path = resolve(workDir, ...relativePath.split('/'));
  if (!isPathWithin(path, workDir)) throw new Error('Trial case path escaped its workspace.');
  return path;
}

interface CopyBudget {
  files: number;
  bytes: number;
}

function copyTrialPipelineTree(
  sourceDir: string,
  destinationDir: string,
  budget: CopyBudget,
): void {
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name.endsWith('.trial-plan.json')) continue;
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('Trial pipeline helpers must not contain symlinks.');
    if (stat.isDirectory()) {
      copyTrialPipelineTree(source, destination, budget);
      continue;
    }
    if (!stat.isFile()) throw new Error('Trial pipeline helpers must be regular files.');
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_TRIAL_CASE_COPY_FILES || budget.bytes > MAX_TRIAL_CASE_COPY_BYTES) {
      throw new Error('Trial pipeline helper copy exceeds the isolated-case limit.');
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function prepareTrialCaseWorkspace(
  stageRoot: string,
  stagedYamlPath: string,
  testCase: ChatPipelineTrialPlanCase,
): { rootDir: string; workDir: string } {
  const casesDir = join(stageRoot, '.trial-cases');
  mkdirSync(casesDir, { recursive: true });
  const rootDir = mkdtempSync(join(casesDir, `${testCase.id}-`));
  const workDir = join(rootDir, 'workspace');
  try {
    mkdirSync(workDir, { recursive: true });
    const pipelineFolder = dirname(stagedYamlPath);
    const stagedTagmaDir = join(workDir, '.tagma');
    copyTrialPipelineTree(pipelineFolder, join(stagedTagmaDir, basename(pipelineFolder)), {
      files: 0,
      bytes: 0,
    });
    for (const fixture of testCase.fixtures) {
      const path = casePath(workDir, fixture.path);
      mkdirSync(dirname(path), { recursive: true });
      atomicWriteFileSync(path, fixture.content);
    }
    return { rootDir, workDir };
  } catch (err) {
    rmSync(rootDir, { recursive: true, force: true });
    throw err;
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function evaluateTrialExpectation(
  workDir: string,
  expectation: ChatPipelineTrialExpectation,
  lastResult: EngineResult | null,
): ChatPipelineTrialExpectationResult {
  if (expectation.type === 'task-status') {
    const actual = lastResult?.states.get(expectation.taskId)?.status ?? 'missing';
    const passed = actual === expectation.status;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.taskId} expected ${expectation.status}, received ${actual}.`,
    };
  }

  const path = casePath(workDir, expectation.path);
  const stat = lstatOrNull(path);
  if (expectation.type === 'path-exists' || expectation.type === 'path-not-exists') {
    const exists = !!stat && !stat.isSymbolicLink();
    const passed = expectation.type === 'path-exists' ? exists : !exists;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.path} ${exists ? 'exists' : 'does not exist'}.`,
    };
  }
  if (
    expectation.type === 'file-contains' ||
    expectation.type === 'file-not-contains' ||
    expectation.type === 'file-equals'
  ) {
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return {
        type: expectation.type,
        passed: false,
        detail: `${expectation.path} is not a regular file.`,
      };
    }
    if (stat.size > MAX_TRIAL_ASSERTION_FILE_BYTES) {
      return {
        type: expectation.type,
        passed: false,
        detail: `${expectation.path} exceeds the assertion read limit.`,
      };
    }
    const content = readFileSync(path, 'utf-8');
    if (expectation.type === 'file-equals') {
      return {
        type: expectation.type,
        passed: content === expectation.text,
        detail:
          expectation.path +
          (content === expectation.text
            ? ' exactly matches the expected text.'
            : ' does not exactly match the expected text.'),
      };
    }
    const contains = content.includes(expectation.text);
    const passed = expectation.type === 'file-contains' ? contains : !contains;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.path} ${contains ? 'contains' : 'does not contain'} the expected marker.`,
    };
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      type: expectation.type,
      passed: false,
      detail: `${expectation.path} is not a directory.`,
    };
  }
  const count = readdirSync(path, { withFileTypes: true }).filter(
    (entry) =>
      !entry.isSymbolicLink() &&
      (!expectation.suffix || entry.name.toLowerCase().endsWith(expectation.suffix.toLowerCase())),
  ).length;
  const passed =
    (expectation.min === null || count >= expectation.min) &&
    (expectation.max === null || count <= expectation.max);
  const range = [
    expectation.min === null ? null : `min=${expectation.min}`,
    expectation.max === null ? null : `max=${expectation.max}`,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    type: expectation.type,
    passed,
    detail: `${expectation.path} contains ${count} matching entries; expected ${range}.`,
  };
}

function collectDeclaredSecretNames(config: RawPipelineConfig): string[] {
  const names = new Set<string>();
  const add = (items: readonly string[] | undefined) => {
    for (const item of items ?? []) names.add(item);
  };
  add(config.secrets);
  for (const track of config.tracks) {
    add(track.secrets);
    for (const task of track.tasks) add(task.secrets);
  }
  return [...names];
}

async function ensureTrialPluginsLoaded(
  ws: WorkspaceState,
  pluginNames: readonly string[],
): Promise<string | null> {
  for (const name of pluginNames) {
    try {
      assertSafePluginName(name);
    } catch (err) {
      return classifyServerError(err).message;
    }
  }
  return withWorkspacePluginMutationLock(ws, async () => {
    const newlyLoaded: string[] = [];
    for (const name of pluginNames) {
      if (ws.loadedPluginMeta.has(name)) continue;
      if (isPluginBlocked(ws, name)) {
        return `Plugin "${name}" was explicitly uninstalled. Install it before trial-running this pipeline.`;
      }
      try {
        await loadPluginFromWorkDir(ws, name);
        newlyLoaded.push(name);
      } catch (err) {
        for (const loadedName of newlyLoaded) {
          unloadPluginFromRegistry(ws, loadedName, { removeStageDir: true });
        }
        return classifyServerError(err).message;
      }
    }
    return null;
  });
}

function trialTaskResults(
  result: EngineResult,
  caseId: string | null,
  runNumber: number,
): {
  tasks: ChatPipelineTrialTaskResult[];
  totalTaskCount: number;
  omittedTaskCount: number;
  countText: string;
} {
  const entries = [...result.states.entries()].sort((left, right) => {
    const leftPassed = left[1].status === 'success';
    const rightPassed = right[1].status === 'success';
    return Number(leftPassed) - Number(rightPassed);
  });
  const counts = new Map<string, number>();
  for (const [, state] of entries) {
    counts.set(state.status, (counts.get(state.status) ?? 0) + 1);
  }
  const tasks = entries.slice(0, MAX_TRIAL_TASK_RESULTS).map(([taskId, state]) => ({
    caseId,
    runNumber,
    taskId,
    status: state.status,
    exitCode: state.result?.exitCode ?? null,
    failureKind: state.result?.failureKind ?? null,
    stdout: boundedTrialText(state.result?.stdout ?? ''),
    stderr: boundedTrialText(state.result?.stderr ?? ''),
  }));
  return {
    tasks,
    totalTaskCount: entries.length,
    omittedTaskCount: Math.max(0, entries.length - tasks.length),
    countText: [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(', '),
  };
}

function buildTrialSummary(
  success: boolean,
  timedOut: boolean,
  tasks: readonly ChatPipelineTrialTaskResult[],
  omittedTaskCount: number,
  countText: string,
): string {
  const lines = [
    timedOut
      ? `Trial run timed out after ${CHAT_PIPELINE_TRIAL_TIMEOUT_MS}ms.`
      : success
        ? `Trial run passed (${countText || 'no tasks'}).`
        : `Trial run failed (${countText || 'no task result'}).`,
  ];
  if (omittedTaskCount > 0) {
    lines.push(`Task evidence omitted for ${omittedTaskCount} additional task(s).`);
  }
  for (const task of tasks) {
    if (task.status === 'success') continue;
    lines.push(
      '',
      `Task ${task.taskId}`,
      `status: ${task.status}`,
      `exitCode: ${task.exitCode ?? 'none'}`,
      `failureKind: ${task.failureKind ?? 'none'}`,
    );
    if (task.stdout) lines.push(`stdout:\n${task.stdout}`);
    if (task.stderr) lines.push(`stderr:\n${task.stderr}`);
  }
  const summary = redactTrialText(lines.join('\n'));
  const bytes = new TextEncoder().encode(summary);
  if (bytes.length <= MAX_TRIAL_SUMMARY_BYTES) return summary;
  return new TextDecoder().decode(bytes.slice(0, MAX_TRIAL_SUMMARY_BYTES)) + '\n…[truncated]…';
}

function buildCasePromptContexts(
  config: PipelineConfig,
  testCase: ChatPipelineTrialPlanCase,
  workDir: string,
): Record<string, Array<{ label: string; content: string }>> {
  const fixturePaths = testCase.fixtures.map((fixture) => fixture.path).join(', ') || 'none';
  const content = [
    `Case: ${testCase.id} — ${testCase.title}`,
    `Objective: ${testCase.objective}`,
    `Isolated workspace: ${workDir}`,
    `Fixture paths: ${fixturePaths}`,
    'Use only this isolated workspace for the case. Preserve full file contents, including blank lines.',
  ].join('\n');
  const contexts: Record<string, Array<{ label: string; content: string }>> = {};
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      if (task.prompt === undefined || task.command !== undefined) continue;
      contexts[`${track.id}.${task.id}`] = [{ label: 'Targeted Trial Case', content }];
    }
  }
  return contexts;
}

interface RunTrialPipelineInput {
  ws: WorkspaceState;
  pipelineConfig: PipelineConfig;
  workDir: string;
  logicalYamlPath: string;
  approvalGateway: InMemoryApprovalGateway;
  controller: AbortController;
  pythonRunEnv: Record<string, string>;
  allSecretEnv: Record<string, string>;
  secretValues: string[];
  preflightEnvKeys: readonly string[];
  runId: string;
  targetTaskIds?: string[];
  testCase?: ChatPipelineTrialPlanCase;
}

async function runTrialPipelineOnce(input: RunTrialPipelineInput): Promise<EngineResult> {
  const trialEnv: Record<string, string> = input.testCase
    ? {
        TAGMA_TRIAL_CASE_ID: input.testCase.id,
        TAGMA_TRIAL_CASE_DIR: input.workDir,
        TAGMA_TRIAL_WORKSPACE: input.workDir,
      }
    : {};
  const tagma = createTagma({
    registry: input.ws.registry,
    builtins: false,
    runtime: runtimeWithInjectedEnv(
      { ...input.pythonRunEnv, ...input.allSecretEnv, ...trialEnv },
      input.secretValues,
    ),
  });
  return tagma.run(input.pipelineConfig, {
    cwd: input.workDir,
    approvalGateway: input.approvalGateway,
    signal: input.controller.signal,
    maxLogRuns: MAX_LOG_RUNS,
    runId: input.runId,
    skipPluginLoading: true,
    defaultTaskTimeoutMs: Math.min(DEFAULT_TASK_TIMEOUT_MS, CHAT_PIPELINE_TRIAL_TIMEOUT_MS),
    secretResolver: (names: readonly string[]) =>
      buildPipelineSecretEnv(input.ws.workDir, input.logicalYamlPath, names),
    ...(input.preflightEnvKeys.length > 0
      ? { envPolicy: { mode: 'allowlist' as const, keys: input.preflightEnvKeys } }
      : {}),
    ...(input.targetTaskIds ? { targetTaskIds: input.targetTaskIds } : {}),
    ...(input.testCase
      ? {
          taskPromptContexts: buildCasePromptContexts(
            input.pipelineConfig,
            input.testCase,
            input.workDir,
          ),
        }
      : {}),
  });
}

async function executeTargetedTrialCase(
  input: Omit<RunTrialPipelineInput, 'workDir' | 'runId' | 'targetTaskIds' | 'testCase'> & {
    stageRoot: string;
    stagedYamlPath: string;
    testCase: ChatPipelineTrialPlanCase;
    targetTaskIds?: string[];
  },
): Promise<{ result: ChatPipelineTrialCaseResult; totalTaskCount: number }> {
  let caseWorkspace: { rootDir: string; workDir: string } | null = null;
  const runIds: string[] = [];
  const tasks: ChatPipelineTrialTaskResult[] = [];
  let totalTaskCount = 0;
  let lastResult: EngineResult | null = null;
  let allRunsSucceeded = true;
  let executionError: string | null = null;
  try {
    caseWorkspace = prepareTrialCaseWorkspace(
      input.stageRoot,
      input.stagedYamlPath,
      input.testCase,
    );
    const casePipelineConfig = await loadPipeline(
      readFileSync(input.stagedYamlPath, 'utf-8'),
      caseWorkspace.workDir,
    );
    const caseConfigErrors = validateConfig(casePipelineConfig);
    if (caseConfigErrors.length > 0) {
      throw new Error(`Isolated case configuration error: ${caseConfigErrors.join('; ')}`);
    }
    for (let runNumber = 1; runNumber <= input.testCase.runs; runNumber += 1) {
      const runId = generateRunId();
      runIds.push(runId);
      lastResult = await runTrialPipelineOnce({
        ...input,
        pipelineConfig: casePipelineConfig,
        workDir: caseWorkspace.workDir,
        runId,
        targetTaskIds: input.targetTaskIds,
        testCase: input.testCase,
      });
      allRunsSucceeded = allRunsSucceeded && lastResult.success;
      const evidence = trialTaskResults(lastResult, input.testCase.id, runNumber);
      totalTaskCount += evidence.totalTaskCount;
      tasks.push(...evidence.tasks);
      if (input.controller.signal.aborted) break;
    }
  } catch (err) {
    executionError = `Case execution crashed: ${errorMessage(err)}`;
  }

  const expectations: ChatPipelineTrialExpectationResult[] = [];
  if (executionError) {
    expectations.push({ type: 'case-execution', passed: false, detail: executionError });
  } else if (caseWorkspace) {
    for (const expectation of input.testCase.expectations) {
      try {
        expectations.push(evaluateTrialExpectation(caseWorkspace.workDir, expectation, lastResult));
      } catch (err) {
        expectations.push({
          type: expectation.type,
          passed: false,
          detail: `Expectation crashed: ${errorMessage(err)}`,
        });
      }
    }
  }
  if (caseWorkspace) {
    try {
      rmSync(caseWorkspace.rootDir, { recursive: true, force: true });
    } catch (err) {
      expectations.push({
        type: 'case-execution',
        passed: false,
        detail: `Case cleanup failed: ${errorMessage(err)}`,
      });
    }
  }
  const success =
    !!lastResult &&
    allRunsSucceeded &&
    runIds.length === input.testCase.runs &&
    expectations.every((item) => item.passed);
  return {
    result: {
      id: input.testCase.id,
      title: boundedTrialText(input.testCase.title),
      objective: boundedTrialText(input.testCase.objective),
      success,
      runIds,
      tasks: tasks.slice(0, MAX_TRIAL_TASK_RESULTS),
      expectations,
    },
    totalTaskCount,
  };
}

function buildPlannedTrialSummary(
  baselineSuccess: boolean,
  timedOut: boolean,
  baselineTasks: readonly ChatPipelineTrialTaskResult[],
  baselineOmitted: number,
  baselineCountText: string,
  cases: readonly ChatPipelineTrialCaseResult[],
): string {
  const lines = [
    buildTrialSummary(
      baselineSuccess && cases.every((item) => item.success),
      timedOut,
      baselineTasks,
      baselineOmitted,
      baselineCountText,
    ),
    '',
    `Targeted cases: ${cases.filter((item) => item.success).length}/${cases.length} passed.`,
  ];
  for (const testCase of cases) {
    lines.push(
      `Case ${testCase.id}: ${testCase.success ? 'passed' : 'failed'} — ${testCase.objective}`,
    );
    for (const expectation of testCase.expectations) {
      if (!expectation.passed) lines.push(`  ${expectation.type}: ${expectation.detail}`);
    }
  }
  const summary = redactTrialText(lines.join('\n'));
  const bytes = new TextEncoder().encode(summary);
  if (bytes.length <= MAX_TRIAL_SUMMARY_BYTES) return summary;
  return new TextDecoder().decode(bytes.slice(0, MAX_TRIAL_SUMMARY_BYTES)) + '\n…[truncated]…';
}

async function executeTrial(
  ws: WorkspaceState,
  stage: ReturnType<typeof listChatYamlStage>,
  entry: ReturnType<typeof listChatYamlStage>['entries'][number],
  plan: ChatPipelineTrialPlan,
  controller: AbortController,
  abortState: { timedOut: boolean },
): Promise<ChatPipelineTrialRunResult> {
  const startedAt = Date.now();
  let pipelineConfig;
  try {
    pipelineConfig = await loadPipeline(readFileSync(entry.stagedPath, 'utf-8'), ws.workDir);
  } catch (err) {
    return resultForSetupFailure(
      'setup-failed',
      `Trial run configuration error: ${errorMessage(err)}`,
      startedAt,
    );
  }
  const configErrors = validateConfig(pipelineConfig);
  if (configErrors.length > 0) {
    return resultForSetupFailure(
      'setup-failed',
      `Trial run configuration error: ${configErrors.join('; ')}`,
      startedAt,
    );
  }

  const targetTaskIdsByCase = new Map<string, string[] | undefined>();
  const planDiagnostics = planBlockingDiagnostics(plan);
  for (const testCase of plan.cases) {
    try {
      targetTaskIdsByCase.set(
        testCase.id,
        testCase.targetTaskIds.length > 0
          ? normalizeRunTargetTaskIds(testCase.targetTaskIds, pipelineConfig)
          : undefined,
      );
    } catch (err) {
      planDiagnostics.push(`${testCase.id}: ${errorMessage(err)}`);
    }
  }
  if (planDiagnostics.length > 0) {
    return resultForPlanFailure(plan, planDiagnostics, startedAt);
  }

  const pluginError = await ensureTrialPluginsLoaded(ws, pipelineConfig.plugins ?? []);
  if (pluginError) {
    return resultForSetupFailure('setup-failed', `Plugin load error: ${pluginError}`, startedAt);
  }

  const pythonSettings = readEditorSettings(ws).pythonAgent;
  const pythonRunEnv = buildPythonAgentRunEnv(ws.workDir, pythonSettings);
  const pythonPreflightOptions =
    Object.keys(pythonRunEnv).length > 0
      ? {
          extraPathDirs: [pythonAgentVenvBinDir(ws.workDir)],
          extraEnv: pythonRunEnv,
        }
      : {};
  const preflight = runPreflight(entry.stagedPath, pythonPreflightOptions);
  const logicalYamlPath = entry.sourcePath ?? resolve(ws.workDir, '.tagma', entry.relativePath);
  const declaredSecretNames = collectDeclaredSecretNames(pipelineConfig);
  const allSecretNames = [...new Set([...preflight.envKeys, ...declaredSecretNames])];
  let allSecretEnv: Record<string, string> = {};
  try {
    allSecretEnv = buildPipelineSecretEnv(ws.workDir, logicalYamlPath, allSecretNames);
  } catch (err) {
    return resultForSetupFailure(
      'setup-failed',
      `Secret manager error: ${errorMessage(err)}`,
      startedAt,
    );
  }
  const missing = {
    binaries: preflight.missing.binaries,
    envs: preflight.missing.envs.filter((name) => !allSecretEnv[name]),
  };
  if (missing.binaries.length > 0 || missing.envs.length > 0) {
    return resultForSetupFailure(
      'preflight-failed',
      `Trial run requirements are missing. binaries=${missing.binaries.join(', ') || 'none'}; env=${missing.envs.join(', ') || 'none'}. Preserve legitimate requirements and safety gates; do not invent or remove them merely to make the trial pass.`,
      startedAt,
    );
  }

  const approvalGateway = new InMemoryApprovalGateway();
  const unsubscribeApproval = approvalGateway.subscribe((event: ApprovalEvent) => {
    if (event.type !== 'requested') return;
    approvalGateway.resolve(event.request.id, {
      outcome: 'rejected',
      actor: 'chat-trial-run',
      reason: 'Chat trial runs never auto-approve manual safety gates.',
    });
  });
  const runId = generateRunId();

  try {
    const secretValues = Object.values(allSecretEnv).filter(Boolean);
    const baseline = await runTrialPipelineOnce({
      ws,
      pipelineConfig,
      workDir: ws.workDir,
      logicalYamlPath,
      approvalGateway,
      controller,
      pythonRunEnv,
      allSecretEnv,
      secretValues,
      preflightEnvKeys: preflight.envKeys,
      runId,
    });
    const baselineEvidence = trialTaskResults(baseline, null, 1);
    const cases: ChatPipelineTrialCaseResult[] = [];
    let totalTaskCount = baselineEvidence.totalTaskCount;
    for (const testCase of plan.cases) {
      if (controller.signal.aborted) break;
      const caseExecution = await executeTargetedTrialCase({
        ws,
        pipelineConfig,
        logicalYamlPath,
        approvalGateway,
        controller,
        pythonRunEnv,
        allSecretEnv,
        secretValues,
        preflightEnvKeys: preflight.envKeys,
        stageRoot: stage.rootDir,
        stagedYamlPath: entry.stagedPath,
        testCase,
        targetTaskIds: targetTaskIdsByCase.get(testCase.id),
      });
      cases.push(caseExecution.result);
      totalTaskCount += caseExecution.totalTaskCount;
    }
    const success =
      baseline.success &&
      !abortState.timedOut &&
      cases.length === plan.cases.length &&
      cases.every((item) => item.success);
    const allVisibleTasks = [
      ...baselineEvidence.tasks,
      ...cases.flatMap((item) => item.tasks),
    ].sort((left, right) => Number(left.status === 'success') - Number(right.status === 'success'));
    const visibleTasks = allVisibleTasks.slice(0, MAX_TRIAL_TASK_RESULTS);
    const omittedTaskCount = Math.max(0, totalTaskCount - visibleTasks.length);
    const visibleCases = cases.map((item) => ({
      ...item,
      tasks: visibleTasks.filter((task) => task.caseId === item.id),
    }));
    return {
      version: TRIAL_CACHE_VERSION,
      success,
      kind: abortState.timedOut ? 'timed-out' : success ? 'passed' : 'failed',
      ran: true,
      runId,
      summary: buildPlannedTrialSummary(
        baseline.success,
        abortState.timedOut,
        baselineEvidence.tasks,
        baselineEvidence.omittedTaskCount,
        baselineEvidence.countText,
        cases,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount,
      omittedTaskCount,
      tasks: visibleTasks,
      plan: trialPlanSummary(plan),
      cases: visibleCases,
    };
  } catch (err) {
    return {
      version: TRIAL_CACHE_VERSION,
      success: false,
      kind: abortState.timedOut ? 'timed-out' : 'failed',
      ran: true,
      runId,
      summary: boundedTrialText(
        abortState.timedOut
          ? `Trial run timed out after ${CHAT_PIPELINE_TRIAL_TIMEOUT_MS}ms.`
          : `Trial run crashed: ${errorMessage(err)}`,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount: 0,
      omittedTaskCount: 0,
      tasks: [],
      plan: trialPlanSummary(plan),
      cases: [],
    };
  } finally {
    unsubscribeApproval();
    approvalGateway.abortAll('chat trial run finished');
  }
}

export async function trialRunChatYamlStage(
  ws: WorkspaceState,
  input: ChatPipelineTrialRunInput,
): Promise<ChatPipelineTrialRunResult> {
  const trialId = validateTrialId(input.trialId);
  const stage = listChatYamlStage(ws, input.stageId);
  const entry = stage.entries.find((candidate) =>
    samePipelineRelativePath(candidate.relativePath, input.relativePath),
  );
  if (!entry) throw new Error(`Staged YAML not found: ${input.relativePath}`);
  const startedAt = Date.now();
  const compile = compileChatYamlStage(ws, input.stageId, entry.relativePath);
  if (!compile.success) {
    return resultForSetupFailure(
      'compile-failed',
      `Trial run was skipped because YAML compilation failed: ${compile.summary}\n${JSON.stringify(compile.validation)}`,
      startedAt,
    );
  }
  const planRead = readChatPipelineTrialPlan(
    entry.stagedPath,
    entry.relativePath,
    entry.contentHash,
  );
  if (planRead.status === 'required') {
    return resultForPlanRequest(planRead.request, startedAt);
  }
  const verificationHash = createHash('sha256')
    .update(`${entry.contentHash}\0${planRead.planHash}`)
    .digest('hex');
  const cachePath = trialCachePath(stage.rootDir, trialId, entry.relativePath, verificationHash);
  const cached = readCachedTrial(cachePath, verificationHash);
  if (cached) return cached;
  const existing = inFlightByCachePath.get(cachePath);
  if (existing) return existing;
  if (isWorkspaceRunBusy(ws) || activeTrialByWorkspace.has(ws.key)) {
    return resultForSetupFailure(
      'busy',
      'Trial run was skipped because another pipeline or workflow run is active in this workspace.',
      Date.now(),
    );
  }

  const controller = new AbortController();
  const abortState = { timedOut: false, userAborted: false };
  const activeIdentity = { stageId: input.stageId, trialId, controller, abortState };
  const timeout = setTimeout(() => {
    abortState.timedOut = true;
    controller.abort('chat trial run timeout');
  }, CHAT_PIPELINE_TRIAL_TIMEOUT_MS);
  timeout.unref?.();
  activeTrialByWorkspace.set(ws.key, cachePath);
  activeTrialIdentityByWorkspace.set(ws.key, activeIdentity);
  ws.chatPipelineTrialAbort = controller;

  const promise = (async () => {
    try {
      let result = await executeTrial(ws, stage, entry, planRead.plan, controller, abortState);
      if (
        abortState.userAborted ||
        (controller.signal.aborted && !abortState.timedOut)
      ) {
        result = resultForAborted(result, startedAt);
      }
      if (result.kind !== 'aborted') writeCachedTrial(cachePath, verificationHash, result);
      return result;
    } finally {
      clearTimeout(timeout);
      if (activeTrialByWorkspace.get(ws.key) === cachePath) activeTrialByWorkspace.delete(ws.key);
      if (activeTrialIdentityByWorkspace.get(ws.key) === activeIdentity) {
        activeTrialIdentityByWorkspace.delete(ws.key);
      }
      if (ws.chatPipelineTrialAbort === controller) ws.chatPipelineTrialAbort = null;
      inFlightByCachePath.delete(cachePath);
    }
  })();
  inFlightByCachePath.set(cachePath, promise);
  return promise;
}
