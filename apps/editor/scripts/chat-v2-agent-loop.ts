import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  NO_AUTH_REQUIRED_SENTINEL,
  upsertCustomProvider,
  validateCustomProvider,
} from '../server/opencode-config.js';
import {
  OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
  OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
  startOpencodeV2FakeProvider,
} from '../tests/helpers/opencode-v2-fake-provider.js';

type JsonRecord = Record<string, unknown>;
export type ChatV2AgentLoopScenario = 'clarification' | 'discussion' | 'authoring-permission';

export interface DriveChatV2OperationOptions {
  readonly origin: string;
  readonly managementToken: string;
  readonly workspacePath: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly clarificationReply: string;
  readonly permissionChoice?: 'allow_once' | 'allow_always' | 'deny';
  readonly questionAnswers?: readonly string[];
  readonly onProgress?: (progress: DriveChatV2OperationProgress) => void;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface DriveChatV2OperationResult {
  readonly operationId: string;
  readonly terminalOutcome: string;
  readonly actionKinds: readonly ChatV2AgentLoopActionKind[];
}

export type ChatV2AgentLoopActionKind =
  | 'create'
  | 'snapshot'
  | 'projection'
  | 'clarification_reply'
  | 'permission_reply'
  | 'question_reply';

export interface DriveChatV2OperationProgress {
  readonly operationId: string;
  readonly generation: number;
  readonly version: number;
  readonly phase: string;
  readonly waitReason: string | null;
  readonly terminalOutcome: string | null;
  readonly actionKinds: readonly ChatV2AgentLoopActionKind[];
}

export interface IsolatedChatV2AgentLoopReport {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly scenario: ChatV2AgentLoopScenario;
  readonly sidecarMode: 'source' | 'compiled';
  readonly verdict: 'passed' | 'failed';
  readonly startedAt: number;
  readonly completedAt: number;
  readonly operation: DriveChatV2OperationResult | null;
  readonly lastOperation: DriveChatV2OperationProgress | null;
  readonly failure: { readonly name: string; readonly message: string } | null;
  readonly diagnostics: {
    readonly protocolVersion: number | null;
    readonly timelineCursor: number | null;
    readonly logCursor: number | null;
    readonly timelineTruncated: boolean | null;
    readonly logsTruncated: boolean | null;
    readonly hostEventCount: number | null;
    readonly opencodeSessionCount: number | null;
  };
  readonly artifactsDirectory: string;
  readonly reportPath: string;
  readonly diagnosticsPath: string | null;
}

export interface RunIsolatedChatV2AgentLoopOptions {
  readonly timeoutMs?: number;
  readonly artifactsParentDirectory?: string;
  readonly keepRuntime?: boolean;
  readonly scenario?: ChatV2AgentLoopScenario;
  readonly sidecarExecutable?: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const editorRoot = resolve(scriptDirectory, '..');

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

function operationFromMutation(value: unknown): JsonRecord {
  const envelope = record(value, 'Chat mutation response');
  if (envelope.protocolVersion !== 2) throw new Error('Chat mutation protocol mismatch.');
  return record(record(envelope.result, 'Chat mutation result').operation, 'Chat operation');
}

function terminalOutcome(operation: JsonRecord): string | null {
  if (operation.phase !== 'terminal') return null;
  return nonEmptyString(operation.terminalOutcome, 'Terminal outcome');
}

function emitProgress(
  options: DriveChatV2OperationOptions,
  operation: JsonRecord,
  actionKinds: readonly ChatV2AgentLoopActionKind[],
): void {
  if (!options.onProgress) return;
  const waitReason = operation.waitReason;
  const projectedWaitReason =
    waitReason === null || typeof waitReason === 'string' ? waitReason : null;
  const projectedTerminal = operation.terminalOutcome;
  options.onProgress({
    operationId: nonEmptyString(operation.operationId, 'Operation id'),
    generation: positiveInteger(operation.generation, 'Operation generation'),
    version:
      Number.isSafeInteger(operation.version) && (operation.version as number) >= 0
        ? (operation.version as number)
        : 0,
    phase: nonEmptyString(operation.phase, 'Operation phase'),
    waitReason: projectedWaitReason,
    terminalOutcome:
      projectedTerminal === null || typeof projectedTerminal === 'string'
        ? projectedTerminal
        : null,
    actionKinds: Object.freeze([...actionKinds]),
  });
}

function pushAction(actions: ChatV2AgentLoopActionKind[], action: ChatV2AgentLoopActionKind): void {
  if (action === 'projection' && actions.at(-1) === 'projection') return;
  if (actions.length >= 512) throw new Error('Chat V2 agent-loop action bound exceeded.');
  actions.push(action);
}

function requestHeaders(options: DriveChatV2OperationOptions, json: boolean): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${options.managementToken}`,
    'X-Tagma-Workspace': options.workspacePath,
  });
  if (json) headers.set('Content-Type', 'application/json');
  return headers;
}

async function requestJson(
  options: DriveChatV2OperationOptions,
  path: string,
  deadline: number,
  init: RequestInit = {},
): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Chat V2 agent loop timed out.');
  const response = await fetch(new URL(path, options.origin), {
    ...init,
    headers: requestHeaders(options, init.body !== undefined),
    signal: AbortSignal.timeout(remaining),
  });
  const body = await response.json().catch(() => {
    throw new Error(`Chat V2 endpoint ${path} returned non-JSON HTTP ${response.status}.`);
  });
  if (!response.ok) {
    const value = record(body, 'Chat V2 error');
    const kind = typeof value.kind === 'string' ? ` ${value.kind}` : '';
    throw new Error(`Chat V2 endpoint ${path} returned HTTP ${response.status}${kind}.`);
  }
  return body;
}

export async function driveChatV2Operation(
  options: DriveChatV2OperationOptions,
): Promise<DriveChatV2OperationResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new TypeError('Agent loop timeoutMs must be an integer of at least 1000ms.');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('Agent loop pollIntervalMs must be a positive integer.');
  }
  const deadline = Date.now() + timeoutMs;
  const rendererInstanceId = `renderer-agent-loop-${randomUUID()}`;
  const conversationId = `conversation-agent-loop-${randomUUID()}`;
  const actions: ChatV2AgentLoopActionKind[] = [];
  type CreateOutcome =
    | { readonly kind: 'completed'; readonly value: unknown }
    | { readonly kind: 'failed'; readonly error: unknown };
  let observedCreate: CreateOutcome | null = null;
  let createFailed = false;
  let createFailure: unknown;
  const createOutcome: Promise<CreateOutcome> = requestJson(
    options,
    '/api/chat/operations',
    deadline,
    {
      method: 'POST',
      body: JSON.stringify({
        protocolVersion: 2,
        clientRequestId: `agent-loop-create-${randomUUID()}`,
        payload: {
          request: { text: options.prompt, attachments: [] },
          provider: options.provider,
          model: options.model,
          variant: null,
          rendererInstanceId,
          conversationId,
          localRevision: null,
          candidateId: null,
          dirtySnapshot: null,
        },
      }),
    },
  ).then(
    (value) => ({ kind: 'completed' as const, value }),
    (error) => ({ kind: 'failed' as const, error }),
  );
  void createOutcome.then((outcome) => {
    observedCreate = outcome;
    if (outcome.kind === 'failed') {
      createFailed = true;
      createFailure = outcome.error;
    }
  });
  const requireSuccessfulCreate = async (authorityOperationId: string): Promise<void> => {
    const outcome = observedCreate ?? (await createOutcome);
    observedCreate = outcome;
    if (outcome.kind === 'failed') throw outcome.error;
    const createdOperation = operationFromMutation(outcome.value);
    const createdOperationId = nonEmptyString(createdOperation.operationId, 'Created operation id');
    if (createdOperationId !== authorityOperationId) {
      throw new Error('Chat create response does not match correlated operation authority.');
    }
  };
  pushAction(actions, 'create');
  let operation: JsonRecord | null = null;
  let operationId: string | null = null;

  while (!operationId) {
    const raced = await Promise.race([
      createOutcome,
      delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))).then(() => null),
    ]);
    if (raced) observedCreate = raced;
    if (observedCreate?.kind === 'failed') throw observedCreate.error;
    if (observedCreate?.kind === 'completed') {
      operation = operationFromMutation(observedCreate.value);
      operationId = nonEmptyString(operation.operationId, 'Operation id');
      emitProgress(options, operation, actions);
      break;
    }
    const snapshotEnvelope = record(
      await requestJson(options, '/api/chat/operations/snapshot', deadline),
      'Chat snapshot response',
    );
    const snapshot = record(snapshotEnvelope.snapshot, 'Chat workspace snapshot');
    const operations = Array.isArray(snapshot.operations) ? snapshot.operations : [];
    const correlated = operations.find((candidate) => {
      const value = record(candidate, 'Chat snapshot operation');
      return (
        value.conversationId === conversationId && value.rendererInstanceId === rendererInstanceId
      );
    });
    if (correlated) {
      operation = record(correlated, 'Correlated Chat operation');
      operationId = nonEmptyString(operation.operationId, 'Operation id');
      pushAction(actions, 'snapshot');
      emitProgress(options, operation, actions);
    }
  }

  for (;;) {
    if (createFailed) throw createFailure;
    if (!operation || !operationId) throw new Error('Chat operation authority disappeared.');
    const completed = terminalOutcome(operation);
    if (completed) {
      await requireSuccessfulCreate(operationId);
      return { operationId, terminalOutcome: completed, actionKinds: Object.freeze([...actions]) };
    }

    const projectionEnvelope = record(
      await requestJson(
        options,
        `/api/chat/operations/${encodeURIComponent(operationId)}`,
        deadline,
      ),
      'Chat projection response',
    );
    if (projectionEnvelope.protocolVersion !== 2) {
      throw new Error('Chat projection protocol mismatch.');
    }
    const detail = record(projectionEnvelope.detail, 'Chat operation detail');
    operation = record(detail.operation, 'Projected Chat operation');
    pushAction(actions, 'projection');
    emitProgress(options, operation, actions);
    const projectedTerminal = terminalOutcome(operation);
    if (projectedTerminal) {
      await requireSuccessfulCreate(operationId);
      return {
        operationId,
        terminalOutcome: projectedTerminal,
        actionKinds: Object.freeze([...actions]),
      };
    }

    if (operation.waitReason === 'provider_unavailable') {
      const failure =
        detail.failure && typeof detail.failure === 'object'
          ? (detail.failure as JsonRecord)
          : null;
      const code = typeof failure?.code === 'string' ? failure.code : 'provider_unavailable';
      throw new Error(`Chat V2 operation requires provider recovery (${code}).`);
    }

    const pending = detail.pendingInput;
    if (pending !== null && pending !== undefined) {
      const pendingRecord = record(pending, 'Pending Chat input');
      if (pendingRecord.state === 'recovery_required') {
        throw new Error('Chat V2 interaction requires explicit restart recovery.');
      }
      const pendingKind = pendingRecord.kind;
      const expectedGeneration = positiveInteger(operation.generation, 'Operation generation');
      const expectedVersion = positiveInteger(operation.version, 'Operation version');
      let replyPath: string;
      let replyBody: unknown;
      let replyAction: ChatV2AgentLoopActionKind;
      if (pendingKind === 'clarification') {
        const requestId = nonEmptyString(pendingRecord.clarificationId, 'Clarification id');
        const candidateIds = Array.isArray(pendingRecord.candidates)
          ? pendingRecord.candidates.map((candidate) =>
              nonEmptyString(
                record(candidate, 'Clarification candidate').candidateId,
                'Candidate id',
              ),
            )
          : [];
        replyPath = `/api/chat/operations/${encodeURIComponent(operationId)}/clarification`;
        replyBody = {
          protocolVersion: 2,
          clientRequestId: `agent-loop-clarification-${randomUUID()}`,
          operationId,
          expectedGeneration,
          expectedVersion,
          payload: {
            requestId,
            rendererInstanceId,
            text: options.clarificationReply,
            candidateIds,
            attachments: [],
          },
        };
        replyAction = 'clarification_reply';
      } else if (pendingKind === 'permission') {
        const requestId = nonEmptyString(pendingRecord.hostRequestId, 'Permission request id');
        replyPath = `/api/chat/operations/${encodeURIComponent(operationId)}/permissions/${encodeURIComponent(requestId)}/reply`;
        replyBody = {
          protocolVersion: 2,
          clientRequestId: `agent-loop-permission-${randomUUID()}`,
          operationId,
          expectedGeneration,
          expectedVersion,
          payload: { requestId, choice: options.permissionChoice ?? 'allow_once' },
        };
        replyAction = 'permission_reply';
      } else if (pendingKind === 'question') {
        const requestId = nonEmptyString(pendingRecord.hostRequestId, 'Question request id');
        const content = record(pendingRecord.content, 'Question content');
        const firstOption = Array.isArray(content.options) ? content.options[0] : null;
        const defaultAnswer = firstOption
          ? nonEmptyString(record(firstOption, 'Question option').label, 'Question option label')
          : 'Continue';
        replyPath = `/api/chat/operations/${encodeURIComponent(operationId)}/questions/${encodeURIComponent(requestId)}/reply`;
        replyBody = {
          protocolVersion: 2,
          clientRequestId: `agent-loop-question-${randomUUID()}`,
          operationId,
          expectedGeneration,
          expectedVersion,
          payload: {
            requestId,
            choice: 'reply',
            answers: [...(options.questionAnswers ?? [defaultAnswer])],
          },
        };
        replyAction = 'question_reply';
      } else {
        throw new Error(`Unsupported pending Chat input kind: ${String(pendingKind)}.`);
      }
      const replied = await requestJson(options, replyPath, deadline, {
        method: 'POST',
        body: JSON.stringify(replyBody),
      });
      operation = operationFromMutation(replied);
      pushAction(actions, replyAction);
      emitProgress(options, operation, actions);
      continue;
    }
    if (
      operation.waitReason === 'clarification' ||
      operation.waitReason === 'permission' ||
      operation.waitReason === 'user_recovery_choice'
    ) {
      throw new Error(
        `Chat V2 operation ${operation.waitReason} wait has no projectable pending input.`,
      );
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Chat V2 agent loop timed out.');
    await delay(Math.min(pollIntervalMs, remaining));
  }
}

function boundedOutputAppend(chunks: string[], value: string): void {
  chunks.push(value);
  let total = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  while (total > 2 * 1024 * 1024 && chunks.length > 1) {
    total -= Buffer.byteLength(chunks.shift()!);
  }
}

async function waitForSidecarReady(
  process: ReturnType<typeof Bun.spawn>,
  output: string[],
  timeoutMs: number,
): Promise<number> {
  let settled = false;
  let buffered = '';
  let resolveReady!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const consume = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        boundedOutputAppend(output, text);
        buffered = (buffered + text).slice(-16_384);
        const match = /TAGMA_READY port=(\d+)/.exec(buffered);
        if (match && !settled) {
          settled = true;
          resolveReady(Number(match[1]));
        }
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  void consume(process.stdout as ReadableStream<Uint8Array> | null);
  void consume(process.stderr as ReadableStream<Uint8Array> | null);
  void process.exited.then((code) => {
    if (!settled) {
      settled = true;
      rejectReady(new Error(`Sidecar exited before readiness with code ${code}.`));
    }
  });
  return await Promise.race([
    ready,
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting ${timeoutMs}ms for sidecar readiness.`);
    }),
  ]);
}

