import type { ChatOperationV2ResultAttachment } from './results.js';

export const FINAL_INSTRUCTIONS_LABEL = 'Verified pipeline instructions';
export const FINAL_INSTRUCTIONS_MAX_BYTES = 64 * 1024;

/** Host-approved final guidance; the original authored message remains immutable. */
export interface ChatOperationV2FinalInstructions {
  readonly version: 1;
  readonly artifactSetHash: string;
  readonly stagedSnapshotHash: string;
  readonly sourceInvocationId: string;
  readonly sourceRequestDigest: string;
  readonly text: string;
}

export function serializeFinalInstructions(value: ChatOperationV2FinalInstructions): string {
  const parsed = parseFinalInstructions(JSON.stringify(value));
  if (!parsed) throw new Error('Final pipeline instructions are invalid.');
  return JSON.stringify(parsed);
}

export function parseFinalInstructions(content: string): ChatOperationV2FinalInstructions | null {
  try {
    const value = JSON.parse(content) as ChatOperationV2FinalInstructions;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'artifactSetHash,sourceInvocationId,sourceRequestDigest,stagedSnapshotHash,text,version' ||
      value.version !== 1 ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      new TextDecoder().decode(new TextEncoder().encode(value.text)) !== value.text ||
      new TextEncoder().encode(value.text).length > FINAL_INSTRUCTIONS_MAX_BYTES ||
      typeof value.sourceInvocationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.sourceInvocationId) ||
      ![value.artifactSetHash, value.stagedSnapshotHash, value.sourceRequestDigest].every(
        (hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash),
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function finalInstructionsAttachment(
  value: ChatOperationV2FinalInstructions,
): ChatOperationV2ResultAttachment {
  return {
    attachmentId: 'final_pipeline_instructions',
    kind: 'notice',
    mediaType: 'application/json',
    label: FINAL_INSTRUCTIONS_LABEL,
    content: serializeFinalInstructions(value),
  };
}

export function projectedFinalInstructions(
  attachments: readonly ChatOperationV2ResultAttachment[],
  artifactSetHash: string | null,
): string | null {
  const attachment = attachments.find(
    (item) =>
      item.label === FINAL_INSTRUCTIONS_LABEL &&
      item.kind === 'notice' &&
      item.mediaType === 'application/json',
  );
  const instructions = attachment ? parseFinalInstructions(attachment.content) : null;
  if (attachment && (!instructions || instructions.artifactSetHash !== artifactSetHash))
    throw new Error('Final pipeline instructions do not match the published artifact set.');
  return instructions?.text ?? null;
}
