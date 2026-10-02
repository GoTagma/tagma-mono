import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { ensureServerRecordControlRootSync, type ServerRecordContext } from '../server-record-auth';
import { isChatRepairErrorEvidence, type ChatRepairErrorEvidence } from './repair-error-evidence';

export const MAX_CHAT_REPAIR_EVIDENCE_BYTES = 64 * 1024 * 1024;
const DIRECTORY = 'repair-error-evidence';
const HASH = /^[0-9a-f]{64}$/;
const FILE = /^([0-9a-f]{64})\.json$/;
const PENDING = /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ChatRepairEvidenceOwner {
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly stageId: string;
}

/** The surrounding stage record HMAC authenticates the owner and complete blob digest. */
export interface ChatRepairEvidenceReference extends ChatRepairEvidenceOwner {
  readonly schemaVersion: 1;
  readonly kind: 'repair-evidence-blob';
  readonly trialId: string;
  readonly hash: string;
  readonly byteLength: number;
}

export class ChatRepairEvidenceStorageError extends Error {
  readonly code: 'repair_evidence_limit' | 'repair_evidence_unavailable';
  constructor(code: ChatRepairEvidenceStorageError['code']) {
    super(
      code === 'repair_evidence_limit'
        ? 'Complete repair evidence exceeds its byte limit.'
        : 'Complete repair evidence is unavailable or changed.',
    );
    this.code = code;
  }
}

export function isChatRepairEvidenceReference(
  value: unknown,
  owner: ChatRepairEvidenceOwner,
): value is ChatRepairEvidenceReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as ChatRepairEvidenceReference;
  return (
    Object.keys(raw).length === 9 &&
    raw.schemaVersion === 1 &&
    raw.kind === 'repair-evidence-blob' &&
    raw.workspaceScopeId === owner.workspaceScopeId &&
    raw.operationId === owner.operationId &&
    raw.operationGeneration === owner.operationGeneration &&
    raw.stageId === owner.stageId &&
    typeof raw.trialId === 'string' &&
    raw.trialId.length > 0 &&
    raw.trialId.length <= 256 &&
    typeof raw.hash === 'string' &&
    HASH.test(raw.hash) &&
    Number.isSafeInteger(raw.byteLength) &&
    raw.byteLength > 0 &&
    raw.byteLength <= MAX_CHAT_REPAIR_EVIDENCE_BYTES
  );
}

function directory(context: ServerRecordContext, create: boolean): string {
  const root = join(context.controlRoot, DIRECTORY);
  if (create) ensureServerRecordControlRootSync({ ...context, controlRoot: root });
  else if (!existsSync(root))
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  // Reuse the same authenticated control path checks on every read, without creating missing data.
  const stage = lstatSync(context.controlRoot);
  const stat = lstatSync(root);
  if (
    !stage.isDirectory() ||
    stage.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(root) !== join(realpathSync.native(context.controlRoot), DIRECTORY)
  )
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  if (create && process.platform !== 'win32') chmodSync(root, 0o700);
  if (process.platform !== 'win32' && (lstatSync(root).mode & 0o077) !== 0)
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  return root;
}

function syncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? ''))
      throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function cleanInterruptedPublications(root: string): void {
  // Cleanup precedes hash reuse and size accounting: a crash between link()
  // and unlink() leaves the published hash and pending name with nlink=2.
  for (const name of readdirSync(root)) {
    if (!PENDING.test(name)) continue;
    const stat = lstatSync(join(root, name));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink > 2 ||
      stat.size > MAX_CHAT_REPAIR_EVIDENCE_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    unlinkSync(join(root, name));
  }
  syncDirectory(root);
}

