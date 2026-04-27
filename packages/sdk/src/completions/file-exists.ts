import { stat } from 'node:fs/promises';
import type { CompletionPlugin, CompletionContext, TaskResult } from '@tagma/types';
import { validatePath } from '@tagma/core';

type Kind = 'file' | 'dir' | 'any';

export const FileExistsCompletion: CompletionPlugin = {
  name: 'file_exists',
  schema: {
    description: 'Mark the task successful when a target file or directory exists.',
    fields: {
      path: {
        type: 'path',
        required: true,
        description: 'Path to check (relative to workDir or absolute).',
      },
      kind: {
        type: 'enum',
        enum: ['file', 'dir', 'any'],
        default: 'any',
        description: 'Restrict to a file, directory, or accept either.',
      },
      min_size: {
        type: 'number',
        min: 0,
        description: 'Optional minimum size in bytes (files only).',
      },
    },
  },

  async check(
    config: Record<string, unknown>,
    _result: TaskResult,
    ctx: CompletionContext,
  ): Promise<boolean> {
    const filePath = config.path as string;
    if (!filePath) throw new Error('file_exists completion: "path" is required');

    const safePath = validatePath(filePath, ctx.workDir);

    const kind = (config.kind as Kind | undefined) ?? 'any';
    if (kind !== 'file' && kind !== 'dir' && kind !== 'any') {
      throw new Error(
        `file_exists completion: "kind" must be "file" | "dir" | "any", got "${kind}"`,
      );
    }

    const minSize = config.min_size;
    if (minSize != null && (typeof minSize !== 'number' || minSize < 0)) {
      throw new Error(`file_exists completion: "min_size" must be a non-negative number`);
    }

    try {
      const st = await stat(safePath);
      if (kind === 'file' && !st.isFile()) return false;
      if (kind === 'dir' && !st.isDirectory()) return false;
      if (typeof minSize === 'number' && st.isFile() && st.size < minSize) return false;
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      // Permission / IO errors should surface, not silently mean "missing"
      throw err;
    }
  },
};
