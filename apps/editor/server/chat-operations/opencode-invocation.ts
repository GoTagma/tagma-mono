import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ListInvocationOutboxOptions,
  PrepareInvocationOutboxInput,
  StoredInvocationOutboxRecord,
  UpdateInvocationOutboxInput,
  UpdateInvocationOutboxResult,
} from './store.js';
import type { ChatOperationV2SubmissionUnknownReason } from './submission-diagnostics.js';

export interface OpenCodeInvocationStore {
  prepareInvocationOutbox(input: PrepareInvocationOutboxInput): StoredInvocationOutboxRecord;
  getInvocationOutbox(invocationId: string): StoredInvocationOutboxRecord | null;
  listInvocationOutbox(
    workspaceScopeId: string,
    options?: ListInvocationOutboxOptions,
  ): StoredInvocationOutboxRecord[];
  updateInvocationOutbox(input: UpdateInvocationOutboxInput): UpdateInvocationOutboxResult;
}

export interface OpenCodeHistoryAdmissionRecord {
  /** Stable durable event id from finite REST history, never inferred from the SSE body. */
  readonly eventId: string;
  readonly type: string;
  readonly sessionId: string;
  readonly inputId: string;
  /** Digest produced with the same canonical admission-request encoding as the outbox row. */
  readonly requestDigest: string;
  /** Authoritative durable aggregate sequence from history. */
  readonly aggregateSeq: number;
}

export interface OpenCodeHistoryPage {
  readonly records: readonly OpenCodeHistoryAdmissionRecord[];
  readonly hasMore: boolean;
}

export interface OpenCodeAdmissionEvidence {
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestDigest: string;
  readonly aggregateSeq: number;
}

export type OpenCodeCreateSessionResult =
  { readonly kind: 'created'; readonly sessionId: string } | { readonly kind: 'conflict' };

export type OpenCodePromptResult =
  | { readonly kind: 'admitted'; readonly admission: OpenCodeAdmissionEvidence }
  | { readonly kind: 'conflict' };

export interface OpenCodeInvocationNativeClient {
  createSession(input: { readonly sessionId: string }): Promise<OpenCodeCreateSessionResult>;
  prompt(input: {
    readonly sessionId: string;
    readonly inputId: string;
    readonly canonicalRequestBytes: Uint8Array;
  }): Promise<OpenCodePromptResult>;
  listHistory(input: {
    readonly sessionId: string;
    /** Exclusive aggregate cursor. */
    readonly after: number;
    readonly limit: number;
  }): Promise<OpenCodeHistoryPage>;
}

export interface HostAssignedOpenCodeInvocation {
  readonly operationId: string;
  readonly invocationId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly inputId: string;
  /** Fresh calls may proceed when preflight history is temporarily unreadable; recovery never may. */
  readonly submissionMode?: 'fresh' | 'recover';
  /** Frozen, canonical native admission bytes. The controller copies them before its first await. */
  readonly canonicalRequestBytes: Uint8Array;
}

export interface AuthenticatedOpenCodeInvocationRequest {
  readonly invocationId: string;
  /** Caller-reloaded bytes are authenticated against the durable outbox before native access. */
  readonly canonicalRequestBytes: Uint8Array;
}

export interface ReconcileOpenCodeInvocationsInput {
  readonly workspaceScopeId: string;
  readonly requests: readonly AuthenticatedOpenCodeInvocationRequest[];
}

export type OpenCodeInvocationOutcome =
  | {
      readonly kind: 'admitted';
      readonly invocationId: string;
      readonly sessionId: string;
      readonly inputId: string;
      readonly admittedAggregateSeq: number;
      readonly recoveredFromHistory: boolean;
    }
  | {
      readonly kind: 'submitted_unknown';
      readonly invocationId: string;
      readonly sessionId: string;
      readonly inputId: string;
      readonly reasonCode: ChatOperationV2SubmissionUnknownReason;
    }
  | {
      readonly kind: 'conflict';
      readonly invocationId: string;
      readonly code: OpenCodeInvocationConflictCode;
    }
  | {
      readonly kind: 'request_required';
      readonly invocationId: string;
    };

export type OpenCodeInvocationConflictCode =
  | 'request_digest_conflict'
  | 'session_identity_conflict'
  | 'admission_evidence_conflict'
  | 'history_protocol_conflict';

