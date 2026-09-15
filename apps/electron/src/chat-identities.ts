import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizeWorkspaceKey } from '@tagma/types/workspace-key';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY = /^[a-f0-9]{64}$/;
const MAX_BYTES = 4 * 1024 * 1024;
interface IdentityRecord {
  version: 1;
  workspace: string;
  rendererId: string;
  selectedConversation: string | null;
  credentials: Record<string, string>;
}
function fail(code: 'identity_invalid' | 'identity_mismatch' | 'identity_unavailable'): never {
  throw new Error(`desktop_chat_${code}`);
}
function assertId(value: string): void {
  if (typeof value !== 'string' || !ID.test(value)) fail('identity_invalid');
}
function assertPrivate(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    fail('identity_invalid');
}
function hasFilesystemObject(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    fail('identity_unavailable');
  }
}

/** Renderer credentials only. The V2 Host remains the authority for owners, grants and mutations. */
export class DesktopChatIdentityStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertPrivate(directory, true);
  }
  #coordinate(workspace: string) {
    if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0'))
      fail('identity_invalid');
    const canonical = normalizeWorkspaceKey(workspace);
    return {
      canonical,
      file: join(this.directory, `${createHash('sha256').update(canonical).digest('hex')}.json`),
    };
  }
  #load(workspace: string): IdentityRecord | null {
    assertPrivate(this.directory, true);
    const { canonical, file } = this.#coordinate(workspace);
    if (!hasFilesystemObject(file)) return null;
    assertPrivate(file, false);
    if (lstatSync(file).size > MAX_BYTES) fail('identity_invalid');
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      fail('identity_invalid');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity_invalid');
    const record = value as IdentityRecord;
    if (
      Object.keys(record).sort().join(',') !==
        'credentials,rendererId,selectedConversation,version,workspace' ||
      record.version !== 1 ||
      record.workspace !== canonical ||
      typeof record.rendererId !== 'string' ||
      !ID.test(record.rendererId) ||
      (record.selectedConversation !== null &&
        (typeof record.selectedConversation !== 'string' ||
          !ID.test(record.selectedConversation))) ||
      !record.credentials ||
      typeof record.credentials !== 'object' ||
      Array.isArray(record.credentials)
    )
      fail('identity_invalid');
    for (const [id, key] of Object.entries(record.credentials)) {
      if (!ID.test(id) || typeof key !== 'string' || !KEY.test(key)) fail('identity_invalid');
    }
    return record;
  }
  #save(record: IdentityRecord): void {
    assertPrivate(this.directory, true);
    const { file } = this.#coordinate(record.workspace);
    if (hasFilesystemObject(file)) assertPrivate(file, false);
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > MAX_BYTES) fail('identity_unavailable');
    const temporary = `${file}.${randomUUID()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      writeFileSync(descriptor, json, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporary, file);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  #owned(workspace: string, rendererId: string): IdentityRecord {
    const record = this.#load(workspace);
    if (!record || record.rendererId !== rendererId) fail('identity_mismatch');
    return record;
  }
  rendererId(workspace: string): string {
    let record = this.#load(workspace);
    if (!record) {
      record = {
        version: 1,
        workspace: this.#coordinate(workspace).canonical,
        rendererId: `renderer-${randomUUID()}`,
        selectedConversation: null,
        credentials: {},
      };
      this.#save(record);
    }
    return record.rendererId;
  }
  selectedConversation(workspace: string): string | null {
    return this.#load(workspace)?.selectedConversation ?? null;
  }
  selectConversation(workspace: string, rendererId: string, conversationId: string): void {
    assertId(conversationId);
    const record = this.#owned(workspace, rendererId);
    if (record.selectedConversation === conversationId) return;
    record.selectedConversation = conversationId;
    this.#save(record);
  }
  conversationKey(
    workspace: string,
    rendererId: string,
    conversationId: string,
    create: boolean,
  ): string | null {
    assertId(conversationId);
    const record = this.#owned(workspace, rendererId);
    const existing = Object.prototype.hasOwnProperty.call(record.credentials, conversationId)
      ? record.credentials[conversationId]!
      : null;
    if (existing || !create) return existing;
    const key = randomBytes(32).toString('hex');
    Object.defineProperty(record.credentials, conversationId, {
      value: key,
      enumerable: true,
      configurable: true,
    });
    this.#save(record);
    return key;
  }
}

/** Called only after Electron authenticates the sending top-level editor frame. */
export function executeDesktopChatIdentityRequest(
  store: DesktopChatIdentityStore,
  boundWorkspace: string | null,
  value: unknown,
): string | boolean | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('identity_invalid');
  const request = value as Record<string, unknown>;
  if (
    typeof request.workspace !== 'string' ||
    !boundWorkspace ||
    normalizeWorkspaceKey(request.workspace) !== normalizeWorkspaceKey(boundWorkspace)
  )
    fail('identity_mismatch');
  const fields =
    request.method === 'renderer' || request.method === 'selected'
      ? ['method', 'workspace']
      : request.method === 'select'
        ? ['conversationId', 'method', 'rendererId', 'workspace']
        : request.method === 'credential'
          ? ['conversationId', 'create', 'method', 'rendererId', 'workspace']
          : null;
  if (!fields || Object.keys(request).sort().join(',') !== fields.sort().join(','))
    fail('identity_invalid');
  if (request.method === 'renderer') return store.rendererId(boundWorkspace);
  if (request.method === 'selected') return store.selectedConversation(boundWorkspace);
  if (typeof request.rendererId !== 'string' || typeof request.conversationId !== 'string')
    fail('identity_invalid');
  if (request.method === 'select') {
    store.selectConversation(boundWorkspace, request.rendererId, request.conversationId);
    return true;
  }
  if (typeof request.create !== 'boolean') fail('identity_invalid');
  return store.conversationKey(
    boundWorkspace,
    request.rendererId,
    request.conversationId,
    request.create,
  );
}
