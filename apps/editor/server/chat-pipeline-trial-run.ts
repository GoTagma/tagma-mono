import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  createTagma,
  DEFAULT_TASK_TIMEOUT_MS,
  type EngineResult,
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
import { atomicWriteFileSync, errorMessage } from './path-utils.js';
import { buildPipelineSecretEnv } from './secrets.js';
import { MAX_LOG_RUNS } from './state.js';
import { runtimeWithInjectedEnv } from './routes/run-session.js';
import type { WorkspaceState } from './workspace-state.js';

const TRIAL_CACHE_VERSION = 1;
const CHAT_PIPELINE_TRIAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TRIAL_STREAM_BYTES = 4 * 1024;
const MAX_TRIAL_SUMMARY_BYTES = 32 * 1024;
const MAX_TRIAL_TASK_RESULTS = 32;
const TRIAL_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

export type ChatPipelineTrialRunKind =
  | 'passed'
  | 'failed'
  | 'compile-failed'
  | 'preflight-failed'
  | 'setup-failed'
  | 'timed-out'
  | 'busy';

export interface ChatPipelineTrialTaskResult {
  taskId: string;
  status: string;
  exitCode: number | null;
  failureKind: string | null;
  stdout: string;
  stderr: string;
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
  contentHash: string,
) {
  const digest = createHash('sha256')
    .update(`${trialId}\0${relativePath}\0${contentHash}`)
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
  kind: Exclude<ChatPipelineTrialRunKind, 'passed' | 'failed' | 'timed-out'>,
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

function trialTaskResults(result: EngineResult): {
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

async function executeTrial(
  ws: WorkspaceState,
  stageId: string,
  entry: ReturnType<typeof listChatYamlStage>['entries'][number],
): Promise<ChatPipelineTrialRunResult> {
  const startedAt = Date.now();
  const compile = compileChatYamlStage(ws, stageId, entry.relativePath);
  if (!compile.success) {
    return resultForSetupFailure(
      'compile-failed',
      `Trial run was skipped because YAML compilation failed: ${compile.summary}\n${JSON.stringify(compile.validation)}`,
      startedAt,
    );
  }

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
  const controller = new AbortController();
  ws.chatPipelineTrialAbort = controller;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort('chat trial run timeout');
  }, CHAT_PIPELINE_TRIAL_TIMEOUT_MS);
  timeout.unref?.();
  const runId = generateRunId();

  try {
    const secretValues = Object.values(allSecretEnv).filter(Boolean);
    const tagma = createTagma({
      registry: ws.registry,
      builtins: false,
      runtime: runtimeWithInjectedEnv({ ...pythonRunEnv, ...allSecretEnv }, secretValues),
    });
    const result = await tagma.run(pipelineConfig, {
      cwd: ws.workDir,
      approvalGateway,
      signal: controller.signal,
      maxLogRuns: MAX_LOG_RUNS,
      runId,
      skipPluginLoading: true,
      defaultTaskTimeoutMs: Math.min(DEFAULT_TASK_TIMEOUT_MS, CHAT_PIPELINE_TRIAL_TIMEOUT_MS),
      secretResolver: (names: readonly string[]) =>
        buildPipelineSecretEnv(ws.workDir, logicalYamlPath, names),
      ...(preflight.envKeys.length > 0
        ? { envPolicy: { mode: 'allowlist' as const, keys: preflight.envKeys } }
        : {}),
    });
    const taskEvidence = trialTaskResults(result);
    const success = result.success && !timedOut;
    return {
      version: TRIAL_CACHE_VERSION,
      success,
      kind: timedOut ? 'timed-out' : success ? 'passed' : 'failed',
      ran: true,
      runId,
      summary: buildTrialSummary(
        success,
        timedOut,
        taskEvidence.tasks,
        taskEvidence.omittedTaskCount,
        taskEvidence.countText,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount: taskEvidence.totalTaskCount,
      omittedTaskCount: taskEvidence.omittedTaskCount,
      tasks: taskEvidence.tasks,
    };
  } catch (err) {
    return {
      version: TRIAL_CACHE_VERSION,
      success: false,
      kind: timedOut ? 'timed-out' : 'failed',
      ran: true,
      runId,
      summary: boundedTrialText(
        timedOut
          ? `Trial run timed out after ${CHAT_PIPELINE_TRIAL_TIMEOUT_MS}ms.`
          : `Trial run crashed: ${errorMessage(err)}`,
      ),
      durationMs: Math.max(0, Date.now() - startedAt),
      totalTaskCount: 0,
      omittedTaskCount: 0,
      tasks: [],
    };
  } finally {
    clearTimeout(timeout);
    if (ws.chatPipelineTrialAbort === controller) ws.chatPipelineTrialAbort = null;
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
  const cachePath = trialCachePath(stage.rootDir, trialId, entry.relativePath, entry.contentHash);
  const cached = readCachedTrial(cachePath, entry.contentHash);
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

  const promise = (async () => {
    activeTrialByWorkspace.set(ws.key, cachePath);
    try {
      const result = await executeTrial(ws, input.stageId, entry);
      writeCachedTrial(cachePath, entry.contentHash, result);
      return result;
    } finally {
      if (activeTrialByWorkspace.get(ws.key) === cachePath) activeTrialByWorkspace.delete(ws.key);
      inFlightByCachePath.delete(cachePath);
    }
  })();
  inFlightByCachePath.set(cachePath, promise);
  return promise;
}
