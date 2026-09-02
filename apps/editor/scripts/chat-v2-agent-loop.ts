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
export type ChatV2AgentLoopScenario =
  | 'clarification'
  | 'discussion'
  | 'authoring-permission'
  | 'authoring-trial'
  | 'authoring-create-trial';
export type ChatV2AgentLoopProviderMode = 'real' | 'fake';

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
  readonly rendererEvidence: DriveChatV2RendererEvidence;
}

export interface DriveChatV2RendererEvidence {
  readonly terminalDetailFetched: true;
  readonly hasResult: boolean;
  readonly assistantMessageCount: number;
  readonly visibleContentBytes: number;
  readonly phaseHistory: readonly string[];
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
  readonly provider: {
    readonly mode: ChatV2AgentLoopProviderMode;
    readonly provider: string | null;
    readonly model: string | null;
    readonly selection: 'opencode-free' | 'deepseek' | 'deterministic-fake' | null;
  };
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
  readonly providerMode?: ChatV2AgentLoopProviderMode;
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

export interface ChatV2AgentLoopRealModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly selection: 'opencode-free' | 'deepseek';
}

export function selectChatV2AgentLoopRealModel(value: unknown): ChatV2AgentLoopRealModelSelection {
  const state = record(value, 'OpenCode provider state');
  const configured = record(state.configured, 'Configured provider state');
  const catalog = record(state.catalog, 'OpenCode provider catalog');
  const providers = Array.isArray(configured.providers) ? configured.providers : [];
  const connected = new Set(
    Array.isArray(catalog.connected)
      ? catalog.connected.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [],
  );

  const modelsFor = (providerId: string): Array<{ id: string; name: string }> => {
    if (!connected.has(providerId)) return [];
    const providerValue = providers.find((provider) => {
      return record(provider, 'Configured provider').id === providerId;
    });
    if (!providerValue) return [];
    const provider = record(providerValue, 'Configured provider');
    const rawModels =
      provider.models && typeof provider.models === 'object' && !Array.isArray(provider.models)
        ? (provider.models as Record<string, unknown>)
        : {};
    return Object.entries(rawModels).flatMap(([key, rawModel]) => {
      const model = record(rawModel, 'Configured model');
      const id = typeof model.id === 'string' && model.id.length > 0 ? model.id : key;
      const name = typeof model.name === 'string' && model.name.length > 0 ? model.name : id;
      const capabilities =
        model.capabilities &&
        typeof model.capabilities === 'object' &&
        !Array.isArray(model.capabilities)
          ? (model.capabilities as Record<string, unknown>)
          : {};
      if (model.status !== 'active' || capabilities.toolcall !== true) return [];
      return [{ id, name }];
    });
  };

  const freeAgentModelPriority = new Map([
    ['deepseek-v4-flash-free', 0],
    ['north-mini-code-free', 1],
  ]);
  const freeModels = modelsFor('opencode')
    .filter(({ id, name }) => {
      const localId = id.split('/').at(-1) ?? id;
      return freeAgentModelPriority.has(localId) && (/free/iu.test(id) || /free/iu.test(name));
    })
    .sort((left, right) => {
      const localId = (id: string): string => id.split('/').at(-1) ?? id;
      return (
        (freeAgentModelPriority.get(localId(left.id)) ?? Number.MAX_SAFE_INTEGER) -
          (freeAgentModelPriority.get(localId(right.id)) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id)
      );
    });
  if (freeModels[0]) {
    return {
      provider: 'opencode',
      model: freeModels[0].id,
      selection: 'opencode-free',
    };
  }

  const deepseekModels = modelsFor('deepseek').sort((left, right) => {
    const priority = (id: string): number => (id === 'deepseek-v4-flash' ? 0 : 1);
    return priority(left.id) - priority(right.id) || left.id.localeCompare(right.id);
  });
  if (deepseekModels[0]) {
    return {
      provider: 'deepseek',
      model: deepseekModels[0].id,
      selection: 'deepseek',
    };
  }

  throw new Error(
    'No connected tool-capable OpenCode free or DeepSeek model is configured for the real Chat V2 agent loop.',
  );
}

