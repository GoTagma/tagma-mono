import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { ChatOperationV2AuthoringInvocationPurpose } from './authoring.js';

export interface ChatExecutionInputWitness {
  readonly schemaVersion: 1;
  readonly layer: 'host-sdk-prompt-arguments';
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly stageId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly executionMessageId: string;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
  readonly repairAttempt: number;
  readonly requestDigest: string;
  readonly continuationOf: string | null;
  readonly trialId: string | null;
  readonly referenceHash: string | null;
  readonly referenceUtf8Bytes: number | null;
  readonly canonicalErrorsHash: string | null;
  readonly canonicalErrorsUtf8Bytes: number | null;
  readonly promptTextHash: string;
  readonly promptTextUtf8Bytes: number;
  readonly decodedPromptErrorsHash: string | null;
  readonly decodedPromptErrorsUtf8Bytes: number | null;
  readonly errorBlockPresent: boolean | null;
  readonly referenceCanonicalMatch: boolean | null;
  readonly decodedCanonicalMatch: boolean | null;
  readonly reason:
    | 'matched'
    | 'mismatch'
    | 'no_error_evidence'
    | 'continuation_context'
    | 'reference_unavailable'
    | 'error_block_absent'
    | 'error_block_ambiguous'
    | 'decode_unavailable';
}

export interface ChatExecutionInputObservation {
  readonly owner: Pick<
    ChatExecutionInputWitness,
    'workspaceScopeId' | 'operationId' | 'operationGeneration' | 'stageId' | 'repairAttempt'
  >;
  readonly reference: {
    readonly hash: string;
    readonly byteLength: number;
    readonly trialId: string;
  } | null;
  readonly emit: (witness: ChatExecutionInputWitness) => void | Promise<void>;
}

const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

export function chatExecutionMessageId(input: {
  readonly operationId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
}): string {
  // The exact sorted canonical string fields used by the existing runtime ID.
  return (
    'msg_tagma_author_' +
    hash(
      JSON.stringify({
        inputId: input.inputId,
        invocationId: input.invocationId,
        operationId: input.operationId,
        purpose: input.purpose,
        sessionId: input.sessionId,
      }),
    ).slice(0, 40)
  );
}
const ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const HASH = /^[0-9a-f]{64}$/;
const identityKeys = [
  'workspaceScopeId',
  'operationId',
  'stageId',
  'invocationId',
  'sessionId',
  'inputId',
  'executionMessageId',
] as const;
const nullableHashKeys = [
  'referenceHash',
  'canonicalErrorsHash',
  'decodedPromptErrorsHash',
] as const;
const nullableCountKeys = [
  'referenceUtf8Bytes',
  'canonicalErrorsUtf8Bytes',
  'decodedPromptErrorsUtf8Bytes',
] as const;
const nullableBoolKeys = [
  'errorBlockPresent',
  'referenceCanonicalMatch',
  'decodedCanonicalMatch',
] as const;
const reasons = [
  'matched',
  'mismatch',
  'no_error_evidence',
  'continuation_context',
  'reference_unavailable',
  'error_block_absent',
  'error_block_ambiguous',
  'decode_unavailable',
];

export function isChatExecutionInputWitness(value: unknown): value is ChatExecutionInputWitness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = [
    'schemaVersion',
    'layer',
    ...identityKeys,
    'operationGeneration',
    'purpose',
    'repairAttempt',
    'requestDigest',
    'continuationOf',
    'trialId',
    ...nullableHashKeys,
    ...nullableCountKeys,
    'promptTextHash',
    'promptTextUtf8Bytes',
    ...nullableBoolKeys,
    'reason',
  ];
  const descriptors = Object.getOwnPropertyDescriptors(r);
  if (
    Object.keys(r).length !== keys.length ||
    !keys.every(
      (k) =>
        descriptors[k]?.enumerable && Object.prototype.hasOwnProperty.call(descriptors[k], 'value'),
    )
  )
    return false;
  const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
  const id = (v: unknown) => typeof v === 'string' && ID.test(v);
  const digest = (v: unknown) => typeof v === 'string' && HASH.test(v);
  const paired = nullableHashKeys.every(
    (key, index) => (r[key] === null) === (r[nullableCountKeys[index]] === null),
  );
  if (!paired) return false;
  const referenceMatches =
    r.referenceHash !== null &&
    r.canonicalErrorsHash !== null &&
    r.referenceHash === r.canonicalErrorsHash &&
    r.referenceUtf8Bytes === r.canonicalErrorsUtf8Bytes;
  const decodedMatches =
    r.decodedPromptErrorsHash !== null &&
    r.canonicalErrorsHash !== null &&
    r.decodedPromptErrorsHash === r.canonicalErrorsHash &&
    r.decodedPromptErrorsUtf8Bytes === r.canonicalErrorsUtf8Bytes;
  if (
    r.referenceCanonicalMatch !== null &&
    (r.referenceHash === null ||
      r.canonicalErrorsHash === null ||
      r.referenceCanonicalMatch !== referenceMatches)
  )
    return false;
  if (
    r.decodedCanonicalMatch !== null &&
    (r.decodedPromptErrorsHash === null ||
      r.canonicalErrorsHash === null ||
      r.decodedCanonicalMatch !== decodedMatches)
  )
    return false;
  if (
    r.reason === 'matched' &&
    (r.referenceCanonicalMatch !== true ||
      r.decodedCanonicalMatch !== true ||
      r.errorBlockPresent !== true)
  )
    return false;
  if (
    r.reason === 'continuation_context' &&
    (r.continuationOf === null ||
      r.decodedPromptErrorsHash !== null ||
      r.decodedCanonicalMatch !== null ||
      r.errorBlockPresent !== null)
  )
    return false;
  return (
    r.schemaVersion === 1 &&
    r.layer === 'host-sdk-prompt-arguments' &&
    identityKeys.every((k) => id(r[k])) &&
    r.executionMessageId === chatExecutionMessageId(r as unknown as ChatExecutionInputWitness) &&
    count(r.operationGeneration) &&
    Number(r.operationGeneration) >= 1 &&
    count(r.repairAttempt) &&
    ['authoring', 'repair', 'trial_plan'].includes(String(r.purpose)) &&
    digest(r.requestDigest) &&
    digest(r.promptTextHash) &&
    count(r.promptTextUtf8Bytes) &&
    [r.continuationOf, r.trialId].every((v) => v === null || id(v)) &&
    nullableHashKeys.every((k) => r[k] === null || digest(r[k])) &&
    nullableCountKeys.every((k) => r[k] === null || count(r[k])) &&
    nullableBoolKeys.every((k) => r[k] === null || typeof r[k] === 'boolean') &&
    reasons.includes(String(r.reason))
  );
}

