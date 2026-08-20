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
  watch,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  createTagma,
  type EngineResult,
  type PipelineConfig,
  type RawPipelineConfig,
  type RunEventPayload,
} from '@tagma/sdk';
import { InMemoryApprovalGateway, type ApprovalEvent } from '@tagma/sdk/approval';
import { buildDag, type Dag } from '@tagma/sdk/config';
import { loadPipeline, validateConfig } from '@tagma/sdk/yaml';
import { generateRunId } from '@tagma/sdk/utils';

import {
  buildChatPipelineTrialInputHash,
  buildChatPipelineTrialVerificationHash,
  compileChatYamlStage,
  hashChatPipelineTrialabilityReport,
  hashChatPipelineTrialTree,
  issueChatYamlStageTrialPlanAttempt,
  listChatYamlStage,
  samePipelineRelativePath,
} from './chat-yaml-staging.js';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from './chat-pipeline-trial-cache.js';
import { TRIAL_STREAM_EVIDENCE_BYTES } from '../shared/chat-pipeline-trial-evidence.js';
import { rewriteCopiedPipelineYaml } from './pipeline-copy-paths.js';
import {
  hasCurrentChatPipelineTrialConsent,
  hasCurrentChatPipelineTrialLiveSmokeTestConsent,
} from '../shared/chat-pipeline-trial-consent.js';
import {
  buildChatPipelineTrialPlanRequest,
  findUncoveredChatPipelineTrialTerminalTaskIds,
  readChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
  type ChatPipelineTrialExpectation,
  type ChatPipelineTrialPlan,
  type ChatPipelineTrialPlanCase,
  type ChatPipelineTrialPlanRequest,
  type ChatPipelineTrialPlanToolTelemetry,
} from './chat-pipeline-trial-plan.js';
import {
  chatPipelineTrialWorkspacePathFromCasePath,
  describeTrialBlockers,
  describeTrialFixtureInputs,
  describeUncoveredTrialFixtureInputs,
  findUncoveredTrialFixtureInputs,
  resolveChatPipelineDataReadiness,
  resolveChatPipelineLiveSmokeBaseline,
  resolveChatPipelineRuntimeReadiness,
  type ChatPipelineLiveSmokeBaseline,
  type ChatPipelineTrialBlocker,
  type ChatPipelineTrialFixtureInput,
  type ChatPipelineTrialReadiness,
  type ChatPipelineTrialRecordedPrerequisiteState,
} from './chat-pipeline-trial-readiness.js';
import {
  buildChatPipelineTrialabilityReport,
  type ChatPipelineTrialMode,
  type ChatPipelineTrialabilityReport,
} from './chat-pipeline-trialability.js';
import type {
  PreparedTrialHostWitnessInputs,
  TrialHostWitness,
} from './chat-pipeline-trial-witness.js';
import {
  safeCaptureTrialHostWitnessAsync,
  safeCaptureTrialWorkspaceWitnessAsync,
  safePrepareTrialHostWitnessInputs,
} from './chat-pipeline-trial-witness.js';
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
import { tagmaDirOf } from './pipeline-paths.js';
import { buildPipelineSecretEnv } from './secrets.js';
import {
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from './server-record-auth.js';
import { MAX_LOG_RUNS } from './state.js';
import {
  normalizeRunTargetTaskIds,
  runtimeWithInjectedEnv,
  snapshotWorkspaceRuntimeMode,
  type WorkspaceRuntimeMode,
} from './routes/run-session.js';
import { beginRunSessionStart, endRunSessionStart } from './routes/run.js';
import type { WorkspaceState } from './workspace-state.js';
import { timeoutMinutesToMs } from '../shared/execution-timeout-settings.js';

const TRIAL_CACHE_VERSION = CHAT_PIPELINE_TRIAL_CACHE_VERSION;
const MAX_TRIAL_STREAM_BYTES = TRIAL_STREAM_EVIDENCE_BYTES;
const MAX_TRIAL_SUMMARY_BYTES = 32 * 1024;
const MAX_TRIAL_TASK_RESULTS = 32;
const MAX_TRIAL_OUTPUT_DIAGNOSTICS = 2;
const MAX_TRIAL_CASE_COPY_BYTES = 16 * 1024 * 1024;
const MAX_TRIAL_CASE_COPY_FILES = 256;
const MAX_TRIAL_ASSERTION_FILE_BYTES = 2 * 1024 * 1024;
const TRIAL_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_TRIAL_WORKSPACE_MONITOR_EVENTS = 10_000;
const MAX_TRIAL_WORKSPACE_CHANGE_PATHS = 32;
const TRIAL_WORKSPACE_MONITOR_QUIET_INTERVAL_MS = 25;
const TRIAL_WORKSPACE_MONITOR_QUIET_ROUNDS = 4;
const TRIAL_WORKSPACE_MONITOR_MAX_SETTLE_MS = 1_000;
const TRIAL_WORKSPACE_MONITOR_IGNORED_TAGMA_DIRS = new Set([
  '.chat-staging',
  '.opencode',
  '.opencode-runtime',
  '.usage',
  'logs',
  'node_modules',
  'plugin-runtime',
  'plugin-store',
]);

export type ChatPipelineTrialRunKind =
  | 'passed'
  | 'passed-with-warnings'
  | 'blocked'
  | 'failed'
  | 'witness-failed'
  | 'plan-required'
  | 'plan-failed'
  | 'compile-failed'
  | 'preflight-failed'
  | 'setup-failed'
  | 'aborted'
  | 'timed-out'
  | 'busy';

export interface ChatPipelineTrialOutputDiagnostic {
  readonly stream: 'stdout' | 'stderr';
  readonly stage: 'read';
  readonly message: string;
  readonly capturedBytes: number;
  /** Basename only; Trial evidence never exposes a host artifact path. */
  readonly path: string | null;
}

export interface ChatPipelineTrialTaskResult {
  caseId: string | null;
  runNumber: number;
  taskId: string;
  status: string;
  exitCode: number | null;
  failureKind: string | null;
  stdout: string;
  stderr: string;
  outputDiagnostics?: readonly ChatPipelineTrialOutputDiagnostic[];
  stderrAuxiliaryDiagnosticsOmittedLines?: number;
  repairScope: 'pipeline-artifact' | 'diagnostic-only' | null;
  stdoutTruncation: ChatPipelineTrialStreamTruncation;
  stderrTruncation: ChatPipelineTrialStreamTruncation;
}

export interface ChatPipelineTrialStreamTruncation {
  source: 'not-truncated' | 'truncated' | 'unknown';
  trialResult: boolean;
  producedBytes: number | null;
  sourceReturnedBytes: number;
  returnedBytes: number;
}

export interface ChatPipelineTrialExpectationResult {
  type: ChatPipelineTrialExpectation['type'] | 'case-execution';
  passed: boolean;
  detail: string;
  repairScope: 'pipeline-artifact' | 'diagnostic-only';
  paths?: string[];
  omittedPathEventCount?: number;
  workspaceMutation?: ChatPipelineTrialWorkspaceMutationEvidence;
  truncation?: {
    layer: 'trial-assertion-reader';
    reason: 'byte-limit';
    limitBytes: number;
    sourceBytes: number;
    returnedBytes: number;
  };
}

export interface ChatPipelineTrialWorkspaceMutationEvidence {
  layer: 'trial-workspace-mutation-monitor';
  attribution: 'writer-unknown';
  observedDuringCaseId: string;
  observedPathEventCount: number;
  returnedPathEventCount: number;
  returnedPathCount: number;
  omittedPathEventCount: number;
  paths: string[];
}

export interface ChatPipelineTrialCaseResult {
  id: string;
  title: string;
  objective: string;
  success: boolean;
  runIds: string[];
  tasks: ChatPipelineTrialTaskResult[];
  totalTaskCount: number;
  omittedTaskCount: number;
  taskStatusCounts: Record<string, number>;
  omittedTaskStatusCounts: Record<string, number>;
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

export interface ChatPipelineTrialManualExecutionGrant {
  taskId: string;
  approvalCount: number;
}

export type ChatPipelineTrialNotRunReason =
  'aborted' | 'timed-out' | 'workspace-verification-failed' | 'execution-stopped';

export interface ChatPipelineTrialNotRunCase {
  id: string;
  title: string;
  reason: ChatPipelineTrialNotRunReason;
  detail: string;
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
  taskStatusCounts?: Record<string, number>;
  omittedTaskStatusCounts?: Record<string, number>;
  repairAuthorization?: 'pipeline-change-allowed' | 'diagnostic-only';
  prerequisiteState?: ChatPipelineTrialRecordedPrerequisiteState;
  trialMode?: ChatPipelineTrialMode;
  trialabilityReport?: ChatPipelineTrialabilityReport;
  verificationMode?: 'sandbox-cases-only' | 'sandbox-cases-with-live-smoke';
  manualExecutionGrants?: ChatPipelineTrialManualExecutionGrant[];
  planTelemetry?: ChatPipelineTrialPlanToolTelemetry;
  planRequest?: ChatPipelineTrialPlanRequest & {
    attemptId: string;
    unavailableBaselineInputs?: ChatPipelineTrialUnavailableBaselineInput[];
  };
  plan?: ChatPipelineTrialPlanSummary;
  plannedCaseCount?: number;
  caseResultCount?: number;
  notRunCaseCount?: number;
  notRunCases?: ChatPipelineTrialNotRunCase[];
  cases: ChatPipelineTrialCaseResult[];
}

export type ChatPipelineTrialUnavailableBaselineInput = ChatPipelineTrialFixtureInput;

export interface ChatPipelineTrialRunInput {
  stageId: string;
  relativePath: string;
  trialId: string;
}

export type ChatPipelineTrialProgressPhase =
  | 'preparing'
  | 'capturing-host-witness'
  | 'running-baseline'
  | 'sealing-baseline'
  | 'running-case'
  | 'verifying-workspace'
  | 'capturing-post-witness';

export interface ChatPipelineTrialProgress {
  stageId: string;
  trialId: string;
  phase: ChatPipelineTrialProgressPhase;
  detail: string;
  startedAt: number;
  updatedAt: number;
  caseId: string | null;
  caseTitle: string | null;
  caseIndex: number | null;
  caseCount: number | null;
  runNumber: number | null;
  runCount: number | null;
  taskId: string | null;
  taskStatus: string | null;
}

interface CachedTrialResult {
  version: typeof TRIAL_CACHE_VERSION;
  inputHash: string;
  trialabilityReportHash: string;
  verificationHash: string;
  hostWitness: TrialHostWitness;
  result: ChatPipelineTrialRunResult;
}

interface TrialPipelineSnapshot {
  rootDir: string;
  yamlPath: string;
  contentHash: string;
  treeHash: string;
}

const inFlightByCacheKey = new Map<string, Promise<ChatPipelineTrialRunResult>>();
const activeTrialByWorkspace = new Map<string, string>();
const activeTrialProgressByIdentity = new Map<string, { value: ChatPipelineTrialProgress }>();
const activeTrialIdentityByWorkspace = new Map<
  string,
  {
    stageId: string;
    trialId: string;
    controller: AbortController;
    abortState: { timedOut: boolean; userAborted: boolean };
  }
>();

type TrialHostWitnessResult = Awaited<ReturnType<typeof safeCaptureTrialHostWitnessAsync>>;
type TrialWorkspaceWitnessResult = Awaited<
  ReturnType<typeof safeCaptureTrialWorkspaceWitnessAsync>
>;

export const __chatPipelineTrialRunTestHooks: {
  captureHostWitnessAsync?: (
    ws: WorkspaceState,
    prepared: PreparedTrialHostWitnessInputs,
    signal?: AbortSignal,
  ) => Promise<TrialHostWitnessResult>;
  captureWorkspaceWitnessAsync?: (
    ws: WorkspaceState,
    signal?: AbortSignal,
  ) => Promise<TrialWorkspaceWitnessResult>;
  timeoutMsOverride?: number;
  taskTimeoutMsOverride?: number;
  onProgress?: (progress: ChatPipelineTrialProgress) => void;
} = {};

type ChatPipelineTrialProgressPatch = Partial<
  Omit<ChatPipelineTrialProgress, 'stageId' | 'trialId' | 'startedAt' | 'updatedAt'>
>;

interface ChatPipelineTrialProgressReporter {
  update(patch: ChatPipelineTrialProgressPatch): void;
  clear(): void;
}

function trialProgressKey(
  ws: WorkspaceState,
  input: Pick<ChatPipelineTrialRunInput, 'stageId' | 'trialId'>,
): string {
  return `${ws.key}\0${input.stageId}\0${input.trialId}`;
}

function cloneTrialProgress(progress: ChatPipelineTrialProgress): ChatPipelineTrialProgress {
  return { ...progress };
}

export function getChatPipelineTrialProgress(
  ws: WorkspaceState,
  input: Pick<ChatPipelineTrialRunInput, 'stageId' | 'trialId'>,
): ChatPipelineTrialProgress | null {
  const trialId = validateTrialId(input.trialId);
  const active = activeTrialProgressByIdentity.get(
    trialProgressKey(ws, { stageId: input.stageId, trialId }),
  );
  return active ? cloneTrialProgress(active.value) : null;
}

function createTrialProgressReporter(
  ws: WorkspaceState,
  input: Pick<ChatPipelineTrialRunInput, 'stageId' | 'trialId'>,
): ChatPipelineTrialProgressReporter {
  const key = trialProgressKey(ws, input);
  const now = Date.now();
  const active: { value: ChatPipelineTrialProgress } = {
    value: {
      stageId: input.stageId,
      trialId: input.trialId,
      phase: 'preparing',
      detail: 'Preparing the targeted Trial.',
      startedAt: now,
      updatedAt: now,
      caseId: null,
      caseTitle: null,
      caseIndex: null,
      caseCount: null,
      runNumber: null,
      runCount: null,
      taskId: null,
      taskStatus: null,
    },
  };
  activeTrialProgressByIdentity.set(key, active);
  try {
    __chatPipelineTrialRunTestHooks.onProgress?.(cloneTrialProgress(active.value));
  } catch {
    // Observability must never affect Trial execution.
  }
  return {
    update(patch) {
      if (activeTrialProgressByIdentity.get(key) !== active) return;
      active.value = {
        ...active.value,
        ...patch,
        updatedAt: Math.max(active.value.updatedAt, Date.now()),
      };
      try {
        __chatPipelineTrialRunTestHooks.onProgress?.(cloneTrialProgress(active.value));
      } catch {
        // Observability must never affect Trial execution.
      }
    },
    clear() {
      if (activeTrialProgressByIdentity.get(key) === active) {
        activeTrialProgressByIdentity.delete(key);
      }
    },
  };
}

function updateTrialTaskProgress(
  progress: ChatPipelineTrialProgressReporter,
  event: RunEventPayload,
): void {
  if (event.type !== 'task_update') return;
  progress.update({ taskId: event.taskId, taskStatus: event.status });
}

async function captureTrialHostWitnessAsync(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
  signal?: AbortSignal,
): Promise<TrialHostWitnessResult> {
  if (__chatPipelineTrialRunTestHooks.captureHostWitnessAsync) {
    return await __chatPipelineTrialRunTestHooks.captureHostWitnessAsync(ws, prepared, signal);
  }
  return await safeCaptureTrialHostWitnessAsync(ws, prepared, signal);
}

async function captureTrialWorkspaceWitnessAsync(
  ws: WorkspaceState,
  signal?: AbortSignal,
): Promise<TrialWorkspaceWitnessResult> {
  if (__chatPipelineTrialRunTestHooks.captureWorkspaceWitnessAsync) {
    return await __chatPipelineTrialRunTestHooks.captureWorkspaceWitnessAsync(ws, signal);
  }
  return await safeCaptureTrialWorkspaceWitnessAsync(ws, signal);
}

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

function trialCachePath(rootDir: string, trialId: string, relativePath: string, inputHash: string) {
  const digest = createHash('sha256')
    .update(`${trialId}\0${relativePath}\0${inputHash}`)
    .digest('hex');
  return join(rootDir, '.trial-runs', `${digest}.json`);
}

function trialCacheRecordContext(
  ws: WorkspaceState,
  stageId: string,
  path: string,
): ServerRecordContext {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  return {
    workspaceTagmaDir: tagmaDirOf(ws.workDir),
    controlRoot: dirname(path),
    stageId,
    kind: 'trial-cache',
  };
}

function readCachedTrial(
  ws: WorkspaceState,
  stageId: string,
  path: string,
  inputHash: string,
  trialabilityReportHash: string,
): ChatPipelineTrialRunResult | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = readAuthenticatedServerRecordSync<Partial<CachedTrialResult>>(
      path,
      trialCacheRecordContext(ws, stageId, path),
    );
    if (
      parsed.version !== TRIAL_CACHE_VERSION ||
      parsed.inputHash !== inputHash ||
      parsed.trialabilityReportHash !== trialabilityReportHash ||
      typeof parsed.verificationHash !== 'string' ||
      typeof parsed.hostWitness?.digest !== 'string' ||
      !parsed.result ||
      parsed.result.version !== TRIAL_CACHE_VERSION ||
      !parsed.result.trialabilityReport ||
      hashChatPipelineTrialabilityReport(parsed.result.trialabilityReport) !==
        trialabilityReportHash
    ) {
      return null;
    }
    return parsed.result;
  } catch {
    return null;
  }
}

