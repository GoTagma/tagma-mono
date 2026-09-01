import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createOpencodeClient as createOpencodeV2Client } from '@opencode-ai/sdk/v2/client';

import {
  buildChatPipelineIntentClassificationPrompt,
  parseChatPipelineIntentClassificationText,
  TAGMA_PIPELINE_INTENT_CLASSIFIER_TOOLS,
  type ChatPipelineIntentCandidate,
  type ResolvedChatPipelineIntent,
} from '../../shared/chat-pipeline-intent-classifier.js';
import { createStreamingLoopbackFetch } from '../loopback-fetch.js';
import { ensureOpencode } from '../opencode-lifecycle.js';
import {
  TAGMA_GENERAL_DISCUSSION_AGENT,
  TAGMA_PIPELINE_DIAGNOSIS_AGENT,
  TAGMA_PIPELINE_DIAGNOSIS_EVIDENCE_CONTRACT,
  TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT,
} from '../opencode-seed.js';
import {
  OpenCodeInvocationController,
  sha256CanonicalOpenCodeRequest,
  type OpenCodeHistoryAdmissionRecord,
  type OpenCodeInvocationNativeClient,
  type OpenCodeInvocationFailureCode,
  type OpenCodeInvocationStore,
  type OpenCodePromptResult,
} from './opencode-invocation.js';
import type { ChatOperationV2AdmissionRequest } from './admission.js';
import type {
  ChatOperationV2DurableInvocationRecoveryRequest,
  ChatOperationV2DurableInvocationRecoveryResult,
  ChatOperationV2DurableInvocationRequest,
  ChatOperationV2DurableInvocationResult,
  ChatOperationV2DurableInvocationRunner,
} from './orchestrator.js';
import {
  buildReadonlyTextCanonicalRequestBytes,
  type ChatOperationV2ReadonlyTextPurpose,
} from './readonly-text.js';
import type { ChatReadSnapshot } from './snapshots.js';
import type { ChatOperationV2SubmissionUnknownReason } from './submission-diagnostics.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const NATIVE_REQUEST_DIGEST_PATTERN =
  /^<tagma-chat-operation-v2-native-request request-digest="sha256:([0-9a-f]{64})" \/>$/;
const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const DEFAULT_HISTORY_MAX_PAGES = 64;
const DEFAULT_ADMISSION_SOURCE_ATTEMPTS = 40;
const DEFAULT_ADMISSION_SOURCE_DELAY_MS = 50;
const READONLY_TEXT_RECOVERY_TIMEOUT_MS = 5 * 60_000;
const MAX_READONLY_TEXT_OUTPUT_BYTES = 1024 * 1024;

export { TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT } from '../opencode-seed.js';
export const TAGMA_READONLY_TEXT_TOOLS = Object.freeze({ '*': false });

export interface OpenCodeAdapterSdkResult<T = unknown> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: { readonly status: number };
}

export interface OpenCodeAdapterNativeSessionCreateInput {
  readonly id: string;
  readonly location: { readonly directory: string };
}

export interface OpenCodeAdapterNativePromptInput {
  readonly sessionID: string;
  readonly id: string;
  readonly prompt: { readonly text: string };
  readonly delivery: 'queue';
  readonly resume: false;
}

export interface OpenCodeAdapterNativeHistoryInput {
  readonly sessionID: string;
  readonly after: number;
  readonly limit: number;
}

export interface OpenCodeAdapterClassifierTextPromptInput {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: typeof TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant?: string;
  readonly tools: typeof TAGMA_PIPELINE_INTENT_CLASSIFIER_TOOLS;
  readonly format: { readonly type: 'text' };
  readonly system: string;
  readonly parts: readonly [{ readonly type: 'text'; readonly text: string }];
}

export interface OpenCodeAdapterTextPromptInput {
  readonly sessionID: string;
  readonly messageID: string;
  readonly agent: typeof TAGMA_GENERAL_DISCUSSION_AGENT | typeof TAGMA_PIPELINE_DIAGNOSIS_AGENT;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant?: string;
  readonly tools: typeof TAGMA_READONLY_TEXT_TOOLS;
  readonly format: { readonly type: 'text' };
  readonly system: string;
  readonly parts: readonly [{ readonly type: 'text'; readonly text: string }];
}

/** Narrow SDK surface so tests can inject the pinned lifecycle and both v2 surfaces. */
export interface OpenCodeAdapterSdkClient {
  readonly v2: {
    readonly session: {
      create(input: OpenCodeAdapterNativeSessionCreateInput): Promise<OpenCodeAdapterSdkResult>;
      prompt(input: OpenCodeAdapterNativePromptInput): Promise<OpenCodeAdapterSdkResult>;
      history(input: OpenCodeAdapterNativeHistoryInput): Promise<OpenCodeAdapterSdkResult>;
      interrupt(input: { readonly sessionID: string }): Promise<OpenCodeAdapterSdkResult>;
    };
  };
  readonly session: {
    prompt(
      input: OpenCodeAdapterClassifierTextPromptInput | OpenCodeAdapterTextPromptInput,
      options?: { readonly signal?: AbortSignal },
    ): Promise<OpenCodeAdapterSdkResult>;
  };
}

export interface OpenCodeSdkAdapterOptions {
  readonly workspaceDirectory: string;
  /** Must be lazy: the invocation controller writes its outbox before the first call here. */
  readonly resolveClient: () => Promise<OpenCodeAdapterSdkClient>;
}

export interface OpenCodeClassifierUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMicrounits: number;
  readonly outcome: 'completed' | 'zero_token';
}

export interface OpenCodeIntentClassifierTextResponse {
  readonly messageId: string;
  readonly text: string;
  readonly failureCode: OpenCodePromptProviderFailureCode | null;
  readonly finishCode: string;
  readonly usage: OpenCodeClassifierUsage | null;
}

export interface OpenCodeReadonlyTextResponse {
  readonly messageId: string;
  readonly text: string;
  readonly failureCode: OpenCodePromptProviderFailureCode | null;
  readonly finishCode: string;
  readonly usage: OpenCodeClassifierUsage | null;
}