// Called only after normal protocol validation has produced the real SDK text.
// Any observation/sink failure leaves the proof unavailable and never changes execution.
export function observeChatExecutionInput(input: {
  readonly observation: ChatExecutionInputObservation;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly executionMessageId: string;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
  readonly canonicalRequestBytes: Uint8Array;
  readonly promptText: string;
}): void {
  try {
    const request = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.canonicalRequestBytes),
    );
    const evidence =
      input.purpose === 'repair'
        ? request.repairEvidence
        : input.purpose === 'trial_plan'
          ? request.verificationErrorEvidence
          : null;
    const errors = typeof evidence?.errors === 'string' ? evidence.errors : null;
    const continuationOf =
      typeof request.continuationOf === 'string' ? request.continuationOf : null;
    const reference = input.observation.reference;
    const canonicalHash = errors === null ? null : hash(errors);
    const canonicalBytes = errors === null ? null : bytes(errors);
    const refMatch =
      errors === null || reference === null
        ? null
        : canonicalHash === reference.hash && canonicalBytes === reference.byteLength;
    let decoded: string | null = null;
    let present: boolean | null = null;
    let reason: ChatExecutionInputWitness['reason'] =
      errors === null
        ? continuationOf !== null
          ? 'continuation_context'
          : 'no_error_evidence'
        : 'error_block_absent';
    if (errors !== null) {
      const tag = input.purpose === 'repair' ? 'repair-error-evidence' : 'trial-error-evidence';
      const open = '<' + tag + '>',
        close = '</' + tag + '>';
      const first = input.promptText.indexOf(open),
        end = input.promptText.indexOf(close, first + open.length);
      present = first >= 0;
      if (
        present &&
        (end < 0 ||
          input.promptText.indexOf(open, first + open.length) >= 0 ||
          input.promptText.indexOf(close, end + close.length) >= 0)
      )
        reason = 'error_block_ambiguous';
      else if (present) {
        const encoded = input.promptText.slice(first + open.length, end);
        const entities: Record<string, string> = {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
        };
        const pattern = /&(amp|lt|gt|quot|apos);/g;
        if (encoded.replace(pattern, '').includes('&')) reason = 'decode_unavailable';
        else {
          // Exactly one pass: &amp;lt; means the literal string &lt;, not <.
          decoded = encoded.replace(pattern, (_, name: string) => entities[name]);
          reason =
            decoded === errors && refMatch === true
              ? 'matched'
              : refMatch === null
                ? 'reference_unavailable'
                : 'mismatch';
        }
      }
    }
    const witness: ChatExecutionInputWitness = Object.freeze({
      schemaVersion: 1,
      layer: 'host-sdk-prompt-arguments',
      ...input.observation.owner,
      invocationId: input.invocationId,
      sessionId: input.sessionId,
      inputId: input.inputId,
      executionMessageId: input.executionMessageId,
      purpose: input.purpose,
      requestDigest: createHash('sha256').update(input.canonicalRequestBytes).digest('hex'),
      continuationOf,
      trialId: reference?.trialId ?? null,
      referenceHash: reference?.hash ?? null,
      referenceUtf8Bytes: reference?.byteLength ?? null,
      canonicalErrorsHash: canonicalHash,
      canonicalErrorsUtf8Bytes: canonicalBytes,
      promptTextHash: hash(input.promptText),
      promptTextUtf8Bytes: bytes(input.promptText),
      decodedPromptErrorsHash: decoded === null ? null : hash(decoded),
      decodedPromptErrorsUtf8Bytes: decoded === null ? null : bytes(decoded),
      errorBlockPresent: present,
      referenceCanonicalMatch: refMatch,
      decodedCanonicalMatch: decoded === null || errors === null ? null : decoded === errors,
      reason,
    });
    if (!isChatExecutionInputWitness(witness)) return;
    void Promise.resolve(input.observation.emit(witness)).catch(() => {});
  } catch {
    // No raw errors, paths or request bodies enter diagnostics, including on failure.
  }
}
