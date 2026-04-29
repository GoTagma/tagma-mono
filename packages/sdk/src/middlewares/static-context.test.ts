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

  test('truncates by character count, not bytes, for multi-byte UTF-8 content', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-cjk-'));
    try {
      // 10 CJK Unified Ideographs; each encodes as 3 bytes in UTF-8.
      // The previous byte-based Blob.slice(0, max_chars + 1) would have
      // returned only 6 bytes (= 2 whole chars + a partial third), so
      // rawContent.length came back as ~2-3 and never hit the truncation
      // branch even though the file was clearly bigger than max_chars.
      writeFileSync(join(tmp, 'reference.txt'), '一二三四五六七八九十');
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
      const content = enhanced.contexts[0].content;
      // First 5 *characters*, not first 5 bytes.
      expect(content).toContain('一二三四五');
      // No characters past the 5-char boundary.
      expect(content).not.toContain('六');
      // No U+FFFD replacement char from a mid-UTF-8 boundary.
      expect(content).not.toContain('�');
      // Truncation is reported (the bug we are fixing was a silent miss).
      expect(content).toContain('truncated static context at 5 chars');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
