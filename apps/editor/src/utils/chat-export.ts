import type { OpencodeThreadEntry, Part } from '../api/opencode-chat';
import { redactDiagnosticText } from '../../shared/diagnostics.js';
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

/** Export only the Host-projected V2 transcript visible to the user. */
export function buildConversationExport({
  format,
  messages,
  title,
  exportedAt = new Date(),
}: BuildConversationExportOptions): ConversationExport {
  const heading = cleanTitle(title) || 'Chat Export';
  const entries = messages
    .map((entry) => renderEntry(entry, format))
    .filter((entry): entry is string => entry !== null);
  const metadata = `Exported: ${exportedAt.toISOString()}`;
  const content =
    format === 'md'
      ? [`# ${heading}`, '', `_${metadata}_`, '', entries.join('\n\n')].join('\n').trimEnd() + '\n'
      : [heading, metadata, '', entries.join('\n\n')].join('\n').trimEnd() + '\n';
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

function renderEntry(entry: OpencodeThreadEntry, format: ChatExportFormat): string | null {
  if (entry.info.role !== 'user' && entry.info.role !== 'assistant') return null;
  const parts = entry.parts
    .map((part) => renderPart(part, entry.info.role))
    .filter((value) => value.length > 0);
  if (parts.length === 0) return null;
  const label = entry.info.role === 'user' ? 'User' : 'Assistant';
  return format === 'md'
    ? `## ${label}\n\n${parts.join('\n\n')}`
    : `${label}:\n${parts.join('\n\n')}`;
}

function renderPart(part: Part, role: 'user' | 'assistant'): string {
  if (part.type !== 'text' || (part as { synthetic?: boolean }).synthetic) return '';
  const visible = role === 'user' ? stripUserHiddenContext(part.text) : part.text;
  return redactDiagnosticText(visible).trim();
}

function stripUserHiddenContext(text: string): string {
  return stripAskAiContext(text.replace(EDITOR_CONTEXT_RE, '')).trim();
}

function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
}
