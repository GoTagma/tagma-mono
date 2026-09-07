import type { ChatOperationV2OperationDetail } from '../api/chat-operations';
import { redactDiagnosticText } from '../../shared/diagnostics';

export type ChatHistoryTopic = { status: 'ready'; text: string } | { status: 'unavailable' };

export function chatHistoryTopic(detail: ChatOperationV2OperationDetail): ChatHistoryTopic {
  const text =
    detail.userMessage.text.trim() ||
    detail.userMessage.attachments.map(({ label }) => label).join('; ') ||
    'Attached context';
  return {
    status: 'ready',
    text: Array.from(redactDiagnosticText(text).replace(/\s+/g, ' ')).slice(0, 160).join(''),
  };
}