export function validateChatV2AgentLoopScenarioOutcome(
  scenario: ChatV2AgentLoopScenario,
  operation: DriveChatV2OperationResult,
  rawDiagnostics: Record<string, unknown>,
): void {
  const validateRendererEvidence = (): void => {
    const rendererEvidence = operation.rendererEvidence;
    if (
      !rendererEvidence?.terminalDetailFetched ||
      !rendererEvidence.hasResult ||
      rendererEvidence.assistantMessageCount < 1 ||
      rendererEvidence.visibleContentBytes < 1
    ) {
      throw new Error(
        `The real ${scenario} scenario did not project a non-empty assistant result to the Renderer boundary.`,
      );
    }
  };
  if (scenario === 'discussion' || scenario === 'clarification') {
    if (operation.terminalOutcome !== 'completed_readonly') {
      throw new Error(`The real ${scenario} scenario must finish as a read-only operation.`);
    }
    if (scenario === 'clarification' && !operation.actionKinds.includes('clarification_reply')) {
      throw new Error(
        'The real clarification scenario did not project and answer a clarification.',
      );
    }
    if (
      scenario === 'discussion' &&
      operation.actionKinds.some((action) =>
        ['clarification_reply', 'permission_reply', 'question_reply'].includes(action),
      )
    ) {
      throw new Error('The real discussion scenario unexpectedly required interactive input.');
    }
    validateRendererEvidence();
    return;
  }
  if (scenario !== 'authoring-trial' && scenario !== 'authoring-create-trial') return;
  if (
    scenario === 'authoring-create-trial' &&
    !operation.actionKinds.includes('clarification_reply')
  ) {
    throw new Error(
      'The real authoring create Trial scenario did not project and answer a clarification before authoring.',
    );
  }
  if (operation.terminalOutcome !== 'completed_published') {
    throw new Error(
      'The real authoring Trial scenario must publish a verified changed pipeline without a failure fork.',
    );
  }
  const context = rawDiagnostics.context;
  const features =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>).features
      : null;
  const chatOperationV2 =
    features && typeof features === 'object' && !Array.isArray(features)
      ? (features as Record<string, unknown>).chatOperationV2
      : null;
  const eventEvidence =
    chatOperationV2 && typeof chatOperationV2 === 'object' && !Array.isArray(chatOperationV2)
      ? (chatOperationV2 as Record<string, unknown>).eventEvidence
      : null;
  const events =
    eventEvidence && typeof eventEvidence === 'object' && !Array.isArray(eventEvidence)
      ? (eventEvidence as Record<string, unknown>).events
      : null;
  const eventRecords = Array.isArray(events)
    ? events.filter(
        (event): event is Record<string, unknown> =>
          event !== null && typeof event === 'object' && !Array.isArray(event),
      )
    : [];
  const trialPlanInvoked = eventRecords.some((event) => {
    const invocation = event.invocation;
    return (
      invocation !== null &&
      typeof invocation === 'object' &&
      !Array.isArray(invocation) &&
      (invocation as Record<string, unknown>).purpose === 'trial_plan'
    );
  });
  if (!trialPlanInvoked) {
    throw new Error('The real authoring Trial scenario did not execute a Trial Plan invocation.');
  }
  if (!eventRecords.some((event) => event.type === 'trial_status_changed')) {
    throw new Error('The real authoring Trial scenario did not execute Host Trial verification.');
  }
  validateRendererEvidence();
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

