import { describe, expect, test } from 'bun:test';

import {
  OpenCodeInvocationController,
  sha256CanonicalOpenCodeRequest,
  type OpenCodeInvocationStore,
} from '../server/chat-operations/opencode-invocation.js';
import {
  ChatOperationV2OpenCodeReadonlyRunner,
  OpenCodeSdkAdapter,
  OpenCodeReadonlyInvocationRunner,
  buildNativeRequestDigestMarker,
  buildReadonlyTextCanonicalRequestBytes,
  buildClassifierTextCanonicalRequestBytes,
  deriveOpenCodeExecutionMessageId,
  extractNativeRequestDigest,
  type OpenCodeAdapterNativePromptInput,
  type OpenCodeAdapterClassifierTextPromptInput,
  type OpenCodeAdapterSdkClient,
  type OpenCodeAdapterTextPromptInput,
  type OpenCodeTextClassifierRunRequest,
} from '../server/chat-operations/opencode-adapter.js';
import type { ChatOperationV2AdmissionRequest } from '../server/chat-operations/admission.js';
import type { ChatOperationV2DurableInvocationRequest } from '../server/chat-operations/orchestrator.js';
import type { ChatReadSnapshot } from '../server/chat-operations/snapshots.js';
import type {
  ListInvocationOutboxOptions,
  PrepareInvocationOutboxInput,
  StoredInvocationOutboxRecord,
  UpdateInvocationOutboxInput,
  UpdateInvocationOutboxResult,
} from '../server/chat-operations/store.js';
import {
  buildChatPipelineIntentClassificationPrompt,
  TAGMA_PIPELINE_INTENT_CLASSIFIER_TOOLS,
  type ChatPipelineIntentCandidate,
} from '../shared/chat-pipeline-intent-classifier.js';

const candidates: readonly ChatPipelineIntentCandidate[] = [
  {
    id: 'pipeline-1',
    path: '/workspace/alpha.yaml',
    pipelineName: 'alpha',
    currentCanvas: true,
    sessionOwned: false,
    manualNewDraft: false,
  },
  {
    id: 'pipeline-2',
    path: '/workspace/beta.yaml',
    pipelineName: 'beta',
    currentCanvas: false,
    sessionOwned: true,
    manualNewDraft: false,
  },
];

const readonlyAdmissionRequest: ChatOperationV2AdmissionRequest = {
  schemaVersion: 1,
  text: 'Explain the current pipeline behavior without changing it.',
  attachments: [
    {
      referenceId: 'attachment-1',
      label: 'User note',
      content: 'Focus on the retry boundary.',
    },
  ],
};

const sealedReadSnapshot: ChatReadSnapshot = {
  version: 2,
  operationId: 'operation-readonly-1',
  workspaceScopeId: 'scope-1',
  generation: 1,
  candidateId: 'pipeline-1',
  rendererInstanceId: 'renderer-1',
  localRevision: 7,
  canonicalYaml: 'name: alpha\ntracks: []\n',
  layoutJson: '{"positions":{}}',
  requirementsMarkdown: '# Requirements\nRemain read-only.\n',
  compileDiagnostics: [
    {
      level: 'warning',
      code: 'readonly-probe',
      message: 'Snapshot warning evidence.',
      path: 'alpha.yaml',
    },
  ],
  candidateRelativePath: 'pipelines/alpha.yaml',
  candidateDiskHash: 'a'.repeat(64),
  inventoryRevision: 3,
  inventoryDigest: 'b'.repeat(64),
  yamlHash: 'c'.repeat(64),
  layoutHash: 'd'.repeat(64),
  requirementsHash: 'e'.repeat(64),
  snapshotHash: 'f'.repeat(64),
  createdAt: 1_777_777_777_000,
  publishable: false,
};

const READONLY_TEXT_RESULT = 'Recovered read-only text result.';

interface SdkHistoryEvent {
  id: string;
  type: string;
  durable: { aggregateID: string; seq: number; version: number };
  data: Record<string, unknown>;
}

interface HarnessOptions {
  nativePrompt?: 'admit' | 'conflict-after-admit' | 'throw-after-admit';
  nativePromptFailure?: { readonly status: number; readonly error: unknown };
  historyVisibilityDelayReads?: number;
  richSdkFailure?: { readonly status: number; readonly error: unknown };
  richPrompt?: (
    input: OpenCodeAdapterClassifierTextPromptInput | OpenCodeAdapterTextPromptInput,
    signal: AbortSignal | undefined,
  ) => unknown;
  textResponseLosses?: number;
}

class MemoryInvocationStore implements OpenCodeInvocationStore {
  private record: StoredInvocationOutboxRecord | null = null;

  constructor(private readonly calls: string[]) {}

  prepareInvocationOutbox(input: PrepareInvocationOutboxInput): StoredInvocationOutboxRecord {
    this.calls.push('outbox.prepare');
    if (this.record) {
      if (
        this.record.invocationId !== input.invocationId ||
        this.record.operationId !== input.operationId ||
        this.record.purpose !== input.purpose ||
        this.record.sessionId !== input.sessionId ||
        this.record.inputId !== input.inputId ||
        this.record.requestDigest !== input.requestDigest
      ) {
        const error = new Error('outbox conflict') as Error & { code: string };
        error.code = 'outbox_conflict';
        throw error;
      }
      return this.record;
    }
    this.record = {
      invocationId: input.invocationId,
      workspaceScopeId: 'scope-1',
      operationId: input.operationId,
      purpose: input.purpose,
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestDigest: input.requestDigest,
      status: 'prepared',
      preparedAt: input.preparedAt ?? 1_777_777_777_000,
      updatedAt: input.preparedAt ?? 1_777_777_777_000,
      admittedAggregateSeq: null,
      settledAt: null,
      failureCode: null,
    };
    return this.record;
  }

  getInvocationOutbox(invocationId: string): StoredInvocationOutboxRecord | null {
    return this.record?.invocationId === invocationId ? this.record : null;
  }

  listInvocationOutbox(
    workspaceScopeId: string,
    options: ListInvocationOutboxOptions = {},
  ): StoredInvocationOutboxRecord[] {
    if (!this.record || this.record.workspaceScopeId !== workspaceScopeId) return [];
    if (options.statuses && !options.statuses.includes(this.record.status)) return [];
    return [this.record];
  }