async function fetchJson(
  origin: string,
  path: string,
  headers: Record<string, string>,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const requestUrl = path.startsWith('/api/')
    ? new URL(path, origin)
    : new URL(path.replace(/^\/+/, ''), `${origin.replace(/\/+$/, '')}/`);
  const response = await fetch(requestUrl, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

export function forceStopProcessTree(child: ReturnType<typeof Bun.spawn>): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(child.pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The process already exited.
  }
}

async function stopSidecar(
  process: ReturnType<typeof Bun.spawn>,
  origin: string | null,
  managementToken: string,
): Promise<void> {
  if (origin) {
    await fetch(new URL('/api/shutdown', origin), {
      method: 'POST',
      headers: { Authorization: `Bearer ${managementToken}` },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  }
  const exited = await Promise.race([
    process.exited.then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (!exited) forceStopProcessTree(process);
}

function diagnosticsSummary(input: {
  manifest: unknown;
  context: unknown;
  timeline: unknown;
  logs: unknown;
  sessions: unknown;
}): IsolatedChatV2AgentLoopReport['diagnostics'] {
  const manifest =
    input.manifest && typeof input.manifest === 'object' ? (input.manifest as JsonRecord) : null;
  const context =
    input.context && typeof input.context === 'object' ? (input.context as JsonRecord) : null;
  const timeline =
    input.timeline && typeof input.timeline === 'object' ? (input.timeline as JsonRecord) : null;
  const logs = input.logs && typeof input.logs === 'object' ? (input.logs as JsonRecord) : null;
  const sessions =
    input.sessions && typeof input.sessions === 'object' ? (input.sessions as JsonRecord) : null;
  const timelineRetention =
    timeline?.retention && typeof timeline.retention === 'object'
      ? (timeline.retention as JsonRecord)
      : null;
  const timelinePage =
    timeline?.page && typeof timeline.page === 'object' ? (timeline.page as JsonRecord) : null;
  const logRetention =
    logs?.retention && typeof logs.retention === 'object' ? (logs.retention as JsonRecord) : null;
  const logPage = logs?.page && typeof logs.page === 'object' ? (logs.page as JsonRecord) : null;
  const features =
    context?.features && typeof context.features === 'object'
      ? (context.features as JsonRecord)
      : null;
  const chatFeature =
    features?.chatOperationV2 && typeof features.chatOperationV2 === 'object'
      ? (features.chatOperationV2 as JsonRecord)
      : null;
  const eventEvidence =
    chatFeature?.eventEvidence && typeof chatFeature.eventEvidence === 'object'
      ? (chatFeature.eventEvidence as JsonRecord)
      : null;
  return {
    protocolVersion: Number.isSafeInteger(manifest?.protocolVersion)
      ? (manifest!.protocolVersion as number)
      : null,
    timelineCursor: Number.isSafeInteger(timeline?.nextCursor)
      ? (timeline!.nextCursor as number)
      : null,
    logCursor: Number.isSafeInteger(logs?.nextCursor) ? (logs!.nextCursor as number) : null,
    timelineTruncated:
      typeof timelineRetention?.truncated === 'boolean' &&
      typeof timelinePage?.truncated === 'boolean'
        ? timelineRetention.truncated || timelinePage.truncated
        : null,
    logsTruncated:
      typeof logRetention?.truncated === 'boolean' && typeof logPage?.truncated === 'boolean'
        ? logRetention.truncated || logPage.truncated
        : null,
    hostEventCount: Number.isSafeInteger(eventEvidence?.returnedEventCount)
      ? (eventEvidence!.returnedEventCount as number)
      : null,
    opencodeSessionCount: Number.isSafeInteger(sessions?.totalSessionCount)
      ? (sessions!.totalSessionCount as number)
      : null,
  };
}

function summarizeProviderState(value: unknown): Record<string, unknown> {
  const state = record(value, 'OpenCode provider state');
  const configured = record(state.configured, 'Configured provider state');
  const providers = Array.isArray(configured.providers) ? configured.providers : [];
  const selected = providers.find((provider) => {
    return record(provider, 'Configured provider').id === OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID;
  });
  const selectedProvider = selected ? record(selected, 'Selected configured provider') : null;
  const selectedModels =
    selectedProvider && selectedProvider.models && typeof selectedProvider.models === 'object'
      ? (selectedProvider.models as Record<string, unknown>)
      : {};
  const selectedModel = selectedModels[OPENCODE_QUESTION_CONFORMANCE_MODEL_ID];
  return {
    schemaVersion: state.schemaVersion ?? null,
    availability: state.availability ?? null,
    configuredProviderCount: providers.length,
    configuredModelCount: providers.reduce((count, provider) => {
      const models = record(provider, 'Configured provider').models;
      return count + (models && typeof models === 'object' ? Object.keys(models).length : 0);
    }, 0),
    selectedProvider: selectedProvider
      ? {
          id: selectedProvider.id,
          name: selectedProvider.name,
          model: selectedModel ?? null,
        }
      : null,
  };
}

async function collectDiagnosticsEvidence(input: {
  readonly diagnosticsToken: string;
  readonly diagnosticsBaseUrl: string;
  readonly providerDiagnostics: readonly unknown[];
  readonly preflightEvidence: Record<string, unknown> | null;
}): Promise<{
  diagnostics: IsolatedChatV2AgentLoopReport['diagnostics'];
  rawDiagnostics: Record<string, unknown>;
}> {
  const diagnosticsHeaders = { Authorization: `Bearer ${input.diagnosticsToken}` };
  const [manifest, context, timeline, logs, sessions] = await Promise.all([
    fetchJson(input.diagnosticsBaseUrl, '/manifest', diagnosticsHeaders),
    fetchJson(input.diagnosticsBaseUrl, '/context', diagnosticsHeaders),
    fetchJson(input.diagnosticsBaseUrl, '/timeline?after=0&limit=500', diagnosticsHeaders),
    fetchJson(input.diagnosticsBaseUrl, '/logs?after=0&limit=500', diagnosticsHeaders),
    fetchJson(input.diagnosticsBaseUrl, '/opencode/sessions', diagnosticsHeaders),
  ]);
  for (const response of [manifest, context, timeline, logs]) {
    if (response.status !== 200) {
      throw new Error(`Diagnostics GET returned HTTP ${response.status}.`);
    }
  }
  const diagnostics = diagnosticsSummary({
    manifest: manifest.body,
    context: context.body,
    timeline: timeline.body,
    logs: logs.body,
    sessions: sessions.status === 200 ? sessions.body : null,
  });
  if (diagnostics.protocolVersion !== 1) {
    throw new Error('Diagnostics manifest protocol is unavailable or unsupported.');
  }
  return {
    diagnostics,
    rawDiagnostics: {
      manifest: manifest.body,
      context: context.body,
      timeline: timeline.body,
      logs: logs.body,
      opencodeSessions: sessions.status === 200 ? sessions.body : null,
      opencodeSessionsStatus: sessions.status,
      provider: input.providerDiagnostics,
      preflight: input.preflightEvidence,
    },
  };
}

export async function runIsolatedChatV2AgentLoop(
  options: RunIsolatedChatV2AgentLoopOptions = {},
): Promise<IsolatedChatV2AgentLoopReport> {
  const runId = randomUUID();
  const scenario = options.scenario ?? 'clarification';
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 180_000;
  const runRoot = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-agent-loop-runtime-'));
  const artifactsParent = options.artifactsParentDirectory ?? tmpdir();
  mkdirSync(artifactsParent, { recursive: true });
  const artifactsDirectory = mkdtempSync(join(artifactsParent, 'tagma-chat-v2-agent-loop-report-'));
  const reportPath = join(artifactsDirectory, 'report.json');
  const sidecarLogPath = join(artifactsDirectory, 'sidecar.log');
  const diagnosticsPath = join(artifactsDirectory, 'diagnostics.json');
  const workspace = join(runRoot, 'workspace');
  const tagmaDirectory = join(workspace, '.tagma');
  const baselinePipelineDirectory = join(tagmaDirectory, 'baseline');
  const baselinePipelinePath = join(baselinePipelineDirectory, 'baseline.yaml');
  const globalSettingsDirectory = join(runRoot, 'global-settings');
  const controlDirectory = join(runRoot, 'server-control');
  mkdirSync(tagmaDirectory, { recursive: true });
  mkdirSync(baselinePipelineDirectory, { recursive: true });
  mkdirSync(globalSettingsDirectory, { recursive: true });
  writeFileSync(
    baselinePipelinePath,
    [
      'pipeline:',
      '  name: Agent Loop Baseline',
      '  tracks:',
      '    - id: main',
      '      name: Main',
      '      tasks:',
      '        - id: baseline',
      '          name: Baseline',
      '          prompt: Return a deterministic baseline.',
      '',
    ].join('\n'),
    'utf8',
  );

  const electronPackage = JSON.parse(
    readFileSync(resolve(editorRoot, '..', 'electron', 'package.json'), 'utf8'),
  ) as { tagma?: { bundledOpencodeVersion?: string; bundledOpencodeDbSchemaVersion?: number } };
  const bundledVersion = electronPackage.tagma?.bundledOpencodeVersion ?? '1.18.18';
  const databaseSchemaVersion = electronPackage.tagma?.bundledOpencodeDbSchemaVersion ?? 2;
  const bundledDirectory = resolve(
    editorRoot,
    '..',
    'electron',
    'build',
    'opencode',
    `${process.platform}-${process.arch}`,
  );
  if (!existsSync(join(bundledDirectory, 'version.txt'))) {
    throw new Error(`Bundled OpenCode is unavailable at ${bundledDirectory}.`);
  }

  const discussionResult = {
    kind: 'discussion' as const,
    targetCandidateId: null,
    clarification: null,
    candidateIds: [],
  };
  const classifierResults =
    scenario === 'clarification'
      ? [
          {
            kind: 'clarify' as const,
            targetCandidateId: null,
            clarification: 'Confirm the deterministic agent-loop path.',
            candidateIds: [],
          },
          discussionResult,
        ]
      : scenario === 'authoring-permission'
        ? [
            {
              kind: 'create' as const,
              targetCandidateId: null,
              clarification: null,
              candidateIds: [],
            },
          ]
        : [discussionResult];
  const provider = startOpencodeV2FakeProvider({
    classifierResults,
    readRounds: scenario === 'authoring-permission' ? 2 : 1,
  });
  const providerDefinition = validateCustomProvider(
    OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
    {
      name: 'Tagma Chat V2 agent loop',
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: provider.baseUrl,
        apiKey: NO_AUTH_REQUIRED_SENTINEL,
        chunkTimeout: 30_000,
      },
      models: {
        [OPENCODE_QUESTION_CONFORMANCE_MODEL_ID]: {
          name: 'Chat V2 agent-loop model',
          limit: { context: 8_192, output: 512 },
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    },
    { scope: 'workspace' },
  );
  upsertCustomProvider(
    'workspace',
    workspace,
    OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
    providerDefinition,
  );

  const managementToken = randomBytes(32).toString('base64url');
  const output: string[] = [];
  const sidecarMode = options.sidecarExecutable ? 'compiled' : 'source';
  const sidecarCommand = options.sidecarExecutable
    ? [options.sidecarExecutable]
    : [process.execPath, resolve(editorRoot, 'server', 'index.ts')];
  const sidecar = Bun.spawn(sidecarCommand, {
    cwd: editorRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      TAGMA_AUTH_TOKEN: managementToken,
      TAGMA_GLOBAL_SETTINGS_DIR: globalSettingsDirectory,
      TAGMA_CHAT_CONTROL_DIR: controlDirectory,
      TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
      TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER: '2',
      TAGMA_OPENCODE_BUNDLED_DIR: bundledDirectory,
      TAGMA_OPENCODE_BUNDLED_VERSION: bundledVersion,
      TAGMA_OPENCODE_SKIP_USER_DIR: '1',
      TAGMA_OPENCODE_DB_STATE_DIR: join(runRoot, 'database-state'),
      TAGMA_OPENCODE_DB_SCHEMA_VERSION: String(databaseSchemaVersion),
      XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
      XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
      XDG_DATA_HOME: join(runRoot, 'xdg-data'),
      XDG_STATE_HOME: join(runRoot, 'xdg-state'),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let origin: string | null = null;
  let diagnosticsToken: string | null = null;
  let diagnosticsBaseUrl: string | null = null;
  let operation: DriveChatV2OperationResult | null = null;
  let lastOperation: DriveChatV2OperationProgress | null = null;
  let failure: IsolatedChatV2AgentLoopReport['failure'] = null;
  let diagnostics: IsolatedChatV2AgentLoopReport['diagnostics'] = {
    protocolVersion: null,
    timelineCursor: null,
    logCursor: null,
    timelineTruncated: null,
    logsTruncated: null,
    hostEventCount: null,
    opencodeSessionCount: null,
  };
  let rawDiagnostics: Record<string, unknown> | null = null;
  let preflightEvidence: Record<string, unknown> | null = null;
  try {
    const port = await waitForSidecarReady(sidecar, output, Math.min(timeoutMs, 60_000));
    origin = `http://127.0.0.1:${port}`;
    const managementHeaders = {
      Authorization: `Bearer ${managementToken}`,
      'X-Tagma-Workspace': workspace,
    };
    const enabled = await fetchJson(origin, '/api/diagnostics/session', managementHeaders, {
      method: 'POST',
    });
    if (enabled.status !== 200) {
      throw new Error(`Diagnostics enable returned HTTP ${enabled.status}.`);
    }
    const connection = record(
      record(enabled.body, 'Diagnostics enable response').connection,
      'Diagnostics connection',
    );
    diagnosticsToken = nonEmptyString(connection.token, 'Diagnostics token');
    diagnosticsBaseUrl = nonEmptyString(connection.baseUrl, 'Diagnostics base URL');

    const opened = await fetchJson(origin, '/api/open', managementHeaders, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: baselinePipelinePath }),
    });
    if (opened.status !== 200) {
      throw new Error(`Baseline pipeline open returned HTTP ${opened.status}.`);
    }

    const ensured = await fetchJson(origin, '/api/opencode/chat/ensure', managementHeaders, {
      method: 'POST',
    });
    if (ensured.status !== 200) {
      throw new Error(`OpenCode Chat bootstrap returned HTTP ${ensured.status}.`);
    }
    const providerState = await fetchJson(
      origin,
      '/api/opencode/chat/provider-state',
      managementHeaders,
    );
    if (providerState.status !== 200) {
      throw new Error(`OpenCode provider-state returned HTTP ${providerState.status}.`);
    }
    preflightEvidence = {
      open: opened.body,
      ensure: ensured.body,
      providerState: summarizeProviderState(providerState.body),
    };

    operation = await driveChatV2Operation({
      origin,
      managementToken,
      workspacePath: workspace,
      provider: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
      model: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
      prompt: 'Exercise the deterministic Chat V2 clarification loop.',
      clarificationReply: 'Continue with the deterministic default.',
      onProgress: (progress) => {
        lastOperation = progress;
      },
      timeoutMs,
      pollIntervalMs: 50,
    });
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (diagnosticsToken && diagnosticsBaseUrl) {
      try {
        const collected = await collectDiagnosticsEvidence({
          diagnosticsToken,
          diagnosticsBaseUrl,
          providerDiagnostics: provider.diagnostics(),
          preflightEvidence,
        });
        diagnostics = collected.diagnostics;
        rawDiagnostics = collected.rawDiagnostics;
      } catch (diagnosticsError) {
        if (!failure) {
          failure = {
            name: diagnosticsError instanceof Error ? diagnosticsError.name : 'Error',
            message:
              diagnosticsError instanceof Error
                ? diagnosticsError.message
                : String(diagnosticsError),
          };
        }
      }
    }
    const cleanupErrors: string[] = [];
    await stopSidecar(sidecar, origin, managementToken).catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    await provider.stop().catch((error) => {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    });
    const redactCredentials = (value: string): string => {
      let redacted = value.split(managementToken).join('[REDACTED]');
      if (diagnosticsToken) redacted = redacted.split(diagnosticsToken).join('[REDACTED]');
      return redacted;
    };
    const sidecarLog = output.join('');
    const diagnosticsText = rawDiagnostics ? JSON.stringify(rawDiagnostics, null, 2) : null;
    const credentialLeak =
      sidecarLog.includes(managementToken) ||
      (diagnosticsToken !== null && sidecarLog.includes(diagnosticsToken)) ||
      (diagnosticsText !== null && diagnosticsText.includes(managementToken)) ||
      (diagnosticsToken !== null &&
        diagnosticsText !== null &&
        diagnosticsText.includes(diagnosticsToken));
    if (credentialLeak) {
      failure = {
        name: 'CredentialLeakError',
        message: 'Agent-loop evidence attempted to retain an authentication token.',
      };
    }
    if (cleanupErrors.length > 0 && !failure) {
      failure = {
        name: 'CleanupError',
        message: `Agent-loop cleanup failed (${cleanupErrors.length} bounded error(s)).`,
      };
    }
    writeFileSync(sidecarLogPath, redactCredentials(sidecarLog), 'utf8');
    if (rawDiagnostics) {
      writeFileSync(diagnosticsPath, `${redactCredentials(diagnosticsText!)}\n`, 'utf8');
    }
    if (!options.keepRuntime) {
      try {
        rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        if (!failure) {
          failure = {
            name: 'CleanupError',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
  }

  const report: IsolatedChatV2AgentLoopReport = {
    schemaVersion: 1,
    runId,
    scenario,
    sidecarMode,
    verdict: failure ? 'failed' : 'passed',
    startedAt,
    completedAt: Date.now(),
    operation,
    lastOperation,
    failure,
    diagnostics,
    artifactsDirectory,
    reportPath,
    diagnosticsPath: rawDiagnostics ? diagnosticsPath : null,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

function cliValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

if (import.meta.main) {
  const scenarioValue = cliValue('--scenario') ?? 'matrix';
  if (!['matrix', 'clarification', 'discussion', 'authoring-permission'].includes(scenarioValue)) {
    throw new Error(
      '--scenario must be matrix, clarification, discussion, or authoring-permission.',
    );
  }
  const repeatValue = Number(cliValue('--repeat') ?? '1');
  if (!Number.isSafeInteger(repeatValue) || repeatValue < 1 || repeatValue > 10) {
    throw new Error('--repeat must be an integer from 1 to 10.');
  }
  const timeoutValue = Number(cliValue('--timeout-ms') ?? '180000');
  if (!Number.isSafeInteger(timeoutValue) || timeoutValue < 30_000) {
    throw new Error('--timeout-ms must be an integer of at least 30000.');
  }
  const artifactsParentDirectory = cliValue('--artifacts') ?? undefined;
  const scenarios: ChatV2AgentLoopScenario[] =
    scenarioValue === 'matrix'
      ? ['clarification', 'discussion', 'authoring-permission']
      : [scenarioValue as ChatV2AgentLoopScenario];
  const reports: IsolatedChatV2AgentLoopReport[] = [];
  for (let repeatIndex = 0; repeatIndex < repeatValue; repeatIndex += 1) {
    for (const scenario of scenarios) {
      reports.push(
        await runIsolatedChatV2AgentLoop({
          scenario,
          timeoutMs: timeoutValue,
          ...(artifactsParentDirectory ? { artifactsParentDirectory } : {}),
          keepRuntime: process.argv.includes('--keep-runtime'),
          ...(process.argv.includes('--compiled')
            ? {
                sidecarExecutable: resolve(
                  editorRoot,
                  'desktop-dist',
                  process.platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server',
                ),
              }
            : {}),
        }),
      );
    }
  }
  const verdict = reports.every((report) => report.verdict === 'passed') ? 'passed' : 'failed';
  process.stdout.write(
    `${JSON.stringify({
      verdict,
      reports: reports.map((report) => ({
        scenario: report.scenario,
        sidecarMode: report.sidecarMode,
        verdict: report.verdict,
        reportPath: report.reportPath,
      })),
    })}\n`,
  );
  process.exitCode = verdict === 'passed' ? 0 : 1;
}
