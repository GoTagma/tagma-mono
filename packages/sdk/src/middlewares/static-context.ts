import { basename } from 'path';
import type { MiddlewarePlugin, MiddlewareContext } from '../types';
import { validatePath } from '../utils';

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
    },
  },

  async enhance(
    prompt: string,
    config: Record<string, unknown>,
    ctx: MiddlewareContext,
  ): Promise<string> {
    const filePath = config.file as string;
    if (!filePath) throw new Error('static_context middleware: "file" is required');

    const safePath = validatePath(filePath, ctx.workDir);
    const file = Bun.file(safePath);

    if (!(await file.exists())) {
      console.warn(`static_context: file ${filePath} not found, skipping`);
      return prompt;
    }

    const content = await file.text();
    const label = (config.label as string) ?? `Reference: ${basename(filePath)}`;

    return `[${label}]\n${content}\n\n[Task]\n${prompt}`;
  },
};