  updateInvocationOutbox(input: UpdateInvocationOutboxInput): UpdateInvocationOutboxResult {
    if (!this.record) throw new Error('missing outbox');
    if (this.record.status !== input.expectedStatus) {
      return { applied: false, reason: 'status_mismatch', outbox: this.record };
    }
    this.record = {
      ...this.record,
      status: input.status,
      admittedAggregateSeq:
        input.admittedAggregateSeq === undefined
          ? this.record.admittedAggregateSeq
          : input.admittedAggregateSeq,
      settledAt: input.settledAt === undefined ? this.record.settledAt : input.settledAt,
      failureCode: input.failureCode === undefined ? this.record.failureCode : input.failureCode,
      updatedAt: input.updatedAt ?? this.record.updatedAt + 1,
    };
    return { applied: true, outbox: this.record };
  }
}

function sdkOk<T>(data: T, status = 200) {
  return Promise.resolve({ data, response: { status } });
}

function createHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const history: SdkHistoryEvent[] = [];
  const richRequests: Array<
    OpenCodeAdapterClassifierTextPromptInput | OpenCodeAdapterTextPromptInput
  > = [];
  const nativePromptRequests: OpenCodeAdapterNativePromptInput[] = [];
  const textCache = new Map<string, unknown>();
  let richCallCount = 0;
  let textProviderCallCount = 0;
  let textResponseLosses = options.textResponseLosses ?? 0;
  let hiddenHistoryReadsRemaining = options.historyVisibilityDelayReads ?? 0;
  let nativeSessionCreated = false;

  const client: OpenCodeAdapterSdkClient = {
    v2: {
      session: {
        create(input) {
          calls.push('sdk.native.create');
          nativeSessionCreated = true;
          return sdkOk({ data: { id: input.id } });
        },
        prompt(input) {
          calls.push('sdk.native.prompt');
          nativePromptRequests.push(input);
          const digest = extractNativeRequestDigest(input.prompt.text);
          if (!digest) throw new Error('native prompt omitted its request-digest marker');
          if (options.nativePromptFailure) {
            return Promise.resolve({
              error: options.nativePromptFailure.error,
              response: { status: options.nativePromptFailure.status },
            });
          }
          const aggregateSeq = history.length + 1;
          const event: SdkHistoryEvent = {
            id: `evt_${aggregateSeq}`,
            type: 'session.next.prompt.admitted',
            durable: {
              aggregateID: input.sessionID,
              seq: aggregateSeq,
              version: aggregateSeq,
            },
            data: {
              timestamp: 1_777_777_777_000 + aggregateSeq,
              sessionID: input.sessionID,
              messageID: input.id,
              prompt: input.prompt,
              delivery: input.delivery,
            },
          };
          history.push(event);
          if (options.nativePrompt === 'throw-after-admit') {
            throw new Error('simulated committed native response loss');
          }
          if (options.nativePrompt === 'conflict-after-admit') {
            return Promise.resolve({
              error: { _tag: 'ConflictError' },
              response: { status: 409 },
            });
          }
          return sdkOk({
            data: {
              id: input.id,
              sessionID: input.sessionID,
              prompt: input.prompt,
              delivery: input.delivery,
              admittedSeq: aggregateSeq,
              timeCreated: 1_777_777_777_000 + aggregateSeq,
            },
          });
        },
        history(input) {
          calls.push('sdk.native.history');
          if (!nativeSessionCreated && history.length === 0) {
            return Promise.resolve({
              error: {
                _tag: 'SessionNotFoundError',
                sessionID: input.sessionID,
              },
              response: { status: 404 },
            });
          }
          if (history.length > 0 && hiddenHistoryReadsRemaining > 0) {
            hiddenHistoryReadsRemaining -= 1;
            return sdkOk({ data: [], hasMore: false });
          }
          const records = history.filter((event) => event.durable.seq > input.after);
          return sdkOk({
            data: records.slice(0, input.limit),
            hasMore: records.length > input.limit,
          });
        },
        interrupt() {
          calls.push('sdk.native.interrupt');
          return Promise.resolve({ response: { status: 204 } });
        },
      },
    },
    session: {
      prompt(input, requestOptions) {
        calls.push('sdk.rich.prompt');
        richCallCount += 1;
        richRequests.push(input);
        if (options.richSdkFailure) {
          return Promise.resolve({
            error: options.richSdkFailure.error,
            response: { status: options.richSdkFailure.status },
          });
        }
        const authored = options.richPrompt?.(input, requestOptions?.signal);
        if (authored !== undefined) return sdkOk(authored);
        if (input.format.type === 'text') {
          const key = `${input.sessionID}\u0000${input.messageID}`;
          const cached = textCache.get(key);
          if (cached !== undefined) {
            if (textResponseLosses > 0) {
              textResponseLosses -= 1;
              throw new Error('simulated cached text response loss');
            }
            return sdkOk(cached);
          }
          textProviderCallCount += 1;
          const text =
            input.agent === 'tagma-pipeline-intent-classifier'
              ? JSON.stringify(discussionOutput())
              : READONLY_TEXT_RESULT;
          const response = {
            info: {
              id: `assistant-${input.messageID}`,
              parentID: input.messageID,
              error: undefined,
              structured: undefined,
              finish: 'stop',
              cost: 0.000321,
              tokens: {
                input: 13,
                output: 5,
                reasoning: 1,
                cache: { read: 3, write: 2 },
              },
            },
            parts: [{ type: 'text', text }],
          };
          textCache.set(key, response);
          if (textResponseLosses > 0) {
            textResponseLosses -= 1;
            throw new Error('simulated committed text response loss');
          }
          return sdkOk(response);
        }
        const result = {
          info: {
            id: `assistant-${input.messageID}`,
            parentID: input.messageID,
            error: undefined,
            structured: discussionOutput(),
            finish: 'stop',
            cost: 0.000123,
            tokens: {
              input: 11,
              output: 7,
              reasoning: 3,
              cache: { read: 2, write: 1 },
            },
          },
          parts: [],
        };
        return sdkOk(result);
      },
    },
  };

  return {
    calls,
    history,
    richRequests,
    nativePromptRequests,
    client,
    richCallCount: () => richCallCount,
    textProviderCallCount: () => textProviderCallCount,
    setTextResponseLosses(value: number) {
      textResponseLosses = value;
    },
  };
}