export interface OpenCodeInvocationControllerOptions {
  readonly store: OpenCodeInvocationStore;
  readonly client: OpenCodeInvocationNativeClient;
  readonly now?: () => number;
  readonly historyPageLimit?: number;
  readonly historyMaxPages?: number;
  readonly historyReconcileAttempts?: number;
  readonly historyReconcileDelayMs?: number;
}

const DEFAULT_HISTORY_PAGE_LIMIT = 100;
const DEFAULT_HISTORY_MAX_PAGES = 64;
const DEFAULT_HISTORY_RECONCILE_ATTEMPTS = 20;
const DEFAULT_HISTORY_RECONCILE_DELAY_MS = 50;
const INVOCATION_CONFLICT_CODES = new Set<OpenCodeInvocationConflictCode>([
  'request_digest_conflict',
  'session_identity_conflict',
  'admission_evidence_conflict',
  'history_protocol_conflict',
]);

type HistoryAdmissionResult =
  | { readonly kind: 'admitted'; readonly aggregateSeq: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'conflict' };

type HistoryUnavailableResult = {
  readonly kind: 'unavailable';
  readonly reason: 'request_failed' | 'scan_incomplete';
};

function preflightHistoryReason(
  reason: HistoryUnavailableResult['reason'],
): ChatOperationV2SubmissionUnknownReason {
  return reason === 'request_failed'
    ? 'admission_preflight_history_request_failed'
    : 'admission_preflight_history_scan_incomplete';
}

function transportHistoryReason(
  boundary: 'session_create' | 'admission_prompt',
  result: Extract<
    HistoryAdmissionResult | HistoryUnavailableResult,
    { kind: 'missing' | 'unavailable' }
  >,
): ChatOperationV2SubmissionUnknownReason {
  if (boundary === 'session_create') {
    if (result.kind === 'missing') return 'session_create_transport_history_missing';
    return result.reason === 'request_failed'
      ? 'session_create_transport_history_request_failed'
      : 'session_create_transport_history_scan_incomplete';
  }
  if (result.kind === 'missing') return 'admission_prompt_transport_history_missing';
  return result.reason === 'request_failed'
    ? 'admission_prompt_transport_history_request_failed'
    : 'admission_prompt_transport_history_scan_incomplete';
}

function promptConflictHistoryReason(
  reason: HistoryUnavailableResult['reason'],
): ChatOperationV2SubmissionUnknownReason {
  return reason === 'request_failed'
    ? 'admission_prompt_conflict_history_request_failed'
    : 'admission_prompt_conflict_history_scan_incomplete';
}

function replayTransportHistoryReason(
  result: Extract<
    HistoryAdmissionResult | HistoryUnavailableResult,
    { kind: 'missing' | 'unavailable' }
  >,
): ChatOperationV2SubmissionUnknownReason {
  if (result.kind === 'missing') {
    return 'admission_prompt_replay_transport_history_missing';
  }
  return result.reason === 'request_failed'
    ? 'admission_prompt_replay_transport_history_request_failed'
    : 'admission_prompt_replay_transport_history_scan_incomplete';
}

function reconciliationHistoryReason(
  result: Extract<
    HistoryAdmissionResult | HistoryUnavailableResult,
    { kind: 'missing' | 'unavailable' }
  >,
): ChatOperationV2SubmissionUnknownReason {
  if (result.kind === 'missing') return 'admission_reconcile_history_missing';
  return result.reason === 'request_failed'
    ? 'admission_reconcile_history_request_failed'
    : 'admission_reconcile_history_scan_incomplete';
}

