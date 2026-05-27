import type { AssistantMessage, Part } from '../../api/opencode-chat';

export type MessageRenderInfo = {
  role: 'user' | 'assistant';
  error?: AssistantMessage['error'];
  finish?: string;
  cost?: number;
  tokens?: AssistantMessage['tokens'];
};

export function hasAssistantFooterInfo(info: MessageRenderInfo): boolean {
  if (info.role !== 'assistant') return false;
  const tokens = info.tokens;
  const totalTokens =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0);
  return totalTokens > 0 || (info.cost ?? 0) > 0 || !!info.error || !!info.finish;
}

export function isRenderableMessagePart(part: Part): boolean {
  if (part.type === 'text') {
    if ((part as { synthetic?: boolean }).synthetic) return false;
    return part.text.trim().length > 0;
  }
  if (part.type === 'reasoning') return part.text.trim().length > 0;
  if (part.type === 'step-finish') return false;
  return true;
}

export function getRenderableMessageParts(parts: Part[]): Part[] {
  return parts.filter(isRenderableMessagePart);
}

export function shouldRenderMessageBubble(entry: {
  info: MessageRenderInfo;
  parts: Part[];
}): boolean {
  return entry.parts.some(isRenderableMessagePart) || hasAssistantFooterInfo(entry.info);
}