function discussionOutput() {
  return {
    kind: 'discussion',
    targetCandidateId: null,
    clarification: null,
    candidateIds: [],
  };
}

function request(
  overrides: Partial<OpenCodeTextClassifierRunRequest> = {},
): OpenCodeTextClassifierRunRequest {
  return {
    operationId: 'operation-1',
    workspaceScopeId: 'scope-1',
    invocationId: 'invocation-1',
    sessionId: 'ses_host_classifier_1',
    inputId: 'msg_host_native_1',
    canonicalRequestBytes: buildClassifierTextCanonicalRequestBytes(
      'Please explain how this pipeline works.',
      candidates,
    ),
    userText: 'Please explain how this pipeline works.',
    candidates,
    model: { providerID: 'provider-1', modelID: 'model-1' },
    variant: 'high',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function readonlyRequest(
  purpose: 'discussion' | 'diagnosis',
  overrides: Partial<ChatOperationV2DurableInvocationRequest> = {},
): ChatOperationV2DurableInvocationRequest {
  const readSnapshot = purpose === 'diagnosis' ? sealedReadSnapshot : null;
  return {
    operationId: 'operation-readonly-1',
    workspaceScopeId: 'scope-1',
    invocationId: `invocation-${purpose}-1`,
    sessionId: `ses_host_${purpose}_1`,
    inputId: `msg_host_native_${purpose}_1`,
    purpose,
    provider: 'provider-1',
    model: 'model-1',
    variant: 'high',
    canonicalRequestBytes: buildReadonlyTextCanonicalRequestBytes({
      purpose,
      request: readonlyAdmissionRequest,
      readSnapshot,
    }),
    readSnapshot,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function setup(
  options: HarnessOptions = {},
  runnerOptions: {
    readonly useDefaultExecutionId?: boolean;
    readonly admissionSourceAttempts?: number;
    readonly admissionSourceDelayMs?: number;
  } = {},
) {
  const harness = createHarness(options);
  const store = new MemoryInvocationStore(harness.calls);
  const adapter = new OpenCodeSdkAdapter({
    workspaceDirectory: '/workspace',
    resolveClient: async () => harness.client,
  });
  const controller = new OpenCodeInvocationController({ store, client: adapter });
  let executionIdAllocations = 0;
  const runner = new OpenCodeReadonlyInvocationRunner({
    controller,
    store,
    nativeClient: adapter,
    textPromptClient: adapter,
    ...(runnerOptions.admissionSourceAttempts === undefined
      ? {}
      : { admissionSourceAttempts: runnerOptions.admissionSourceAttempts }),
    ...(runnerOptions.admissionSourceDelayMs === undefined
      ? {}
      : { admissionSourceDelayMs: runnerOptions.admissionSourceDelayMs }),
    ...(runnerOptions.useDefaultExecutionId
      ? {}
      : {
          nextExecutionMessageId: () => {
            executionIdAllocations += 1;
            return 'msg_host_execution_1';
          },
        }),
  });
  const durableRunner = new ChatOperationV2OpenCodeReadonlyRunner(runner);
  return {
    adapter,
    controller,
    durableRunner,
    harness,
    runner,
    store,
    executionIdAllocations: () => executionIdAllocations,
  };
}

describe('Chat Operation V2 OpenCode adapter', () => {
  test('preserves a native session-not-found response instead of reporting transport ambiguity', async () => {
    const { harness, runner } = setup({
      nativePromptFailure: {
        status: 404,
        error: { _tag: 'SessionNotFoundError', sessionID: 'ses_host_classifier_1' },
      },
    });

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'admission_session_missing',
    });
    expect(harness.nativePromptRequests).toHaveLength(1);
  });

  test('keeps a malformed successful native response in bounded history ambiguity', async () => {
    const { harness, runner } = setup({
      nativePromptFailure: {
        status: 200,
        error: { _tag: 'MalformedSuccessfulResponse' },
      },
    });

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'admission_prompt_replay_transport_history_missing',
    });
    expect(harness.nativePromptRequests).toHaveLength(2);
  });

  test('does not label an unrelated native 404 as a missing session', async () => {
    const { harness, runner } = setup({
      nativePromptFailure: {
        status: 404,
        error: { _tag: 'RouteNotFoundError' },
      },
    });

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'admission_request_rejected',
    });
    expect(harness.nativePromptRequests).toHaveLength(1);
  });

  test('writes the durable outbox before resolving or calling any SDK client', async () => {
    const { harness, runner } = setup();

    const result = await runner.run(request());

    expect(result.kind).toBe('completed');
    expect(harness.calls[0]).toBe('outbox.prepare');
    expect(harness.calls.slice(1)).toEqual([
      'sdk.native.history',
      'sdk.native.create',
      'sdk.native.prompt',
      'sdk.native.history',
      'sdk.rich.prompt',
    ]);
  });

  test('waits for a newly admitted history event without resubmitting the native prompt', async () => {
    const { harness, runner } = setup({ historyVisibilityDelayReads: 2 });

    expect(await runner.run(request())).toMatchObject({ kind: 'completed' });
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.calls.filter((call) => call === 'sdk.native.history')).toHaveLength(4);
    expect(harness.richCallCount()).toBe(1);
  });

  test('reports bounded history unavailability without claiming response loss', async () => {
    const { harness, runner } = setup(
      { historyVisibilityDelayReads: 3 },
      { admissionSourceAttempts: 2, admissionSourceDelayMs: 0 },
    );

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'execution_history_unavailable',
    });
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.richRequests).toHaveLength(0);
  });

  test('admits natively, then sends one tool-free text classifier message', async () => {
    const { harness, runner, executionIdAllocations } = setup();
    const input = request();

    const result = await runner.run(input);

    expect(result).toMatchObject({
      kind: 'completed',
      executionMessageId: 'msg_host_execution_1',
      admittedAggregateSeq: 1,
      source: { aggregateSeq: 1, eventId: 'evt_1' },
      usage: {
        inputTokens: 13,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costMicrounits: 321,
      },
    });
    expect(executionIdAllocations()).toBe(1);
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.nativePromptRequests[0]).toMatchObject({
      sessionID: input.sessionId,
      id: input.inputId,
      delivery: 'queue',
      resume: false,
    });
    const rich = harness.richRequests[0];
    expect(rich).toBeDefined();
    expect(rich?.sessionID).toBe(input.sessionId);
    expect(rich?.messageID).toBe('msg_host_execution_1');
    expect(rich?.messageID).not.toBe(input.inputId);
    expect(rich?.model).toEqual(input.model);
    expect(rich?.variant).toBe('high');
    expect(rich?.tools).toEqual(TAGMA_PIPELINE_INTENT_CLASSIFIER_TOOLS);
    expect(Object.keys(rich?.tools as Record<string, boolean>)).toEqual(['*']);
    expect((rich?.tools as Record<string, boolean>)['*']).toBe(false);
    const expectedPrompt = buildChatPipelineIntentClassificationPrompt(
      input.userText,
      input.candidates,
    );
    expect(rich?.system).toBe(expectedPrompt.system);
    expect(rich?.parts).toEqual([{ type: 'text', text: expectedPrompt.user }]);
    expect(rich?.format).toEqual({ type: 'text' });
    expect(rich?.format).not.toHaveProperty('retryCount');
    expect(rich).not.toHaveProperty('noReply');
  });

  test('implements the orchestrator runner with authenticated bytes and a safe Host decision', async () => {
    const { durableRunner, harness } = setup();
    const input = request();

    const result = await durableRunner.run({
      operationId: input.operationId,
      workspaceScopeId: 'scope-1',
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: 'classifier',
      provider: input.model.providerID,
      model: input.model.modelID,
      variant: input.variant,
      canonicalRequestBytes: input.canonicalRequestBytes,
      readSnapshot: null,
      signal: input.signal,
    });

    expect(result).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
      text: null,
      executionMessageId: 'msg_host_execution_1',
      finishCode: 'stop',
      admittedAggregateSeq: 1,
      source: { aggregateSeq: 1, eventId: 'evt_1' },
      usage: { outcome: 'completed' },
    });
    expect(result).not.toHaveProperty('intent');
    expect(harness.richCallCount()).toBe(1);
  });

  test('runs discussion as native admission followed by one tool-free compatibility text message', async () => {
    const { durableRunner, harness, store } = setup();
    const input = readonlyRequest('discussion');

    const result = await durableRunner.run(input);

    expect(result).toMatchObject({
      kind: 'completed',
      structuredOutput: READONLY_TEXT_RESULT,
      text: READONLY_TEXT_RESULT,
      executionMessageId: 'msg_host_execution_1',
      finishCode: 'stop',
      admittedAggregateSeq: 1,
      source: { aggregateSeq: 1, eventId: 'evt_1' },
      usage: {
        inputTokens: 13,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        costMicrounits: 321,
      },
    });
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.richRequests).toHaveLength(1);
    const rich = harness.richRequests[0];
    expect(rich?.sessionID).toBe(input.sessionId);
    expect(rich?.messageID).toBe('msg_host_execution_1');
    expect(rich?.messageID).not.toBe(input.inputId);
    expect(rich?.agent).toBe('tagma-general-discussion');
    expect(rich?.tools).toEqual({ '*': false });
    expect(Object.keys(rich?.tools ?? {})).toEqual(['*']);
    expect(rich?.format).toEqual({ type: 'text' });
    expect(rich?.system).toContain('read-only discussion');
    expect(rich?.parts[0]?.text).toContain(readonlyAdmissionRequest.text);
    expect(rich?.parts[0]?.text).toContain('Focus on the retry boundary.');
    expect(rich?.parts[0]?.text).not.toContain(sealedReadSnapshot.canonicalYaml);
    expect(store.getInvocationOutbox(input.invocationId)).toMatchObject({
      status: 'running',
      admittedAggregateSeq: 1,
    });
  });

  test('preserves a specific safe provider failure for discussion without requiring text parts', async () => {
    const { durableRunner, harness } = setup({
      richPrompt: (input) => ({
        info: {
          id: `assistant-${input.messageID}`,
          parentID: input.messageID,
          error: {
            name: 'APIError',
            data: {
              message: 'private rate-limit response body',
              statusCode: 429,
              isRetryable: true,
            },
          },
          finish: 'error',
        },
      }),
    });

    expect(await durableRunner.run(readonlyRequest('discussion'))).toEqual({
      kind: 'provider_unavailable',
      code: 'provider_rate_limited',
    });
    expect(harness.richCallCount()).toBe(1);
  });

  test('keeps a definitive read-only SDK rejection distinct from response loss', async () => {
    const { durableRunner, harness } = setup({
      richSdkFailure: {
        status: 401,
        error: { name: 'ProviderAuthError', data: { private: 'do not persist' } },
      },
    });

    expect(await durableRunner.run(readonlyRequest('diagnosis'))).toEqual({
      kind: 'provider_unavailable',
      code: 'provider_authentication_failed',
    });
    expect(harness.richCallCount()).toBe(1);
  });

  test('derives a restart-stable execution message id from Host invocation identity', async () => {
    const { durableRunner, harness } = setup({}, { useDefaultExecutionId: true });
    const input = readonlyRequest('discussion');
    const expected = deriveOpenCodeExecutionMessageId({
      operationId: input.operationId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: 'discussion',
    });

    await durableRunner.run(input);

    expect(harness.richRequests[0]?.messageID).toBe(expected);
    expect(expected).toMatch(/^msg_tagma_exec_[0-9a-f]{40}$/);
    expect(
      deriveOpenCodeExecutionMessageId({
        operationId: input.operationId,
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'discussion',
      }),
    ).toBe(expected);
  });

  test('runs diagnosis with only the sealed snapshot context and no provider-facing tools', async () => {
    const { durableRunner, harness } = setup();
    const input = readonlyRequest('diagnosis');

    const result = await durableRunner.run(input);

    expect(result).toMatchObject({ kind: 'completed', structuredOutput: READONLY_TEXT_RESULT });
    const rich = harness.richRequests[0];
    expect(rich?.agent).toBe('tagma-pipeline-diagnosis');
    expect(rich?.tools).toEqual({ '*': false });
    expect(rich?.format).toEqual({ type: 'text' });
    expect(rich?.system).toContain('sealed Host snapshot');
    expect(rich?.system).toContain('empty `compileDiagnostics` array');
    expect(rich?.system).toContain('static Host compilation evidence only');
    expect(rich?.system).toContain('`fromDriver: opencode`');
    expect(rich?.system).toContain('Tagma-managed runtime dependency');
    expect(rich?.system).toContain('Do not invent schema fields');
    expect(rich?.system).toContain('Never group `.compile.log` with runtime evidence');
    expect(rich?.system).toContain('Never combine compilation and preflight into one claim');
    const providerContext = JSON.parse(
      rich?.parts[0]?.text.split('\n').slice(1, -1).join('\n') ?? '{}',
    ) as Record<string, unknown>;
    expect(providerContext.sealedSnapshot).toMatchObject({
      canonicalYaml: sealedReadSnapshot.canonicalYaml,
      layoutJson: sealedReadSnapshot.layoutJson,
      requirementsMarkdown: sealedReadSnapshot.requirementsMarkdown,
      compileDiagnostics: sealedReadSnapshot.compileDiagnostics,
    });
    expect(providerContext.sealedSnapshot).not.toHaveProperty('workspaceScopeId');
    expect(providerContext.sealedSnapshot).not.toHaveProperty('candidateDiskHash');
  });

  test('runs diagnosis without a canvas snapshot as authenticated request-only context', async () => {
    const { durableRunner, harness } = setup();
    const readSnapshot = null;
    const input = readonlyRequest('diagnosis', {
      canonicalRequestBytes: buildReadonlyTextCanonicalRequestBytes({
        purpose: 'diagnosis',
        request: readonlyAdmissionRequest,
        readSnapshot,
      }),
      readSnapshot,
    });

    const result = await durableRunner.run(input);

    expect(result).toMatchObject({ kind: 'completed', structuredOutput: READONLY_TEXT_RESULT });
    const rich = harness.richRequests[0];
    expect(rich?.agent).toBe('tagma-pipeline-diagnosis');
    expect(rich?.tools).toEqual({ '*': false });
    expect(rich?.format).toEqual({ type: 'text' });
    expect(rich?.system).toContain('No sealed pipeline snapshot is available');
    const providerContext = JSON.parse(
      rich?.parts[0]?.text.split('\n').slice(1, -1).join('\n') ?? '{}',
    ) as Record<string, unknown>;
    expect(providerContext).not.toHaveProperty('sealedSnapshot');
    expect(providerContext).toMatchObject({
      schemaVersion: 1,
      purpose: 'diagnosis',
      request: readonlyAdmissionRequest,
    });
  });

  test('rejects diagnosis when the caller snapshot differs from the authenticated canonical bytes', async () => {
    const { durableRunner, harness } = setup();
    const canonical = readonlyRequest('diagnosis');
    const mismatchedSnapshot = {
      ...sealedReadSnapshot,
      canonicalYaml: 'name: attacker-supplied\ntracks: []\n',
    };

    expect(await durableRunner.run({ ...canonical, readSnapshot: mismatchedSnapshot })).toEqual({
      kind: 'provider_unavailable',
      code: 'request_digest_conflict',
    });
    expect(harness.calls).toEqual([]);
  });

  // Pinned runtime proof is env-gated by TAGMA_OPENCODE_NATIVE_SMOKE=1 in
  // opencode-v2-question-conformance.test.ts; this regression pins its adapter consequence.
  test('recovers a lost text response by replaying the identical Host message id once', async () => {
    const { durableRunner, harness } = setup({ textResponseLosses: 1 });
    const input = readonlyRequest('discussion');

    const result = await durableRunner.run(input);

    expect(result).toMatchObject({ kind: 'completed', structuredOutput: READONLY_TEXT_RESULT });
    expect(harness.richRequests).toHaveLength(2);
    expect(harness.richRequests[0]).toEqual(harness.richRequests[1]);
    expect(harness.richRequests.map(({ messageID }) => messageID)).toEqual([
      'msg_host_execution_1',
      'msg_host_execution_1',
    ]);
    expect(harness.textProviderCallCount()).toBe(1);
  });

  test('restart reconcile recovers cached text with the same Host id and no provider reinvocation', async () => {
    const first = setup({ textResponseLosses: 2 });
    const input = readonlyRequest('diagnosis');
    expect(await first.durableRunner.run(input)).toEqual({
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'text_execution_response_unknown',
    });
    expect(first.harness.richRequests).toHaveLength(2);
    expect(first.harness.textProviderCallCount()).toBe(1);
    first.harness.setTextResponseLosses(0);

    const restartedAdapter = new OpenCodeSdkAdapter({
      workspaceDirectory: '/workspace',
      resolveClient: async () => first.harness.client,
    });
    const restartedReadonlyInvocationRunner = new OpenCodeReadonlyInvocationRunner({
      controller: new OpenCodeInvocationController({
        store: first.store,
        client: restartedAdapter,
      }),
      store: first.store,
      nativeClient: restartedAdapter,
      textPromptClient: restartedAdapter,
      nextExecutionMessageId: () => 'msg_host_execution_1',
    });
    const restartedRunner = new ChatOperationV2OpenCodeReadonlyRunner(
      restartedReadonlyInvocationRunner,
    );
    const { signal: _signal, ...recoveryRequest } = input;

    expect(await restartedRunner.reconcile(recoveryRequest)).toMatchObject({
      kind: 'completed',
      structuredOutput: READONLY_TEXT_RESULT,
      source: { aggregateSeq: 1, eventId: 'evt_1' },
    });
    expect(first.harness.richRequests).toHaveLength(3);
    expect(first.harness.richRequests.map(({ messageID }) => messageID)).toEqual([
      'msg_host_execution_1',
      'msg_host_execution_1',
      'msg_host_execution_1',
    ]);
    expect(first.harness.richRequests[2]).toEqual(first.harness.richRequests[0]);
    expect(first.harness.textProviderCallCount()).toBe(1);
  });

  test('reconcile rejects changed caller bytes before replaying the cached text id', async () => {
    const first = setup({ textResponseLosses: 2 });
    const input = readonlyRequest('discussion');
    await first.durableRunner.run(input);
    const richCalls = first.harness.richCallCount();
    const changed = readonlyRequest('discussion', {
      canonicalRequestBytes: buildReadonlyTextCanonicalRequestBytes({
        purpose: 'discussion',
        request: { ...readonlyAdmissionRequest, text: 'Different caller bytes.' },
        readSnapshot: null,
      }),
    });
    const { signal: _signal, ...changedRecovery } = changed;

    expect(await first.durableRunner.reconcile(changedRecovery)).toEqual({
      kind: 'provider_unavailable',
      code: 'request_digest_conflict',
    });
    expect(first.harness.richCallCount()).toBe(richCalls);
    expect(first.harness.textProviderCallCount()).toBe(1);
  });

  test('rejects classifier text with provider-authored extra fields', async () => {
    const { runner } = setup({
      richPrompt: (richInput) => ({
        info: {
          id: `assistant-${richInput.messageID}`,
          parentID: richInput.messageID,
          finish: 'stop',
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              ...discussionOutput(),
              unexpectedProviderField: 'do not return',
            }),
          },
        ],
      }),
    });
    const input = request();

    const result = await runner.run(input);

    expect(result).toEqual({ kind: 'provider_unavailable', code: 'malformed_text_result' });
  });

  test('rejects non-canonical orchestrator bytes before outbox or SDK access', async () => {
    const { durableRunner, harness } = setup();
    const input = request();
    const nonCanonicalBytes = Uint8Array.from([...input.canonicalRequestBytes, 0x20]);

    expect(
      await durableRunner.run({
        operationId: input.operationId,
        workspaceScopeId: 'scope-1',
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'classifier',
        provider: input.model.providerID,
        model: input.model.modelID,
        variant: input.variant,
        canonicalRequestBytes: nonCanonicalBytes,
        readSnapshot: null,
        signal: input.signal,
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'request_digest_conflict' });
    expect(harness.calls).toEqual([]);
  });

  test.each([
    ['discussion', discussionOutput(), { kind: 'discussion' }],
    [
      'diagnosis',
      {
        kind: 'diagnosis',
        targetCandidateId: 'pipeline-1',
        clarification: null,
        candidateIds: [],
      },
      { kind: 'diagnosis', target: candidates[0] },
    ],
    [
      'clarify',
      {
        kind: 'clarify',
        targetCandidateId: null,
        clarification: 'Which pipeline should I inspect?',
        candidateIds: ['pipeline-1', 'pipeline-2'],
      },
      {
        kind: 'clarify',
        question: 'Which pipeline should I inspect?',
        candidates,
      },
    ],
  ] as const)('strictly resolves a successful %s result', async (_label, structured, intent) => {
    const { runner } = setup({
      richPrompt: (input) => ({
        info: {
          id: `assistant-${input.messageID}`,
          parentID: input.messageID,
          finish: 'stop',
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [{ type: 'text', text: JSON.stringify(structured) }],
      }),
    });

    const result = await runner.run(request());

    expect(result).toMatchObject({ kind: 'completed', structuredOutput: structured, intent });
  });

  test('continues text classification after recovering a native 409 from history', async () => {
    const { harness, runner } = setup({ nativePrompt: 'conflict-after-admit' });

    const result = await runner.run(request());

    expect(result).toMatchObject({ kind: 'completed', structuredOutput: discussionOutput() });
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.richRequests).toHaveLength(1);
    expect(harness.history).toHaveLength(1);
  });

  test('continues text classification after a lost native admission response', async () => {
    const { harness, runner } = setup({ nativePrompt: 'throw-after-admit' });

    expect(await runner.run(request())).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
    });
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.history).toHaveLength(1);
    expect(harness.richRequests).toHaveLength(1);
  });

  test('recovers one classifier transport loss through the identical cached text id', async () => {
    const { executionIdAllocations, harness, runner } = setup({ textResponseLosses: 1 });
    const input = request();

    expect(await runner.run(input)).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
    });
    expect(await runner.run(input)).toMatchObject({ kind: 'completed' });
    expect(harness.richCallCount()).toBe(2);
    expect(harness.textProviderCallCount()).toBe(1);
    expect(executionIdAllocations()).toBe(1);
    expect(harness.richRequests[0]?.messageID).toBe('msg_host_execution_1');
    expect(harness.richRequests[1]?.messageID).toBe('msg_host_execution_1');
  });

  test('coalesces concurrent calls for the same Host invocation and execution id', async () => {
    const { executionIdAllocations, harness, runner } = setup();
    const input = request();

    const [first, second] = await Promise.all([runner.run(input), runner.run(input)]);

    expect(first).toEqual(second);
    expect(first.kind).toBe('completed');
    expect(harness.nativePromptRequests).toHaveLength(1);
    expect(harness.richCallCount()).toBe(1);
    expect(executionIdAllocations()).toBe(1);
  });

  test('restart run recovers cached classifier text with the same execution id', async () => {
    const first = setup({ textResponseLosses: 2 });
    const input = request();
    expect(await first.runner.run(input)).toEqual({
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'text_execution_response_unknown',
    });

    const restartedAdapter = new OpenCodeSdkAdapter({
      workspaceDirectory: '/workspace',
      resolveClient: async () => first.harness.client,
    });
    const restartedController = new OpenCodeInvocationController({
      store: first.store,
      client: restartedAdapter,
    });
    const restartedRunner = new OpenCodeReadonlyInvocationRunner({
      controller: restartedController,
      store: first.store,
      nativeClient: restartedAdapter,
      textPromptClient: restartedAdapter,
      nextExecutionMessageId: () => 'msg_host_execution_1',
    });
    const callsBeforeRestartRun = first.harness.calls.length;

    expect(await restartedRunner.run(input)).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
    });
    expect(first.harness.richCallCount()).toBe(3);
    expect(first.harness.textProviderCallCount()).toBe(1);
    expect(first.harness.calls.slice(callsBeforeRestartRun)).toContain('sdk.native.history');
  });

  test('orchestrator reconciliation recovers cached classifier text after restart', async () => {
    const first = setup({ textResponseLosses: 2 });
    const input = request();
    expect(await first.runner.run(input)).toEqual({
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'text_execution_response_unknown',
    });

    const restartedAdapter = new OpenCodeSdkAdapter({
      workspaceDirectory: '/workspace',
      resolveClient: async () => first.harness.client,
    });
    const restartedReadonlyInvocationRunner = new OpenCodeReadonlyInvocationRunner({
      controller: new OpenCodeInvocationController({
        store: first.store,
        client: restartedAdapter,
      }),
      store: first.store,
      nativeClient: restartedAdapter,
      textPromptClient: restartedAdapter,
      nextExecutionMessageId: () => 'msg_host_execution_1',
    });
    const restartedRunner = new ChatOperationV2OpenCodeReadonlyRunner(
      restartedReadonlyInvocationRunner,
    );
    const nativePromptCalls = first.harness.nativePromptRequests.length;
    const richCalls = first.harness.richCallCount();

    expect(
      await restartedRunner.reconcile({
        operationId: input.operationId,
        workspaceScopeId: 'scope-1',
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'classifier',
        provider: input.model.providerID,
        model: input.model.modelID,
        variant: input.variant,
        canonicalRequestBytes: input.canonicalRequestBytes,
        readSnapshot: null,
      }),
    ).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
      text: null,
    });
    expect(first.harness.nativePromptRequests).toHaveLength(nativePromptCalls);
    expect(first.harness.richCallCount()).toBe(richCalls + 1);
    expect(first.harness.textProviderCallCount()).toBe(1);
  });

  test('reconciliation starts text classification from a proven native admission', async () => {
    const state = setup();
    const input = request();
    const requestDigest = sha256CanonicalOpenCodeRequest(input.canonicalRequestBytes);
    state.store.prepareInvocationOutbox({
      operationId: input.operationId,
      invocationId: input.invocationId,
      purpose: 'classifier',
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestDigest,
    });
    state.harness.history.push({
      id: 'evt_1',
      type: 'session.next.prompt.admitted',
      durable: { aggregateID: input.sessionId, seq: 1, version: 1 },
      data: {
        timestamp: 1_777_777_777_001,
        sessionID: input.sessionId,
        messageID: input.inputId,
        prompt: { text: buildNativeRequestDigestMarker(requestDigest) },
        delivery: 'queue',
      },
    });

    expect(
      await state.durableRunner.reconcile({
        operationId: input.operationId,
        workspaceScopeId: 'scope-1',
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'classifier',
        provider: input.model.providerID,
        model: input.model.modelID,
        variant: input.variant,
        canonicalRequestBytes: input.canonicalRequestBytes,
        readSnapshot: null,
      }),
    ).toMatchObject({
      kind: 'completed',
      structuredOutput: discussionOutput(),
      text: null,
    });
    expect(state.store.getInvocationOutbox(input.invocationId)).toMatchObject({
      status: 'running',
      admittedAggregateSeq: 1,
    });
    expect(state.harness.nativePromptRequests).toHaveLength(0);
    expect(state.harness.richRequests).toHaveLength(1);
    expect(state.harness.calls).toEqual([
      'outbox.prepare',
      'sdk.native.history',
      'sdk.rich.prompt',
    ]);
  });

  test('fails closed on malformed classifier text', async () => {
    const { runner } = setup({
      richPrompt: (input) => ({
        info: {
          id: `assistant-${input.messageID}`,
          parentID: input.messageID,
          finish: 'stop',
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'edit',
              targetCandidateId: 'model-authored-path',
              clarification: null,
              candidateIds: [],
            }),
          },
        ],
      }),
    });

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'malformed_text_result',
    });
  });

  test('orchestrator runner rejects malformed classifier text before settling completion', async () => {
    const { durableRunner } = setup({
      richPrompt: (richInput) => ({
        info: {
          id: `assistant-${richInput.messageID}`,
          parentID: richInput.messageID,
          finish: 'stop',
          cost: 0,
          tokens: {
            input: 1,
            output: 1,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'edit',
              targetCandidateId: 'model-authored-path',
              clarification: null,
              candidateIds: [],
            }),
          },
        ],
      }),
    });
    const input = request();

    expect(
      await durableRunner.run({
        operationId: input.operationId,
        workspaceScopeId: 'scope-1',
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'classifier',
        provider: input.model.providerID,
        model: input.model.modelID,
        variant: input.variant,
        canonicalRequestBytes: input.canonicalRequestBytes,
        readSnapshot: null,
        signal: input.signal,
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'malformed_text_result' });
  });

  test('returns a typed provider failure for unknown errors without leaking the provider payload', async () => {
    const { runner } = setup({
      richPrompt: (input) => ({
        info: {
          id: `assistant-${input.messageID}`,
          parentID: input.messageID,
          error: {
            name: 'APIError',
            data: { message: 'secret upstream body', responseBody: 'do not leak' },
          },
          structured: undefined,
          cost: 0,
          tokens: {
            input: 1,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      }),
    });

    expect(await runner.run(request())).toEqual({
      kind: 'provider_unavailable',
      code: 'provider_invocation_failed',
    });
  });

  test.each([
    [
      'provider authentication',
      {
        name: 'ProviderAuthError',
        data: { providerID: 'provider-1', message: 'secret authentication detail' },
      },
      'provider_authentication_failed',
    ],
    [
      'unknown provider failure',
      {
        name: 'UnknownError',
        data: {
          message: 'user content mentioned an unknown model and API key',
          ref: 'private-ref',
        },
      },
      'provider_invocation_failed',
    ],
    ['malformed scalar provider failure', 'secret upstream error', 'provider_invocation_failed'],
    [
      'model output length',
      { name: 'MessageOutputLengthError', data: { private: 'do not leak' } },
      'model_output_length',
    ],
    [
      'aborted provider message',
      { name: 'MessageAbortedError', data: { message: 'secret abort detail' } },
      'provider_invocation_aborted',
    ],
    [
      'model context overflow',
      {
        name: 'ContextOverflowError',
        data: { message: 'secret context detail', responseBody: 'do not leak' },
      },
      'model_context_overflow',
    ],
    [
      'provider content filter',
      { name: 'ContentFilterError', data: { message: 'secret filter detail' } },
      'provider_content_filtered',
    ],
    [
      'provider billing',
      {
        name: 'APIError',
        data: { message: 'secret billing detail', statusCode: 402, isRetryable: false },
      },
      'provider_billing_required',
    ],
    [
      'provider rate limit',
      {
        name: 'APIError',
        data: { message: 'secret rate detail', statusCode: 429, isRetryable: true },
      },
      'provider_rate_limited',
    ],
    [
      'retryable provider outage',
      {
        name: 'APIError',
        data: { message: 'secret outage detail', statusCode: 503, isRetryable: true },
      },
      'provider_unavailable',
    ],
    [
      'authentication status over conflicting model text',
      {
        name: 'APIError',
        data: { message: 'unknown model', statusCode: 401, isRetryable: false },
      },
      'provider_authentication_failed',
    ],
    [
      'authentication status over conflicting structured-output text',
      {
        name: 'APIError',
        data: { message: 'structured output error', statusCode: 401, isRetryable: false },
      },
      'provider_authentication_failed',
    ],
    [
      'billing status over conflicting rate-limit text',
      {
        name: 'APIError',
        data: { message: 'rate limit', statusCode: 402, isRetryable: false },
      },
      'provider_billing_required',
    ],
    [
      'rate-limit status over conflicting billing text',
      {
        name: 'APIError',
        data: { message: 'insufficient credits', statusCode: 429, isRetryable: true },
      },
      'provider_rate_limited',
    ],
    [
      'rate-limit status over conflicting content-policy text',
      {
        name: 'APIError',
        data: {
          message: 'content filter and context overflow',
          statusCode: 429,
          isRetryable: true,
        },
      },
      'provider_rate_limited',
    ],
    [
      'provider request rejection',
      {
        name: 'APIError',
        data: { message: 'secret rejection detail', statusCode: 422, isRetryable: false },
      },
      'provider_request_rejected',
    ],
    [
      'retryable API error without status',
      {
        name: 'APIError',
        data: { message: 'secret transient detail', isRetryable: true },
      },
      'provider_unavailable',
    ],
  ] as const)(
    'classifies a rich %s without persisting provider content',
    async (_label, error, expectedCode) => {
      const { runner } = setup({
        richPrompt: (input) => ({
          info: {
            id: `assistant-${input.messageID}`,
            parentID: input.messageID,
            error,
            structured: undefined,
            cost: 0,
            tokens: {
              input: 1,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        }),
      });

      expect(await runner.run(request())).toEqual({
        kind: 'provider_unavailable',
        code: expectedCode,
      });
    },
  );

  test.each([
    ['unknown model', 'The requested provider model was not found.', 'model_unavailable'],
    [
      'unsupported structured output',
      'This model does not support tools or structured output.',
      'model_incompatible',
    ],
    [
      'billing without status',
      'Insufficient credits for this request.',
      'provider_billing_required',
    ],
  ] as const)(
    'classifies bounded APIError signal %s without returning the message',
    async (_label, message, expectedCode) => {
      const { runner } = setup({
        richPrompt: (input) => ({
          info: {
            id: `assistant-${input.messageID}`,
            parentID: input.messageID,
            error: { name: 'APIError', data: { message, isRetryable: false } },
            structured: undefined,
            cost: 0,
            tokens: {
              input: 1,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [],
        }),
      });

      expect(await runner.run(request())).toEqual({
        kind: 'provider_unavailable',
        code: expectedCode,
      });
    },
  );

  test.each([
    [
      'missing model',
      { status: 400, error: { _tag: 'ProviderModelNotFoundError' } },
      'model_unavailable',
    ],
    [
      'unsupported structured tool',
      { status: 400, error: { name: 'UnsupportedToolError' } },
      'model_incompatible',
    ],
    [
      'provider authentication',
      { status: 401, error: { code: 'AUTHENTICATION_FAILED' } },
      'provider_authentication_failed',
    ],
    [
      'provider rate limit',
      { status: 429, error: { code: 'RATE_LIMITED' } },
      'provider_rate_limited',
    ],
    [
      'bounded provider rejection',
      { status: 400, error: { name: 'BadRequestError', data: { secret: 'do not leak' } } },
      'provider_request_rejected',
    ],
  ] as const)(
    'keeps a definitive %s SDK rejection distinct from response loss',
    async (_label, richSdkFailure, expectedCode) => {
      const { runner } = setup({ richSdkFailure });

      expect(await runner.run(request())).toEqual({
        kind: 'provider_unavailable',
        code: expectedCode,
      });
    },
  );

  test('does not retry a legacy pinned StructuredOutputError response', async () => {
    const { harness, runner } = setup({
      richPrompt: (input) => ({
        info: {
          id: `assistant-${input.messageID}`,
          parentID: input.messageID,
          error: {
            name: 'StructuredOutputError',
            data: { message: 'schema failed', retries: 0 },
          },
          cost: 0,
          tokens: {
            input: 1,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [],
      }),
    });
    const input = request();

    expect(await runner.run(input)).toEqual({
      kind: 'provider_unavailable',
      code: 'structured_output_error',
    });
    expect(await runner.run(input)).toEqual({
      kind: 'provider_unavailable',
      code: 'structured_output_error',
    });
    expect(harness.richCallCount()).toBe(1);
  });

  test('aborts without reusing or replacing the rich execution message id', async () => {
    const abortController = new AbortController();
    const { executionIdAllocations, harness, runner } = setup({
      richPrompt: (_input, signal) => {
        abortController.abort();
        expect(signal?.aborted).toBe(true);
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    const input = request({ signal: abortController.signal });

    expect(await runner.run(input)).toEqual({ kind: 'cancelled', code: 'aborted' });
    expect(await runner.run(input)).toEqual({ kind: 'cancelled', code: 'aborted' });
    expect(harness.richCallCount()).toBe(1);
    expect(executionIdAllocations()).toBe(1);
  });

  test('native request marker carries exactly the durable request digest', async () => {
    const { harness, runner } = setup();
    const input = request();

    await runner.run(input);

    const nativeText = (harness.nativePromptRequests[0]?.prompt as { text?: unknown } | undefined)
      ?.text;
    expect(typeof nativeText).toBe('string');
    expect(extractNativeRequestDigest(nativeText as string)).toBe(
      sha256CanonicalOpenCodeRequest(input.canonicalRequestBytes),
    );
  });
});