export interface OpenCodeTextPromptClient {
  promptIntentClassifierText(input: {
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly system: string;
    readonly user: string;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeIntentClassifierTextResponse>;
  promptReadonlyText(input: {
    readonly purpose: 'discussion' | 'diagnosis';
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly system: string;
    readonly user: string;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeReadonlyTextResponse>;
  interruptSession(sessionId: string): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireSuccessfulSdkData(result: OpenCodeAdapterSdkResult): unknown {
  if (
    result.error !== undefined ||
    !Number.isInteger(result.response?.status) ||
    result.response.status < 200 ||
    result.response.status >= 300 ||
    result.data === undefined
  ) {
    throw new Error('OpenCode request failed.');
  }
  return result.data;
}

class OpenCodeDefinitivePromptError extends Error {
  constructor(readonly code: OpenCodePromptProviderFailureCode) {
    super('OpenCode returned a definitive bounded prompt failure.');
    this.name = 'OpenCodeDefinitivePromptError';
  }
}

function sdkErrorSignals(value: unknown, depth = 0): string[] {
  if (depth > 2 || typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const signals: string[] = [];
    for (const key of ['_tag', 'name', 'code', 'type']) {
      const descriptor = descriptors[key];
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        const field = descriptor.value;
        if (typeof field === 'string' && field.length <= 128) signals.push(field.toLowerCase());
      }
    }
    for (const key of ['data', 'detail', 'error', 'cause']) {
      const descriptor = descriptors[key];
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        signals.push(...sdkErrorSignals(descriptor.value, depth + 1));
      }
    }
    return signals;
  } catch {
    return [];
  }
}

function sdkErrorMessages(value: unknown, depth = 0): string[] {
  if (depth > 2 || typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const messages: string[] = [];
    const message = descriptors.message;
    if (
      message &&
      Object.prototype.hasOwnProperty.call(message, 'value') &&
      typeof message.value === 'string' &&
      message.value.length <= 512
    ) {
      messages.push(message.value.toLowerCase());
    }
    for (const key of ['data', 'detail', 'error', 'cause']) {
      const descriptor = descriptors[key];
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        messages.push(...sdkErrorMessages(descriptor.value, depth + 1));
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function sdkErrorStatus(value: unknown, depth = 0): number | null {
  if (depth > 2 || typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of ['statusCode', 'status']) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const field = descriptor.value;
      if (Number.isInteger(field) && (field as number) >= 100 && (field as number) <= 599) {
        return field as number;
      }
    }
    for (const key of ['data', 'detail', 'error', 'cause']) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const nested = sdkErrorStatus(descriptor.value, depth + 1);
      if (nested !== null) return nested;
    }
  } catch {
    return null;
  }
  return null;
}

function sdkErrorRetryable(value: unknown, depth = 0): boolean | null {
  if (depth > 2 || typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const retryable = descriptors.isRetryable;
    if (
      retryable &&
      Object.prototype.hasOwnProperty.call(retryable, 'value') &&
      typeof retryable.value === 'boolean'
    ) {
      return retryable.value;
    }
    for (const key of ['data', 'detail', 'error', 'cause']) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
      const nested = sdkErrorRetryable(descriptor.value, depth + 1);
      if (nested !== null) return nested;
    }
  } catch {
    return null;
  }
  return null;
}

export function openCodeProviderFailureCode(
  error: unknown,
  responseStatus: number | null = null,
): OpenCodePromptProviderFailureCode {
  const identifiers = sdkErrorSignals(error);
  const identifierSignal = identifiers.join(' ');
  const signal = identifiers.includes('apierror')
    ? `${identifierSignal} ${sdkErrorMessages(error).join(' ')}`
    : identifierSignal;
  const status = sdkErrorStatus(error) ?? responseStatus;
  const retryable = sdkErrorRetryable(error);

  if (identifiers.includes('structuredoutputerror')) {
    return 'structured_output_error';
  }
  if (identifiers.includes('providerautherror')) return 'provider_authentication_failed';
  if (identifiers.includes('messageoutputlengtherror')) return 'model_output_length';
  if (identifiers.includes('messageabortederror')) return 'provider_invocation_aborted';
  if (identifiers.includes('contextoverflowerror')) return 'model_context_overflow';
  if (identifiers.includes('contentfiltererror')) return 'provider_content_filtered';
  if (status === 401 || status === 403) return 'provider_authentication_failed';
  if (status === 402) return 'provider_billing_required';
  if (status === 429) return 'provider_rate_limited';
  if (status === 408 || (status !== null && status >= 500)) {
    return 'provider_unavailable';
  }
  if (/structured.?output.?error/.test(signal)) return 'structured_output_error';
  if (/context.?overflow|context.?length|context.?window/.test(signal)) {
    return 'model_context_overflow';
  }
  if (/content.?filter|content.?policy|moderation/.test(signal)) {
    return 'provider_content_filtered';
  }
  if (
    /provider.?model.?not.?found|model.{0,24}(?:not.?found|does.?not.?exist)|unknown.?model|invalid.?model/.test(
      signal,
    )
  ) {
    return 'model_unavailable';
  }
  if (
    /unsupported.?tool|tool.?unsupported|tools.?not.?supported|structured.?output.?unsupported|does.?not.?support.{0,32}(?:tool|structured.?output)/.test(
      signal,
    )
  ) {
    return 'model_incompatible';
  }
  if (/auth|unauthorized|forbidden|credential|api.?key/.test(signal)) {
    return 'provider_authentication_failed';
  }
  if (
    /insufficient.?credit|insufficient.?quota|billing|payment.?required|credit.?balance/.test(
      signal,
    )
  ) {
    return 'provider_billing_required';
  }
  if (/rate.?limit|too.?many.?requests|quota.?exceeded/.test(signal)) {
    return 'provider_rate_limited';
  }
  if (status !== null && status >= 400 && status < 500) return 'provider_request_rejected';
  if (retryable === true) return 'provider_unavailable';
  return 'provider_invocation_failed';
}

function promptSdkFailureCode(
  result: OpenCodeAdapterSdkResult,
): OpenCodePromptProviderFailureCode | null {
  const status = Number.isInteger(result.response?.status) ? result.response.status : null;
  if (
    result.error === undefined &&
    status !== null &&
    status >= 200 &&
    status < 300 &&
    result.data !== undefined
  ) {
    return null;
  }
  return openCodeProviderFailureCode(result.error, status);
}

function nativePromptFailureCode(
  result: OpenCodeAdapterSdkResult,
): OpenCodeInvocationFailureCode | null {
  const status = Number.isInteger(result.response?.status) ? result.response.status : null;
  if (
    result.error === undefined &&
    status !== null &&
    status >= 200 &&
    status < 300 &&
    result.data !== undefined
  ) {
    return null;
  }
  // A missing HTTP status is transport/response ambiguity. Preserve the
  // controller's bounded history reconciliation and exact replay for that
  // case; only classify a response the server actually returned.
  if (status === null) return null;
  // A successful status with malformed or missing data is response ambiguity,
  // not an explicit server rejection. Let the controller reconcile history.
  if (status >= 200 && status < 300) return null;
  if (status === 400) return 'admission_invalid_request';
  if (status === 401 || status === 403) return 'admission_authentication_failed';
  if (status === 404 && sdkErrorSignals(result.error).includes('sessionnotfounderror')) {
    return 'admission_session_missing';
  }
  if (status === 429) return 'admission_rate_limited';
  if (status === 408 || status >= 500) return 'admission_service_unavailable';
  return 'admission_request_rejected';
}

function safeNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function safeUsage(info: Record<string, unknown>): OpenCodeClassifierUsage | null {
  const tokens = record(info.tokens);
  const cache = record(tokens?.cache);
  const inputTokens = safeNonNegativeInteger(tokens?.input);
  const outputTokens = safeNonNegativeInteger(tokens?.output);
  const reasoningTokens = safeNonNegativeInteger(tokens?.reasoning);
  const cacheReadTokens = safeNonNegativeInteger(cache?.read);
  const cacheWriteTokens = safeNonNegativeInteger(cache?.write);
  const cost = info.cost;
  if (
    inputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    return null;
  }
  const costMicrounits = Math.round(cost * 1_000_000);
  if (!Number.isSafeInteger(costMicrounits) || costMicrounits < 0) return null;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costMicrounits,
    outcome:
      inputTokens + outputTokens + reasoningTokens + cacheReadTokens + cacheWriteTokens === 0
        ? 'zero_token'
        : 'completed',
  };
}

function safeFinishCode(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : 'unknown';
}

export function buildNativeRequestDigestMarker(requestDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) {
    throw new TypeError('Native OpenCode request digest must be a lowercase SHA-256 hex string.');
  }
  return `<tagma-chat-operation-v2-native-request request-digest="sha256:${requestDigest}" />`;
}

export function extractNativeRequestDigest(value: string): string | null {
  return NATIVE_REQUEST_DIGEST_PATTERN.exec(value)?.[1] ?? null;
}

function parseHistoryRecord(
  value: unknown,
  expectedSessionId: string,
): OpenCodeHistoryAdmissionRecord {
  const event = record(value);
  const durable = record(event?.durable);
  const data = record(event?.data);
  const prompt = record(data?.prompt);
  const aggregateSeq = durable?.seq;
  const eventId = event?.id;
  const type = event?.type;
  const sessionId = data?.sessionID;
  if (
    typeof eventId !== 'string' ||
    !/^evt_[A-Za-z0-9]{1,240}$/.test(eventId) ||
    typeof type !== 'string' ||
    !Number.isSafeInteger(aggregateSeq) ||
    (aggregateSeq as number) <= 0 ||
    sessionId !== expectedSessionId
  ) {
    throw new Error('OpenCode native history returned malformed durable evidence.');
  }
  const inputId = typeof data?.messageID === 'string' ? data.messageID : '';
  const requestDigest =
    type === 'session.next.prompt.admitted' && typeof prompt?.text === 'string'
      ? (extractNativeRequestDigest(prompt.text) ?? '')
      : '';
  return {
    eventId,
    type,
    sessionId,
    inputId,
    requestDigest,
    aggregateSeq: aggregateSeq as number,
  };
}

/**
 * Maps the pinned v2 native create/prompt/history APIs and the compatibility
 * rich prompt onto one Host-owned session identity. It never delegates execution authority to the renderer.
 */