export function sha256CanonicalOpenCodeRequest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class OpenCodeInvocationController {
  private readonly store: OpenCodeInvocationStore;
  private readonly client: OpenCodeInvocationNativeClient;
  private readonly now: () => number;
  private readonly historyPageLimit: number;
  private readonly historyMaxPages: number;
  private readonly historyReconcileAttempts: number;
  private readonly historyReconcileDelayMs: number;

  constructor(options: OpenCodeInvocationControllerOptions) {
    this.store = options.store;
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.historyPageLimit = options.historyPageLimit ?? DEFAULT_HISTORY_PAGE_LIMIT;
    this.historyMaxPages = options.historyMaxPages ?? DEFAULT_HISTORY_MAX_PAGES;
    this.historyReconcileAttempts =
      options.historyReconcileAttempts ?? DEFAULT_HISTORY_RECONCILE_ATTEMPTS;
    this.historyReconcileDelayMs =
      options.historyReconcileDelayMs ?? DEFAULT_HISTORY_RECONCILE_DELAY_MS;
    if (
      !Number.isSafeInteger(this.historyPageLimit) ||
      this.historyPageLimit < 1 ||
      this.historyPageLimit > 1_000 ||
      !Number.isSafeInteger(this.historyMaxPages) ||
      this.historyMaxPages < 1 ||
      this.historyMaxPages > 1_000 ||
      !Number.isSafeInteger(this.historyReconcileAttempts) ||
      this.historyReconcileAttempts < 1 ||
      this.historyReconcileAttempts > 20 ||
      !Number.isSafeInteger(this.historyReconcileDelayMs) ||
      this.historyReconcileDelayMs < 0 ||
      this.historyReconcileDelayMs > 5_000
    ) {
      throw new TypeError('OpenCode history bounds or reconciliation policy are invalid.');
    }
  }

  async invoke(input: HostAssignedOpenCodeInvocation): Promise<OpenCodeInvocationOutcome> {
    const requestBytes = Uint8Array.from(input.canonicalRequestBytes);
    const requestDigest = sha256CanonicalOpenCodeRequest(requestBytes);
    let outbox: StoredInvocationOutboxRecord;
    try {
      outbox = this.store.prepareInvocationOutbox({
        operationId: input.operationId,
        invocationId: input.invocationId,
        purpose: input.purpose,
        sessionId: input.sessionId,
        inputId: input.inputId,
        requestDigest,
      });
    } catch (error) {
      if (!this.hasStoreErrorCode(error, 'outbox_conflict')) throw error;
      const existing = this.store.getInvocationOutbox(input.invocationId);
      if (
        existing &&
        existing.operationId === input.operationId &&
        !['settled', 'interrupted', 'failed_terminal'].includes(existing.status)
      ) {
        return this.conflict(existing, 'request_digest_conflict');
      }
      return {
        kind: 'conflict',
        invocationId: input.invocationId,
        code: 'request_digest_conflict',
      };
    }

    if (outbox.requestDigest !== requestDigest) {
      return this.conflict(outbox, 'request_digest_conflict');
    }
    if (outbox.status === 'submitted_unknown') {
      return this.reconcileSubmittedUnknown(outbox);
    }
    if (outbox.status !== 'prepared') {
      return this.outcomeForObservedStatus(outbox);
    }
    return this.resumePrepared(outbox, requestBytes, input.submissionMode ?? 'recover');
  }

  async reconcileUnresolved(
    input: ReconcileOpenCodeInvocationsInput,
  ): Promise<readonly OpenCodeInvocationOutcome[]> {
    const requests = new Map<string, Uint8Array>();
    for (const request of input.requests) {
      requests.set(request.invocationId, Uint8Array.from(request.canonicalRequestBytes));
    }
    const outboxes = this.store.listInvocationOutbox(input.workspaceScopeId, {
      statuses: ['prepared', 'submitted_unknown'],
    });
    const outcomes: OpenCodeInvocationOutcome[] = [];
    for (const outbox of outboxes) {
      const requestBytes = requests.get(outbox.invocationId);
      if (!requestBytes) {
        outcomes.push({ kind: 'request_required', invocationId: outbox.invocationId });
        continue;
      }
      if (sha256CanonicalOpenCodeRequest(requestBytes) !== outbox.requestDigest) {
        outcomes.push(this.conflict(outbox, 'request_digest_conflict'));
        continue;
      }
      outcomes.push(
        outbox.status === 'prepared'
          ? await this.resumePrepared(outbox, requestBytes, 'recover')
          : await this.reconcileSubmittedUnknown(outbox),
      );
    }
    return outcomes;
  }

  private async resumePrepared(
    outbox: StoredInvocationOutboxRecord,
    requestBytes: Uint8Array,
    submissionMode: 'fresh' | 'recover',
  ): Promise<OpenCodeInvocationOutcome> {
    const existingAdmission = await this.safeQueryHistory(outbox);
    if (existingAdmission.kind === 'admitted') {
      return this.admit(outbox, existingAdmission.aggregateSeq, true);
    }
    if (existingAdmission.kind === 'conflict') {
      return this.conflict(outbox, 'history_protocol_conflict');
    }
    if (existingAdmission.kind === 'unavailable') {
      if (submissionMode === 'recover') {
        return this.outcomeAfterSubmittedUnknownCas(
          this.markSubmittedUnknown(outbox),
          preflightHistoryReason(existingAdmission.reason),
        );
      }
    }

    let created: OpenCodeCreateSessionResult;
    try {
      created = await this.client.createSession({ sessionId: outbox.sessionId });
    } catch {
      return this.recoverAfterTransportFailure(outbox, 'session_create');
    }
    if (created.kind !== 'created' || created.sessionId !== outbox.sessionId) {
      return this.conflict(outbox, 'session_identity_conflict');
    }

    let prompted: OpenCodePromptResult;
    try {
      prompted = await this.client.prompt({
        sessionId: outbox.sessionId,
        inputId: outbox.inputId,
        canonicalRequestBytes: Uint8Array.from(requestBytes),
      });
    } catch {
      return this.recoverAfterTransportFailure(
        outbox,
        'admission_prompt',
        submissionMode === 'fresh' ? requestBytes : null,
      );
    }
    return this.outcomeAfterPrompt(outbox, prompted);
  }

  private async outcomeAfterPrompt(
    outbox: StoredInvocationOutboxRecord,
    prompted: OpenCodePromptResult,
  ): Promise<OpenCodeInvocationOutcome> {
    if (prompted.kind === 'conflict') {
      const recovered = await this.reconcileHistory(outbox);
      if (recovered.kind === 'admitted') {
        return this.admit(outbox, recovered.aggregateSeq, true);
      }
      if (recovered.kind === 'unavailable') {
        return this.outcomeAfterSubmittedUnknownCas(
          this.markSubmittedUnknown(outbox),
          promptConflictHistoryReason(recovered.reason),
        );
      }
      return this.conflict(outbox, 'admission_evidence_conflict');
    }
    if (!this.matches(outbox, prompted.admission)) {
      return this.conflict(outbox, 'admission_evidence_conflict');
    }
    return this.admit(outbox, prompted.admission.aggregateSeq, false);
  }

  private async recoverAfterTransportFailure(
    outbox: StoredInvocationOutboxRecord,
    boundary: 'session_create' | 'admission_prompt',
    freshReplayRequestBytes: Uint8Array | null = null,
  ): Promise<OpenCodeInvocationOutcome> {
    const unknown = this.markSubmittedUnknown(outbox);
    if (unknown.admittedAggregateSeq !== null || unknown.status === 'failed_terminal') {
      return this.outcomeForObservedStatus(unknown);
    }
    const recovered = await this.reconcileHistory(unknown);
    if (recovered.kind === 'admitted') {
      return this.admit(unknown, recovered.aggregateSeq, true);
    }
    if (recovered.kind === 'conflict') {
      return this.conflict(unknown, 'history_protocol_conflict');
    }
    if (
      boundary === 'admission_prompt' &&
      freshReplayRequestBytes !== null &&
      recovered.kind === 'missing'
    ) {
      const replayAuthority = this.store.getInvocationOutbox(unknown.invocationId) ?? unknown;
      if (
        replayAuthority.status !== 'submitted_unknown' ||
        replayAuthority.admittedAggregateSeq !== null
      ) {
        return this.outcomeForObservedStatus(replayAuthority);
      }
      return this.replayFreshAdmissionPrompt(replayAuthority, freshReplayRequestBytes);
    }
    return this.unknownOutcome(unknown, transportHistoryReason(boundary, recovered));
  }

  private async replayFreshAdmissionPrompt(
    outbox: StoredInvocationOutboxRecord,
    requestBytes: Uint8Array,
  ): Promise<OpenCodeInvocationOutcome> {
    let prompted: OpenCodePromptResult;
    try {
      prompted = await this.client.prompt({
        sessionId: outbox.sessionId,
        inputId: outbox.inputId,
        canonicalRequestBytes: Uint8Array.from(requestBytes),
      });
    } catch {
      const recovered = await this.reconcileHistory(outbox);
      if (recovered.kind === 'admitted') {
        return this.admit(outbox, recovered.aggregateSeq, true);
      }
      if (recovered.kind === 'conflict') {
        return this.conflict(outbox, 'history_protocol_conflict');
      }
      return this.unknownOutcome(outbox, replayTransportHistoryReason(recovered));
    }
    return this.outcomeAfterPrompt(outbox, prompted);
  }

  private async reconcileSubmittedUnknown(
    outbox: StoredInvocationOutboxRecord,
  ): Promise<OpenCodeInvocationOutcome> {
    const recovered = await this.reconcileHistory(outbox);
    if (recovered.kind === 'admitted') {
      return this.admit(outbox, recovered.aggregateSeq, true);
    }
    if (recovered.kind === 'conflict') {
      return this.conflict(outbox, 'history_protocol_conflict');
    }
    return this.unknownOutcome(outbox, reconciliationHistoryReason(recovered));
  }

  private async safeQueryHistory(
    outbox: StoredInvocationOutboxRecord,
  ): Promise<HistoryAdmissionResult | HistoryUnavailableResult> {
    try {
      return await this.queryHistory(outbox);
    } catch {
      return { kind: 'unavailable', reason: 'request_failed' };
    }
  }

  private async reconcileHistory(
    outbox: StoredInvocationOutboxRecord,
  ): Promise<HistoryAdmissionResult | HistoryUnavailableResult> {
    let observed: HistoryAdmissionResult | HistoryUnavailableResult = { kind: 'missing' };
    for (let attempt = 0; attempt < this.historyReconcileAttempts; attempt += 1) {
      observed = await this.safeQueryHistory(outbox);
      if (observed.kind === 'admitted' || observed.kind === 'conflict') return observed;
      if (attempt + 1 < this.historyReconcileAttempts && this.historyReconcileDelayMs > 0) {
        await delay(this.historyReconcileDelayMs);
      }
    }
    return observed;
  }

  private async queryHistory(
    outbox: StoredInvocationOutboxRecord,
  ): Promise<HistoryAdmissionResult | HistoryUnavailableResult> {
    let exactSequence: number | null = null;
    let after = 0;
    for (let pageIndex = 0; pageIndex < this.historyMaxPages; pageIndex += 1) {
      const page = await this.client.listHistory({
        sessionId: outbox.sessionId,
        after,
        limit: this.historyPageLimit,
      });
      if (!page || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        return { kind: 'conflict' };
      }
      let nextAfter = after;
      for (const record of page.records) {
        if (!record || !Number.isSafeInteger(record.aggregateSeq) || record.aggregateSeq <= after) {
          return { kind: 'conflict' };
        }
        nextAfter = Math.max(nextAfter, record.aggregateSeq);
        if (record.type !== 'session.next.prompt.admitted' || record.inputId !== outbox.inputId) {
          continue;
        }
        if (!this.matches(outbox, record)) return { kind: 'conflict' };
        if (exactSequence !== null && exactSequence !== record.aggregateSeq) {
          return { kind: 'conflict' };
        }
        exactSequence = record.aggregateSeq;
      }
      if (!page.hasMore) {
        return exactSequence === null
          ? { kind: 'missing' }
          : { kind: 'admitted', aggregateSeq: exactSequence };
      }
      if (nextAfter === after) return { kind: 'conflict' };
      after = nextAfter;
    }
    return { kind: 'unavailable', reason: 'scan_incomplete' };
  }

  private admit(
    outbox: StoredInvocationOutboxRecord,
    aggregateSeq: number,
    recoveredFromHistory: boolean,
  ): OpenCodeInvocationOutcome {
    let observed = outbox;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (observed.status === 'failed_terminal') {
        return this.outcomeForObservedStatus(observed);
      }
      if (observed.admittedAggregateSeq !== null) {
        if (observed.admittedAggregateSeq !== aggregateSeq) {
          return this.conflict(observed, 'admission_evidence_conflict');
        }
        return this.admittedOutcome(observed, recoveredFromHistory);
      }
      if (observed.status !== 'prepared' && observed.status !== 'submitted_unknown') {
        return this.outcomeForObservedStatus(observed);
      }
      const updated = this.store.updateInvocationOutbox({
        invocationId: observed.invocationId,
        expectedStatus: observed.status,
        status: 'admitted',
        admittedAggregateSeq: aggregateSeq,
      });
      observed = updated.outbox;
      if (updated.applied) return this.admittedOutcome(observed, recoveredFromHistory);
    }
    return this.outcomeForObservedStatus(observed);
  }

  private admittedOutcome(
    admitted: StoredInvocationOutboxRecord,
    recoveredFromHistory: boolean,
  ): OpenCodeInvocationOutcome {
    if (admitted.status === 'failed_terminal') return this.outcomeForObservedStatus(admitted);
    if (admitted.admittedAggregateSeq === null) {
      return this.unknownOutcome(admitted, 'admission_sequence_missing');
    }
    return {
      kind: 'admitted',
      invocationId: admitted.invocationId,
      sessionId: admitted.sessionId,
      inputId: admitted.inputId,
      admittedAggregateSeq: admitted.admittedAggregateSeq,
      recoveredFromHistory,
    };
  }

  private markSubmittedUnknown(outbox: StoredInvocationOutboxRecord): StoredInvocationOutboxRecord {
    if (outbox.status === 'submitted_unknown') return outbox;
    const updated = this.store.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: outbox.status,
      status: 'submitted_unknown',
    });
    return updated.outbox;
  }

  private outcomeAfterSubmittedUnknownCas(
    outbox: StoredInvocationOutboxRecord,
    reasonCode: ChatOperationV2SubmissionUnknownReason,
  ): OpenCodeInvocationOutcome {
    return outbox.status === 'submitted_unknown'
      ? this.unknownOutcome(outbox, reasonCode)
      : this.outcomeForObservedStatus(outbox);
  }

  private unknownOutcome(
    outbox: StoredInvocationOutboxRecord,
    reasonCode: ChatOperationV2SubmissionUnknownReason,
  ): OpenCodeInvocationOutcome {
    return {
      kind: 'submitted_unknown',
      invocationId: outbox.invocationId,
      sessionId: outbox.sessionId,
      inputId: outbox.inputId,
      reasonCode,
    };
  }

  private outcomeForObservedStatus(
    outbox: StoredInvocationOutboxRecord,
  ): OpenCodeInvocationOutcome {
    if (outbox.status === 'failed_terminal') {
      return {
        kind: 'conflict',
        invocationId: outbox.invocationId,
        code: this.safeStoredConflictCode(outbox.failureCode),
      };
    }
    if (outbox.admittedAggregateSeq !== null) {
      return {
        kind: 'admitted',
        invocationId: outbox.invocationId,
        sessionId: outbox.sessionId,
        inputId: outbox.inputId,
        admittedAggregateSeq: outbox.admittedAggregateSeq,
        recoveredFromHistory: true,
      };
    }
    return this.unknownOutcome(outbox, 'admission_state_changed_without_evidence');
  }

  private safeStoredConflictCode(failureCode: string | null): OpenCodeInvocationConflictCode {
    return failureCode &&
      INVOCATION_CONFLICT_CODES.has(failureCode as OpenCodeInvocationConflictCode)
      ? (failureCode as OpenCodeInvocationConflictCode)
      : 'history_protocol_conflict';
  }

  private hasStoreErrorCode(error: unknown, code: string): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === code
    );
  }

  private matches(
    outbox: StoredInvocationOutboxRecord,
    evidence: OpenCodeAdmissionEvidence,
  ): boolean {
    return (
      evidence.sessionId === outbox.sessionId &&
      evidence.inputId === outbox.inputId &&
      evidence.requestDigest === outbox.requestDigest &&
      Number.isSafeInteger(evidence.aggregateSeq) &&
      evidence.aggregateSeq > 0
    );
  }

  private conflict(
    outbox: StoredInvocationOutboxRecord,
    code: OpenCodeInvocationConflictCode,
  ): OpenCodeInvocationOutcome {
    const terminal = this.store.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: outbox.status,
      status: 'failed_terminal',
      settledAt: this.now(),
      failureCode: code,
    });
    if (!terminal.applied) return this.outcomeForObservedStatus(terminal.outbox);
    return { kind: 'conflict', invocationId: terminal.outbox.invocationId, code };
  }
}