function writeCachedTrial(
  ws: WorkspaceState,
  stageId: string,
  path: string,
  inputHash: string,
  trialabilityReportHash: string,
  verificationHash: string,
  hostWitness: TrialHostWitness,
  result: ChatPipelineTrialRunResult,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAuthenticatedServerRecordSync(path, trialCacheRecordContext(ws, stageId, path), {
    version: TRIAL_CACHE_VERSION,
    inputHash,
    trialabilityReportHash,
    verificationHash,
    hostWitness,
    result,
  } satisfies CachedTrialResult);
}

function cleanupTrialPipelineSnapshot(snapshot: TrialPipelineSnapshot | null): void {
  if (!snapshot) return;
  rmSync(snapshot.rootDir, { recursive: true, force: true });
}

function createTrialPipelineSnapshot(
  stageRoot: string,
  stagedYamlPath: string,
  relativePath: string,
): TrialPipelineSnapshot {
  const snapshotsDir = join(stageRoot, '.trial-snapshots');
  mkdirSync(snapshotsDir, { recursive: true });
  const rootDir = mkdtempSync(join(snapshotsDir, 'run-'));
  try {
    const snapshotYamlPath = join(rootDir, '.tagma', ...relativePath.split('/'));
    copyTrialPipelineTree(
      dirname(stagedYamlPath),
      dirname(snapshotYamlPath),
      {
        files: 0,
        bytes: 0,
      },
      { includeTrialPlan: true },
    );
    const snapshotYaml = readFileSync(snapshotYamlPath, 'utf-8');
    const treeHash = hashChatPipelineTrialTree(dirname(snapshotYamlPath));
    if (!treeHash) throw new Error('Trial snapshot tree hash is missing.');
    return {
      rootDir,
      yamlPath: snapshotYamlPath,
      contentHash: createHash('sha1').update(snapshotYaml).digest('hex'),
      treeHash,
    };
  } catch (err) {
    rmSync(rootDir, { recursive: true, force: true });
    throw err;
  }
}

function hasActiveWorkspaceRun(ws: WorkspaceState): boolean {
  if (ws.runSessions.size > 0) return true;
  const workflow = ws.workflowRunSession as { done?: boolean } | null;
  return !!workflow && workflow.done !== true;
}

function boundedTrialText(value: string): string {
  const redacted = redactTrialText(value);
  const bytes = new TextEncoder().encode(redacted);
  if (bytes.length <= MAX_TRIAL_STREAM_BYTES) return redacted;
  const marker = '\n[trial-result-field truncated]\n';
  const markerBytes = new TextEncoder().encode(marker);
  const budget = Math.max(0, MAX_TRIAL_STREAM_BYTES - markerBytes.length);
  const head = Math.floor(budget / 3);
  const tail = budget - head;
  const decoder = new TextDecoder();
  return decoder.decode(bytes.slice(0, head)) + marker + decoder.decode(bytes.slice(-tail));
}

function boundedTrialDiagnosticText(value: string): string {
  const bounded = boundedTrialText(value);
  const bytes = new TextEncoder().encode(bounded);
  if (bytes.length <= MAX_TRIAL_STREAM_BYTES) return bounded;
  // boundedTrialText preserves both ends. A slice that cuts a multibyte
  // codepoint can add a replacement character and exceed the byte budget by
  // up to three bytes; streaming decode drops only that incomplete suffix.
  return new TextDecoder().decode(bytes.slice(0, MAX_TRIAL_STREAM_BYTES), { stream: true });
}

export function filterChatPipelineTrialStderr(value: string): {
  text: string;
  omittedAuxiliaryDiagnosticLines: number;
} {
  let omittedAuxiliaryDiagnosticLines = 0;
  const kept: string[] = [];
  for (const line of value.split(/(?<=\n)/u)) {
    const auxiliaryTitleError =
      line.includes('level=ERROR') &&
      line.includes('message="stream error"') &&
      /\bsmall=true\b/u.test(line) &&
      /\bmode=primary\b/u.test(line);
    if (auxiliaryTitleError) {
      omittedAuxiliaryDiagnosticLines += 1;
    } else {
      kept.push(line);
    }
  }
  return { text: kept.join(''), omittedAuxiliaryDiagnosticLines };
}

export function buildChatPipelineTrialStreamEvidence(
  value: string,
  producedBytes: number | undefined,
  sourceReturnedBytes = new TextEncoder().encode(value).length,
): { text: string; truncation: ChatPipelineTrialStreamTruncation } {
  const source =
    /^\[\d+ bytes truncated from head;/u.test(value) ||
    (producedBytes !== undefined && producedBytes > sourceReturnedBytes)
      ? 'truncated'
      : producedBytes !== undefined && producedBytes === sourceReturnedBytes
        ? 'not-truncated'
        : 'unknown';
  const redacted = redactTrialText(value);
  const bytes = new TextEncoder().encode(redacted);
  let text = redacted;
  let trialResult = false;
  if (bytes.length > MAX_TRIAL_STREAM_BYTES) {
    trialResult = true;
    const marker = '\n[trial-result truncated]\n';
    const markerBytes = new TextEncoder().encode(marker);
    const budget = Math.max(0, MAX_TRIAL_STREAM_BYTES - markerBytes.length);
    const head = Math.floor(budget / 3);
    const tail = budget - head;
    const decoder = new TextDecoder();
    text = decoder.decode(bytes.slice(0, head)) + marker + decoder.decode(bytes.slice(-tail));
  }
  return {
    text,
    truncation: {
      source,
      trialResult,
      producedBytes: producedBytes ?? null,
      sourceReturnedBytes,
      returnedBytes: new TextEncoder().encode(text).length,
    },
  };
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
    'passed' | 'passed-with-warnings' | 'failed' | 'plan-required' | 'plan-failed'
  >,
  message: string,
  startedAt: number,
  metadata: Pick<
    ChatPipelineTrialRunResult,
    'prerequisiteState' | 'trialMode' | 'trialabilityReport'
  > = {},
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind,
    ...metadata,
    repairAuthorization: 'diagnostic-only',
    ran: false,
    runId: null,
    summary: boundedTrialText(message),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    tasks: [],
    cases: [],
  };
}