export class OpenCodeSdkAdapter
  implements OpenCodeInvocationNativeClient, OpenCodeTextPromptClient
{
  private readonly workspaceDirectory: string;
  private readonly resolveClient: () => Promise<OpenCodeAdapterSdkClient>;

  constructor(options: OpenCodeSdkAdapterOptions) {
    if (!isAbsolute(options.workspaceDirectory)) {
      throw new TypeError(
        'OpenCode adapter requires an authenticated absolute workspace directory.',
      );
    }
    this.workspaceDirectory = options.workspaceDirectory;
    this.resolveClient = options.resolveClient;
  }

  async createSession(input: {
    readonly sessionId: string;
  }): Promise<
    { readonly kind: 'created'; readonly sessionId: string } | { readonly kind: 'conflict' }
  > {
    const client = await this.resolveClient();
    const result = await client.v2.session.create({
      id: input.sessionId,
      location: { directory: this.workspaceDirectory },
    });
    if (result.response?.status === 409) return { kind: 'conflict' };
    const envelope = record(requireSuccessfulSdkData(result));
    const session = record(envelope?.data);
    if (session?.id !== input.sessionId) {
      throw new Error('OpenCode native session identity did not match the Host identity.');
    }
    return { kind: 'created', sessionId: input.sessionId };
  }

  async prompt(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly canonicalRequestBytes: Uint8Array;
  }): Promise<OpenCodePromptResult> {
    const requestDigest = sha256CanonicalOpenCodeRequest(input.canonicalRequestBytes);
    const client = await this.resolveClient();
    const result = await client.v2.session.prompt({
      sessionID: input.sessionId,
      id: input.inputId,
      prompt: { text: buildNativeRequestDigestMarker(requestDigest) },
      delivery: 'queue',
      resume: false,
    });
    if (result.response?.status === 409) return { kind: 'conflict' };
    const rejected = nativePromptFailureCode(result);
    if (rejected) return { kind: 'rejected', code: rejected };
    const envelope = record(requireSuccessfulSdkData(result));
    const admitted = record(envelope?.data);
    const aggregateSeq = admitted?.admittedSeq;
    if (
      admitted?.sessionID !== input.sessionId ||
      admitted?.id !== input.inputId ||
      !Number.isSafeInteger(aggregateSeq) ||
      (aggregateSeq as number) <= 0
    ) {
      throw new Error('OpenCode native prompt returned malformed admission evidence.');
    }
    return {
      kind: 'admitted',
      admission: {
        sessionId: input.sessionId,
        inputId: input.inputId,
        requestDigest,
        aggregateSeq: aggregateSeq as number,
      },
    };
  }

  async listHistory(input: {
    readonly sessionId: string;
    readonly after: number;
    readonly limit: number;
  }): Promise<{
    readonly records: readonly OpenCodeHistoryAdmissionRecord[];
    readonly hasMore: boolean;
  }> {
    const client = await this.resolveClient();
    const result = await client.v2.session.history({
      sessionID: input.sessionId,
      after: input.after,
      limit: input.limit,
    });
    if (result.response?.status === 404 && record(result.error)?._tag === 'SessionNotFoundError') {
      return { records: [], hasMore: false };
    }
    const envelope = record(requireSuccessfulSdkData(result));
    if (!envelope || !Array.isArray(envelope.data) || typeof envelope.hasMore !== 'boolean') {
      throw new Error('OpenCode native history returned a malformed finite page.');
    }
    const records = envelope.data.map((event) => parseHistoryRecord(event, input.sessionId));
    let previous = input.after;
    for (const item of records) {
      if (item.aggregateSeq <= previous) {
        throw new Error('OpenCode native history violated its exclusive aggregate cursor.');
      }
      previous = item.aggregateSeq;
    }
    return { records, hasMore: envelope.hasMore };
  }

  async promptIntentClassifierText(input: {
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly system: string;
    readonly user: string;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeIntentClassifierTextResponse> {
    const client = await this.resolveClient();
    const result = await client.session.prompt(
      {
        sessionID: input.sessionId,
        messageID: input.executionMessageId,
        agent: TAGMA_PIPELINE_INTENT_CLASSIFIER_AGENT,
        model: input.model,
        ...(input.variant ? { variant: input.variant } : {}),
        tools: TAGMA_PIPELINE_INTENT_CLASSIFIER_TOOLS,
        format: { type: 'text' },
        system: input.system,
        parts: [{ type: 'text', text: input.user }],
      },
      { signal: input.signal },
    );
    const failureCode = promptSdkFailureCode(result);
    if (failureCode) throw new OpenCodeDefinitivePromptError(failureCode);
    const response = record(requireSuccessfulSdkData(result));
    const info = record(response?.info);
    if (!info || typeof info.parentID !== 'string') {
      throw new Error('OpenCode text classifier returned a malformed response envelope.');
    }
    const providerError = info.error === undefined || info.error === null ? null : info.error;
    if (providerError === null && !Array.isArray(response?.parts)) {
      throw new Error('OpenCode text classifier returned a malformed response envelope.');
    }
    const text = Array.isArray(response?.parts)
      ? response.parts
          .map((value) => record(value))
          .filter(
            (part): part is Record<string, unknown> =>
              part?.type === 'text' && typeof part.text === 'string',
          )
          .map((part) => part.text as string)
          .join('')
      : '';
    return {
      messageId: info.parentID,
      text,
      failureCode: providerError === null ? null : openCodeProviderFailureCode(providerError),
      finishCode: safeFinishCode(info.finish),
      usage: safeUsage(info),
    };
  }

  async promptReadonlyText(input: {
    readonly purpose: 'discussion' | 'diagnosis';
    readonly sessionId: string;
    readonly executionMessageId: string;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly system: string;
    readonly user: string;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeReadonlyTextResponse> {
    const client = await this.resolveClient();
    const result = await client.session.prompt(
      {
        sessionID: input.sessionId,
        messageID: input.executionMessageId,
        agent:
          input.purpose === 'diagnosis'
            ? TAGMA_PIPELINE_DIAGNOSIS_AGENT
            : TAGMA_GENERAL_DISCUSSION_AGENT,
        model: input.model,
        ...(input.variant ? { variant: input.variant } : {}),
        tools: TAGMA_READONLY_TEXT_TOOLS,
        format: { type: 'text' },
        system: input.system,
        parts: [{ type: 'text', text: input.user }],
      },
      { signal: input.signal },
    );
    const sdkFailureCode = promptSdkFailureCode(result);
    if (sdkFailureCode) throw new OpenCodeDefinitivePromptError(sdkFailureCode);
    const response = record(requireSuccessfulSdkData(result));
    const info = record(response?.info);
    if (!info || typeof info.parentID !== 'string') {
      throw new Error('OpenCode read-only text returned a malformed response envelope.');
    }
    const providerError = info.error === undefined || info.error === null ? null : info.error;
    if (providerError === null && !Array.isArray(response?.parts)) {
      throw new Error('OpenCode read-only text returned a malformed response envelope.');
    }
    const text = Array.isArray(response?.parts)
      ? response.parts
          .map((value) => record(value))
          .filter(
            (part): part is Record<string, unknown> =>
              part?.type === 'text' && typeof part.text === 'string',
          )
          .map((part) => part.text as string)
          .join('')
      : '';
    if (
      providerError === null &&
      (!text.trim() || encoder.encode(text).byteLength > MAX_READONLY_TEXT_OUTPUT_BYTES)
    ) {
      throw new Error('OpenCode read-only text returned an invalid bounded text result.');
    }
    return {
      messageId: info.parentID,
      text,
      failureCode: providerError === null ? null : openCodeProviderFailureCode(providerError),
      finishCode: safeFinishCode(info.finish),
      usage: safeUsage(info),
    };
  }

  async interruptSession(sessionId: string): Promise<void> {
    const client = await this.resolveClient();
    const result = await client.v2.session.interrupt({ sessionID: sessionId });
    if (
      result.error !== undefined ||
      !Number.isInteger(result.response?.status) ||
      result.response.status < 200 ||
      result.response.status >= 300
    ) {
      throw new Error('OpenCode native interrupt failed.');
    }
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(',')}}`;
}

export function buildClassifierTextCanonicalRequestBytes(
  userText: string,
  candidates: readonly ChatPipelineIntentCandidate[],
): Uint8Array {
  return encoder.encode(
    canonicalJson({
      purpose: 'classifier',
      prompt: buildChatPipelineIntentClassificationPrompt(userText, candidates),
    }),
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseClassifierTextCanonicalRequestBytes(
  bytes: Uint8Array,
): ReturnType<typeof buildChatPipelineIntentClassificationPrompt> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error('Classifier invocation bytes are not canonical UTF-8 JSON.');
  }
  const envelope = record(value);
  const prompt = record(envelope?.prompt);
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !== 'prompt,purpose' ||
    envelope.purpose !== 'classifier' ||
    !prompt ||
    Object.keys(prompt).sort().join(',') !== 'schema,system,user' ||
    typeof prompt.system !== 'string' ||
    typeof prompt.user !== 'string' ||
    !record(prompt.schema)
  ) {
    throw new Error('Classifier invocation bytes do not contain the shared prompt contract.');
  }
  const canonical = encoder.encode(canonicalJson(envelope));
  if (!sameBytes(bytes, canonical)) {
    throw new Error('Classifier invocation JSON is not canonically encoded.');
  }
  return {
    system: prompt.system,
    user: prompt.user,
    schema: prompt.schema as Record<string, unknown>,
  };
}

export type OpenCodeReadonlyTextPurpose = ChatOperationV2ReadonlyTextPurpose;

export { buildReadonlyTextCanonicalRequestBytes } from './readonly-text.js';

export interface OpenCodeReadonlyTextPrompt {
  readonly purpose: OpenCodeReadonlyTextPurpose;
  readonly system: string;
  readonly user: string;
}

function requireReadonlyAdmissionRequest(value: unknown): ChatOperationV2AdmissionRequest {
  const request = record(value);
  if (
    !request ||
    Object.keys(request).sort().join(',') !== 'attachments,schemaVersion,text' ||
    request.schemaVersion !== 1 ||
    typeof request.text !== 'string' ||
    !Array.isArray(request.attachments)
  ) {
    throw new Error('Read-only invocation contains an invalid sealed request.');
  }
  const attachments = request.attachments.map((value) => {
    const attachment = record(value);
    if (
      !attachment ||
      Object.keys(attachment).sort().join(',') !== 'content,label,referenceId' ||
      typeof attachment.referenceId !== 'string' ||
      typeof attachment.label !== 'string' ||
      typeof attachment.content !== 'string'
    ) {
      throw new Error('Read-only invocation contains an invalid sealed attachment.');
    }
    return {
      referenceId: attachment.referenceId,
      label: attachment.label,
      content: attachment.content,
    };
  });
  return { schemaVersion: 1, text: request.text, attachments };
}

function readonlyProviderSnapshot(snapshot: ChatReadSnapshot): Record<string, unknown> {
  return {
    candidateId: snapshot.candidateId,
    candidateRelativePath: snapshot.candidateRelativePath,
    localRevision: snapshot.localRevision,
    canonicalYaml: snapshot.canonicalYaml,
    layoutJson: snapshot.layoutJson,
    requirementsMarkdown: snapshot.requirementsMarkdown,
    compileDiagnostics: snapshot.compileDiagnostics,
  };
}

export function parseReadonlyTextCanonicalRequestBytes(input: {
  readonly bytes: Uint8Array;
  readonly purpose: OpenCodeReadonlyTextPurpose;
  readonly readSnapshot: ChatReadSnapshot | null;
}): OpenCodeReadonlyTextPrompt {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(input.bytes));
  } catch {
    throw new Error('Read-only invocation bytes are not canonical UTF-8 JSON.');
  }
  const envelope = record(value);
  const access = record(envelope?.access);
  if (
    !envelope ||
    Object.keys(envelope).sort().join(',') !== 'access,purpose,request' ||
    envelope.purpose !== input.purpose ||
    !access ||
    !sameBytes(input.bytes, encoder.encode(canonicalJson(envelope)))
  ) {
    throw new Error('Read-only invocation bytes do not match their Host purpose.');
  }
  const request = requireReadonlyAdmissionRequest(envelope.request);
  let snapshot: ChatReadSnapshot | null = null;
  if (input.purpose === 'discussion') {
    if (input.readSnapshot !== null) {
      throw new Error('Discussion invocation cannot carry snapshot authority.');
    }
  } else {
    snapshot = input.readSnapshot;
  }
  if (
    !sameBytes(
      input.bytes,
      buildReadonlyTextCanonicalRequestBytes({
        purpose: input.purpose,
        request,
        readSnapshot: snapshot,
      }),
    )
  ) {
    throw new Error('Read-only invocation does not match its Host authority.');
  }
  const system =
    input.purpose === 'diagnosis'
      ? snapshot
        ? [
            'Answer this Tagma diagnosis using only the sealed Host snapshot in the request.',
            'Do not use tools, inspect live files, or claim access to workspace state outside that snapshot.',
            'Explain evidence, uncertainty, and safe next steps without modifying anything.',
            TAGMA_PIPELINE_DIAGNOSIS_EVIDENCE_CONTRACT,
          ].join(' ')
        : [
            'Answer this Tagma diagnosis using only the Host-authenticated request.',
            'No sealed pipeline snapshot is available; do not claim that pipeline or workspace artifacts were inspected.',
            'Do not use tools or modify anything. Explain the evidence limit, uncertainty, and safe next steps.',
            TAGMA_PIPELINE_DIAGNOSIS_EVIDENCE_CONTRACT,
          ].join(' ')
      : [
          'Answer this Tagma read-only discussion using only the Host-authenticated request.',
          'Do not use tools, inspect files, or claim that pipeline or workspace state was modified.',
        ].join(' ');
  const providerContext = {
    schemaVersion: 1,
    purpose: input.purpose,
    request,
    ...(snapshot ? { sealedSnapshot: readonlyProviderSnapshot(snapshot) } : {}),
  };
  return {
    purpose: input.purpose,
    system,
    user: [
      `<tagma-readonly-request purpose="${input.purpose}" schema="1">`,
      canonicalJson(providerContext),
      '</tagma-readonly-request>',
    ].join('\n'),
  };
}

function classifierValidationCandidates(
  schema: Record<string, unknown>,
): readonly ChatPipelineIntentCandidate[] {
  const properties = record(schema.properties);
  const candidateIdsProperty = record(properties?.candidateIds);
  const items = record(candidateIdsProperty?.items);
  const rawIds = Array.isArray(items?.enum) ? items.enum : [];
  const ids = rawIds.filter(
    (value): value is string =>
      typeof value === 'string' && value.length > 0 && value.length <= 256,
  );
  if (ids.length !== rawIds.length || new Set(ids).size !== ids.length) {
    throw new Error('Classifier schema contains invalid Host candidate ids.');
  }
  return ids.map((id) => ({
    id,
    path: '',
    pipelineName: null,
    currentCanvas: false,
    sessionOwned: false,
    manualNewDraft: false,
  }));
}

function safeClassifierDecision(intent: ResolvedChatPipelineIntent): Record<string, unknown> {
  switch (intent.kind) {
    case 'discussion':
      return {
        kind: 'discussion',
        targetCandidateId: null,
        clarification: null,
        candidateIds: [],
      };
    case 'diagnosis':
      return {
        kind: 'diagnosis',
        targetCandidateId: intent.target?.id ?? null,
        clarification: null,
        candidateIds: [],
      };
    case 'create':
      return {
        kind: 'create',
        targetCandidateId: null,
        clarification: null,
        candidateIds: [],
      };
    case 'edit':
      return {
        kind: 'edit',
        targetCandidateId: intent.target.id,
        clarification: null,
        candidateIds: [],
      };
    case 'clarify':
      return {
        kind: 'clarify',
        targetCandidateId: null,
        clarification: intent.question,
        candidateIds: intent.candidates.map(({ id }) => id),
      };
  }
}

export interface OpenCodeTextClassifierRunRequest {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly canonicalRequestBytes: Uint8Array;
  readonly userText: string;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant: string | null;
  readonly signal: AbortSignal;
}

export type OpenCodePromptProviderFailureCode =
  | OpenCodeInvocationFailureCode
  | 'submitted_unknown'
  | 'request_digest_conflict'
  | 'session_identity_conflict'
  | 'admission_evidence_conflict'
  | 'history_protocol_conflict'
  | 'execution_identity_conflict'
  | 'execution_history_unavailable'
  | 'structured_output_error'
  | 'model_error'
  | 'model_context_overflow'
  | 'model_incompatible'
  | 'model_output_length'
  | 'model_unavailable'
  | 'provider_authentication_failed'
  | 'provider_billing_required'
  | 'provider_content_filtered'
  | 'provider_invocation_aborted'
  | 'provider_rate_limited'
  | 'provider_request_rejected'
  | 'provider_unavailable'
  | 'provider_invocation_failed'
  | 'malformed_structured_result'
  | 'malformed_text_result'
  | 'readonly_replay_not_authorized';

interface OpenCodeClassifierCompletedResult {
  readonly kind: 'completed';
  readonly structuredOutput: unknown;
  readonly finishCode: string;
  readonly admittedAggregateSeq: number;
  readonly source: { readonly aggregateSeq: number; readonly eventId: string };
  readonly usage: OpenCodeClassifierUsage | null;
  readonly executionMessageId: string;
}

type OpenCodeClassifierUnavailableResult = {
  readonly kind: 'provider_unavailable';
  readonly code: OpenCodePromptProviderFailureCode;
  readonly submissionUnknown?: true;
  readonly submissionUnknownReason?: ChatOperationV2SubmissionUnknownReason;
};

type OpenCodeClassifierCancelledResult = { readonly kind: 'cancelled'; readonly code: 'aborted' };

export type OpenCodeTextClassifierResult =
  | (OpenCodeClassifierCompletedResult & { readonly intent: ResolvedChatPipelineIntent })
  | OpenCodeClassifierUnavailableResult
  | OpenCodeClassifierCancelledResult;

type OpenCodeClassifierCoreResult =
  | (OpenCodeClassifierCompletedResult & {
      readonly intent: ResolvedChatPipelineIntent | null;
      readonly safeDecision: Record<string, unknown>;
    })
  | OpenCodeClassifierUnavailableResult
  | OpenCodeClassifierCancelledResult;

type OpenCodeReadonlyTextResult =
  | OpenCodeClassifierCompletedResult
  | OpenCodeClassifierUnavailableResult
  | OpenCodeClassifierCancelledResult;

export function deriveOpenCodeExecutionMessageId(input: {
  readonly operationId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: 'classifier' | OpenCodeReadonlyTextPurpose;
}): string {
  const digest = sha256CanonicalOpenCodeRequest(
    encoder.encode(
      canonicalJson({
        operationId: input.operationId,
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: input.purpose,
      }),
    ),
  );
  return `msg_tagma_exec_${digest.slice(0, 40)}`;
}

export interface OpenCodeReadonlyInvocationRunnerOptions {
  readonly controller: OpenCodeInvocationController;
  readonly store?: OpenCodeInvocationStore;
  readonly nativeClient: OpenCodeInvocationNativeClient;
  readonly textPromptClient: OpenCodeTextPromptClient;
  readonly nextExecutionMessageId?: (input: {
    readonly operationId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: 'classifier' | OpenCodeReadonlyTextPurpose;
  }) => string;
  readonly historyPageLimit?: number;
  readonly historyMaxPages?: number;
  readonly admissionSourceAttempts?: number;
  readonly admissionSourceDelayMs?: number;
}

interface FrozenClassifierRun {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestBytes: Uint8Array;
  readonly requestDigest: string;
  readonly prompt: ReturnType<typeof buildChatPipelineIntentClassificationPrompt>;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  readonly candidateAuthority: boolean;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant: string | null;
  readonly signal: AbortSignal;
}

interface OwnedClassifierRun {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestDigest: string;
  readonly candidateAuthority: boolean;
  readonly result: Promise<OpenCodeClassifierCoreResult>;
}

interface FrozenReadonlyTextRun {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: OpenCodeReadonlyTextPurpose;
  readonly requestBytes: Uint8Array;
  readonly requestDigest: string;
  readonly prompt: OpenCodeReadonlyTextPrompt;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly variant: string | null;
  readonly signal: AbortSignal;
}

interface OwnedReadonlyTextRun {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: OpenCodeReadonlyTextPurpose;
  readonly requestDigest: string;
  readonly result: Promise<OpenCodeReadonlyTextResult>;
}

interface TextReplayAuthority {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: 'classifier' | OpenCodeReadonlyTextPurpose;
  readonly requestDigest: string;
}

type AdmissionSourceLookup =
  | {
      readonly kind: 'found';
      readonly source: { readonly aggregateSeq: number; readonly eventId: string };
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict' };

/** Runs tool-free text classification behind the same durable outbox boundary. */
export class OpenCodeReadonlyInvocationRunner {
  private readonly controller: OpenCodeInvocationController;
  private readonly store: OpenCodeInvocationStore | null;
  private readonly nativeClient: OpenCodeInvocationNativeClient;
  private readonly textPromptClient: OpenCodeTextPromptClient;
  private readonly nextExecutionMessageId: NonNullable<
    OpenCodeReadonlyInvocationRunnerOptions['nextExecutionMessageId']
  >;
  private readonly historyPageLimit: number;
  private readonly historyMaxPages: number;
  private readonly admissionSourceAttempts: number;
  private readonly admissionSourceDelayMs: number;
  private readonly ownedRuns = new Map<string, OwnedClassifierRun>();
  private readonly ownedReadonlyRuns = new Map<string, OwnedReadonlyTextRun>();
  private readonly activeSessions = new Map<string, string>();

  constructor(options: OpenCodeReadonlyInvocationRunnerOptions) {
    this.controller = options.controller;
    this.store = options.store ?? null;
    this.nativeClient = options.nativeClient;
    this.textPromptClient = options.textPromptClient;
    this.nextExecutionMessageId =
      options.nextExecutionMessageId ?? deriveOpenCodeExecutionMessageId;
    this.historyPageLimit = options.historyPageLimit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    this.historyMaxPages = options.historyMaxPages ?? DEFAULT_HISTORY_MAX_PAGES;
    this.admissionSourceAttempts =
      options.admissionSourceAttempts ?? DEFAULT_ADMISSION_SOURCE_ATTEMPTS;
    this.admissionSourceDelayMs =
      options.admissionSourceDelayMs ?? DEFAULT_ADMISSION_SOURCE_DELAY_MS;
    if (
      !Number.isSafeInteger(this.historyPageLimit) ||
      this.historyPageLimit < 1 ||
      this.historyPageLimit > 1_000 ||
      !Number.isSafeInteger(this.historyMaxPages) ||
      this.historyMaxPages < 1 ||
      this.historyMaxPages > 1_000 ||
      !Number.isSafeInteger(this.admissionSourceAttempts) ||
      this.admissionSourceAttempts < 1 ||
      this.admissionSourceAttempts > 1_000 ||
      !Number.isSafeInteger(this.admissionSourceDelayMs) ||
      this.admissionSourceDelayMs < 0 ||
      this.admissionSourceDelayMs > 1_000
    ) {
      throw new TypeError('OpenCode read-only history bounds and retry policy are invalid.');
    }
  }

  run(input: OpenCodeTextClassifierRunRequest): Promise<OpenCodeTextClassifierResult> {
    const candidates = input.candidates.map((candidate) => Object.freeze({ ...candidate }));
    const prompt = buildChatPipelineIntentClassificationPrompt(input.userText, candidates);
    const expectedRequestBytes = buildClassifierTextCanonicalRequestBytes(
      input.userText,
      candidates,
    );
    const suppliedRequestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const expectedDigest = sha256CanonicalOpenCodeRequest(expectedRequestBytes);
    if (sha256CanonicalOpenCodeRequest(suppliedRequestBytes) !== expectedDigest) {
      return Promise.resolve({
        kind: 'provider_unavailable',
        code: 'request_digest_conflict',
      });
    }
    const frozen: FrozenClassifierRun = {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestBytes: expectedRequestBytes,
      requestDigest: expectedDigest,
      prompt,
      candidates,
      candidateAuthority: true,
      model: Object.freeze({ ...input.model }),
      variant: input.variant,
      signal: input.signal,
    };
    return this.start(frozen).then((result): OpenCodeTextClassifierResult => {
      if (result.kind !== 'completed') return result;
      if (!result.intent) {
        return { kind: 'provider_unavailable', code: 'malformed_structured_result' };
      }
      const { safeDecision, ...completed } = result;
      return {
        ...completed,
        structuredOutput: safeDecision,
        intent: result.intent,
      };
    });
  }

  runCanonicalClassifier(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly canonicalRequestBytes: Uint8Array;
    readonly prompt: ReturnType<typeof buildChatPipelineIntentClassificationPrompt>;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeClassifierCoreResult> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    return this.start({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestBytes,
      requestDigest: sha256CanonicalOpenCodeRequest(requestBytes),
      prompt: Object.freeze({
        system: input.prompt.system,
        user: input.prompt.user,
        schema: Object.freeze({ ...input.prompt.schema }),
      }),
      candidates: classifierValidationCandidates(input.prompt.schema),
      candidateAuthority: false,
      model: Object.freeze({ ...input.model }),
      variant: input.variant,
      signal: input.signal,
    });
  }

  runCanonicalReadonlyText(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: OpenCodeReadonlyTextPurpose;
    readonly canonicalRequestBytes: Uint8Array;
    readonly prompt: OpenCodeReadonlyTextPrompt;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
    readonly signal: AbortSignal;
  }): Promise<OpenCodeReadonlyTextResult> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const frozen: FrozenReadonlyTextRun = {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: input.purpose,
      requestBytes,
      requestDigest: sha256CanonicalOpenCodeRequest(requestBytes),
      prompt: Object.freeze({ ...input.prompt }),
      model: Object.freeze({ ...input.model }),
      variant: input.variant,
      signal: input.signal,
    };
    const existing = this.ownedReadonlyRuns.get(input.invocationId);
    if (existing) {
      if (
        existing.operationId !== input.operationId ||
        existing.workspaceScopeId !== input.workspaceScopeId ||
        existing.sessionId !== input.sessionId ||
        existing.inputId !== input.inputId ||
        existing.purpose !== input.purpose ||
        existing.requestDigest !== frozen.requestDigest
      ) {
        return Promise.resolve({
          kind: 'provider_unavailable',
          code: 'request_digest_conflict',
        });
      }
      return existing.result;
    }
    const result = this.executeReadonlyText(frozen).catch((): OpenCodeReadonlyTextResult => ({
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'readonly_dispatch_exception',
    }));
    this.ownedReadonlyRuns.set(input.invocationId, {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: input.purpose,
      requestDigest: frozen.requestDigest,
      result,
    });
    return result;
  }

  private start(input: FrozenClassifierRun): Promise<OpenCodeClassifierCoreResult> {
    const existing = this.ownedRuns.get(input.invocationId);
    if (existing) {
      if (
        existing.operationId !== input.operationId ||
        existing.workspaceScopeId !== input.workspaceScopeId ||
        existing.sessionId !== input.sessionId ||
        existing.inputId !== input.inputId ||
        existing.requestDigest !== input.requestDigest ||
        existing.candidateAuthority !== input.candidateAuthority
      ) {
        return Promise.resolve({
          kind: 'provider_unavailable',
          code: 'request_digest_conflict',
        });
      }
      return existing.result;
    }
    const result = this.execute(input).catch((): OpenCodeClassifierCoreResult => ({
      kind: 'provider_unavailable',
      code: 'provider_invocation_failed',
    }));
    this.ownedRuns.set(input.invocationId, {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestDigest: input.requestDigest,
      candidateAuthority: input.candidateAuthority,
      result,
    });
    return result;
  }

  async interrupt(input: {
    readonly operationId: string;
    readonly invocationId: string;
  }): Promise<void> {
    const sessionId = this.activeSessions.get(`${input.operationId}\u0000${input.invocationId}`);
    if (!sessionId) return;
    await this.textPromptClient.interruptSession(sessionId).catch(() => undefined);
  }

  /**
   * Recover a classifier text result through OpenCode's exact same-message-id
   * cache. Canonical bytes, durable admission, and the running boundary are
   * authenticated before the compatibility prompt is replayed.
   */
  async reconcileCanonicalClassifier(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly canonicalRequestBytes: Uint8Array;
    readonly prompt: ReturnType<typeof buildChatPipelineIntentClassificationPrompt>;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
  }): Promise<OpenCodeClassifierCoreResult> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const frozen: FrozenClassifierRun = {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestBytes,
      requestDigest: sha256CanonicalOpenCodeRequest(requestBytes),
      prompt: Object.freeze({
        system: input.prompt.system,
        user: input.prompt.user,
        schema: Object.freeze({ ...input.prompt.schema }),
      }),
      candidates: classifierValidationCandidates(input.prompt.schema),
      candidateAuthority: false,
      model: Object.freeze({ ...input.model }),
      variant: input.variant,
      signal: AbortSignal.timeout(READONLY_TEXT_RECOVERY_TIMEOUT_MS),
    };
    const replayAuthority: TextReplayAuthority = {
      operationId: frozen.operationId,
      workspaceScopeId: frozen.workspaceScopeId,
      invocationId: frozen.invocationId,
      sessionId: frozen.sessionId,
      inputId: frozen.inputId,
      purpose: 'classifier',
      requestDigest: frozen.requestDigest,
    };
    if (!this.exactTextOutbox(replayAuthority)) {
      return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
    }
    const source = await this.reconcileNativeAdmission({
      operationId: frozen.operationId,
      workspaceScopeId: frozen.workspaceScopeId,
      invocationId: frozen.invocationId,
      sessionId: frozen.sessionId,
      inputId: frozen.inputId,
      purpose: 'classifier',
      canonicalRequestBytes: requestBytes,
    }).catch(() => null);
    if (!source) {
      return {
        kind: 'provider_unavailable',
        code: 'submitted_unknown',
        submissionUnknown: true,
        submissionUnknownReason: 'admission_source_unavailable',
      };
    }
    if (!this.markTextRunning(replayAuthority, source.aggregateSeq)) {
      return { kind: 'provider_unavailable', code: 'readonly_replay_not_authorized' };
    }
    const executionMessageId = this.textExecutionMessageId(replayAuthority);
    if (!executionMessageId) {
      return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
    }
    const activeKey = `${frozen.operationId}\u0000${frozen.invocationId}`;
    this.activeSessions.set(activeKey, frozen.sessionId);
    try {
      const result = await this.promptClassifierTextResult(
        frozen,
        replayAuthority,
        source,
        executionMessageId,
        false,
      );
      return result.kind === 'cancelled'
        ? {
            kind: 'provider_unavailable',
            code: 'submitted_unknown',
            submissionUnknown: true,
            submissionUnknownReason: 'text_execution_cancelled_after_admission',
          }
        : result;
    } finally {
      this.activeSessions.delete(activeKey);
    }
  }

  /**
   * Pinned 1.18.18 can replay an ordinary text message id from its private
   * cache. The exact durable outbox digest and running boundary authorize it.
   */
  async reconcileCanonicalReadonlyText(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: OpenCodeReadonlyTextPurpose;
    readonly canonicalRequestBytes: Uint8Array;
    readonly prompt: OpenCodeReadonlyTextPrompt;
    readonly model: { readonly providerID: string; readonly modelID: string };
    readonly variant: string | null;
  }): Promise<OpenCodeReadonlyTextResult> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const frozen: FrozenReadonlyTextRun = {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: input.purpose,
      requestBytes,
      requestDigest: sha256CanonicalOpenCodeRequest(requestBytes),
      prompt: Object.freeze({ ...input.prompt }),
      model: Object.freeze({ ...input.model }),
      variant: input.variant,
      signal: AbortSignal.timeout(READONLY_TEXT_RECOVERY_TIMEOUT_MS),
    };
    if (!this.exactTextOutbox(frozen)) {
      return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
    }
    const source = await this.reconcileNativeAdmission({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: input.purpose,
      canonicalRequestBytes: requestBytes,
    }).catch(() => null);
    if (!source) {
      return {
        kind: 'provider_unavailable',
        code: 'submitted_unknown',
        submissionUnknown: true,
        submissionUnknownReason: 'admission_source_unavailable',
      };
    }
    if (!this.markTextRunning(frozen, source.aggregateSeq)) {
      return { kind: 'provider_unavailable', code: 'readonly_replay_not_authorized' };
    }
    const executionMessageId = this.textExecutionMessageId(frozen);
    if (!executionMessageId) {
      return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
    }
    const activeKey = `${input.operationId}\u0000${input.invocationId}`;
    this.activeSessions.set(activeKey, input.sessionId);
    try {
      const result = await this.promptReadonlyTextResult(frozen, source, executionMessageId, false);
      return result.kind === 'cancelled'
        ? {
            kind: 'provider_unavailable',
            code: 'submitted_unknown',
            submissionUnknown: true,
            submissionUnknownReason: 'text_execution_cancelled_after_admission',
          }
        : result;
    } finally {
      this.activeSessions.delete(activeKey);
    }
  }

  async reconcileNativeAdmission(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly inputId: string;
    readonly purpose: 'classifier' | OpenCodeReadonlyTextPurpose;
    readonly canonicalRequestBytes: Uint8Array;
  }): Promise<{ readonly aggregateSeq: number; readonly eventId: string } | null> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    const admitted = await this.resolveAdmissionSourceByIdentity({
      sessionId: input.sessionId,
      inputId: input.inputId,
      requestDigest,
    }).catch(() => null);
    if (!admitted) return null;
    if (!this.store) return admitted;
    const outbox = this.store.getInvocationOutbox(input.invocationId);
    if (!outbox) return admitted;
    if (
      outbox.operationId !== input.operationId ||
      outbox.workspaceScopeId !== input.workspaceScopeId ||
      outbox.purpose !== input.purpose ||
      outbox.sessionId !== input.sessionId ||
      outbox.inputId !== input.inputId ||
      outbox.requestDigest !== requestDigest
    ) {
      return null;
    }
    if (outbox.admittedAggregateSeq !== null) {
      return outbox.admittedAggregateSeq === admitted.aggregateSeq ? admitted : null;
    }
    if (outbox.status !== 'prepared' && outbox.status !== 'submitted_unknown') return null;
    const updated = this.store.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: outbox.status,
      status: 'admitted',
      admittedAggregateSeq: admitted.aggregateSeq,
    });
    return updated.outbox.admittedAggregateSeq === admitted.aggregateSeq ? admitted : null;
  }

  private async execute(input: FrozenClassifierRun): Promise<OpenCodeClassifierCoreResult> {
    if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
    const activeKey = `${input.operationId}\u0000${input.invocationId}`;
    this.activeSessions.set(activeKey, input.sessionId);
    try {
      const admission = await this.controller.invoke({
        operationId: input.operationId,
        invocationId: input.invocationId,
        purpose: 'classifier',
        sessionId: input.sessionId,
        inputId: input.inputId,
        submissionMode: 'fresh',
        canonicalRequestBytes: input.requestBytes,
      });
      if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
      if (admission.kind === 'conflict') {
        return { kind: 'provider_unavailable', code: admission.code };
      }
      if (admission.kind === 'failed') {
        return { kind: 'provider_unavailable', code: admission.code };
      }
      if (admission.kind === 'request_required') {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      if (admission.kind === 'submitted_unknown') {
        return {
          kind: 'provider_unavailable',
          code: 'submitted_unknown',
          submissionUnknown: true,
          submissionUnknownReason: admission.reasonCode,
        };
      }
      let source: { readonly aggregateSeq: number; readonly eventId: string } | null;
      try {
        source = await this.resolveAdmissionSource(
          {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest: input.requestDigest,
            aggregateSeq: admission.admittedAggregateSeq,
          },
          input.signal,
        );
      } catch {
        return { kind: 'provider_unavailable', code: 'history_protocol_conflict' };
      }
      if (!source) {
        return { kind: 'provider_unavailable', code: 'execution_history_unavailable' };
      }
      if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
      const replayAuthority: TextReplayAuthority = {
        operationId: input.operationId,
        workspaceScopeId: input.workspaceScopeId,
        invocationId: input.invocationId,
        sessionId: input.sessionId,
        inputId: input.inputId,
        purpose: 'classifier',
        requestDigest: input.requestDigest,
      };
      const authorized = this.markTextRunning(replayAuthority, source.aggregateSeq);
      if (!authorized) {
        return {
          kind: 'provider_unavailable',
          code: admission.recoveredFromHistory
            ? 'readonly_replay_not_authorized'
            : 'request_digest_conflict',
        };
      }
      const executionMessageId = this.textExecutionMessageId(replayAuthority);
      if (!executionMessageId) {
        return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
      }
      return this.promptClassifierTextResult(
        input,
        replayAuthority,
        source,
        executionMessageId,
        !admission.recoveredFromHistory,
      );
    } finally {
      this.activeSessions.delete(activeKey);
    }
  }

  private async promptClassifierTextResult(
    input: FrozenClassifierRun,
    replayAuthority: TextReplayAuthority,
    source: { readonly aggregateSeq: number; readonly eventId: string },
    executionMessageId: string,
    allowOneTransportReplay: boolean,
  ): Promise<OpenCodeClassifierCoreResult> {
    const attempts = allowOneTransportReplay ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
      if (attempt > 0 && !this.hasTextReplayAuthority(replayAuthority, source.aggregateSeq)) {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      let response: OpenCodeIntentClassifierTextResponse;
      try {
        response = await this.textPromptClient.promptIntentClassifierText({
          sessionId: input.sessionId,
          executionMessageId,
          model: input.model,
          variant: input.variant,
          system: input.prompt.system,
          user: input.prompt.user,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
        if (error instanceof OpenCodeDefinitivePromptError) {
          return { kind: 'provider_unavailable', code: error.code };
        }
        if (attempt + 1 < attempts) continue;
        return {
          kind: 'provider_unavailable',
          code: 'submitted_unknown',
          submissionUnknown: true,
          submissionUnknownReason: 'text_execution_response_unknown',
        };
      }
      if (response.messageId !== executionMessageId) {
        return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
      }
      if (response.failureCode !== null) {
        return { kind: 'provider_unavailable', code: response.failureCode };
      }
      let intent: ResolvedChatPipelineIntent;
      try {
        intent = parseChatPipelineIntentClassificationText(response.text, input.candidates);
      } catch {
        return { kind: 'provider_unavailable', code: 'malformed_text_result' };
      }
      const safeDecision = safeClassifierDecision(intent);
      return {
        kind: 'completed',
        intent,
        structuredOutput: safeDecision,
        safeDecision,
        finishCode: response.finishCode,
        admittedAggregateSeq: source.aggregateSeq,
        source,
        usage: response.usage,
        executionMessageId,
      };
    }
    return {
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'text_execution_response_unknown',
    };
  }

  private exactTextOutbox(
    input: TextReplayAuthority,
  ): NonNullable<ReturnType<OpenCodeInvocationStore['getInvocationOutbox']>> | null {
    const outbox = this.store?.getInvocationOutbox(input.invocationId) ?? null;
    return outbox &&
      outbox.operationId === input.operationId &&
      outbox.workspaceScopeId === input.workspaceScopeId &&
      outbox.purpose === input.purpose &&
      outbox.sessionId === input.sessionId &&
      outbox.inputId === input.inputId &&
      outbox.requestDigest === input.requestDigest
      ? outbox
      : null;
  }

  private markTextRunning(input: TextReplayAuthority, aggregateSeq: number): boolean {
    const outbox = this.exactTextOutbox(input);
    if (!outbox || outbox.admittedAggregateSeq !== aggregateSeq) return false;
    if (outbox.status === 'running') return true;
    if (outbox.status !== 'admitted' || !this.store) return false;
    const updated = this.store.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: 'admitted',
      status: 'running',
      admittedAggregateSeq: aggregateSeq,
    });
    return (
      updated.outbox.status === 'running' && updated.outbox.admittedAggregateSeq === aggregateSeq
    );
  }

  private hasTextReplayAuthority(input: TextReplayAuthority, aggregateSeq: number): boolean {
    const outbox = this.exactTextOutbox(input);
    return outbox?.status === 'running' && outbox.admittedAggregateSeq === aggregateSeq;
  }

  private textExecutionMessageId(input: TextReplayAuthority): string | null {
    const executionMessageId = this.nextExecutionMessageId({
      operationId: input.operationId,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      purpose: input.purpose,
    });
    return executionMessageId !== input.inputId &&
      /^msg_[A-Za-z0-9_-]{1,240}$/.test(executionMessageId)
      ? executionMessageId
      : null;
  }

  private async promptReadonlyTextResult(
    input: FrozenReadonlyTextRun,
    source: { readonly aggregateSeq: number; readonly eventId: string },
    executionMessageId: string,
    allowOneTransportReplay: boolean,
  ): Promise<OpenCodeReadonlyTextResult> {
    const attempts = allowOneTransportReplay ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
      if (attempt > 0 && !this.hasTextReplayAuthority(input, source.aggregateSeq)) {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      let response: OpenCodeReadonlyTextResponse;
      try {
        response = await this.textPromptClient.promptReadonlyText({
          purpose: input.purpose,
          sessionId: input.sessionId,
          executionMessageId,
          model: input.model,
          variant: input.variant,
          system: input.prompt.system,
          user: input.prompt.user,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
        if (error instanceof OpenCodeDefinitivePromptError) {
          return { kind: 'provider_unavailable', code: error.code };
        }
        if (attempt + 1 < attempts) continue;
        return {
          kind: 'provider_unavailable',
          code: 'submitted_unknown',
          submissionUnknown: true,
          submissionUnknownReason: 'text_execution_response_unknown',
        };
      }
      if (response.messageId !== executionMessageId) {
        return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
      }
      if (response.failureCode !== null) {
        return { kind: 'provider_unavailable', code: response.failureCode };
      }
      if (!response.text.trim()) {
        return { kind: 'provider_unavailable', code: 'malformed_text_result' };
      }
      return {
        kind: 'completed',
        structuredOutput: response.text,
        finishCode: response.finishCode,
        admittedAggregateSeq: source.aggregateSeq,
        source,
        usage: response.usage,
        executionMessageId,
      };
    }
    return {
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
      submissionUnknownReason: 'text_execution_response_unknown',
    };
  }

  private async executeReadonlyText(
    input: FrozenReadonlyTextRun,
  ): Promise<OpenCodeReadonlyTextResult> {
    if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
    const activeKey = `${input.operationId}\u0000${input.invocationId}`;
    this.activeSessions.set(activeKey, input.sessionId);
    try {
      const admission = await this.controller.invoke({
        operationId: input.operationId,
        invocationId: input.invocationId,
        purpose: input.purpose,
        sessionId: input.sessionId,
        inputId: input.inputId,
        submissionMode: 'fresh',
        canonicalRequestBytes: input.requestBytes,
      });
      if (input.signal.aborted) return { kind: 'cancelled', code: 'aborted' };
      if (admission.kind === 'conflict') {
        return { kind: 'provider_unavailable', code: admission.code };
      }
      if (admission.kind === 'failed') {
        return { kind: 'provider_unavailable', code: admission.code };
      }
      if (admission.kind === 'request_required') {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      if (admission.kind === 'submitted_unknown') {
        return {
          kind: 'provider_unavailable',
          code: 'submitted_unknown',
          submissionUnknown: true,
          submissionUnknownReason: admission.reasonCode,
        };
      }
      let source: { readonly aggregateSeq: number; readonly eventId: string } | null;
      try {
        source = await this.resolveAdmissionSource(
          {
            sessionId: input.sessionId,
            inputId: input.inputId,
            requestDigest: input.requestDigest,
            aggregateSeq: admission.admittedAggregateSeq,
          },
          input.signal,
        );
      } catch {
        return { kind: 'provider_unavailable', code: 'history_protocol_conflict' };
      }
      if (!source) {
        return {
          kind: 'provider_unavailable',
          code: 'execution_history_unavailable',
        };
      }
      const authorized = this.markTextRunning(input, source.aggregateSeq);
      if (!authorized) {
        return {
          kind: 'provider_unavailable',
          code: admission.recoveredFromHistory
            ? 'readonly_replay_not_authorized'
            : 'request_digest_conflict',
        };
      }
      const executionMessageId = this.textExecutionMessageId(input);
      if (!executionMessageId) {
        return { kind: 'provider_unavailable', code: 'execution_identity_conflict' };
      }
      return this.promptReadonlyTextResult(
        input,
        source,
        executionMessageId,
        !admission.recoveredFromHistory,
      );
    } finally {
      this.activeSessions.delete(activeKey);
    }
  }

  private async resolveAdmissionSource(
    input: {
      readonly sessionId: string;
      readonly inputId: string;
      readonly requestDigest: string;
      readonly aggregateSeq: number;
    },
    signal: AbortSignal,
  ): Promise<{ readonly aggregateSeq: number; readonly eventId: string } | null> {
    for (let attempt = 0; attempt < this.admissionSourceAttempts; attempt += 1) {
      const lookup = await this.readAdmissionSource(input);
      if (lookup.kind === 'found') return lookup.source;
      if (lookup.kind === 'conflict') {
        throw new Error('OpenCode admission history conflicts with Host evidence.');
      }
      if (attempt + 1 >= this.admissionSourceAttempts || signal.aborted) return null;
      try {
        await delay(this.admissionSourceDelayMs, undefined, { signal });
      } catch {
        return null;
      }
    }
    return null;
  }

  private async readAdmissionSource(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestDigest: string;
    readonly aggregateSeq: number;
  }): Promise<AdmissionSourceLookup> {
    let after = Math.max(0, input.aggregateSeq - 1);
    for (let pageIndex = 0; pageIndex < this.historyMaxPages; pageIndex += 1) {
      const page = await this.nativeClient.listHistory({
        sessionId: input.sessionId,
        after,
        limit: this.historyPageLimit,
      });
      let nextAfter = after;
      for (const item of page.records) {
        if (item.aggregateSeq <= after) return { kind: 'conflict' };
        nextAfter = item.aggregateSeq;
        if (item.aggregateSeq < input.aggregateSeq) continue;
        if (item.aggregateSeq > input.aggregateSeq) return { kind: 'conflict' };
        return item.type === 'session.next.prompt.admitted' &&
          item.sessionId === input.sessionId &&
          item.inputId === input.inputId &&
          item.requestDigest === input.requestDigest
          ? {
              kind: 'found',
              source: { aggregateSeq: item.aggregateSeq, eventId: item.eventId },
            }
          : { kind: 'conflict' };
      }
      if (!page.hasMore || nextAfter === after) return { kind: 'missing' };
      after = nextAfter;
    }
    return { kind: 'conflict' };
  }

  private async resolveAdmissionSourceByIdentity(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestDigest: string;
  }): Promise<{ readonly aggregateSeq: number; readonly eventId: string } | null> {
    let after = 0;
    for (let pageIndex = 0; pageIndex < this.historyMaxPages; pageIndex += 1) {
      const page = await this.nativeClient.listHistory({
        sessionId: input.sessionId,
        after,
        limit: this.historyPageLimit,
      });
      let nextAfter = after;
      for (const item of page.records) {
        if (item.aggregateSeq <= nextAfter) return null;
        nextAfter = item.aggregateSeq;
        if (item.type !== 'session.next.prompt.admitted' || item.inputId !== input.inputId) {
          continue;
        }
        return item.sessionId === input.sessionId && item.requestDigest === input.requestDigest
          ? { aggregateSeq: item.aggregateSeq, eventId: item.eventId }
          : null;
      }
      if (!page.hasMore || nextAfter === after) return null;
      after = nextAfter;
    }
    return null;
  }
}

/** Direct adapter for the sidecar orchestrator's durable runner contract. */
export class ChatOperationV2OpenCodeReadonlyRunner implements ChatOperationV2DurableInvocationRunner {
  constructor(private readonly invocations: OpenCodeReadonlyInvocationRunner) {}

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    let result: OpenCodeClassifierCoreResult | OpenCodeReadonlyTextResult;
    if (request.purpose === 'classifier') {
      if (request.readSnapshot !== null) {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      let prompt: ReturnType<typeof buildChatPipelineIntentClassificationPrompt>;
      try {
        prompt = parseClassifierTextCanonicalRequestBytes(request.canonicalRequestBytes);
      } catch {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      try {
        result = await this.invocations.runCanonicalClassifier({
          operationId: request.operationId,
          workspaceScopeId: request.workspaceScopeId,
          invocationId: request.invocationId,
          sessionId: request.sessionId,
          inputId: request.inputId,
          canonicalRequestBytes: request.canonicalRequestBytes,
          prompt,
          model: { providerID: request.provider, modelID: request.model },
          variant: request.variant,
          signal: request.signal,
        });
      } catch {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
    } else if (request.purpose === 'discussion' || request.purpose === 'diagnosis') {
      let prompt: OpenCodeReadonlyTextPrompt;
      try {
        prompt = parseReadonlyTextCanonicalRequestBytes({
          bytes: request.canonicalRequestBytes,
          purpose: request.purpose,
          readSnapshot: request.readSnapshot,
        });
      } catch {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      result = await this.invocations.runCanonicalReadonlyText({
        operationId: request.operationId,
        workspaceScopeId: request.workspaceScopeId,
        invocationId: request.invocationId,
        sessionId: request.sessionId,
        inputId: request.inputId,
        purpose: request.purpose,
        canonicalRequestBytes: request.canonicalRequestBytes,
        prompt,
        model: { providerID: request.provider, modelID: request.model },
        variant: request.variant,
        signal: request.signal,
      });
    } else {
      return { kind: 'provider_unavailable', code: 'unsupported_readonly_purpose' };
    }
    if (result.kind !== 'completed') return result;
    return {
      kind: 'completed',
      structuredOutput: result.structuredOutput,
      text:
        request.purpose === 'classifier' || typeof result.structuredOutput !== 'string'
          ? null
          : result.structuredOutput,
      executionMessageId: result.executionMessageId,
      finishCode: result.finishCode,
      admittedAggregateSeq: result.admittedAggregateSeq,
      source: result.source,
      usage: result.usage,
    };
  }

  async reconcile(
    request: ChatOperationV2DurableInvocationRecoveryRequest,
  ): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    if (request.purpose === 'classifier') {
      if (request.readSnapshot !== null) {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      let prompt: ReturnType<typeof buildChatPipelineIntentClassificationPrompt>;
      try {
        prompt = parseClassifierTextCanonicalRequestBytes(request.canonicalRequestBytes);
      } catch {
        return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
      }
      const result = await this.invocations.reconcileCanonicalClassifier({
        operationId: request.operationId,
        workspaceScopeId: request.workspaceScopeId,
        invocationId: request.invocationId,
        sessionId: request.sessionId,
        inputId: request.inputId,
        canonicalRequestBytes: request.canonicalRequestBytes,
        prompt,
        model: { providerID: request.provider, modelID: request.model },
        variant: request.variant,
      });
      if (result.kind !== 'completed') return result;
      return {
        kind: 'completed',
        structuredOutput: result.safeDecision,
        text: null,
        executionMessageId: result.executionMessageId,
        finishCode: result.finishCode,
        admittedAggregateSeq: result.admittedAggregateSeq,
        source: result.source,
        usage: result.usage,
      };
    }
    if (request.purpose !== 'discussion' && request.purpose !== 'diagnosis') {
      return { kind: 'provider_unavailable', code: 'unsupported_readonly_purpose' };
    }
    let prompt: OpenCodeReadonlyTextPrompt;
    try {
      prompt = parseReadonlyTextCanonicalRequestBytes({
        bytes: request.canonicalRequestBytes,
        purpose: request.purpose,
        readSnapshot: request.readSnapshot,
      });
    } catch {
      return { kind: 'provider_unavailable', code: 'request_digest_conflict' };
    }
    const result = await this.invocations.reconcileCanonicalReadonlyText({
      operationId: request.operationId,
      workspaceScopeId: request.workspaceScopeId,
      invocationId: request.invocationId,
      sessionId: request.sessionId,
      inputId: request.inputId,
      purpose: request.purpose,
      canonicalRequestBytes: request.canonicalRequestBytes,
      prompt,
      model: { providerID: request.provider, modelID: request.model },
      variant: request.variant,
    });
    if (result.kind !== 'completed') return result;
    return {
      kind: 'completed',
      structuredOutput: result.structuredOutput,
      text: typeof result.structuredOutput === 'string' ? result.structuredOutput : null,
      executionMessageId: result.executionMessageId,
      finishCode: result.finishCode,
      admittedAggregateSeq: result.admittedAggregateSeq,
      source: result.source,
      usage: result.usage,
    };
  }

  interrupt(input: { readonly operationId: string; readonly invocationId: string }): Promise<void> {
    return this.invocations.interrupt(input);
  }
}

export function createManagedOpenCodeSdkAdapter(workspaceDirectory: string): OpenCodeSdkAdapter {
  return new OpenCodeSdkAdapter({
    workspaceDirectory,
    resolveClient: async () => {
      const handle = await ensureOpencode(workspaceDirectory);
      return createOpencodeV2Client({
        baseUrl: handle.baseUrl,
        directory: workspaceDirectory,
        headers: { Authorization: handle.auth.authorization },
        throwOnError: false,
        fetch: createStreamingLoopbackFetch(handle.baseUrl),
      }) as unknown as OpenCodeAdapterSdkClient;
    },
  });
}

export function createManagedOpenCodeReadonlyInvocationRunner(options: {
  readonly workspaceDirectory: string;
  readonly store: OpenCodeInvocationStore;
  readonly nextExecutionMessageId?: OpenCodeReadonlyInvocationRunnerOptions['nextExecutionMessageId'];
}): {
  readonly adapter: OpenCodeSdkAdapter;
  readonly controller: OpenCodeInvocationController;
  readonly readonlyInvocationRunner: OpenCodeReadonlyInvocationRunner;
  readonly runner: ChatOperationV2OpenCodeReadonlyRunner;
} {
  const adapter = createManagedOpenCodeSdkAdapter(options.workspaceDirectory);
  const controller = new OpenCodeInvocationController({ store: options.store, client: adapter });
  const readonlyInvocationRunner = new OpenCodeReadonlyInvocationRunner({
    controller,
    store: options.store,
    nativeClient: adapter,
    textPromptClient: adapter,
    ...(options.nextExecutionMessageId
      ? { nextExecutionMessageId: options.nextExecutionMessageId }
      : {}),
  });
  const runner = new ChatOperationV2OpenCodeReadonlyRunner(readonlyInvocationRunner);
  return { adapter, controller, readonlyInvocationRunner, runner };
}
