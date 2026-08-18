import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticContextMiddleware } from './static-context';
import { promptDocumentFromString, serializePromptDocument } from '@tagma/core';
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
      // 10 accented Latin characters; each encodes as 2 bytes in UTF-8.
      // The previous byte-based Blob.slice(0, max_chars + 1) would have
      // returned only 6 bytes (= 3 whole chars), so rawContent.length
      // came back as 3 and never hit the truncation
      // branch even though the file was clearly bigger than max_chars.
      writeFileSync(
        join(tmp, 'reference.txt'),
        '\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc\u00e7\u00f8\u00e5',
      );
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
      expect(content).toContain('\u00e1\u00e9\u00ed\u00f3\u00fa');
      // No characters past the 5-char boundary.
      expect(content).not.toContain('\u00f1');
      // No U+FFFD replacement char from a mid-UTF-8 boundary.
      expect(content).not.toContain('\uFFFD');
      // Truncation is reported (the bug we are fixing was a silent miss).
      expect(content).toContain('truncated static context at 5 chars');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects malformed string fields with plugin errors', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-invalid-'));
    try {
      const doc: PromptDocument = { contexts: [], task: 'Do the work' };
      const ctx: MiddlewareContext = {
        workDir: tmp,
        track: { id: 't', name: 'T', tasks: [] },
        task: { id: 'a', name: 'A', prompt: 'Do the work' },
      };

      await expect(StaticContextMiddleware.enhanceDoc(doc, { file: 42 }, ctx)).rejects.toThrow(
        /"file" must be a string/,
      );
      await expect(StaticContextMiddleware.enhanceDoc(doc, { file: '   ' }, ctx)).rejects.toThrow(
        /"file" is required/,
      );
      await expect(
        StaticContextMiddleware.enhanceDoc(doc, { file: 'missing.txt', label: 42 }, ctx),
      ).rejects.toThrow(/"label" must be a string/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing required source file fails loudly instead of silently skipping', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-missing-'));
    try {
      const doc = promptDocumentFromString('verify the allowlist');
      const ctx: MiddlewareContext = {
        workDir: tmp,
        track: { id: 't', name: 'T', tasks: [] },
        task: { id: 'a', name: 'A', prompt: 'verify the allowlist' },
      };
      await expect(
        StaticContextMiddleware.enhanceDoc(doc, { file: 'trusted-sources.yaml' }, ctx),
      ).rejects.toThrow(/static_context middleware: file "trusted-sources\.yaml" not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a present source file is prepended as a labelled context block', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-present-'));
    try {
      writeFileSync(join(tmp, 'trusted-sources.yaml'), 'version: 1\nsources: []\n');
      const doc = promptDocumentFromString('verify the allowlist');
      const ctx: MiddlewareContext = {
        workDir: tmp,
        track: { id: 't', name: 'T', tasks: [] },
        task: { id: 'a', name: 'A', prompt: 'verify the allowlist' },
      };
      const enhanced = await StaticContextMiddleware.enhanceDoc(
        doc,
        { file: 'trusted-sources.yaml' },
        ctx,
      );
      const serialized = serializePromptDocument(enhanced);
      expect(serialized).toContain('Reference: trusted-sources.yaml');
      expect(serialized).toContain('version: 1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('config validation still fails before any file access', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-static-context-config-'));
    try {
      const doc = promptDocumentFromString('work');
      const ctx: MiddlewareContext = {
        workDir: tmp,
        track: { id: 't', name: 'T', tasks: [] },
        task: { id: 'a', name: 'A', prompt: 'work' },
      };
      await expect(
        StaticContextMiddleware.enhanceDoc(doc, { file: 'x.yaml', max_chars: 0 }, ctx),
      ).rejects.toThrow(/max_chars/);
      await expect(StaticContextMiddleware.enhanceDoc(doc, {}, ctx)).rejects.toThrow(
        /"file" is required/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
