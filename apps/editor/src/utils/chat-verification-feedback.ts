import type { ChatOperationFeedback } from '../../shared/chat-operation-feedback';

const STAGE_LABELS: Record<ChatOperationFeedback['stage'], string> = {
  compile: 'Compilation',
  trial_plan: 'Trial planning',
  trial: 'Trial verification',
};

export function chatOperationFeedbackStageLabel(stage: ChatOperationFeedback['stage']): string {
  return STAGE_LABELS[stage];
}

export interface ChatVerificationFeedbackExcerpt {
  readonly text: string;
  readonly truncated: boolean;
}

const EXCERPT_MAX_LINES = 3;
const EXCERPT_MAX_CHARS = 280;

/**
 * The retained-verification notice never scrolls its own evidence: the excerpt
 * is a scan target, and the full details live in the draft editor's read-only
 * feedback view. Keep both bounds here so the panel height stays predictable.
 */
export function verificationFeedbackExcerpt(details: string): ChatVerificationFeedbackExcerpt {
  const lines = details.split('\n');
  let text = lines.slice(0, EXCERPT_MAX_LINES).join('\n');
  let truncated = lines.length > EXCERPT_MAX_LINES;
  if (text.length > EXCERPT_MAX_CHARS) {
    text = text.slice(0, EXCERPT_MAX_CHARS).trimEnd();
    truncated = true;
  }
  return { text: truncated ? `${text}…` : text, truncated };
}
