import type { PortDef, PromptContextBlock, PromptDocument } from './types';

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

/**
 * Helper: return a new document with the given block PREPENDED. The
 * engine uses this to place port-related context blocks (`[Inputs]`,
 * `[Output Format]`) at the top of the document so middlewares that
 * assemble retrieval context against the task's inputs see them.
 */
export function prependContext(
  doc: PromptDocument,
  block: PromptContextBlock,
): PromptDocument {
  return { contexts: [block, ...doc.contexts], task: doc.task };
}

/**
 * Build an `[Inputs]` context block from a map of resolved port inputs.
 * Each input is rendered on its own line as `name: <value>` with an
 * optional trailing `# <description>` comment so the model has both the
 * value and the reason it matters.
 *
 * The block is *only* useful for AI tasks; command tasks consume inputs
 * through `{{inputs.X}}` substitution in their command line and do not
 * need this context.
 *
 * Returns null when there are no inputs to render — callers can forward
 * that nullish value to `prependContext` via an `if (block)` check so
 * empty-input tasks don't grow a noise block in their prompt.
 */
export function renderInputsBlock(
  inputsDecl: readonly PortDef[] | undefined,
  values: Readonly<Record<string, unknown>>,
): PromptContextBlock | null {
  if (!inputsDecl || inputsDecl.length === 0) return null;
  const lines: string[] = [];
  for (const port of inputsDecl) {
    if (!(port.name in values)) continue;
    const raw = values[port.name];
    const rendered = renderInputValue(raw);
    const descr = port.description?.trim();
    lines.push(descr ? `${port.name}: ${rendered}  # ${descr}` : `${port.name}: ${rendered}`);
  }
  if (lines.length === 0) return null;
  return { label: 'Inputs', content: lines.join('\n') };
}

function renderInputValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build an `[Output Format]` context block from a task's declared output
 * ports. The block instructs the model to emit a final-line JSON object
 * matching the declared schema so `extractTaskOutputs` can pick it up
 * without fragile heuristics. Returns null when the task declares no
 * outputs.
 *
 * The instruction is deliberately short and explicit — a terse "emit
 * this object as JSON on the final line" beats a long schema dump
 * because shorter prompts compose better with downstream middlewares.
 */
export function renderOutputSchemaBlock(
  outputsDecl: readonly PortDef[] | undefined,
): PromptContextBlock | null {
  if (!outputsDecl || outputsDecl.length === 0) return null;
  const lines: string[] = [];
  lines.push(
    'After your response, emit a single JSON object on the FINAL line with these keys:',
  );
  for (const port of outputsDecl) {
    const descr = port.description?.trim();
    const enumHint =
      port.type === 'enum' && port.enum?.length
        ? ` (one of: ${port.enum.map((v) => JSON.stringify(v)).join(', ')})`
        : '';
    lines.push(
      descr
        ? `  - ${port.name} (${port.type}${enumHint}): ${descr}`
        : `  - ${port.name} (${port.type}${enumHint})`,
    );
  }
  const example = buildExampleObject(outputsDecl);
  lines.push('');
  lines.push(`Example final line: ${JSON.stringify(example)}`);
  return { label: 'Output Format', content: lines.join('\n') };
}

function buildExampleObject(outputsDecl: readonly PortDef[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const port of outputsDecl) {
    if (port.default !== undefined) {
      example[port.name] = port.default;
      continue;
    }
    switch (port.type) {
      case 'string':
        example[port.name] = '...';
        break;
      case 'number':
        example[port.name] = 0;
        break;
      case 'boolean':
        example[port.name] = false;
        break;
      case 'enum':
        example[port.name] = port.enum?.[0] ?? '...';
        break;
      case 'json':
      default:
        example[port.name] = null;
    }
  }
  return example;
}
