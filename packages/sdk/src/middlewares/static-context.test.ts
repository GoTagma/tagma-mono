import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticContextMiddleware } from './static-context';
import type { MiddlewareContext, PromptDocument } from '@tagma/types';

describe('StaticContextMiddleware', () => {
  test('caps static context reads when max_chars is configured', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-'));
    try {
      writeFileSync(join(tmp, 'reference.txt'), 'abcdefghij');
      const doc: PromptDocument = { contexts: [], task: 'Do the work' };
      const ctx: MiddlewareContext = {
        workDir: tmp,
        track: { id: 't', name: 'T', tasks: [] },
        task: { id: 'a', name: 'A', prompt: 'Do the work' },
      };

      const enhanced = await StaticContextMiddleware.enhanceDoc(
        doc,
        { file: 'reference.txt', max_chars: 5 },
        ctx,
      );

      expect(enhanced.contexts).toHaveLength(1);
      expect(enhanced.contexts[0].content).toContain('abcde');
      expect(enhanced.contexts[0].content).not.toContain('fghij');
      expect(enhanced.contexts[0].content).toContain('truncated static context');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