export function readChatRepairEvidenceBlob(
  context: ServerRecordContext,
  owner: ChatRepairEvidenceOwner,
  reference: ChatRepairEvidenceReference,
): ChatRepairErrorEvidence {
  if (!isChatRepairEvidenceReference(reference, owner))
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  const root = directory(context, false);
  const path = join(root, `${reference.hash}.json`);
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== BigInt(reference.byteLength) ||
    (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)
  )
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    const bytes = Buffer.alloc(reference.byteLength + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = lstatSync(path, { bigint: true });
    const finished = fstatSync(descriptor, { bigint: true });
    if (
      offset !== reference.byteLength ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      finished.size !== opened.size ||
      realpathSync.native(path) !== join(realpathSync.native(root), `${reference.hash}.json`)
    )
      throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    const text = bytes.subarray(0, offset).toString('utf8');
    const evidence = { trialId: reference.trialId, hash: reference.hash, text };
    if (
      Buffer.byteLength(text) !== offset ||
      createHash('sha256').update(bytes.subarray(0, offset)).digest('hex') !== reference.hash ||
      !isChatRepairErrorEvidence(evidence)
    )
      throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    return evidence;
  } finally {
    closeSync(descriptor);
  }
}

export function writeChatRepairEvidenceBlob(
  context: ServerRecordContext,
  owner: ChatRepairEvidenceOwner,
  evidence: ChatRepairErrorEvidence,
): ChatRepairEvidenceReference {
  const byteLength = Buffer.byteLength(evidence.text);
  if (byteLength > MAX_CHAT_REPAIR_EVIDENCE_BYTES)
    throw new ChatRepairEvidenceStorageError('repair_evidence_limit');
  if (!isChatRepairErrorEvidence(evidence))
    throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
  const reference: ChatRepairEvidenceReference = {
    schemaVersion: 1,
    kind: 'repair-evidence-blob',
    ...owner,
    trialId: evidence.trialId,
    hash: evidence.hash,
    byteLength,
  };
  const root = directory(context, true);
  cleanInterruptedPublications(root);
  const path = join(root, `${reference.hash}.json`);
  if (existsSync(path)) {
    readChatRepairEvidenceBlob(context, owner, reference);
    syncDirectory(root);
    syncDirectory(context.controlRoot);
    return reference;
  }
  // At most one old 64MiB blob and one replacement are retained during publication.
  const storedBytes = readdirSync(root).reduce((sum, name) => {
    if (!FILE.test(name)) throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    const stat = lstatSync(join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new ChatRepairEvidenceStorageError('repair_evidence_unavailable');
    return sum + stat.size;
  }, 0);
  if (storedBytes + byteLength > 2 * MAX_CHAT_REPAIR_EVIDENCE_BYTES)
    throw new ChatRepairEvidenceStorageError('repair_evidence_limit');
  const temporary = join(root, `.pending-${randomUUID()}`);
  let descriptor: number | null = null;
  let publicationError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const bytes = Buffer.from(evidence.text);
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } catch (error) {
    publicationError = error;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    // Preserve the primary write failure while keeping cleanup failure visible
    // without publishing paths or arbitrary filesystem exception text.
    console.warn(
      '[chat-repair-evidence] temporary_cleanup_failed',
      cleanupErrors.map((error) => {
        const code = (error as NodeJS.ErrnoException)?.code;
        return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'cleanup_error';
      }),
    );
  }
  if (publicationError !== undefined) throw publicationError;
  if (cleanupErrors.length) throw cleanupErrors[0];
  readChatRepairEvidenceBlob(context, owner, reference);
  syncDirectory(root);
  syncDirectory(context.controlRoot);
  return reference;
}

/** Called only after the small authenticated pointer has been durably replaced. */
export function pruneChatRepairEvidenceBlobs(
  context: ServerRecordContext,
  keep: ChatRepairEvidenceReference | null,
): void {
  if (!existsSync(join(context.controlRoot, DIRECTORY))) return;
  const root = directory(context, false);
  cleanInterruptedPublications(root);
  for (const name of readdirSync(root)) {
    if (!FILE.test(name) || (keep && name === `${keep.hash}.json`)) continue;
    const stat = lstatSync(join(root, name));
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) unlinkSync(join(root, name));
  }
  syncDirectory(root);
}