function resultForStoppedBeforeRun(
  abortState: { timedOut: boolean },
  startedAt: number,
  lifecycleTimeoutMs: number,
): ChatPipelineTrialRunResult {
  if (abortState.timedOut) {
    return resultForSetupFailure(
      'witness-failed',
      `Trial host witness timed out before task execution after ${lifecycleTimeoutMs}ms.`,
      startedAt,
    );
  }
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind: 'aborted',
    repairAuthorization: 'diagnostic-only',
    ran: false,
    runId: null,
    summary: boundedTrialText('Trial run stopped by the user.'),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
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
    repairAuthorization: 'diagnostic-only',
    summary: boundedTrialText('Trial run stopped by the user.'),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

function resultForStopped(
  result: ChatPipelineTrialRunResult,
  abortState: { timedOut: boolean },
  startedAt: number,
  lifecycleTimeoutMs: number,
): ChatPipelineTrialRunResult {
  if (abortState.timedOut) {
    return {
      ...result,
      success: false,
      kind: 'timed-out',
      repairAuthorization: 'diagnostic-only',
      summary: boundedTrialText(`Trial run timed out after ${lifecycleTimeoutMs}ms.`),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
  return resultForAborted(result, startedAt);
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

function resultWithTrialPlan(
  result: ChatPipelineTrialRunResult,
  plan: ChatPipelineTrialPlan,
): ChatPipelineTrialRunResult {
  const returnedCaseIds = new Set(result.cases.map((testCase) => testCase.id));
  const defaultReason: ChatPipelineTrialNotRunReason =
    result.kind === 'timed-out'
      ? 'timed-out'
      : result.kind === 'aborted'
        ? 'aborted'
        : result.kind === 'witness-failed'
          ? 'workspace-verification-failed'
          : 'execution-stopped';
  const defaultDetail =
    defaultReason === 'timed-out'
      ? 'The Trial lifecycle timeout expired before this case could start.'
      : defaultReason === 'aborted'
        ? 'The Trial was stopped before this case could start.'
        : defaultReason === 'workspace-verification-failed'
          ? 'Host workspace verification failed before this case could start.'
          : `Trial execution stopped with result kind ${result.kind} before this case could start.`;
  const notRunCases =
    result.notRunCases ??
    plan.cases
      .filter((testCase) => !returnedCaseIds.has(testCase.id))
      .map((testCase) => ({
        id: testCase.id,
        title: boundedTrialText(testCase.title),
        reason: defaultReason,
        detail: defaultDetail,
      }));
  return {
    ...result,
    plan: trialPlanSummary(plan),
    plannedCaseCount: plan.cases.length,
    caseResultCount: result.cases.length,
    notRunCaseCount: notRunCases.length,
    ...(notRunCases.length > 0 ? { notRunCases } : {}),
  };
}

function resultForPlanRequest(
  request: ChatPipelineTrialPlanRequest,
  planTelemetry: ChatPipelineTrialPlanToolTelemetry,
  startedAt: number,
  attemptId: string,
  prerequisiteState?: Extract<
    ChatPipelineTrialRecordedPrerequisiteState,
    { state: 'fixture-backed' }
  >,
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
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    tasks: [],
    repairAuthorization: 'diagnostic-only',
    ...(prerequisiteState ? { prerequisiteState } : {}),
    planTelemetry,
    planRequest: {
      ...request,
      attemptId,
      ...(prerequisiteState ? { unavailableBaselineInputs: prerequisiteState.inputs } : {}),
    },
    cases: [],
  };
}

function resultForPlanAttemptBudgetExhausted(
  planTelemetry: ChatPipelineTrialPlanToolTelemetry,
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind: 'plan-failed',
    ran: false,
    runId: null,
    summary: boundedTrialText(
      'Trial plan tool attempt budget exhausted for this staged YAML revision.',
    ),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    tasks: [],
    repairAuthorization: 'diagnostic-only',
    planTelemetry,
    cases: [],
  };
}

function resultForPlanFailure(
  plan: ChatPipelineTrialPlan,
  diagnostics: readonly TrialPlanBlockingDiagnostic[],
  startedAt: number,
): ChatPipelineTrialRunResult {
  return {
    version: TRIAL_CACHE_VERSION,
    success: false,
    kind: 'plan-failed',
    ran: false,
    runId: null,
    summary: boundedTrialText(
      [
        'Trial plan found pipeline defects or blocked coverage before execution.',
        ...diagnostics.map((item) => item.message),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    durationMs: Math.max(0, Date.now() - startedAt),
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    tasks: [],
    repairAuthorization: diagnostics.some((item) => item.scope === 'pipeline-artifact')
      ? 'pipeline-change-allowed'
      : 'diagnostic-only',
    plan: trialPlanSummary(plan),
    cases: [],
  };
}

export interface TrialPlanBlockingDiagnostic {
  message: string;
  scope: 'pipeline-artifact' | 'diagnostic-only';
}

/**
 * Only genuine pipeline findings block the plan. Blocked coverage is an
 * observation limit (the harness cannot observe a required dimension), not a
 * defect: it must never fail the plan, only surface as a non-fatal warning.
 */
export function planBlockingDiagnostics(
  plan: ChatPipelineTrialPlan,
): TrialPlanBlockingDiagnostic[] {
  return plan.findings
    .filter((item) => item.severity === 'blocking')
    .map((item) => ({
      message: `${item.summary}: ${item.evidence}`,
      scope: item.repairScope,
    }));
}

export function planWarningDiagnostics(plan: ChatPipelineTrialPlan): string[] {
  return [
    ...plan.coverage
      .filter((item) => item.status === 'blocked')
      .map((item) => `Coverage not verifiable (${item.dimension}): ${item.rationale}`),
    ...plan.coverage
      .filter((item) => item.status === 'accepted-risk')
      .map((item) => `Accepted risk ${item.dimension}: ${item.rationale}`),
    ...plan.findings
      .filter((item) => item.severity === 'warning')
      .map((item) => `Plan warning ${item.summary}: ${item.evidence}`),
  ].map((message) => boundedTrialText(message));
}

export function normalizeTrialCaseTargetTaskIdsForExecution(
  raw: unknown,
  pipelineConfig: RawPipelineConfig,
): string[] {
  const targetTaskIds = normalizeRunTargetTaskIds(raw, pipelineConfig);
  if (!targetTaskIds) {
    throw new Error('Trial case targetTaskIds must contain at least one task id');
  }
  return targetTaskIds;
}

function manualTaskIdsInTargetClosure(
  dag: Dag,
  targetTaskIds: readonly string[],
): ReadonlySet<string> {
  const pending = [...targetTaskIds];
  const visited = new Set<string>();
  const manualTaskIds = new Set<string>();
  while (pending.length > 0) {
    const taskId = pending.pop()!;
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const node = dag.nodes.get(taskId);
    if (!node) throw new Error(`Target task ${taskId} not found`);
    if (node.task.trigger?.type === 'manual') manualTaskIds.add(taskId);
    pending.push(...node.dependsOn);
  }
  return manualTaskIds;
}

function casePath(workDir: string, relativePath: string, relativeYamlPath: string): string {
  const workspaceRelativePath = chatPipelineTrialWorkspacePathFromCasePath(
    relativePath,
    relativeYamlPath,
  );
  const path = resolve(workDir, ...workspaceRelativePath.split('/'));
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
  options: { includeTrialPlan?: boolean } = {},
): void {
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!options.includeTrialPlan && entry.name.endsWith('.trial-plan.json')) continue;
    const source = join(sourceDir, entry.name);
    const destination = join(destinationDir, entry.name);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('Trial pipeline helpers must not contain symlinks.');
    if (stat.isDirectory()) {
      copyTrialPipelineTree(source, destination, budget, options);
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
  relativeYamlPath: string,
  testCase: ChatPipelineTrialPlanCase,
): { rootDir: string; workDir: string; yamlPath: string } {
  const casesDir = join(stageRoot, '.trial-cases');
  mkdirSync(casesDir, { recursive: true });
  const rootDir = mkdtempSync(join(casesDir, `${testCase.id}-`));
  const workDir = join(rootDir, 'workspace');
  try {
    mkdirSync(workDir, { recursive: true });
    const pipelineFolder = dirname(stagedYamlPath);
    const stagedTagmaDir = join(workDir, '.tagma');
    const copiedPipelineFolder = join(stagedTagmaDir, basename(pipelineFolder));
    copyTrialPipelineTree(pipelineFolder, copiedPipelineFolder, {
      files: 0,
      bytes: 0,
    });
    const yamlPath = join(copiedPipelineFolder, basename(stagedYamlPath));
    for (const fixture of testCase.fixtures) {
      const path = casePath(workDir, fixture.path, relativeYamlPath);
      mkdirSync(dirname(path), { recursive: true });
      atomicWriteFileSync(path, fixture.content);
    }
    return { rootDir, workDir, yamlPath };
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

function resolveJsonPointer(
  value: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  if (pointer === '') return { found: true, value };
  let current = value;
  for (const encodedToken of pointer.slice(1).split('/')) {
    const token = encodedToken.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (
      !current ||
      typeof current !== 'object' ||
      !Object.prototype.hasOwnProperty.call(current, token)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

export function evaluateTrialExpectation(
  workDir: string,
  relativeYamlPath: string,
  expectation: ChatPipelineTrialExpectation,
  lastResult: EngineResult | null,
): ChatPipelineTrialExpectationResult {
  if (expectation.type === 'task-status') {
    const state = lastResult?.states.get(expectation.taskId);
    const actual = state?.status ?? 'missing';
    const passed = actual === expectation.status;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.taskId} expected ${expectation.status}, received ${actual}.`,
      repairScope:
        passed || !state
          ? passed
            ? 'pipeline-artifact'
            : 'diagnostic-only'
          : (trialTaskRepairScope(
              state.status,
              state.result?.failureKind ?? null,
              state.result?.outputDiagnostics,
              isExternalDriverStreamFailure(state.result?.failureKind ?? null, state.result?.stderr),
            ) ?? 'pipeline-artifact'),
    };
  }

  const path = casePath(workDir, expectation.path, relativeYamlPath);
  const stat = lstatOrNull(path);
  if (expectation.type === 'path-exists' || expectation.type === 'path-not-exists') {
    const exists = !!stat && !stat.isSymbolicLink();
    const passed = expectation.type === 'path-exists' ? exists : !exists;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.path} ${exists ? 'exists' : 'does not exist'}.`,
      repairScope: 'pipeline-artifact',
    };
  }
  if (
    expectation.type === 'file-contains' ||
    expectation.type === 'file-not-contains' ||
    expectation.type === 'file-equals' ||
    expectation.type === 'json-valid' ||
    expectation.type === 'json-pointer-equals'
  ) {
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return {
        type: expectation.type,
        passed: false,
        detail: `${expectation.path} is not a regular file.`,
        repairScope: 'pipeline-artifact',
      };
    }
    if (stat.size > MAX_TRIAL_ASSERTION_FILE_BYTES) {
      return {
        type: expectation.type,
        passed: false,
        detail: `${expectation.path} exceeds the assertion read limit.`,
        repairScope: 'diagnostic-only',
        truncation: {
          layer: 'trial-assertion-reader',
          reason: 'byte-limit',
          limitBytes: MAX_TRIAL_ASSERTION_FILE_BYTES,
          sourceBytes: stat.size,
          returnedBytes: 0,
        },
      };
    }
    const content = readFileSync(path, 'utf-8');
    if (expectation.type === 'json-valid' || expectation.type === 'json-pointer-equals') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        return {
          type: expectation.type,
          passed: false,
          detail: boundedTrialText(`${expectation.path} is not valid JSON: ${errorMessage(err)}`),
          repairScope: 'pipeline-artifact',
        };
      }
      if (expectation.type === 'json-valid') {
        return {
          type: expectation.type,
          passed: true,
          detail: `${expectation.path} contains one valid JSON value.`,
          repairScope: 'pipeline-artifact',
        };
      }
      const actual = resolveJsonPointer(parsed, expectation.pointer);
      if (!actual.found) {
        return {
          type: expectation.type,
          passed: false,
          detail: `${expectation.path} does not contain JSON Pointer ${expectation.pointer || '<root>'}.`,
          repairScope: 'pipeline-artifact',
        };
      }
      const passed = isDeepStrictEqual(actual.value, JSON.parse(expectation.expectedJson));
      return {
        type: expectation.type,
        passed,
        detail: `${expectation.path} JSON Pointer ${expectation.pointer || '<root>'} ${passed ? 'matches' : 'does not match'} the expected JSON value.`,
        repairScope: 'pipeline-artifact',
      };
    }
    if (expectation.type === 'file-equals') {
      return {
        type: expectation.type,
        passed: content === expectation.text,
        detail:
          expectation.path +
          (content === expectation.text
            ? ' exactly matches the expected text.'
            : ' does not exactly match the expected text.'),
        repairScope: 'pipeline-artifact',
      };
    }
    const contains = content.includes(expectation.text);
    const passed = expectation.type === 'file-contains' ? contains : !contains;
    return {
      type: expectation.type,
      passed,
      detail: `${expectation.path} ${contains ? 'contains' : 'does not contain'} the expected marker.`,
      repairScope: 'pipeline-artifact',
    };
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      type: expectation.type,
      passed: false,
      detail: `${expectation.path} is not a directory.`,
      repairScope: 'pipeline-artifact',
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
    repairScope: 'pipeline-artifact',
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

function syntheticTrialSecretEnv(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    [...new Set(names)]
      .sort((left, right) => left.localeCompare(right))
      .map((name) => [
        name,
        `tagma-sandbox-trial-synthetic-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`,
      ]),
  );
}

function selectTrialSecretEnv(
  source: Readonly<Record<string, string>>,
  names: readonly string[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value) selected[name] = value;
  }
  return selected;
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

export function buildChatPipelineTrialOutputDiagnostics(
  diagnostics: readonly ChatPipelineTrialOutputDiagnostic[] | undefined,
): readonly ChatPipelineTrialOutputDiagnostic[] | undefined {
  if (!diagnostics || diagnostics.length === 0) return undefined;
  const projected = diagnostics.slice(0, MAX_TRIAL_OUTPUT_DIAGNOSTICS).map((diagnostic) => {
    const pathSegments = diagnostic.path?.replace(/\\/gu, '/').split('/').filter(Boolean);
    const pathBasename = pathSegments?.at(-1);
    return Object.freeze({
      stream: diagnostic.stream,
      stage: diagnostic.stage,
      message: boundedTrialDiagnosticText(diagnostic.message),
      capturedBytes:
        Number.isSafeInteger(diagnostic.capturedBytes) && diagnostic.capturedBytes >= 0
          ? diagnostic.capturedBytes
          : 0,
      path: pathBasename ? boundedTrialDiagnosticText(pathBasename) : null,
    });
  });
  return Object.freeze(projected);
}

function isExternalDriverStreamFailure(
  failureKind: string | null,
  stderr: string | null | undefined,
): boolean {
  if (failureKind !== 'exit_nonzero') return false;
  const text = stderr ?? '';
  if (text.includes('[editor] OpenCode primary model error:')) return true;
  return (
    text.includes('message="stream error"') &&
    /\bmode=primary\b/u.test(text) &&
    /\bsmall=false\b/u.test(text)
  );
}

export function trialTaskRepairScope(
  status: string,
  failureKind: string | null,
  outputDiagnostics?: readonly ChatPipelineTrialOutputDiagnostic[],
  externalDriverStreamFailure = false,
): ChatPipelineTrialTaskResult['repairScope'] {
  if (status === 'success') return null;
  if (
    status === 'skipped' ||
    status === 'blocked' ||
    status === 'timeout' ||
    failureKind === 'timeout' ||
    failureKind === 'aborted' ||
    failureKind === 'spawn_error' ||
    failureKind === 'binary_missing' ||
    externalDriverStreamFailure ||
    (failureKind === 'output_error' && !!outputDiagnostics?.length)
  ) {
    return 'diagnostic-only';
  }
  return 'pipeline-artifact';
}

function countTrialTaskStatuses(
  tasks: readonly ChatPipelineTrialTaskResult[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function mergeTrialTaskStatusCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>>,
): void {
  for (const [status, count] of Object.entries(source)) {
    target[status] = (target[status] ?? 0) + count;
  }
}

function omittedTrialTaskStatusCounts(
  total: Readonly<Record<string, number>>,
  visible: readonly ChatPipelineTrialTaskResult[],
): Record<string, number> {
  const visibleCounts = countTrialTaskStatuses(visible);
  const omitted: Record<string, number> = {};
  for (const [status, count] of Object.entries(total)) {
    const omittedCount = Math.max(0, count - (visibleCounts[status] ?? 0));
    if (omittedCount > 0) omitted[status] = omittedCount;
  }
  return omitted;
}

function trialTaskEvidencePriority(
  task: ChatPipelineTrialTaskResult,
  failedCaseIds: ReadonlySet<string>,
): number {
  if (
    task.status === 'failed' ||
    task.status === 'timeout' ||
    task.failureKind !== null ||
    task.stderr.length > 0
  ) {
    return 0;
  }
  if (task.caseId && failedCaseIds.has(task.caseId)) return 1;
  if (task.status === 'blocked') return 2;
  if (task.status === 'skipped') return 3;
  if (task.status === 'success') return 4;
  return 2;
}

export function selectChatPipelineTrialTaskEvidence(
  tasks: readonly ChatPipelineTrialTaskResult[],
  failedCaseIds: ReadonlySet<string>,
  limit = MAX_TRIAL_TASK_RESULTS,
): ChatPipelineTrialTaskResult[] {
  if (limit <= 0 || tasks.length === 0) return [];
  const order = new Map(tasks.map((task, index) => [task, index]));
  const ranked = [...tasks].sort(
    (left, right) =>
      trialTaskEvidencePriority(left, failedCaseIds) -
        trialTaskEvidencePriority(right, failedCaseIds) ||
      (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );
  const representatives = [...failedCaseIds]
    .map((caseId) => ranked.find((task) => task.caseId === caseId))
    .filter((task): task is ChatPipelineTrialTaskResult => !!task)
    .slice(0, limit);
  const selected = new Set<ChatPipelineTrialTaskResult>(representatives);
  for (const task of ranked) {
    if (selected.size >= limit) break;
    selected.add(task);
  }
  return [...selected].sort(
    (left, right) =>
      trialTaskEvidencePriority(left, failedCaseIds) -
        trialTaskEvidencePriority(right, failedCaseIds) ||
      (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );
}

function trialTaskResults(
  result: EngineResult,
  pipelineConfig: PipelineConfig,
  caseId: string | null,
  runNumber: number,
): {
  tasks: ChatPipelineTrialTaskResult[];
  totalTaskCount: number;
  omittedTaskCount: number;
  taskStatusCounts: Record<string, number>;
  omittedTaskStatusCounts: Record<string, number>;
  countText: string;
} {
  const allTasks = [...result.states.entries()].map(([taskId, state]) => {
    const stdout = buildChatPipelineTrialStreamEvidence(
      state.result?.stdout ?? '',
      state.result?.stdoutBytes,
    );
    const rawStderr = state.result?.stderr ?? '';
    const driver =
      state.config.driver ?? state.trackConfig.driver ?? pipelineConfig.driver ?? 'opencode';
    const managedOpencodePrompt = state.config.prompt !== undefined && driver === 'opencode';
    const filteredStderr = managedOpencodePrompt
      ? filterChatPipelineTrialStderr(rawStderr)
      : { text: rawStderr, omittedAuxiliaryDiagnosticLines: 0 };
    const stderr = buildChatPipelineTrialStreamEvidence(
      filteredStderr.text,
      state.result?.stderrBytes,
      new TextEncoder().encode(rawStderr).length,
    );
    const failureKind = state.result?.failureKind ?? null;
    const outputDiagnostics = buildChatPipelineTrialOutputDiagnostics(
      state.result?.outputDiagnostics,
    );
    return {
      caseId,
      runNumber,
      taskId,
      status: state.status,
      exitCode: state.result?.exitCode ?? null,
      failureKind,
      stdout: stdout.text,
      stderr: stderr.text,
      ...(outputDiagnostics && outputDiagnostics.length > 0 ? { outputDiagnostics } : {}),
      ...(filteredStderr.omittedAuxiliaryDiagnosticLines > 0
        ? { stderrAuxiliaryDiagnosticsOmittedLines: filteredStderr.omittedAuxiliaryDiagnosticLines }
        : {}),
      repairScope: trialTaskRepairScope(
        state.status,
        failureKind,
        outputDiagnostics,
        isExternalDriverStreamFailure(failureKind, rawStderr),
      ),
      stdoutTruncation: stdout.truncation,
      stderrTruncation: stderr.truncation,
    };
  });
  const tasks = selectChatPipelineTrialTaskEvidence(allTasks, new Set());
  const taskStatusCounts = countTrialTaskStatuses(allTasks);
  return {
    tasks,
    totalTaskCount: allTasks.length,
    omittedTaskCount: Math.max(0, allTasks.length - tasks.length),
    taskStatusCounts,
    omittedTaskStatusCounts: omittedTrialTaskStatusCounts(taskStatusCounts, tasks),
    countText: Object.entries(taskStatusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(', '),
  };
}

function buildTrialSummary(
  success: boolean,
  timedOut: boolean,
  lifecycleTimeoutMs: number,
  tasks: readonly ChatPipelineTrialTaskResult[],
  omittedTaskCount: number,
  countText: string,
): string {
  const lines = [
    timedOut
      ? `Trial run timed out after ${lifecycleTimeoutMs}ms.`
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
  return (
    new TextDecoder().decode(bytes.slice(0, MAX_TRIAL_SUMMARY_BYTES)) +
    '\n[trial-summary truncated]'
  );
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
  globalSecretEnv: Record<string, string>;
  scopedSecretEnv: Record<string, string>;
  secretValues: string[];
  preflightEnvKeys: readonly string[];
  taskTimeoutMs: number;
  runtimeMode: WorkspaceRuntimeMode;
  runId: string;
  manualApprovalScopesByRunId: Map<string, ReadonlySet<string>>;
  manualApprovalTaskIds: ReadonlySet<string>;
  targetTaskIds?: string[];
  testCase?: ChatPipelineTrialPlanCase;
  onEvent?: (event: RunEventPayload) => void;
}

interface TrialExecutionBudgets {
  taskTimeoutMs: number;
  lifecycleTimeoutMs: number;
}

interface PreparedTrialExecution {
  pipelineConfig: PipelineConfig;
  targetTaskIdsByCase: Map<string, string[]>;
  manualTaskIdsByCase: Map<string, ReadonlySet<string>>;
  liveSmokeBaseline: ChatPipelineLiveSmokeBaseline;
  dataReadiness: Exclude<ChatPipelineTrialReadiness, { state: 'blocked' }>;
  trialMode: ChatPipelineTrialMode;
  trialabilityReport: ChatPipelineTrialabilityReport;
  liveSmokeTestEnabled: boolean;
}

type TrialExecutionPreparation =
  | { status: 'ready'; prepared: PreparedTrialExecution }
  | { status: 'result'; result: ChatPipelineTrialRunResult };

async function captureTrialWorkspaceDigest(
  ws: WorkspaceState,
  signal?: AbortSignal,
): Promise<{
  digest: string | null;
  reason: string | null;
}> {
  const captured = await captureTrialWorkspaceWitnessAsync(ws, signal);
  return {
    digest: captured.witness?.digest ?? null,
    reason: captured.reason,
  };
}

interface TrialWorkspaceMutationState {
  revision: number;
  healthy: boolean;
  reason: string | null;
  recentChanges: Array<{ revision: number; path: string }>;
}

interface TrialWorkspaceMutationMonitor {
  read(): TrialWorkspaceMutationState;
  settle(): Promise<void>;
  close(): void;
}

function trialWorkspaceMutationPath(filename: string | Buffer | null): string | null {
  if (filename === null) return null;
  let value: string;
  try {
    value =
      typeof filename === 'string'
        ? filename
        : new TextDecoder('utf-8', { fatal: true }).decode(filename);
  } catch {
    return null;
  }
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return normalized;
}

function ignoreTrialWorkspaceMutation(path: string): boolean {
  const segments = path.split('/');
  if (segments[0] === '.git') return true;
  return (
    segments[0] === '.tagma' &&
    segments.length >= 2 &&
    TRIAL_WORKSPACE_MONITOR_IGNORED_TAGMA_DIRS.has(segments[1]!)
  );
}

export interface TrialWorkspaceMutationEventState {
  healthy: boolean;
  reason: string | null;
  /** Every filesystem event, including ignored paths; drives quiescence tracking. */
  eventRevision: number;
  /** Tracked (non-ignored) events only; bounded by the capacity check. */
  revision: number;
  recentChanges: Array<{ revision: number; path: string }>;
}

/**
 * Applies one filesystem event to the mutation monitor state. Ignored paths
 * (runtime churn such as `.chat-staging`, `.opencode-runtime`, and `logs`)
 * never consume the bounded capacity: the capacity exists to bound tracked
 * change evidence, and ignored events produce none. Only tracked events can
 * exhaust the capacity and fail the monitor.
 */
export function applyTrialWorkspaceMutationEvent(
  state: TrialWorkspaceMutationEventState,
  filename: string | null,
): TrialWorkspaceMutationEventState {
  if (!state.healthy) return state;
  const path = trialWorkspaceMutationPath(filename);
  if (!path) {
    return {
      ...state,
      healthy: false,
      reason: 'Workspace mutation monitor reported an unknown path.',
    };
  }
  const eventRevision = state.eventRevision + 1;
  if (ignoreTrialWorkspaceMutation(path)) {
    return { ...state, eventRevision };
  }
  if (state.revision >= MAX_TRIAL_WORKSPACE_MONITOR_EVENTS) {
    return {
      ...state,
      eventRevision,
      healthy: false,
      reason: 'Workspace mutation monitor exceeded its bounded event capacity.',
    };
  }
  const revision = state.revision + 1;
  const recentChanges = [...state.recentChanges, { revision, path: boundedTrialText(path) }];
  if (recentChanges.length > MAX_TRIAL_WORKSPACE_CHANGE_PATHS) recentChanges.shift();
  return { ...state, eventRevision, revision, recentChanges };
}

function startTrialWorkspaceMutationMonitor(ws: WorkspaceState): {
  monitor: TrialWorkspaceMutationMonitor | null;
  reason: string | null;
} {
  let state: TrialWorkspaceMutationEventState = {
    healthy: true,
    reason: null,
    eventRevision: 0,
    revision: 0,
    recentChanges: [],
  };
  let closing = false;
  const fail = (message: string): void => {
    if (state.healthy) {
      state = { ...state, healthy: false, reason: state.reason ?? message };
    }
  };
  let watcher: FSWatcher;
  try {
    watcher = watch(ws.workDir, { persistent: false, recursive: true }, (_eventType, filename) => {
      state = applyTrialWorkspaceMutationEvent(state, filename);
    });
  } catch (err) {
    return {
      monitor: null,
      reason: `Workspace mutation monitor could not start: ${errorMessage(err)}`,
    };
  }
  watcher.on('error', (err) => fail(`Workspace mutation monitor failed: ${errorMessage(err)}`));
  watcher.on('close', () => {
    if (!closing) fail('Workspace mutation monitor closed unexpectedly.');
  });
  return {
    monitor: {
      read: () => ({
        revision: state.revision,
        healthy: state.healthy,
        reason: state.reason,
        recentChanges: [...state.recentChanges],
      }),
      settle: async () => {
        let observedEventRevision = state.eventRevision;
        let quietRounds = 0;
        const maxRounds = Math.ceil(
          TRIAL_WORKSPACE_MONITOR_MAX_SETTLE_MS / TRIAL_WORKSPACE_MONITOR_QUIET_INTERVAL_MS,
        );
        for (let round = 0; round < maxRounds; round += 1) {
          await new Promise<void>((resolvePromise) =>
            setTimeout(resolvePromise, TRIAL_WORKSPACE_MONITOR_QUIET_INTERVAL_MS),
          );
          if (!state.healthy) return;
          if (state.eventRevision === observedEventRevision) {
            quietRounds += 1;
            if (quietRounds >= TRIAL_WORKSPACE_MONITOR_QUIET_ROUNDS) return;
          } else {
            observedEventRevision = state.eventRevision;
            quietRounds = 0;
          }
        }
        fail('Workspace mutation monitor did not become quiescent within its bounded wait.');
      },
      close: () => {
        if (closing) return;
        closing = true;
        watcher.close();
      },
    },
    reason: null,
  };
}

function diagnosticCaseExecutionExpectation(
  detail: string,
  evidence?: ChatPipelineTrialWorkspaceMutationEvidence,
): ChatPipelineTrialExpectationResult {
  return {
    type: 'case-execution',
    passed: false,
    detail: boundedTrialText(detail),
    repairScope: 'diagnostic-only',
    ...(evidence && evidence.paths.length > 0 ? { paths: evidence.paths } : {}),
    ...(evidence && evidence.omittedPathEventCount > 0
      ? { omittedPathEventCount: evidence.omittedPathEventCount }
      : {}),
    ...(evidence ? { workspaceMutation: evidence } : {}),
  };
}

function trialWorkspaceMutationEvidence(
  previousRevision: number,
  state: TrialWorkspaceMutationState,
  caseId: string,
): ChatPipelineTrialWorkspaceMutationEvidence {
  const relevant = state.recentChanges.filter((change) => change.revision > previousRevision);
  const paths = [...new Set(relevant.map((change) => change.path))];
  const observedPathEventCount = Math.max(0, state.revision - previousRevision);
  return {
    layer: 'trial-workspace-mutation-monitor',
    attribution: 'writer-unknown',
    observedDuringCaseId: caseId,
    observedPathEventCount,
    returnedPathEventCount: relevant.length,
    returnedPathCount: paths.length,
    omittedPathEventCount: Math.max(0, observedPathEventCount - relevant.length),
    paths,
  };
}

function describeTrialWorkspaceMutation(
  caseId: string,
  evidence: ChatPipelineTrialWorkspaceMutationEvidence,
): string {
  const parts = [
    `A real-workspace change was observed while isolated case ${caseId} was running; the mutation monitor cannot identify the writer, so case containment could not be verified.`,
  ];
  if (evidence.paths.length > 0) parts.push(`Changed paths: ${evidence.paths.join(', ')}.`);
  if (evidence.omittedPathEventCount > 0) {
    parts.push(
      `${evidence.omittedPathEventCount} earlier change event(s) were omitted by the bounded diagnostic path list.`,
    );
  }
  return parts.join(' ');
}

function trialCaseForWorkspaceWitnessFailure(
  testCase: ChatPipelineTrialPlanCase,
  detail: string,
): ChatPipelineTrialCaseResult {
  return {
    id: testCase.id,
    title: testCase.title,
    objective: testCase.objective,
    success: false,
    runIds: [],
    tasks: [],
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    expectations: [diagnosticCaseExecutionExpectation(detail)],
  };
}

function resultForHostWitnessFailure(
  result: ChatPipelineTrialRunResult,
  reason: string,
): ChatPipelineTrialRunResult {
  return {
    ...result,
    success: false,
    kind: 'witness-failed',
    repairAuthorization: 'diagnostic-only',
    summary: boundedTrialText(`${result.summary}

Trial authorization witness failed: ${reason}`),
  };
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
      { ...input.pythonRunEnv, ...input.globalSecretEnv, ...trialEnv },
      input.secretValues,
      tagmaDirOf(input.ws.workDir),
      { mode: input.runtimeMode },
    ),
  });
  if (input.manualApprovalScopesByRunId.has(input.runId)) {
    throw new Error(`Trial manual execution scope already exists for run ${input.runId}.`);
  }
  input.manualApprovalScopesByRunId.set(input.runId, input.manualApprovalTaskIds);
  try {
    return await tagma.run(input.pipelineConfig, {
      cwd: input.workDir,
      approvalGateway: input.approvalGateway,
      signal: input.controller.signal,
      maxLogRuns: MAX_LOG_RUNS,
      runId: input.runId,
      skipPluginLoading: true,
      defaultTaskTimeoutMs: input.taskTimeoutMs,
      secretResolver: (names: readonly string[]) =>
        selectTrialSecretEnv(input.scopedSecretEnv, names),
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
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
  } finally {
    if (input.manualApprovalScopesByRunId.get(input.runId) === input.manualApprovalTaskIds) {
      input.manualApprovalScopesByRunId.delete(input.runId);
    }
  }
}

const TRIAL_CASE_FAILURE_STATUSES = new Set(['failed', 'timeout', 'blocked']);

/**
 * True when a run contains a task in a non-success terminal status
 * (`failed`, `timeout`, `blocked`) that no `task-status` expectation
 * declares for the same task and status. Declared expected failures (for
 * example an empty-input fail-fast gate) must not defeat an otherwise
 * passing case; undeclared failures always do.
 */
function hasUndeclaredTrialCaseTaskFailures(
  result: EngineResult,
  testCase: ChatPipelineTrialPlanCase,
): boolean {
  const declared = new Set<string>();
  for (const expectation of testCase.expectations) {
    if (expectation.type === 'task-status') {
      declared.add(`${expectation.taskId}\u0000${expectation.status}`);
    }
  }
  for (const [taskId, state] of result.states) {
    if (
      TRIAL_CASE_FAILURE_STATUSES.has(state.status) &&
      !declared.has(`${taskId}\u0000${state.status}`)
    ) {
      return true;
    }
  }
  return false;
}

function trialCaseRunMatchesExpectedTaskStatuses(
  result: EngineResult,
  testCase: ChatPipelineTrialPlanCase,
): boolean {
  const taskStatusExpectations = testCase.expectations.filter(
    (expectation) => expectation.type === 'task-status',
  );
  if (
    !taskStatusExpectations.every(
      (expectation) => result.states.get(expectation.taskId)?.status === expectation.status,
    )
  ) {
    return false;
  }
  if (hasUndeclaredTrialCaseTaskFailures(result, testCase)) return false;
  if (result.success) return true;
  return taskStatusExpectations.some(
    (expectation) =>
      TRIAL_CASE_FAILURE_STATUSES.has(expectation.status) &&
      result.states.get(expectation.taskId)?.status === expectation.status,
  );
}

export function evaluateChatPipelineTrialCaseSuccess(input: {
  testCase: ChatPipelineTrialPlanCase;
  runResults: readonly EngineResult[];
  expectations: ChatPipelineTrialExpectationResult[];
}): boolean {
  if (input.runResults.length !== input.testCase.runs) return false;
  if (!input.expectations.every((item) => item.passed)) return false;
  return input.runResults.every((result) =>
    trialCaseRunMatchesExpectedTaskStatuses(result, input.testCase),
  );
}

async function executeTargetedTrialCase(
  input: Omit<
    RunTrialPipelineInput,
    'workDir' | 'runId' | 'targetTaskIds' | 'testCase' | 'onEvent'
  > & {
    stageRoot: string;
    stagedYamlPath: string;
    relativeYamlPath: string;
    testCase: ChatPipelineTrialPlanCase;
    targetTaskIds?: string[];
    caseIndex: number;
    caseCount: number;
    progress: ChatPipelineTrialProgressReporter;
  },
): Promise<{ result: ChatPipelineTrialCaseResult; totalTaskCount: number }> {
  let caseWorkspace: { rootDir: string; workDir: string; yamlPath: string } | null = null;
  const runIds: string[] = [];
  const tasks: ChatPipelineTrialTaskResult[] = [];
  let totalTaskCount = 0;
  const taskStatusCounts: Record<string, number> = {};
  const runResults: EngineResult[] = [];
  let lastResult: EngineResult | null = null;
  let executionError: string | null = null;
  input.progress.update({
    phase: 'running-case',
    detail: `Preparing targeted case ${input.caseIndex}/${input.caseCount}: ${input.testCase.title}.`,
    caseId: input.testCase.id,
    caseTitle: input.testCase.title,
    caseIndex: input.caseIndex,
    caseCount: input.caseCount,
    runNumber: null,
    runCount: input.testCase.runs,
    taskId: null,
    taskStatus: null,
  });
  try {
    caseWorkspace = prepareTrialCaseWorkspace(
      input.stageRoot,
      input.stagedYamlPath,
      input.relativeYamlPath,
      input.testCase,
    );
    const stagedYaml = readFileSync(input.stagedYamlPath, 'utf-8');
    const relocatedCaseYaml = rewriteCopiedPipelineYaml(stagedYaml, {
      workDir: caseWorkspace.workDir,
      sourceContentPath: input.stagedYamlPath,
      sourceIdentityPath: input.logicalYamlPath,
      destinationYamlPath: caseWorkspace.yamlPath,
      pipelineName: input.pipelineConfig.name,
    });
    const casePipelineConfig = await loadPipeline(relocatedCaseYaml, caseWorkspace.workDir);
    const caseConfigErrors = validateConfig(casePipelineConfig);
    if (caseConfigErrors.length > 0) {
      throw new Error(`Isolated case configuration error: ${caseConfigErrors.join('; ')}`);
    }
    for (let runNumber = 1; runNumber <= input.testCase.runs; runNumber += 1) {
      input.progress.update({
        phase: 'running-case',
        detail: `Running targeted case ${input.caseIndex}/${input.caseCount}: ${input.testCase.title}.`,
        caseId: input.testCase.id,
        caseTitle: input.testCase.title,
        caseIndex: input.caseIndex,
        caseCount: input.caseCount,
        runNumber,
        runCount: input.testCase.runs,
        taskId: null,
        taskStatus: null,
      });
      const runId = generateRunId();
      runIds.push(runId);
      lastResult = await runTrialPipelineOnce({
        ...input,
        pipelineConfig: casePipelineConfig,
        workDir: caseWorkspace.workDir,
        runId,
        targetTaskIds: input.targetTaskIds,
        testCase: input.testCase,
        onEvent: (event) => updateTrialTaskProgress(input.progress, event),
      });
      runResults.push(lastResult);
      const evidence = trialTaskResults(
        lastResult,
        casePipelineConfig,
        input.testCase.id,
        runNumber,
      );
      totalTaskCount += evidence.totalTaskCount;
      mergeTrialTaskStatusCounts(taskStatusCounts, evidence.taskStatusCounts);
      tasks.push(...evidence.tasks);
      if (input.controller.signal.aborted) break;
    }
  } catch (err) {
    executionError = `Case execution crashed: ${errorMessage(err)}`;
  }

  const expectations: ChatPipelineTrialExpectationResult[] = [];
  if (executionError) {
    expectations.push(diagnosticCaseExecutionExpectation(executionError));
  } else if (caseWorkspace) {
    for (const expectation of input.testCase.expectations) {
      try {
        expectations.push(
          evaluateTrialExpectation(
            caseWorkspace.workDir,
            input.relativeYamlPath,
            expectation,
            lastResult,
          ),
        );
      } catch (err) {
        expectations.push({
          type: expectation.type,
          passed: false,
          detail: `Expectation crashed: ${errorMessage(err)}`,
          repairScope: 'diagnostic-only',
        });
      }
    }
  }
  if (caseWorkspace) {
    try {
      rmSync(caseWorkspace.rootDir, { recursive: true, force: true });
    } catch (err) {
      expectations.push(
        diagnosticCaseExecutionExpectation(`Case cleanup failed: ${errorMessage(err)}`),
      );
    }
  }
  const success = evaluateChatPipelineTrialCaseSuccess({
    testCase: input.testCase,
    runResults,
    expectations,
  });
  const selectedTasks = selectChatPipelineTrialTaskEvidence(
    tasks,
    success ? new Set() : new Set([input.testCase.id]),
  );
  return {
    result: {
      id: input.testCase.id,
      title: boundedTrialText(input.testCase.title),
      objective: boundedTrialText(input.testCase.objective),
      success,
      runIds,
      tasks: selectedTasks,
      totalTaskCount,
      omittedTaskCount: Math.max(0, totalTaskCount - selectedTasks.length),
      taskStatusCounts,
      omittedTaskStatusCounts: omittedTrialTaskStatusCounts(taskStatusCounts, selectedTasks),
      expectations,
    },
    totalTaskCount,
  };
}

function buildPlannedTrialSummary(
  baselineSuccess: boolean,
  timedOut: boolean,
  lifecycleTimeoutMs: number,
  baselineTasks: readonly ChatPipelineTrialTaskResult[],
  baselineOmittedTaskCount: number,
  taskStatusCounts: Readonly<Record<string, number>>,
  cases: readonly ChatPipelineTrialCaseResult[],
  notRunCases: readonly ChatPipelineTrialNotRunCase[],
  plannedCaseCount: number,
  trialMode: ChatPipelineTrialMode,
  warnings: readonly string[],
  manualExecutionGrants: readonly ChatPipelineTrialManualExecutionGrant[],
): string {
  const allPassed =
    baselineSuccess && notRunCases.length === 0 && cases.every((item) => item.success);
  const countText = Object.entries(taskStatusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  const baseSummary = buildTrialSummary(
    allPassed,
    timedOut,
    lifecycleTimeoutMs,
    baselineTasks,
    baselineOmittedTaskCount,
    countText,
  );
  const lines = [
    allPassed && !timedOut && warnings.length > 0
      ? baseSummary.replace('Trial run passed', 'Trial run passed with warnings')
      : baseSummary,
    '',
    trialMode === 'sandbox'
      ? 'Trial mode: Sandbox Trial only; Live Smoke Test was not requested.'
      : 'Trial mode: Sandbox Trial with an explicitly enabled Live Smoke Test.',
    `Targeted cases: ${cases.filter((item) => item.success).length}/${plannedCaseCount} passed; ${cases.length} result(s) returned; ${Math.max(0, plannedCaseCount - cases.length)} not run.`,
  ];
  for (const testCase of cases) {
    lines.push(
      `Case ${testCase.id}: ${testCase.success ? 'passed' : 'failed'} — ${testCase.objective}`,
    );
    for (const expectation of testCase.expectations) {
      if (!expectation.passed) lines.push(`  ${expectation.type}: ${expectation.detail}`);
    }
  }
  for (const testCase of notRunCases) {
    const reason =
      testCase.reason === 'workspace-verification-failed'
        ? 'workspace verification failed'
        : testCase.reason === 'timed-out'
          ? 'Trial timed out'
          : testCase.reason === 'aborted'
            ? 'Trial was aborted'
            : 'Trial execution stopped';
    lines.push(`Not-run case ${testCase.id}: ${reason} — ${testCase.detail}`);
  }
  if (manualExecutionGrants.length > 0) {
    lines.push(
      '',
      `Selected manual tasks executed under explicit Trial grants: ${manualExecutionGrants
        .map((grant) => `${grant.taskId} (${grant.approvalCount} approvals)`)
        .join(', ')}.`,
    );
  }
  if (warnings.length > 0) {
    lines.push('', `Verification warnings: ${warnings.length}.`, ...warnings);
  }
  const summary = redactTrialText(lines.join('\n'));
  const bytes = new TextEncoder().encode(summary);
  if (bytes.length <= MAX_TRIAL_SUMMARY_BYTES) return summary;
  return (
    new TextDecoder().decode(bytes.slice(0, MAX_TRIAL_SUMMARY_BYTES)) +
    '\n[trial-summary truncated]'
  );
}

async function loadTrialPipelineConfig(
  snapshot: TrialPipelineSnapshot,
  workDir: string,
): Promise<PipelineConfig> {
  const pipelineConfig = await loadPipeline(readFileSync(snapshot.yamlPath, 'utf-8'), workDir);
  const configErrors = validateConfig(pipelineConfig);
  if (configErrors.length > 0) {
    throw new Error(configErrors.join('; '));
  }
  return pipelineConfig;
}

async function prepareTrialExecution(
  ws: WorkspaceState,
  stage: ReturnType<typeof listChatYamlStage>,
  entry: ReturnType<typeof listChatYamlStage>['entries'][number],
  snapshot: TrialPipelineSnapshot,
  pipelineConfig: PipelineConfig,
  trialabilityReport: ChatPipelineTrialabilityReport,
  plan: ChatPipelineTrialPlan,
  planTelemetry: ChatPipelineTrialPlanToolTelemetry,
  trialId: string,
  startedAt: number,
  trialMode: ChatPipelineTrialMode,
  liveSmokeTestEnabled: boolean,
): Promise<TrialExecutionPreparation> {
  const withTrialability = (result: ChatPipelineTrialRunResult): ChatPipelineTrialRunResult => ({
    ...result,
    trialMode,
    trialabilityReport,
  });

  let dag: Dag;
  try {
    dag = buildDag(pipelineConfig);
  } catch (err) {
    return {
      status: 'result',
      result: withTrialability(
        resultForSetupFailure(
          'setup-failed',
          `Trial run dependency graph error: ${errorMessage(err)}`,
          startedAt,
        ),
      ),
    };
  }

  const targetTaskIdsByCase = new Map<string, string[]>();
  const manualTaskIdsByCase = new Map<string, ReadonlySet<string>>();
  const planDiagnostics = planBlockingDiagnostics(plan);
  for (const testCase of plan.cases) {
    try {
      const targetTaskIds = normalizeTrialCaseTargetTaskIdsForExecution(
        testCase.targetTaskIds,
        pipelineConfig,
      );
      const manualTaskIds = manualTaskIdsInTargetClosure(dag, targetTaskIds);
      targetTaskIdsByCase.set(testCase.id, targetTaskIds);
      manualTaskIdsByCase.set(testCase.id, manualTaskIds);
    } catch (err) {
      planDiagnostics.push({
        message: `${testCase.id}: ${errorMessage(err)}`,
        scope: 'pipeline-artifact',
      });
    }
  }
  if (planDiagnostics.length > 0) {
    return {
      status: 'result',
      result: withTrialability(resultForPlanFailure(plan, planDiagnostics, startedAt)),
    };
  }
  if (!trialabilityReport.runnable) {
    return {
      status: 'result',
      result: resultForSetupFailure(
        'blocked',
        `Trial Interaction Protocol preflight blocked execution: ${trialabilityReport.blockers.join('; ')}`,
        startedAt,
        { trialMode, trialabilityReport },
      ),
    };
  }

  const dataReadiness = resolveChatPipelineDataReadiness(
    pipelineConfig,
    ws.workDir,
    entry.relativePath,
  );
  if (dataReadiness.state === 'blocked') {
    return {
      status: 'result',
      result: resultForSetupFailure(
        'blocked',
        `Trial cannot safely virtualize its data prerequisites: ${describeTrialBlockers(dataReadiness.blockers)}. Preserve the declared paths; do not write placeholders outside the isolated Trial workspace.`,
        startedAt,
        { prerequisiteState: dataReadiness, trialMode, trialabilityReport },
      ),
    };
  }
  const liveSmokeBaseline = resolveChatPipelineLiveSmokeBaseline(
    pipelineConfig,
    dataReadiness,
    ws.workDir,
    {
      livePipelineDir: dirname(
        entry.sourcePath ?? resolve(ws.workDir, '.tagma', entry.relativePath),
      ),
      stagedPipelineDir: dirname(snapshot.yamlPath),
    },
  );
  const liveSmokeCoveredTaskIds = new Set<string>(
    !liveSmokeTestEnabled || liveSmokeBaseline.mode === 'skip'
      ? []
      : liveSmokeBaseline.mode === 'run-all'
        ? dag.nodes.keys()
        : liveSmokeBaseline.targetTaskIds,
  );
  const uncoveredTerminalTaskIds = findUncoveredChatPipelineTrialTerminalTaskIds(
    plan,
    pipelineConfig,
    liveSmokeCoveredTaskIds,
  );
  if (uncoveredTerminalTaskIds.length > 0) {
    if (planTelemetry.toolAttemptCount >= stage.trialPlanMaxAttempts) {
      return {
        status: 'result',
        result: withTrialability(resultForPlanAttemptBudgetExhausted(planTelemetry, startedAt)),
      };
    }
    issueChatYamlStageTrialPlanAttempt(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      yamlHash: snapshot.contentHash,
      attemptId: trialId,
    });
    const reason = !liveSmokeTestEnabled
      ? 'Sandbox Trial does not execute a real-workspace baseline'
      : liveSmokeBaseline.mode === 'skip'
        ? 'The requested Live Smoke Test has no runnable real-workspace branch'
        : 'The requested Live Smoke Test excludes terminal branches that are not runnable in the real workspace';
    return {
      status: 'result',
      result: withTrialability(
        resultForPlanRequest(
          buildChatPipelineTrialPlanRequest(
            'invalid',
            entry.relativePath,
            snapshot.contentHash,
            `${reason}, and targeted cases do not execute every uncovered terminal task: ${uncoveredTerminalTaskIds.join(', ')}. Add a case targeting each terminal task so its dependency closure runs. If a terminal task is unsafe or cannot be executed in Trial, record a blocking diagnostic-only finding instead of claiming Trial passed.`,
            stage.trialPlanMaxAttempts,
          ),
          planTelemetry,
          startedAt,
          trialId,
          dataReadiness.state === 'fixture-backed' ? dataReadiness : undefined,
        ),
      ),
    };
  }
  if (dataReadiness.state === 'fixture-backed') {
    const uncoveredInputs = findUncoveredTrialFixtureInputs(
      plan,
      dataReadiness.inputs,
      pipelineConfig,
    );
    if (uncoveredInputs.length > 0) {
      if (planTelemetry.toolAttemptCount >= stage.trialPlanMaxAttempts) {
        return {
          status: 'result',
          result: withTrialability(resultForPlanAttemptBudgetExhausted(planTelemetry, startedAt)),
        };
      }
      issueChatYamlStageTrialPlanAttempt(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        yamlHash: snapshot.contentHash,
        attemptId: trialId,
      });
      return {
        status: 'result',
        result: withTrialability(
          resultForPlanRequest(
            buildChatPipelineTrialPlanRequest(
              'invalid',
              entry.relativePath,
              snapshot.contentHash,
              `The current trial plan does not cover unavailable baseline data inputs: ${describeUncoveredTrialFixtureInputs(uncoveredInputs)}. Correct the Trial Plan only; preserve the pipeline requirements and do not write placeholders to the real workspace.`,
              stage.trialPlanMaxAttempts,
            ),
            planTelemetry,
            startedAt,
            trialId,
            dataReadiness,
          ),
        ),
      };
    }
  }

  return {
    status: 'ready',
    prepared: {
      pipelineConfig,
      targetTaskIdsByCase,
      manualTaskIdsByCase,
      liveSmokeBaseline,
      dataReadiness,
      trialMode,
      trialabilityReport,
      liveSmokeTestEnabled,
    },
  };
}

async function executeTrial(
  ws: WorkspaceState,
  stage: ReturnType<typeof listChatYamlStage>,
  entry: ReturnType<typeof listChatYamlStage>['entries'][number],
  snapshot: TrialPipelineSnapshot,
  plan: ChatPipelineTrialPlan,
  prepared: PreparedTrialExecution,
  controller: AbortController,
  abortState: { timedOut: boolean },
  budgets: TrialExecutionBudgets,
  progress: ChatPipelineTrialProgressReporter,
  runtimeMode: WorkspaceRuntimeMode,
): Promise<ChatPipelineTrialRunResult> {
  const startedAt = Date.now();
  progress.update({
    phase: 'preparing',
    detail: prepared.liveSmokeTestEnabled
      ? 'Preparing Sandbox Trial cases and the optional Live Smoke Test.'
      : 'Preparing Sandbox Trial cases without a real-workspace baseline.',
    caseId: null,
    caseTitle: null,
    caseIndex: null,
    caseCount: null,
    runNumber: null,
    runCount: null,
    taskId: null,
    taskStatus: null,
  });
  const {
    pipelineConfig,
    targetTaskIdsByCase,
    manualTaskIdsByCase,
    liveSmokeBaseline,
    dataReadiness,
    trialMode,
    trialabilityReport,
    liveSmokeTestEnabled,
  } = prepared;
  const fixtureInputs = dataReadiness.state === 'fixture-backed' ? dataReadiness.inputs : [];
  const baselineSkipped = !liveSmokeTestEnabled || liveSmokeBaseline.mode === 'skip';
  const baselineTargetTaskIds =
    liveSmokeTestEnabled && liveSmokeBaseline.mode === 'targeted'
      ? liveSmokeBaseline.targetTaskIds
      : undefined;

  const pythonSettings = readEditorSettings(ws).pythonAgent;
  const pythonRunEnv = buildPythonAgentRunEnv(ws.workDir, pythonSettings);
  const pythonPreflightOptions =
    Object.keys(pythonRunEnv).length > 0
      ? {
          extraPathDirs: [pythonAgentVenvBinDir(ws.workDir)],
          extraEnv: pythonRunEnv,
        }
      : {};
  const preflight = runPreflight(snapshot.yamlPath, pythonPreflightOptions);
  const logicalYamlPath = entry.sourcePath ?? resolve(ws.workDir, '.tagma', entry.relativePath);
  const declaredSecretNames = collectDeclaredSecretNames(pipelineConfig);
  const allSecretNames = [...new Set([...preflight.envKeys, ...declaredSecretNames])];
  const sandboxScopedSecretEnv = syntheticTrialSecretEnv(allSecretNames);
  const sandboxGlobalSecretEnv = selectTrialSecretEnv(sandboxScopedSecretEnv, preflight.envKeys);
  let liveScopedSecretEnv: Record<string, string> = {};
  if (liveSmokeTestEnabled) {
    try {
      liveScopedSecretEnv = buildPipelineSecretEnv(ws.workDir, logicalYamlPath, allSecretNames);
    } catch (err) {
      return resultForSetupFailure(
        'setup-failed',
        `Secret manager error: ${errorMessage(err)}`,
        startedAt,
        { trialMode, trialabilityReport },
      );
    }
  }
  const liveGlobalSecretEnv = selectTrialSecretEnv(liveScopedSecretEnv, preflight.envKeys);
  const runtimeReadiness = resolveChatPipelineRuntimeReadiness({
    missingBinaries: preflight.missing.binaries,
    missingEnvironment: liveSmokeTestEnabled
      ? preflight.missing.envs.filter((name) => !liveGlobalSecretEnv[name])
      : [],
  });
  if (runtimeReadiness.state === 'blocked') {
    return resultForSetupFailure(
      'blocked',
      `Trial run requirements are unavailable: ${describeTrialBlockers(runtimeReadiness.blockers)}. Preserve legitimate requirements and safety gates; do not invent or remove them merely to make the trial pass.`,
      startedAt,
      { prerequisiteState: runtimeReadiness, trialMode, trialabilityReport },
    );
  }

  const approvalGateway = new InMemoryApprovalGateway();
  const manualApprovalScopesByRunId = new Map<string, ReadonlySet<string>>();
  const manualExecutionGrantCounts = new Map<string, number>();
  const manualApprovalBlockers = new Map<string, ChatPipelineTrialBlocker>();
  const unsubscribeApproval = approvalGateway.subscribe((event: ApprovalEvent) => {
    if (event.type !== 'requested') return;
    const taskId = event.request.taskId.includes('.')
      ? event.request.taskId
      : event.request.trackId
        ? `${event.request.trackId}.${event.request.taskId}`
        : event.request.taskId;
    const allowedManualTaskIds = event.request.runId
      ? manualApprovalScopesByRunId.get(event.request.runId)
      : undefined;
    if (allowedManualTaskIds?.has(taskId)) {
      manualExecutionGrantCounts.set(taskId, (manualExecutionGrantCounts.get(taskId) ?? 0) + 1);
      approvalGateway.resolve(event.request.id, {
        outcome: 'approved',
        actor: 'chat-trial-run',
        reason: 'Explicit Trial target execution grant for this manual task.',
      });
      return;
    }
    manualApprovalBlockers.set(taskId, { kind: 'approval', name: taskId, taskId });
    approvalGateway.resolve(event.request.id, {
      outcome: 'rejected',
      actor: 'chat-trial-run',
      reason:
        'Chat trial runs never auto-approve manual safety gates unless the task is in an explicit Trial target closure.',
    });
  });
  const runId = generateRunId();
  let workspaceMutationMonitor: TrialWorkspaceMutationMonitor | null = null;
  let hostWitnessCaptureFailure = false;

  try {
    const secretValues = Object.values({
      ...sandboxScopedSecretEnv,
      ...liveScopedSecretEnv,
    }).filter(Boolean);
    let baselineSuccess = true;
    let baselineEvidence = {
      tasks: [] as ChatPipelineTrialTaskResult[],
      totalTaskCount: 0,
      omittedTaskCount: 0,
      taskStatusCounts: {} as Record<string, number>,
      omittedTaskStatusCounts: {} as Record<string, number>,
      countText: '',
    };
    if (!baselineSkipped) {
      progress.update({
        phase: 'running-baseline',
        detail: 'Running the optional Live Smoke Test in the real workspace.',
        caseId: null,
        caseTitle: null,
        caseIndex: null,
        caseCount: null,
        runNumber: 1,
        runCount: 1,
        taskId: null,
        taskStatus: null,
      });
      const baseline = await runTrialPipelineOnce({
        ws,
        pipelineConfig,
        workDir: ws.workDir,
        logicalYamlPath,
        approvalGateway,
        controller,
        pythonRunEnv,
        globalSecretEnv: liveGlobalSecretEnv,
        scopedSecretEnv: liveScopedSecretEnv,
        secretValues,
        preflightEnvKeys: preflight.envKeys,
        taskTimeoutMs: budgets.taskTimeoutMs,
        runtimeMode,
        runId,
        manualApprovalScopesByRunId,
        // The live smoke never auto-approves manual safety gates: manual
        // tasks are human boundaries and are exercised through Sandbox
        // cases instead (the baseline target set already excludes them).
        manualApprovalTaskIds: new Set<string>(),
        ...(baselineTargetTaskIds ? { targetTaskIds: baselineTargetTaskIds } : {}),
        onEvent: (event) => updateTrialTaskProgress(progress, event),
      });
      baselineSuccess = baseline.success;
      baselineEvidence = trialTaskResults(baseline, pipelineConfig, null, 1);
    }
    const cases: ChatPipelineTrialCaseResult[] = [];
    let caseLoopStop: { reason: ChatPipelineTrialNotRunReason; detail: string } | null = null;
    let totalTaskCount = baselineEvidence.totalTaskCount;
    progress.update({
      phase: 'sealing-baseline',
      detail: baselineSkipped
        ? 'Sealing the real workspace before Sandbox Trial cases.'
        : 'Sealing the real workspace after the Live Smoke Test.',
      caseId: null,
      caseTitle: null,
      caseIndex: null,
      caseCount: null,
      runNumber: null,
      runCount: null,
      taskId: null,
      taskStatus: null,
    });
    const mutationMonitorStart = startTrialWorkspaceMutationMonitor(ws);
    workspaceMutationMonitor = mutationMonitorStart.monitor;
    if (workspaceMutationMonitor) await workspaceMutationMonitor.settle();
    const baselineWorkspace = await captureTrialWorkspaceDigest(ws, controller.signal);
    const baselineMutationState = workspaceMutationMonitor?.read() ?? null;
    let expectedWorkspaceMutationRevision = baselineMutationState?.revision ?? null;
    let pendingWorkspaceWitnessFailure = baselineWorkspace.digest
      ? null
      : `Could not seal the real workspace ${baselineSkipped ? 'before isolated cases' : 'after baseline'}: ${baselineWorkspace.reason ?? 'unknown witness failure'}.`;
    pendingWorkspaceWitnessFailure ??= mutationMonitorStart.reason
      ? `Could not verify that isolated cases left the real workspace unchanged: ${mutationMonitorStart.reason}`
      : baselineMutationState && !baselineMutationState.healthy
        ? `Could not verify that isolated cases left the real workspace unchanged: ${baselineMutationState.reason ?? 'workspace mutation monitor failed'}.`
        : null;
    if (!baselineWorkspace.digest && pendingWorkspaceWitnessFailure) {
      hostWitnessCaptureFailure = true;
    }
    for (const [caseOffset, testCase] of plan.cases.entries()) {
      if (controller.signal.aborted) {
        caseLoopStop = abortState.timedOut
          ? {
              reason: 'timed-out',
              detail: `The Trial lifecycle timeout expired before case ${testCase.id} could start.`,
            }
          : {
              reason: 'aborted',
              detail: `The Trial was stopped before case ${testCase.id} could start.`,
            };
        break;
      }
      if (pendingWorkspaceWitnessFailure) {
        cases.push(trialCaseForWorkspaceWitnessFailure(testCase, pendingWorkspaceWitnessFailure));
        caseLoopStop = {
          reason: 'workspace-verification-failed',
          detail: `Workspace verification failed while preparing case ${testCase.id}.`,
        };
        pendingWorkspaceWitnessFailure = null;
        break;
      }
      const workspaceFailures: ChatPipelineTrialExpectationResult[] = [];

      const caseExecution = await executeTargetedTrialCase({
        ws,
        pipelineConfig,
        logicalYamlPath,
        approvalGateway,
        controller,
        pythonRunEnv,
        globalSecretEnv: sandboxGlobalSecretEnv,
        scopedSecretEnv: sandboxScopedSecretEnv,
        secretValues,
        preflightEnvKeys: preflight.envKeys,
        taskTimeoutMs: budgets.taskTimeoutMs,
        runtimeMode,
        manualApprovalScopesByRunId,
        manualApprovalTaskIds: manualTaskIdsByCase.get(testCase.id) ?? new Set<string>(),
        stageRoot: stage.rootDir,
        stagedYamlPath: snapshot.yamlPath,
        relativeYamlPath: entry.relativePath,
        testCase,
        targetTaskIds: targetTaskIdsByCase.get(testCase.id),
        caseIndex: caseOffset + 1,
        caseCount: plan.cases.length,
        progress,
      });
      progress.update({
        phase: 'verifying-workspace',
        detail: `Verifying the real workspace after case ${caseOffset + 1}/${plan.cases.length}.`,
        caseId: testCase.id,
        caseTitle: testCase.title,
        caseIndex: caseOffset + 1,
        caseCount: plan.cases.length,
        runNumber: null,
        runCount: testCase.runs,
        taskId: null,
        taskStatus: null,
      });
      if (workspaceMutationMonitor) await workspaceMutationMonitor.settle();
      if (workspaceMutationMonitor) {
        const mutationState = workspaceMutationMonitor.read();
        if (!mutationState.healthy) {
          workspaceFailures.push(
            diagnosticCaseExecutionExpectation(
              `Could not verify that isolated cases left the real workspace unchanged: ${mutationState.reason ?? 'workspace mutation monitor failed'}.`,
            ),
          );
        } else if (
          expectedWorkspaceMutationRevision !== null &&
          mutationState.revision !== expectedWorkspaceMutationRevision
        ) {
          const evidence = trialWorkspaceMutationEvidence(
            expectedWorkspaceMutationRevision,
            mutationState,
            testCase.id,
          );
          workspaceFailures.push(
            diagnosticCaseExecutionExpectation(
              describeTrialWorkspaceMutation(testCase.id, evidence),
              evidence,
            ),
          );
        }
        expectedWorkspaceMutationRevision = mutationState.revision;
      }
      const caseResult =
        workspaceFailures.length === 0
          ? caseExecution.result
          : {
              ...caseExecution.result,
              success: false,
              expectations: [...caseExecution.result.expectations, ...workspaceFailures],
            };
      cases.push(caseResult);
      totalTaskCount += caseExecution.totalTaskCount;
      if (workspaceFailures.length > 0) {
        caseLoopStop = {
          reason: 'workspace-verification-failed',
          detail: `Workspace verification failed after case ${testCase.id}.`,
        };
        break;
      }
    }
    if (baselineWorkspace.digest) {
      progress.update({
        phase: 'verifying-workspace',
        detail: 'Verifying the real workspace after all targeted cases.',
        caseId: null,
        caseTitle: null,
        caseIndex: null,
        caseCount: plan.cases.length,
        runNumber: null,
        runCount: null,
        taskId: null,
        taskStatus: null,
      });
      const finalWorkspace = await captureTrialWorkspaceDigest(ws, controller.signal);
      const finalWorkspaceFailure = !finalWorkspace.digest
        ? `Could not capture the real workspace after isolated cases: ${finalWorkspace.reason ?? 'unknown witness failure'}.`
        : finalWorkspace.digest !== baselineWorkspace.digest
          ? 'A real-workspace change was observed while isolated cases were running; witness evidence cannot identify the writer, so case containment could not be verified.'
          : null;
      if (finalWorkspaceFailure) {
        if (!finalWorkspace.digest) hostWitnessCaptureFailure = true;
        const lastCaseIndex = cases.length - 1;
        const lastCase = cases[lastCaseIndex];
        if (lastCase) {
          cases[lastCaseIndex] = {
            ...lastCase,
            success: false,
            expectations: [
              ...lastCase.expectations,
              diagnosticCaseExecutionExpectation(finalWorkspaceFailure),
            ],
          };
        } else {
          const pendingCase = plan.cases[0];
          if (pendingCase) {
            cases.push(trialCaseForWorkspaceWitnessFailure(pendingCase, finalWorkspaceFailure));
          }
        }
      }
    }
    if (cases.length < plan.cases.length && !caseLoopStop) {
      caseLoopStop = {
        reason: 'execution-stopped',
        detail: 'Trial execution stopped before the remaining cases could start.',
      };
    }
    const returnedCaseIds = new Set(cases.map((testCase) => testCase.id));
    const notRunCases: ChatPipelineTrialNotRunCase[] = plan.cases
      .filter((testCase) => !returnedCaseIds.has(testCase.id))
      .map((testCase) => ({
        id: testCase.id,
        title: boundedTrialText(testCase.title),
        reason: caseLoopStop?.reason ?? 'execution-stopped',
        detail: boundedTrialText(
          caseLoopStop?.detail ?? 'Trial execution stopped before the remaining cases could start.',
        ),
      }));
    const success =
      baselineSuccess &&
      !abortState.timedOut &&
      cases.length === plan.cases.length &&
      cases.every((item) => item.success);
    const planWarnings = [
      ...planWarningDiagnostics(plan),
      ...trialabilityReport.warnings,
      ...(fixtureInputs.length > 0
        ? [
            baselineSkipped
              ? `The Live Smoke Test was skipped because its real-workspace data inputs were unavailable. Sandbox cases ran with isolated fixtures instead: ${describeTrialFixtureInputs(fixtureInputs)}. No placeholder was written to the real workspace.`
              : `The Live Smoke Test ran only prerequisite-ready tasks. Tasks depending on unavailable data were exercised through Sandbox fixtures instead: ${describeTrialFixtureInputs(fixtureInputs)}. No placeholder was written to the real workspace.`,
          ]
        : []),
      ...(liveSmokeBaseline.manualGatedTaskIds.length > 0 && liveSmokeTestEnabled
        ? [
            liveSmokeBaseline.mode === 'skip'
              ? `The Live Smoke Test was skipped because every eligible task requires a manual approval gate. Manual-gated tasks were exercised through Sandbox cases instead: ${liveSmokeBaseline.manualGatedTaskIds.join(', ')}. No placeholder was written to the real workspace.`
              : `The Live Smoke Test ran only tasks without manual approval gates. Manual-gated tasks were exercised through Sandbox cases instead: ${liveSmokeBaseline.manualGatedTaskIds.join(', ')}. No placeholder was written to the real workspace.`,
          ]
        : []),
      ...(liveSmokeBaseline.middlewareUnavailableTaskIds.length > 0 && liveSmokeTestEnabled
        ? [
            `The Live Smoke Test excluded tasks whose static_context middleware source is not ready in the real workspace (the source is missing or differs from the staged artifact, which merges only after the Trial). Their terminal branches were exercised through Sandbox cases instead: ${liveSmokeBaseline.middlewareUnavailableTaskIds.join(', ')}. No placeholder was written to the real workspace.`,
          ]
        : []),
    ];
    const manualExecutionGrants: ChatPipelineTrialManualExecutionGrant[] = [
      ...manualExecutionGrantCounts.entries(),
    ]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskId, approvalCount]) => ({ taskId, approvalCount }));
    const allTaskEvidenceCandidates = [
      ...baselineEvidence.tasks,
      ...cases.flatMap((item) => item.tasks),
    ];
    const failedCaseIds = new Set(cases.filter((item) => !item.success).map((item) => item.id));
    const visibleTasks = selectChatPipelineTrialTaskEvidence(
      allTaskEvidenceCandidates,
      failedCaseIds,
    );
    const omittedTaskCount = Math.max(0, totalTaskCount - visibleTasks.length);
    const taskStatusCounts = { ...baselineEvidence.taskStatusCounts };
    for (const testCase of cases) {
      mergeTrialTaskStatusCounts(taskStatusCounts, testCase.taskStatusCounts);
    }
    const omittedTaskStatusCounts = omittedTrialTaskStatusCounts(taskStatusCounts, visibleTasks);
    const visibleCases = cases.map((item) => {
      const visibleCaseTasks = visibleTasks.filter((task) => task.caseId === item.id);
      return {
        ...item,
        tasks: visibleCaseTasks,
        omittedTaskCount: Math.max(0, item.totalTaskCount - visibleCaseTasks.length),
        omittedTaskStatusCounts: omittedTrialTaskStatusCounts(
          item.taskStatusCounts,
          visibleCaseTasks,
        ),
      };
    });
    const kind: ChatPipelineTrialRunKind = abortState.timedOut
      ? 'timed-out'
      : hostWitnessCaptureFailure
        ? 'witness-failed'
        : success
          ? planWarnings.length > 0
            ? 'passed-with-warnings'
            : 'passed'
          : 'failed';
    const hasPipelineArtifactFailure =
      allTaskEvidenceCandidates.some(
        (task) =>
          task.repairScope === 'pipeline-artifact' &&
          !['success', 'skipped', 'blocked'].includes(task.status),
      ) ||
      cases.some((testCase) =>
        testCase.expectations.some(
          (expectation) => !expectation.passed && expectation.repairScope === 'pipeline-artifact',
        ),
      );
    const result: ChatPipelineTrialRunResult = {
      version: TRIAL_CACHE_VERSION,
      success,
      kind,
      ...(kind === 'failed'
        ? {
            repairAuthorization: hasPipelineArtifactFailure
              ? ('pipeline-change-allowed' as const)
              : ('diagnostic-only' as const),
          }
        : kind === 'timed-out' || kind === 'witness-failed'
          ? { repairAuthorization: 'diagnostic-only' as const }
          : {}),
      ran: true,
      runId: baselineSkipped ? (cases.flatMap((item) => item.runIds)[0] ?? null) : runId,
      ...(dataReadiness.state === 'fixture-backed' ? { prerequisiteState: dataReadiness } : {}),
      trialMode,
      trialabilityReport,
      verificationMode: baselineSkipped ? 'sandbox-cases-only' : 'sandbox-cases-with-live-smoke',
      ...(manualExecutionGrants.length > 0 ? { manualExecutionGrants } : {}),
      summary: buildPlannedTrialSummary(
        baselineSuccess,
        abortState.timedOut,
        budgets.lifecycleTimeoutMs,
        baselineEvidence.tasks,
        baselineEvidence.omittedTaskCount,
        taskStatusCounts,
        cases,
        notRunCases,
        plan.cases.length,
        trialMode,
        planWarnings,
        manualExecutionGrants,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount,
      omittedTaskCount,
      tasks: visibleTasks,
      taskStatusCounts,
      omittedTaskStatusCounts,
      plan: trialPlanSummary(plan),
      plannedCaseCount: plan.cases.length,
      caseResultCount: visibleCases.length,
      notRunCaseCount: notRunCases.length,
      ...(notRunCases.length > 0 ? { notRunCases } : {}),
      cases: visibleCases,
    };
    const hasExecutableFailure = allTaskEvidenceCandidates.some(
      (task) => !['success', 'skipped', 'blocked'].includes(task.status),
    );
    const hasUnrelatedCaseFailure = cases.some(
      (testCase) => !testCase.success && !testCase.tasks.some((task) => task.status === 'blocked'),
    );
    if (
      manualApprovalBlockers.size > 0 &&
      !abortState.timedOut &&
      !hostWitnessCaptureFailure &&
      !hasExecutableFailure &&
      !hasUnrelatedCaseFailure
    ) {
      const prerequisiteState = {
        state: 'blocked' as const,
        blockers: [...manualApprovalBlockers.values()],
      };
      return {
        ...result,
        success: false,
        kind: 'blocked',
        repairAuthorization: 'diagnostic-only',
        prerequisiteState,
        summary: boundedTrialText(
          `Trial is blocked by manual approval prerequisites outside the explicit target grant: ${describeTrialBlockers(prerequisiteState.blockers)}. Tagma did not grant execution to those manual tasks or execute their gated side effects.\n\n${result.summary}`,
        ),
      };
    }
    return result;
  } catch (err) {
    return {
      version: TRIAL_CACHE_VERSION,
      success: false,
      kind: abortState.timedOut ? 'timed-out' : 'failed',
      repairAuthorization: 'diagnostic-only',
      ran: true,
      runId,
      trialMode,
      trialabilityReport,
      summary: boundedTrialText(
        abortState.timedOut
          ? `Trial run timed out after ${budgets.lifecycleTimeoutMs}ms.`
          : `Trial run crashed: ${errorMessage(err)}`,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount: 0,
      omittedTaskCount: 0,
      taskStatusCounts: {},
      omittedTaskStatusCounts: {},
      tasks: [],
      plan: trialPlanSummary(plan),
      cases: [],
    };
  } finally {
    workspaceMutationMonitor?.close();
    unsubscribeApproval();
    approvalGateway.abortAll('chat trial run finished');
  }
}

export async function trialRunChatYamlStage(
  ws: WorkspaceState,
  input: ChatPipelineTrialRunInput,
): Promise<ChatPipelineTrialRunResult> {
  const runtimeMode = snapshotWorkspaceRuntimeMode();
  const trialId = validateTrialId(input.trialId);
  const editorSettings = readEditorSettings(ws);
  if (!hasCurrentChatPipelineTrialConsent(editorSettings)) {
    throw new Error(
      'Explicit consent is required in Editor Settings before Sandbox Trial can run AI-authored commands with host process authority.',
    );
  }
  const liveSmokeTestEnabled = hasCurrentChatPipelineTrialLiveSmokeTestConsent(editorSettings);
  const trialMode: ChatPipelineTrialMode = liveSmokeTestEnabled
    ? 'sandbox-with-live-smoke'
    : 'sandbox';
  const timeoutMsOverride = __chatPipelineTrialRunTestHooks.timeoutMsOverride;
  const taskTimeoutMsOverride = __chatPipelineTrialRunTestHooks.taskTimeoutMsOverride;
  const budgets: TrialExecutionBudgets = {
    taskTimeoutMs:
      typeof taskTimeoutMsOverride === 'number'
        ? taskTimeoutMsOverride
        : timeoutMinutesToMs(editorSettings.pipelineDefaultTaskTimeoutMinutes),
    lifecycleTimeoutMs:
      typeof timeoutMsOverride === 'number'
        ? timeoutMsOverride
        : timeoutMinutesToMs(editorSettings.opencodeChatTrialRunTimeoutMinutes),
  };
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
  let snapshot: TrialPipelineSnapshot | null = createTrialPipelineSnapshot(
    stage.rootDir,
    entry.stagedPath,
    entry.relativePath,
  );
  let pendingRunReservation: ReturnType<typeof beginRunSessionStart> = null;
  try {
    const planTelemetry = readChatPipelineTrialPlanToolTelemetry(
      entry.stagedPath,
      stage.trialPlanMaxAttempts,
    );
    if (planTelemetry.yamlHash !== snapshot.contentHash) {
      throw new Error('Staged YAML changed while Trial was preparing; retry the Trial run.');
    }
    let pipelineConfig: PipelineConfig;
    try {
      pipelineConfig = await loadTrialPipelineConfig(snapshot, ws.workDir);
    } catch (err) {
      return {
        ...resultForSetupFailure(
          'setup-failed',
          `Trial run configuration error: ${errorMessage(err)}`,
          startedAt,
          { trialMode },
        ),
        planTelemetry,
      };
    }
    const pluginError = await ensureTrialPluginsLoaded(ws, pipelineConfig.plugins ?? []);
    if (pluginError) {
      return {
        ...resultForSetupFailure('setup-failed', `Plugin load error: ${pluginError}`, startedAt, {
          trialMode,
        }),
        planTelemetry,
      };
    }
    const trialabilityReport = buildChatPipelineTrialabilityReport({
      pipelineConfig,
      registry: ws.registry,
      capabilityOwners: ws.pluginCapabilityOwners,
      mode: trialMode,
    });
    const preflightMetadata = { trialMode, trialabilityReport };
    if (!trialabilityReport.runnable) {
      return {
        ...resultForSetupFailure(
          'blocked',
          `Trial Interaction Protocol preflight blocked execution: ${trialabilityReport.blockers.join('; ')}`,
          startedAt,
          preflightMetadata,
        ),
        planTelemetry,
      };
    }
    const planRead = readChatPipelineTrialPlan(
      snapshot.yamlPath,
      entry.relativePath,
      snapshot.contentHash,
      stage.trialPlanMaxAttempts,
      pipelineConfig,
      ws.workDir,
    );
    if (planRead.status === 'required') {
      const dataReadiness = resolveChatPipelineDataReadiness(
        pipelineConfig,
        ws.workDir,
        entry.relativePath,
      );
      if (planTelemetry.toolAttemptCount >= stage.trialPlanMaxAttempts) {
        return {
          ...resultForPlanAttemptBudgetExhausted(planTelemetry, startedAt),
          ...preflightMetadata,
        };
      }
      issueChatYamlStageTrialPlanAttempt(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        yamlHash: snapshot.contentHash,
        attemptId: trialId,
      });
      return {
        ...resultForPlanRequest(
          planRead.request,
          planTelemetry,
          startedAt,
          trialId,
          dataReadiness.state === 'fixture-backed' ? dataReadiness : undefined,
        ),
        ...preflightMetadata,
      };
    }
    const plan = planRead.plan;
    const preparation = await prepareTrialExecution(
      ws,
      stage,
      entry,
      snapshot,
      pipelineConfig,
      trialabilityReport,
      plan,
      planTelemetry,
      trialId,
      startedAt,
      trialMode,
      liveSmokeTestEnabled,
    );
    if (preparation.status === 'result') {
      return { ...resultWithTrialPlan(preparation.result, plan), planTelemetry };
    }
    const preparedExecution = preparation.prepared;
    const trialabilityReportHash = hashChatPipelineTrialabilityReport(trialabilityReport);
    const inputHash = buildChatPipelineTrialInputHash({
      stagedTreeHash: snapshot.treeHash,
      planHash: planRead.planHash,
      trialMode,
      trialabilityReportHash,
    });
    const cachePath = trialCachePath(stage.rootDir, trialId, entry.relativePath, inputHash);
    const cached = readCachedTrial(ws, stage.id, cachePath, inputHash, trialabilityReportHash);
    if (cached) return resultWithTrialPlan(cached, plan);
    const inFlightKey = cachePath;
    const existing = inFlightByCacheKey.get(inFlightKey);
    if (existing) return existing;
    pendingRunReservation = beginRunSessionStart(ws);
    if (pendingRunReservation === null) {
      return {
        ...resultWithTrialPlan(
          resultForSetupFailure(
            'busy',
            'Trial run was skipped because another pipeline or workflow run is active in this workspace.',
            Date.now(),
            preflightMetadata,
          ),
          plan,
        ),
        planTelemetry,
      };
    }
    if (hasActiveWorkspaceRun(ws) || activeTrialByWorkspace.has(ws.key)) {
      endRunSessionStart(ws, pendingRunReservation);
      pendingRunReservation = null;
      return {
        ...resultWithTrialPlan(
          resultForSetupFailure(
            'busy',
            'Trial run was skipped because another pipeline or workflow run is active in this workspace.',
            Date.now(),
            preflightMetadata,
          ),
          plan,
        ),
        planTelemetry,
      };
    }

    const controller = new AbortController();
    const abortState = { timedOut: false, userAborted: false };
    const activeIdentity = { stageId: stage.id, trialId, controller, abortState };
    const timeout = setTimeout(() => {
      abortState.timedOut = true;
      controller.abort('chat trial run timeout');
    }, budgets.lifecycleTimeoutMs);
    if (timeoutMsOverride === undefined) timeout.unref?.();
    activeTrialByWorkspace.set(ws.key, inFlightKey);
    activeTrialIdentityByWorkspace.set(ws.key, activeIdentity);
    ws.chatPipelineTrialAbort = controller;
    const progress = createTrialProgressReporter(ws, { stageId: stage.id, trialId });

    const executionSnapshot = snapshot;
    snapshot = null;
    const runReservation = pendingRunReservation;
    pendingRunReservation = null;
    const promise = (async () => {
      try {
        if (controller.signal.aborted) {
          return {
            ...resultForStoppedBeforeRun(abortState, startedAt, budgets.lifecycleTimeoutMs),
            ...preflightMetadata,
          };
        }
        progress.update({
          phase: 'preparing',
          detail: 'Preparing the Trial host witness inputs.',
          caseId: null,
          caseTitle: null,
          caseIndex: null,
          caseCount: null,
          runNumber: null,
          runCount: null,
          taskId: null,
          taskStatus: null,
        });
        const prepared = safePrepareTrialHostWitnessInputs(ws, {
          relativePath: entry.relativePath,
          sourcePath: entry.sourcePath,
          stagedYamlPath: executionSnapshot.yamlPath,
        });
        if (controller.signal.aborted) {
          return {
            ...resultForStoppedBeforeRun(abortState, startedAt, budgets.lifecycleTimeoutMs),
            ...preflightMetadata,
          };
        }
        if (!prepared.prepared) {
          return resultForSetupFailure(
            'witness-failed',
            `Trial host witness setup failed: ${prepared.reason}`,
            startedAt,
            preflightMetadata,
          );
        }
        const hostWitnessInputs = prepared.prepared;
        progress.update({
          phase: 'capturing-host-witness',
          detail: 'Capturing the pre-run host witness.',
          caseId: null,
          caseTitle: null,
          caseIndex: null,
          caseCount: null,
          runNumber: null,
          runCount: null,
          taskId: null,
          taskStatus: null,
        });
        const currentWitness = await captureTrialHostWitnessAsync(
          ws,
          hostWitnessInputs,
          controller.signal,
        );
        if (controller.signal.aborted) {
          return {
            ...resultForStoppedBeforeRun(abortState, startedAt, budgets.lifecycleTimeoutMs),
            ...preflightMetadata,
          };
        }
        if (!currentWitness.witness) {
          return resultForSetupFailure(
            'witness-failed',
            `Trial host witness capture failed: ${currentWitness.reason}`,
            startedAt,
            preflightMetadata,
          );
        }
        const preWitness = currentWitness.witness;
        const result = await executeTrial(
          ws,
          stage,
          entry,
          executionSnapshot,
          plan,
          preparedExecution,
          controller,
          abortState,
          budgets,
          progress,
          runtimeMode,
        );
        if (controller.signal.aborted) {
          return resultForStopped(result, abortState, startedAt, budgets.lifecycleTimeoutMs);
        }
        if (result.kind !== 'aborted') {
          progress.update({
            phase: 'capturing-post-witness',
            detail: 'Capturing the post-run host witness.',
            caseId: null,
            caseTitle: null,
            caseIndex: null,
            caseCount: null,
            runNumber: null,
            runCount: null,
            taskId: null,
            taskStatus: null,
          });
          const postPrepared = safePrepareTrialHostWitnessInputs(ws, {
            relativePath: entry.relativePath,
            sourcePath: entry.sourcePath,
            stagedYamlPath: executionSnapshot.yamlPath,
          });
          if (controller.signal.aborted) {
            return resultForStopped(result, abortState, startedAt, budgets.lifecycleTimeoutMs);
          }
          if (!postPrepared.prepared) {
            if (result.success) {
              return resultForHostWitnessFailure(
                result,
                postPrepared.reason ?? 'unknown witness setup failure',
              );
            }
            return result;
          }
          const postWitness = await captureTrialHostWitnessAsync(
            ws,
            postPrepared.prepared,
            controller.signal,
          );
          if (controller.signal.aborted) {
            return resultForStopped(result, abortState, startedAt, budgets.lifecycleTimeoutMs);
          }
          if (!postWitness.witness) {
            if (result.success) {
              return resultForHostWitnessFailure(
                result,
                postWitness.reason ?? 'unknown witness failure',
              );
            }
            return result;
          }
          if (
            result.success &&
            preWitness.prerequisiteDigest !== postWitness.witness.prerequisiteDigest
          ) {
            return resultForHostWitnessFailure(
              result,
              'Host prerequisites changed during trial execution; rerun is required before finalize.',
            );
          }
          const postVerificationHash = buildChatPipelineTrialVerificationHash({
            inputHash,
            hostWitnessDigest: postWitness.witness.digest,
          });
          writeCachedTrial(
            ws,
            stage.id,
            cachePath,
            inputHash,
            trialabilityReportHash,
            postVerificationHash,
            postWitness.witness,
            { ...resultWithTrialPlan(result, plan), planTelemetry },
          );
        }
        return result;
      } finally {
        clearTimeout(timeout);
        progress.clear();
        if (activeTrialByWorkspace.get(ws.key) === inFlightKey)
          activeTrialByWorkspace.delete(ws.key);
        if (activeTrialIdentityByWorkspace.get(ws.key) === activeIdentity) {
          activeTrialIdentityByWorkspace.delete(ws.key);
        }
        if (ws.chatPipelineTrialAbort === controller) ws.chatPipelineTrialAbort = null;
        endRunSessionStart(ws, runReservation);
        inFlightByCacheKey.delete(inFlightKey);
        cleanupTrialPipelineSnapshot(executionSnapshot);
      }
    })().then((result) => ({ ...resultWithTrialPlan(result, plan), planTelemetry }));
    inFlightByCacheKey.set(inFlightKey, promise);
    return promise;
  } finally {
    if (pendingRunReservation !== null) endRunSessionStart(ws, pendingRunReservation);
    cleanupTrialPipelineSnapshot(snapshot);
  }
}
