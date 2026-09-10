export const CHAT_DRAFT_MAX_FILE_BYTES = 1024 * 1024;
export const CHAT_DRAFT_MAX_FILES = 200;

export interface ChatOperationDraftFile {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly editable: boolean;
}

export interface ChatOperationDraft {
  readonly files: readonly ChatOperationDraftFile[];
  readonly totalFileCount: number;
  readonly omittedFileCount: number;
  readonly selected: { readonly id: string; readonly text: string; readonly hash: string } | null;
}

export interface ChatOperationDraftEdit {
  readonly fileId: string;
  readonly expectedHash: string;
  readonly text: string;
}

export function isChatOperationDraftEdit(value: unknown): value is ChatOperationDraftEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'expectedHash,fileId,text' &&
    typeof record.fileId === 'string' &&
    /^[a-f0-9]{64}$/.test(record.fileId) &&
    typeof record.expectedHash === 'string' &&
    /^[a-f0-9]{64}$/.test(record.expectedHash) &&
    typeof record.text === 'string' &&
    new TextEncoder().encode(record.text).length <= CHAT_DRAFT_MAX_FILE_BYTES
  );
}

export function isChatOperationDraft(value: unknown): value is ChatOperationDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'files,omittedFileCount,selected,totalFileCount' ||
    !Array.isArray(record.files) ||
    record.files.length > CHAT_DRAFT_MAX_FILES ||
    !Number.isSafeInteger(record.totalFileCount) ||
    Number(record.totalFileCount) < record.files.length ||
    record.omittedFileCount !== Number(record.totalFileCount) - record.files.length
  )
    return false;
  const ids = new Set<string>();
  for (const file of record.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      Object.keys(file).sort().join(',') !== 'bytes,editable,id,name' ||
      typeof file.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.id) ||
      ids.has(file.id) ||
      typeof file.name !== 'string' ||
      file.name.length > 4096 ||
      Array.from(file.name as string).some((character) => character.charCodeAt(0) < 32) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.editable !== 'boolean'
    )
      return false;
    ids.add(file.id);
  }
  if (record.selected === null) return true;
  if (!record.selected || typeof record.selected !== 'object') return false;
  const selected = record.selected as Record<string, unknown>;
  return (
    Object.keys(selected).sort().join(',') === 'hash,id,text' &&
    typeof selected.id === 'string' &&
    ids.has(selected.id) &&
    typeof selected.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(selected.hash) &&
    typeof selected.text === 'string' &&
    new TextEncoder().encode(selected.text).length <= CHAT_DRAFT_MAX_FILE_BYTES
  );
}
