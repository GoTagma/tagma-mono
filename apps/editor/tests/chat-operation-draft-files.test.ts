import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDraftFiles, writeDraftFile } from '../server/chat-operations/draft-files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-draft-'));
  roots.push(root);
  mkdirSync(join(root, 'pipeline'));
  writeFileSync(join(root, 'pipeline', 'pipeline.yaml'), 'pipeline: [invalid');
  writeFileSync(join(root, 'pipeline', 'helper.txt'), 'old helper');
  return { root, files: ['pipeline/pipeline.yaml', 'pipeline/helper.txt'] };
}
test('invalid YAML and companions remain readable and manually editable', () => {
  const { root, files } = fixture();
  const draft = readDraftFiles(root, files);
  expect(draft.selected?.text).toBe('pipeline: [invalid');
  const saved = writeDraftFile(root, files, {
    fileId: draft.selected!.id,
    expectedHash: draft.selected!.hash,
    text: 'still: [invalid',
  });
  expect(saved.selected?.text).toBe('still: [invalid');
  expect(readFileSync(join(root, files[1]!), 'utf8')).toBe('old helper');
});
test('a stale edit cannot overwrite another edit, and arbitrary files cannot be selected', () => {
  const { root, files } = fixture();
  const before = readDraftFiles(root, files).selected!;
  writeFileSync(join(root, files[0]!), 'newer');
  expect(() =>
    writeDraftFile(root, files, { fileId: before.id, expectedHash: before.hash, text: 'stale' }),
  ).toThrow('changed');
  expect(readFileSync(join(root, files[0]!), 'utf8')).toBe('newer');
  expect(() => readDraftFiles(root, files, 'a'.repeat(64))).toThrow('unavailable');
  expect(() => readDraftFiles(root, ['../outside.yaml'])).toThrow();
});

test('binary and oversized artifacts stay preserved and directory links cannot escape the draft', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'pipeline/binary.bin'), Buffer.from([0, 255, 13]));
  writeFileSync(join(root, 'pipeline/large.txt'), 'x'.repeat(1024 * 1024 + 1));
  expect(readDraftFiles(root, ['pipeline/binary.bin']).selected).toBeNull();
  expect(readDraftFiles(root, ['pipeline/large.txt']).files[0]?.editable).toBe(false);
  const other = mkdtempSync(join(tmpdir(), 'tagma-draft-other-'));
  roots.push(other);
  writeFileSync(join(other, 'private.txt'), 'outside');
  symlinkSync(other, join(root, 'pipeline/linked'), 'junction');
  expect(() => readDraftFiles(root, ['pipeline/linked/private.txt'])).toThrow('Unsafe');
  expect(readFileSync(join(other, 'private.txt'), 'utf8')).toBe('outside');
});
