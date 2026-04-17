import type { PromptDocument, PromptContextBlock } from './types';

/**
 * Build a fresh `PromptDocument` from a raw task string.
 * Middlewares receive this from the engine and push context blocks onto
 * `contexts`. `task` is the user's original prompt and should not be
 * rewritten by middlewares (translation middlewares are the rare exception).
 */
export function promptDocumentFromString(task: string): PromptDocument {
  return { contexts: [], task };
}

/**
 * Serialize a `PromptDocument` to the default string form consumed by
 * drivers that read `task.prompt` instead of `ctx.promptDoc`.
 *
 * Format:
 *
 *     [<label1>]
 *     <content1>
 *
 *     [<label2>]
 *     <content2>
 *
 *     <task>
 *
 * Each context block is separated from the next (and from `task`) by a
 * single blank line. No implicit `[Task]` header is emitted — that framing
 * is the driver's responsibility (e.g. opencode's `agent_profile` wrapping).
 * Emitting one here would compose incorrectly with any driver that also
 * adds a `[Task]` header, producing a double header that some models
 * (observed with `opencode/big-pickle`) misread as a cut-off message.
 */
export function serializePromptDocument(doc: PromptDocument): string {
  if (doc.contexts.length === 0) return doc.task;
  const blocks = doc.contexts.map((c) => `[${c.label}]\n${c.content}`);
  return `${blocks.join('\n\n')}\n\n${doc.task}`;
}

/**
 * Helper for middlewares: return a new document with the given block
 * appended to `contexts`, preserving immutability of `doc`.
 */
export function appendContext(
  doc: PromptDocument,
  block: PromptContextBlock,
): PromptDocument {
  return { contexts: [...doc.contexts, block], task: doc.task };
}
