import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  CHAT_DRAFT_MAX_FILES,
  CHAT_DRAFT_MAX_FILE_BYTES,
  isChatOperationDraftEdit,
  type ChatOperationDraft,
  type ChatOperationDraftEdit,
} from '../../shared/chat-operation-draft.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function readTextBytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(CHAT_DRAFT_MAX_FILE_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > CHAT_DRAFT_MAX_FILE_BYTES)
      throw new Error('Draft file exceeds the text editing limit.');
    return buffer.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

function draftConflict(): never {
  throw Object.assign(new Error('Draft file changed; reload it before saving.'), {
    code: 'stale_operation',
  });
}

/** Paths come from the authenticated stage artifact inventory, never from the renderer. */
function draftPath(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid draft artifact.');
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, name);
  if (relative(absoluteRoot, path).startsWith('..')) throw new Error('Invalid draft artifact.');
  let current = absoluteRoot;
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())
    throw new Error('Unsafe draft root.');
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('Unsafe draft artifact.');
  }
  return path;
}

export function readDraftFiles(
  root: string,
  names: readonly string[],
  selectedId?: string,
): ChatOperationDraft {
  const selectedNames = [...new Set(names)].slice(0, CHAT_DRAFT_MAX_FILES);
  const files = selectedNames.map((name) => {
    const bytes = lstatSync(draftPath(root, name)).size;
    return { id: hash(name), name, bytes, editable: bytes <= CHAT_DRAFT_MAX_FILE_BYTES };
  });
  const selected = selectedId ? files.find((file) => file.id === selectedId) : files[0];
  if (selectedId && !selected) throw new Error('Draft file is unavailable.');
  let content: ChatOperationDraft['selected'] = null;
  if (selected?.editable) {
    const bytes = readTextBytes(draftPath(root, selected.name));
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.includes('\0')) content = { id: selected.id, text, hash: hash(bytes) };
    } catch {
      /* Binary companions remain preserved, but are not a text editor target. */
    }
  }
  return {
    files,
    totalFileCount: names.length,
    omittedFileCount: Math.max(0, names.length - files.length),
    selected: content,
  };
}

export function writeDraftFile(
  root: string,
  names: readonly string[],
  edit: ChatOperationDraftEdit,
): ChatOperationDraft {
  if (!isChatOperationDraftEdit(edit)) throw new Error('Invalid draft edit.');
  const draft = readDraftFiles(root, names, edit.fileId);
  if (!draft.selected || draft.selected.hash !== edit.expectedHash) draftConflict();
  const file = draft.files.find((file) => file.id === edit.fileId)!;
  const path = draftPath(root, file.name);
  const temporary = resolve(dirname(path), `.draft-edit-${randomUUID()}.tmp`);
  let cleanupError: unknown;
  try {
    const mode = lstatSync(path).mode & 0o777;
    const fd = openSync(temporary, 'wx', mode);
    try {
      writeFileSync(fd, edit.text, 'utf8');
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (hash(readTextBytes(draftPath(root, file.name))) !== edit.expectedHash) draftConflict();
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  return readDraftFiles(root, names, edit.fileId);
}
