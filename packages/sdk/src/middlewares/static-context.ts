import { basename } from 'path';
import type { MiddlewarePlugin, MiddlewareContext, PromptDocument } from '@tagma/types';
import { appendContext, validatePath } from '@tagma/core';

const DEFAULT_MAX_CONTEXT_CHARS = 200_000;

function parseMaxChars(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_CONTEXT_CHARS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('static_context middleware: "max_chars" must be a positive integer');
  }
  return value;
}

export const StaticContextMiddleware: MiddlewarePlugin = {
  name: 'static_context',
  schema: {
    description: 'Prepend a reference file to the prompt as static context.',
    fields: {
      file: {
        type: 'path',
        required: true,
        description: 'Path to the reference file (relative to workDir or absolute).',
        placeholder: 'docs/spec.md',
      },
      label: {
        type: 'string',
        description: 'Header shown before the content. Defaults to "Reference: <basename>".',
        placeholder: 'Reference: spec.md',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum number of characters to read from the file.',
        default: DEFAULT_MAX_CONTEXT_CHARS,
        min: 1,
      },
    },
  },

  async enhanceDoc(
    doc: PromptDocument,
    config: Record<string, unknown>,
    ctx: MiddlewareContext,
  ): Promise<PromptDocument> {
    const filePath = config.file as string;
    if (!filePath) throw new Error('static_context middleware: "file" is required');

    const safePath = validatePath(filePath, ctx.workDir);
    const file = Bun.file(safePath);

    if (!(await file.exists())) {
      console.warn(`static_context: file ${filePath} not found, skipping`);
      return doc;
    }

    const maxChars = parseMaxChars(config.max_chars);
    const rawContent = await file.slice(0, maxChars + 1).text();
    const content =
      rawContent.length > maxChars
        ? `${rawContent.slice(0, maxChars)}\n\n[truncated static context at ${maxChars} chars]`
        : rawContent;
    const label = (config.label as string) ?? `Reference: ${basename(filePath)}`;

    // Append a labeled context block; the engine's serializer joins blocks
    // with blank lines and places the task last. No [Task] header here —
    // that framing is the driver's concern (e.g. opencode's agent_profile).
    return appendContext(doc, { label, content });
  },
};
