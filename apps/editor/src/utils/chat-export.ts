import type { AssistantMessage, OpencodeThreadEntry, Part } from '../api/opencode-chat';
import { stripAskAiContext } from './ask-ai-context';

export type ChatExportFormat = 'md' | 'txt';

export interface ConversationExport {
  content: string;
  extension: ChatExportFormat;
  mimeType: string;
}

export interface BuildConversationExportOptions {
  format: ChatExportFormat;
  messages: readonly OpencodeThreadEntry[];
  title?: string | null;
  exportedAt?: Date;
}

const EDITOR_CONTEXT_RE = /^<editor-context>[\s\S]*?<\/editor-context>\n*/;

export function buildConversationExport({
  format,
  messages,
  title,
  exportedAt = new Date(),
}: BuildConversationExportOptions): ConversationExport {
  const heading = cleanTitle(title) || 'Chat Export';
  const body = messages
    .map((entry) => renderEntry(entry, format))
    .filter((part): part is string => part !== null);

  const content =
    format === 'md'
      ? [`# ${heading}`, `Exported: ${exportedAt.toISOString()}`, ...body].join('\n\n').trimEnd() +
        '\n'
      : [heading, `Exported: ${exportedAt.toISOString()}`, '', body.join('\n\n')]
          .join('\n')
          .trimEnd() + '\n';

  return {
    content,
    extension: format,
    mimeType: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
  };
}

export function conversationExportFilename(
  title: string | null | undefined,
  format: ChatExportFormat,
): string {
  const slug = (cleanTitle(title) || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `tagma-chat-${slug || 'conversation'}.${format}`;
}

export function downloadConversationExport(exported: ConversationExport, filename: string): void {
  const blob = new Blob([exported.content], { type: exported.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
}

function renderEntry(entry: OpencodeThreadEntry, format: ChatExportFormat): string | null {
  const role = entry.info.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (role === 'user' && isInternalUserEntry(entry.parts)) return null;

  const visibleParts = entry.parts
    .map((part) => renderPart(part, role, format))
    .filter((text): text is string => text.trim().length > 0);
  if (role === 'assistant') {
    const footer = renderAssistantFooter(entry.info as AssistantMessage, format);
    if (footer) visibleParts.push(footer);
  }
  if (visibleParts.length === 0) return null;

  const label = role === 'user' ? 'User' : 'Assistant';
  if (format === 'md') {
    return `## ${label}\n\n${visibleParts.join('\n\n')}`;
  }
  return `${label}:\n${visibleParts.join('\n\n')}`;
}

function renderPart(part: Part, role: 'user' | 'assistant', format: ChatExportFormat): string {
  if (part.type === 'text') {
    if ((part as { synthetic?: boolean }).synthetic) return '';
    return role === 'user' ? stripUserHiddenContext(part.text).trim() : part.text.trim();
  }
  if (part.type === 'reasoning') {
    const text = part.text.trim();
    if (!text) return '';
    return format === 'md' ? `**Reasoning**\n\n${text}` : `Reasoning:\n${text}`;
  }
  return '';
}

function renderAssistantFooter(info: AssistantMessage, format: ChatExportFormat): string | null {
  const tokens = info.tokens;
  const outputTokens = tokens?.output ?? 0;
  const inputTokens =
    (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0);
  const chunks: string[] = [];
  const usage: string[] = [];
  if (outputTokens > 0) usage.push(`${formatTokens(outputTokens)} output tokens`);
  if (inputTokens > 0) usage.push(`${formatTokens(inputTokens)} input tokens`);
  const cost = info.cost ?? 0;
  if (cost > 0) usage.push(formatCost(cost));
  if (usage.length > 0) chunks.push(`Usage: ${usage.join(', ')}`);
  if (info.finish && info.finish !== 'stop') chunks.push(`Finish: ${info.finish}`);
  if (info.error) chunks.push(`Error: ${assistantErrorText(info.error)}`);
  if (chunks.length === 0) return null;
  return format === 'md' ? `_${chunks.join(' · ')}_` : chunks.join(' · ');
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function assistantErrorText(error: NonNullable<AssistantMessage['error']>): string {
  const data = 'data' in error ? error.data : null;
  const message =
    data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
      ? data.message
      : null;
  return message ? `${error.name}: ${message}` : error.name;
}

function isInternalUserEntry(parts: readonly Part[]): boolean {
  return parts.some(
    (part) =>
      part.type === 'text' &&
      stripUserHiddenContext(part.text).trimStart().startsWith('<tagma-internal>'),
  );
}

function stripUserHiddenContext(text: string): string {
  return stripAskAiContext(text.replace(EDITOR_CONTEXT_RE, ''));
}