function rendererEvidenceFromDetail(
  detail: JsonRecord,
  phaseHistory: readonly string[],
): DriveChatV2RendererEvidence {
  const operation = record(detail.operation, 'Terminal projected Chat operation');
  const resultValue = detail.result;
  const result =
    resultValue && typeof resultValue === 'object' && !Array.isArray(resultValue)
      ? (resultValue as JsonRecord)
      : null;
  const messages = Array.isArray(result?.messages)
    ? result.messages.filter(
        (message): message is JsonRecord =>
          message !== null && typeof message === 'object' && !Array.isArray(message),
      )
    : [];
  const visibleContentBytes = messages.reduce((total, message) => {
    const textBytes = typeof message.text === 'string' ? Buffer.byteLength(message.text) : 0;
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const attachmentBytes = attachments.reduce((sum, attachment) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return sum;
      const value = attachment as JsonRecord;
      return (
        sum +
        (typeof value.label === 'string' ? Buffer.byteLength(value.label) : 0) +
        (typeof value.content === 'string' ? Buffer.byteLength(value.content) : 0)
      );
    }, 0);
    return total + textBytes + attachmentBytes;
  }, 0);
  return Object.freeze({
    terminalDetailFetched: true as const,
    hasResult: operation.hasResult === true && result !== null,
    assistantMessageCount: messages.length,
    visibleContentBytes,
    phaseHistory: Object.freeze([...phaseHistory]),
  });
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
  const phaseHistory: string[] = [];
  const observeOperation = (candidate: JsonRecord): void => {
    const phase = nonEmptyString(candidate.phase, 'Operation phase');
    if (phaseHistory.at(-1) !== phase) phaseHistory.push(phase);
    emitProgress(options, candidate, actions);
  };
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
  const completeFromTerminal = async (
    authorityOperationId: string,
    expectedTerminalOutcome: string,
  ): Promise<DriveChatV2OperationResult> => {
    await requireSuccessfulCreate(authorityOperationId);
    const projectionEnvelope = record(
      await requestJson(
        options,
        `/api/chat/operations/${encodeURIComponent(authorityOperationId)}`,
        deadline,
      ),
      'Terminal Chat projection response',
    );
    if (projectionEnvelope.protocolVersion !== 2) {
      throw new Error('Terminal Chat projection protocol mismatch.');
    }
    const detail = record(projectionEnvelope.detail, 'Terminal Chat operation detail');
    const terminalOperation = record(detail.operation, 'Terminal projected Chat operation');
    const projectedTerminalOutcome = terminalOutcome(terminalOperation);
    if (projectedTerminalOutcome !== expectedTerminalOutcome) {
      throw new Error('Terminal Chat detail does not match the observed terminal operation.');
    }
    pushAction(actions, 'projection');
    observeOperation(terminalOperation);
    return {
      operationId: authorityOperationId,
      terminalOutcome: projectedTerminalOutcome,
      actionKinds: Object.freeze([...actions]),
      rendererEvidence: rendererEvidenceFromDetail(detail, phaseHistory),
    };
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
      observeOperation(operation);
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
      observeOperation(operation);
    }
  }

  for (;;) {
    if (createFailed) throw createFailure;
    if (!operation || !operationId) throw new Error('Chat operation authority disappeared.');
    const completed = terminalOutcome(operation);
    if (completed) {
      return completeFromTerminal(operationId, completed);
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
    observeOperation(operation);
    const projectedTerminal = terminalOutcome(operation);
    if (projectedTerminal) {
      return completeFromTerminal(operationId, projectedTerminal);
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
      observeOperation(operation);
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

function summarizeProviderState(
  value: unknown,
  selectedModel: { readonly provider: string; readonly model: string } | null,
): Record<string, unknown> {
  const state = record(value, 'OpenCode provider state');
  const configured = record(state.configured, 'Configured provider state');
  const providers = Array.isArray(configured.providers) ? configured.providers : [];
  const selected = providers.find((provider) => {
    return record(provider, 'Configured provider').id === selectedModel?.provider;
  });
  const selectedProvider = selected ? record(selected, 'Selected configured provider') : null;
  const selectedModels =
    selectedProvider && selectedProvider.models && typeof selectedProvider.models === 'object'
      ? (selectedProvider.models as Record<string, unknown>)
      : {};
  const selectedModelState = selectedModel ? selectedModels[selectedModel.model] : undefined;
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
          model: selectedModelState ?? null,
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
  const providerMode = options.providerMode ?? 'real';
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
  let selectedModel: IsolatedChatV2AgentLoopReport['provider'] = {
    mode: providerMode,
    provider: null,
    model: null,
    selection: null,
  };
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
      '        - id: draft',
      '          name: Draft greeting',
      '          command: node -e "console.log(\'baseline\')"',
      '        - id: review',
      '          name: Review greeting',
      '          command: node -e "console.log(\'review\')"',
      '          depends_on:',
      '            - draft',
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
  const createResult = {
    kind: 'create' as const,
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
      : scenario === 'authoring-create-trial'
        ? [
            {
              kind: 'clarify' as const,
              targetCandidateId: null,
              clarification: 'Create a new pipeline or edit the current baseline?',
              candidateIds: [],
            },
            createResult,
          ]
        : scenario === 'authoring-permission' || scenario === 'authoring-trial'
          ? [createResult]
          : [discussionResult];
  const provider =
    providerMode === 'fake'
      ? startOpencodeV2FakeProvider({
          classifierResults,
          readRounds:
            scenario === 'authoring-permission' ||
            scenario === 'authoring-trial' ||
            scenario === 'authoring-create-trial'
              ? 2
              : 1,
        })
      : null;
  if (provider) {
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
  }

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
      ...(providerMode === 'fake'
        ? {
            XDG_DATA_HOME: join(runRoot, 'xdg-data'),
            XDG_STATE_HOME: join(runRoot, 'xdg-state'),
          }
        : {}),
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
    const model = provider
      ? {
          provider: OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID,
          model: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
          selection: 'deterministic-fake' as const,
        }
      : selectChatV2AgentLoopRealModel(providerState.body);
    selectedModel = {
      mode: providerMode,
      provider: model.provider,
      model: model.model,
      selection: model.selection,
    };
    preflightEvidence = {
      open: opened.body,
      ensure: ensured.body,
      providerState: summarizeProviderState(providerState.body, model),
    };

    const prompt =
      scenario === 'authoring-trial'
        ? 'Edit the current Agent Loop Baseline pipeline. In the existing draft command, change only the printed string from baseline to hello. Preserve both existing Node command tasks and their dependency exactly; do not convert either task to a prompt and do not add files or tasks. Complete Host compilation, an LLM-authored Trial Plan, Sandbox Trial, and verified publication.'
        : scenario === 'authoring-create-trial'
          ? 'Build a Tagma pipeline to say hi. Before changing anything, ask whether to create a brand-new pipeline or edit the current Agent Loop Baseline. After the user chooses a new pipeline, create exactly one deterministic command task that prints hi and has no downstream consumer. Keep its interface minimal: do not add unused inputs, outputs, files, or prompt tasks. Complete Host compilation, an LLM-authored Trial Plan, Sandbox Trial, and verified publication.'
          : scenario === 'authoring-permission'
            ? 'Create a minimal Tagma pipeline that reads the staged workspace before finishing.'
            : scenario === 'discussion'
              ? 'Explain in one sentence what a Tagma pipeline is. Do not create or edit a pipeline.'
              : 'Help choose between creating a new greeting pipeline and editing the current baseline; ask one clarification before proceeding.';

    operation = await driveChatV2Operation({
      origin,
      managementToken,
      workspacePath: workspace,
      provider: model.provider,
      model: model.model,
      prompt,
      clarificationReply:
        scenario === 'clarification'
          ? 'Do not create or edit anything. Explain the choice as a read-only discussion.'
          : scenario === 'authoring-create-trial'
            ? 'Create a brand-new pipeline. Do not edit the current Agent Loop Baseline.'
            : 'Continue with the deterministic default.',
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
          providerDiagnostics: provider?.diagnostics() ?? [],
          preflightEvidence,
        });
        diagnostics = collected.diagnostics;
        rawDiagnostics = collected.rawDiagnostics;
        if (!failure && operation) {
          validateChatV2AgentLoopScenarioOutcome(scenario, operation, rawDiagnostics);
        }
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
    if (provider) {
      await provider.stop().catch((error) => {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      });
    }
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
    provider: selectedModel,
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
  if (
    ![
      'matrix',
      'clarification',
      'discussion',
      'authoring-permission',
      'authoring-trial',
      'authoring-create-trial',
    ].includes(scenarioValue)
  ) {
    throw new Error(
      '--scenario must be matrix, clarification, discussion, authoring-permission, authoring-trial, or authoring-create-trial.',
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
      ? ['discussion', 'authoring-trial', 'authoring-create-trial']
      : [scenarioValue as ChatV2AgentLoopScenario];
  const reports: IsolatedChatV2AgentLoopReport[] = [];
  for (let repeatIndex = 0; repeatIndex < repeatValue; repeatIndex += 1) {
    for (const scenario of scenarios) {
      reports.push(
        await runIsolatedChatV2AgentLoop({
          scenario,
          timeoutMs: timeoutValue,
          providerMode: process.argv.includes('--fake-provider') ? 'fake' : 'real',
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
