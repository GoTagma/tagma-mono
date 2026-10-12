// Prepared-only B12 candidate. Source review only; ready: false.
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
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  ensureServerRecordControlRootSync,
  MAX_SERVER_RECORD_BYTES,
  readAuthenticatedServerRecordSync,
  syncAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from '../server-record-auth';
import { redactChatRepairErrorOutput } from './repair-error-evidence';
import type { ChatRepairEvidenceOwner } from './repair-evidence-store';
import { readCompleteRepairOutput } from './repair-output-reader';

/** Independent, per-stage aggregate blob bound; repair evidence pruning never applies. */
export const MAX_TRIAL_STREAM_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const DIRECTORY = '.trial-streams';
const HASH = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TASK_ID = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const TERMINAL_STATUSES = new Set([
  'success',
  'failed',
  'timeout',
  'aborted',
  'cancelled',
  'blocked',
]);
type StreamName = 'stdout' | 'stderr';

export type TrialTaskStreamArchiveErrorCode =
  | 'source_invalid'
  | 'source_identity_mismatch'
  | 'source_missing'
  | 'source_path_invalid'
  | 'source_limit'
  | 'source_read_failed'
  | 'source_count_unknown'
  | 'source_count_mismatch'
  | 'source_capture_read_error'
  | 'source_invalid_utf8'
  | 'archive_limit'
  | 'archive_conflict'
  | 'archive_unavailable'
  | 'archive_sink_failure';
const ERROR_CODES: readonly TrialTaskStreamArchiveErrorCode[] = [
  'source_invalid',
  'source_identity_mismatch',
  'source_missing',
  'source_path_invalid',
  'source_limit',
  'source_read_failed',
  'source_count_unknown',
  'source_count_mismatch',
  'source_capture_read_error',
  'source_invalid_utf8',
  'archive_limit',
  'archive_conflict',
  'archive_unavailable',
  'archive_sink_failure',
];

interface CompletedTrialStreamSource {
  readonly path: string | null;
  /** Child-produced bytes and persisted bytes can differ because runtime redaction transforms text. */
  readonly producedBytes: number | null;
  readonly storedBytes: number | null;
  readonly captureReadError: boolean;
}

export interface CompletedTrialTaskStreamSource {
  readonly trialId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly runNumber: number;
  readonly taskId: string;
  readonly taskStatus: string;
  readonly workDir: string;
  readonly logPath: string;
  readonly stdout: CompletedTrialStreamSource;
  readonly stderr: CompletedTrialStreamSource;
}

export interface TrialTaskStreamArchiveReference extends ChatRepairEvidenceOwner {
  readonly schemaVersion: 1;
  readonly kind: 'trial-task-stream-archive';
  readonly trialId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly runNumber: number;
  readonly taskId: string;
  /** Digest and byte count of the exact JSON manifest payload, excluding its HMAC envelope. */
  readonly hash: string;
  readonly byteLength: number;
}

export interface TrialTaskStreamArchiveMetadata {
  readonly stream: StreamName;
  readonly producedBytes: number | null;
  readonly storedBytes: number | null;
  readonly capturedBytes: number | null;
  /** Exact Host log bytes, which may already have been redacted by the runtime. */
  readonly sourceHash: string | null;
  /** Exact, additionally redacted UTF-8 archive bytes. This is not a raw producer digest. */
  readonly hash: string | null;
  readonly byteLength: number | null;
  readonly encoding: 'utf-8';
  readonly state: 'complete' | 'unknown' | 'unavailable';
  readonly errorCodes: readonly TrialTaskStreamArchiveErrorCode[];
}

interface TaskTuple {
  readonly trialId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly runNumber: number;
  readonly taskId: string;
}

export interface TrialTaskStreamArchiveResult extends TaskTuple {
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly manifest: TrialTaskStreamArchiveReference | null;
  readonly errorCodes: readonly TrialTaskStreamArchiveErrorCode[];
  readonly streams?: readonly TrialTaskStreamArchiveMetadata[];
}

export type TrialTaskStreamEvidenceSink = (
  source: CompletedTrialTaskStreamSource,
) => TrialTaskStreamArchiveResult;

interface ArchiveManifest extends ChatRepairEvidenceOwner, TaskTuple {
  readonly schemaVersion: 1;
  readonly kind: 'trial-task-stream-archive';
  readonly taskStatus: string;
  readonly status: TrialTaskStreamArchiveResult['status'];
  readonly errorCodes: readonly TrialTaskStreamArchiveErrorCode[];
  readonly streams: readonly TrialTaskStreamArchiveMetadata[];
}

class ArchiveError extends Error {
  constructor(readonly code: TrialTaskStreamArchiveErrorCode) {
    super(code);
  }
}

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function keys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validateSetup(context: ServerRecordContext, owner: ChatRepairEvidenceOwner): void {
  if (
    !keys(owner, ['workspaceScopeId', 'operationId', 'operationGeneration', 'stageId']) ||
    !identifier(owner.workspaceScopeId) ||
    !identifier(owner.operationId) ||
    !identifier(owner.stageId) ||
    !count(owner.operationGeneration) ||
    owner.operationGeneration === 0 ||
    context.kind !== 'stage-metadata' ||
    context.stageId !== owner.stageId ||
    !isAbsolute(context.workspaceTagmaDir) ||
    !isAbsolute(context.controlRoot)
  )
    throw new ArchiveError('archive_unavailable');
}

function privateDirectory(context: ServerRecordContext, create: boolean): string {
  const root = join(context.controlRoot, DIRECTORY);
  if (create) {
    const existed = existsSync(root);
    ensureServerRecordControlRootSync({ ...context, controlRoot: root });
    if (!existed && process.platform !== 'win32') chmodSync(root, 0o700);
  }
  if (!existsSync(root)) throw new ArchiveError('archive_unavailable');
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(root) !== join(realpathSync.native(context.controlRoot), DIRECTORY) ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new ArchiveError('archive_unavailable');
  return root;
}

function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new ArchiveError('archive_unavailable');
}

function syncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? ''))
      throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function tuple(source: TaskTuple): TaskTuple {
  return {
    trialId: source.trialId,
    caseId: source.caseId,
    runId: source.runId,
    runNumber: source.runNumber,
    taskId: source.taskId,
  };
}

function validTuple(value: TaskTuple): boolean {
  return (
    identifier(value.trialId) &&
    identifier(value.caseId) &&
    typeof value.runId === 'string' &&
    RUN_ID.test(value.runId) &&
    count(value.runNumber) &&
    value.runNumber > 0 &&
    typeof value.taskId === 'string' &&
    value.taskId.length <= 256 &&
    TASK_ID.test(value.taskId)
  );
}

function manifestPath(root: string, owner: ChatRepairEvidenceOwner, item: TaskTuple): string {
  return join(
    root,
    `${sha(
      JSON.stringify([
        owner.workspaceScopeId,
        owner.operationId,
        owner.operationGeneration,
        owner.stageId,
        item.trialId,
        item.caseId,
        item.runId,
        item.runNumber,
        item.taskId,
      ]),
    )}.json`,
  );
}

function errorCode(error: unknown): TrialTaskStreamArchiveErrorCode {
  return error instanceof ArchiveError ? error.code : 'archive_unavailable';
}

function uniqueErrors(
  values: readonly TrialTaskStreamArchiveErrorCode[],
): TrialTaskStreamArchiveErrorCode[] {
  return [...new Set(values)];
}

function readBlob(root: string, hash: string, byteLength: number): Buffer {
  if (!HASH.test(hash) || !count(byteLength) || byteLength > MAX_SERVER_RECORD_BYTES)
    throw new ArchiveError('archive_unavailable');
  const path = join(root, `${hash}.utf8`);
  privateFile(path);
  const before = lstatSync(path, { bigint: true });
  if (before.size !== BigInt(byteLength)) throw new ArchiveError('archive_unavailable');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      throw new ArchiveError('archive_unavailable');
    const bytes = Buffer.alloc(byteLength + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = lstatSync(path, { bigint: true });
    const finished = fstatSync(fd, { bigint: true });
    if (
      offset !== byteLength ||
      after.isSymbolicLink() ||
      after.nlink !== 1n ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      finished.size !== opened.size ||
      realpathSync.native(path) !== join(realpathSync.native(root), `${hash}.utf8`) ||
      (process.platform !== 'win32' && (after.mode & 0o077n) !== 0n)
    )
      throw new ArchiveError('archive_unavailable');
    const result = bytes.subarray(0, offset);
    if (sha(result) !== hash || !Buffer.from(result.toString('utf8'), 'utf8').equals(result))
      throw new ArchiveError('archive_unavailable');
    return result;
  } finally {
    closeSync(fd);
  }
}

function writeBlob(root: string, bytes: Buffer): string {
  const hash = sha(bytes);
  const path = join(root, `${hash}.utf8`);
  if (existsSync(path)) {
    readBlob(root, hash, bytes.length);
    syncDirectory(root);
    return hash;
  }
  assertArchiveBudget(root, bytes.length);
  if (bytes.length > MAX_SERVER_RECORD_BYTES) throw new ArchiveError('archive_limit');
  const pending = join(root, `.pending-${randomUUID()}`);
  let fd: number | null = null;
  try {
    fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new ArchiveError('archive_unavailable');
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(pending, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    if (fd !== null) closeSync(fd);
    if (existsSync(pending)) unlinkSync(pending);
  }
  readBlob(root, hash, bytes.length);
  syncDirectory(root);
  return hash;
}

function assertArchiveBudget(root: string, additionalBytes: number): void {
  let total = 0;
  for (const name of readdirSync(root)) {
    if (
      !/^(?:[0-9a-f]{64}\.(?:utf8|json|json\.claim)|\.pending-[0-9a-f-]{36}|\.quota-claim)$/.test(
        name,
      )
    )
      throw new ArchiveError('archive_unavailable');
    const file = join(root, name);
    privateFile(file);
    total += lstatSync(file).size;
  }
  // Count orphan pending files and manifests as well as blobs; never silently prune them.
  if (total + additionalBytes > MAX_TRIAL_STREAM_ARCHIVE_BYTES)
    throw new ArchiveError('archive_limit');
}

function captureStream(
  source: CompletedTrialTaskStreamSource,
  stream: StreamName,
): {
  metadata: TrialTaskStreamArchiveMetadata;
  bytes: Buffer | null;
} {
  const input = source[stream];
  const metadata: TrialTaskStreamArchiveMetadata = {
    stream,
    producedBytes: count(input?.producedBytes) ? input.producedBytes : null,
    storedBytes: count(input?.storedBytes) ? input.storedBytes : null,
    capturedBytes: null,
    sourceHash: null,
    hash: null,
    byteLength: null,
    encoding: 'utf-8',
    state: 'unavailable',
    errorCodes: [],
  };
  const errors: TrialTaskStreamArchiveErrorCode[] = [];
  try {
    if (
      !input ||
      !keys(input, ['path', 'producedBytes', 'storedBytes', 'captureReadError']) ||
      typeof input.captureReadError !== 'boolean' ||
      (input.producedBytes !== null && !count(input.producedBytes)) ||
      (input.storedBytes !== null && !count(input.storedBytes))
    )
      throw new ArchiveError('source_invalid');
    if (input.captureReadError) errors.push('source_capture_read_error');
    if (!input.path) throw new ArchiveError('source_missing');
    const expectedLog = join(
      resolve(source.workDir),
      '.tagma',
      'logs',
      source.runId,
      'pipeline.log',
    );
    const expectedOutput = join(
      dirname(expectedLog),
      `${source.taskId.replace(/\./g, '_')}.${stream}`,
    );
    if (
      !isAbsolute(source.workDir) ||
      !isAbsolute(source.logPath) ||
      !isAbsolute(input.path) ||
      source.logPath !== expectedLog ||
      input.path !== expectedOutput
    )
      throw new ArchiveError('source_path_invalid');
    const before = lstatSync(input.path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    )
      throw new ArchiveError('source_read_failed');
    if (before.size > MAX_SERVER_RECORD_BYTES) throw new ArchiveError('source_limit');
    let captured: Buffer;
    try {
      captured = readCompleteRepairOutput(source.workDir, source.logPath, input.path);
    } catch {
      throw new ArchiveError('source_read_failed');
    }
    const text = captured.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(captured)) throw new ArchiveError('source_invalid_utf8');
    if (input.producedBytes === null || input.storedBytes === null)
      errors.push('source_count_unknown');
    if (input.storedBytes !== null && input.storedBytes !== captured.length)
      errors.push('source_count_mismatch');
    const bytes = Buffer.from(redactChatRepairErrorOutput(text), 'utf8');
    return {
      bytes,
      metadata: {
        ...metadata,
        capturedBytes: captured.length,
        sourceHash: sha(captured),
        hash: sha(bytes),
        byteLength: bytes.length,
        state: errors.length === 0 ? 'complete' : 'unknown',
        errorCodes: uniqueErrors(errors),
      },
    };
  } catch (error) {
    errors.push(error instanceof ArchiveError ? error.code : 'source_read_failed');
    return { bytes: null, metadata: { ...metadata, errorCodes: uniqueErrors(errors) } };
  }
}

function archiveStatus(
  streams: readonly TrialTaskStreamArchiveMetadata[],
): TrialTaskStreamArchiveResult['status'] {
  return streams.every((stream) => stream.state === 'complete')
    ? 'complete'
    : streams.some((stream) => stream.hash !== null)
      ? 'partial'
      : 'unavailable';
}

function reference(
  owner: ChatRepairEvidenceOwner,
  item: TaskTuple,
  manifest: ArchiveManifest,
): TrialTaskStreamArchiveReference {
  const text = JSON.stringify(manifest);
  return {
    schemaVersion: 1,
    kind: 'trial-task-stream-archive',
    ...owner,
    ...item,
    hash: sha(text),
    byteLength: Buffer.byteLength(text, 'utf8'),
  };
}

function validMetadata(
  value: unknown,
  stream: StreamName,
): value is TrialTaskStreamArchiveMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as TrialTaskStreamArchiveMetadata;
  if (
    !keys(item, [
      'stream',
      'producedBytes',
      'storedBytes',
      'capturedBytes',
      'sourceHash',
      'hash',
      'byteLength',
      'encoding',
      'state',
      'errorCodes',
    ]) ||
    item.stream !== stream ||
    item.encoding !== 'utf-8' ||
    !['complete', 'unknown', 'unavailable'].includes(item.state) ||
    !Array.isArray(item.errorCodes) ||
    item.errorCodes.some((code) => !ERROR_CODES.includes(code)) ||
    new Set(item.errorCodes).size !== item.errorCodes.length ||
    ![item.producedBytes, item.storedBytes, item.capturedBytes, item.byteLength].every(
      (value) => value === null || count(value),
    ) ||
    ![item.sourceHash, item.hash].every(
      (value) => value === null || (typeof value === 'string' && HASH.test(value)),
    )
  )
    return false;
  if (item.state === 'unavailable')
    return (
      item.hash === null &&
      item.sourceHash === null &&
      item.byteLength === null &&
      item.capturedBytes === null &&
      item.errorCodes.length > 0
    );
  if (
    item.hash === null ||
    item.sourceHash === null ||
    item.byteLength === null ||
    item.byteLength > MAX_SERVER_RECORD_BYTES ||
    item.capturedBytes === null ||
    item.capturedBytes > MAX_SERVER_RECORD_BYTES
  )
    return false;
  return item.state === 'unknown'
    ? item.errorCodes.length > 0
    : item.producedBytes !== null &&
        item.storedBytes !== null &&
        item.storedBytes === item.capturedBytes &&
        item.errorCodes.length === 0;
}

/** Internal reader only: no new API and no provider/native tool-part completeness claim. */
export function readTrialTaskStreamEvidence(
  context: ServerRecordContext,
  owner: ChatRepairEvidenceOwner,
  ref: TrialTaskStreamArchiveReference,
): {
  readonly manifest: ArchiveManifest;
  readonly stdout: string | null;
  readonly stderr: string | null;
} {
  validateSetup(context, owner);
  if (
    !ref ||
    !keys(ref, [
      'schemaVersion',
      'kind',
      'workspaceScopeId',
      'operationId',
      'operationGeneration',
      'stageId',
      'trialId',
      'caseId',
      'runId',
      'runNumber',
      'taskId',
      'hash',
      'byteLength',
    ]) ||
    ref.schemaVersion !== 1 ||
    ref.kind !== 'trial-task-stream-archive' ||
    !validTuple(ref) ||
    !HASH.test(ref.hash) ||
    !count(ref.byteLength) ||
    ref.byteLength === 0 ||
    ref.byteLength > MAX_MANIFEST_BYTES ||
    ref.workspaceScopeId !== owner.workspaceScopeId ||
    ref.operationId !== owner.operationId ||
    ref.operationGeneration !== owner.operationGeneration ||
    ref.stageId !== owner.stageId
  )
    throw new ArchiveError('archive_unavailable');
  const root = privateDirectory(context, false);
  const path = manifestPath(root, owner, ref);
  privateFile(path);
  const manifest = readAuthenticatedServerRecordSync<ArchiveManifest>(path, context);
  if (
    !keys(manifest, [
      'schemaVersion',
      'kind',
      'workspaceScopeId',
      'operationId',
      'operationGeneration',
      'stageId',
      'trialId',
      'caseId',
      'runId',
      'runNumber',
      'taskId',
      'taskStatus',
      'status',
      'errorCodes',
      'streams',
    ]) ||
    reference(owner, ref, manifest).hash !== ref.hash ||
    reference(owner, ref, manifest).byteLength !== ref.byteLength ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== ref.kind ||
    manifest.workspaceScopeId !== owner.workspaceScopeId ||
    manifest.operationId !== owner.operationId ||
    manifest.operationGeneration !== owner.operationGeneration ||
    manifest.stageId !== owner.stageId ||
    JSON.stringify(tuple(manifest)) !== JSON.stringify(tuple(ref)) ||
    !TERMINAL_STATUSES.has(manifest.taskStatus) ||
    !Array.isArray(manifest.streams) ||
    manifest.streams.length !== 2 ||
    !validMetadata(manifest.streams[0], 'stdout') ||
    !validMetadata(manifest.streams[1], 'stderr') ||
    manifest.status !== archiveStatus(manifest.streams) ||
    JSON.stringify(manifest.errorCodes) !==
      JSON.stringify(uniqueErrors(manifest.streams.flatMap((stream) => stream.errorCodes)))
  )
    throw new ArchiveError('archive_unavailable');
  const contents = manifest.streams.map((stream) =>
    stream.hash === null ? null : readBlob(root, stream.hash, stream.byteLength!).toString('utf8'),
  );
  return { manifest, stdout: contents[0]!, stderr: contents[1]! };
}

/** Caller authenticates ProductionStagingAdapter authority and owner before constructing this closure. */
export function createTrialTaskStreamEvidenceSink(
  context: ServerRecordContext,
  owner: ChatRepairEvidenceOwner,
): TrialTaskStreamEvidenceSink {
  validateSetup(context, owner);
  const pinnedContext = Object.freeze({ ...context });
  const pinnedOwner = Object.freeze({ ...owner });
  let root: string;
  try {
    root = privateDirectory(pinnedContext, true);
  } catch (error) {
    // Authenticated ownership still fails closed above. Storage availability cannot block Trial.
    const failure = errorCode(error);
    return (source) => ({
      ...tuple(source),
      status: 'unavailable',
      manifest: null,
      errorCodes: [
        validTuple(source) && TERMINAL_STATUSES.has(source.taskStatus) ? failure : 'source_invalid',
      ],
    });
  }
  return (source) => {
    const item = tuple(source);
    let streams: TrialTaskStreamArchiveMetadata[] | undefined;
    let claim: string | null = null;
    let quotaClaim: string | null = null;
    try {
      if (!validTuple(source) || !TERMINAL_STATUSES.has(source.taskStatus))
        throw new ArchiveError('source_invalid');
      privateDirectory(pinnedContext, false);
      const captures = (['stdout', 'stderr'] as const).map((stream) =>
        captureStream(source, stream),
      );
      streams = captures.map((capture) => capture.metadata);
      if (archiveStatus(streams) === 'unavailable')
        return {
          ...item,
          status: 'unavailable',
          manifest: null,
          errorCodes: uniqueErrors(streams.flatMap((stream) => stream.errorCodes)),
          streams,
        };
      const manifest: ArchiveManifest = {
        schemaVersion: 1,
        kind: 'trial-task-stream-archive',
        ...pinnedOwner,
        ...item,
        taskStatus: source.taskStatus,
        status: archiveStatus(streams),
        errorCodes: uniqueErrors(streams.flatMap((stream) => stream.errorCodes)),
        streams,
      };
      const ref = reference(pinnedOwner, item, manifest);
      if (ref.byteLength > MAX_MANIFEST_BYTES) throw new ArchiveError('archive_limit');
      const path = manifestPath(root, pinnedOwner, item);
      const claimPath = `${path}.claim`;
      const reuse = (): TrialTaskStreamArchiveResult => {
        const existing = readTrialTaskStreamEvidence(pinnedContext, pinnedOwner, ref);
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest))
          throw new ArchiveError('archive_conflict');
        syncAuthenticatedServerRecordSync(path, pinnedContext);
        return {
          ...item,
          status: manifest.status,
          manifest: ref,
          errorCodes: manifest.errorCodes,
          streams,
        };
      };
      if (existsSync(claimPath)) throw new ArchiveError('archive_conflict');
      if (existsSync(path)) {
        try {
          return reuse();
        } catch {
          throw new ArchiveError('archive_conflict');
        }
      }
      // Transient filesystem publication guards; they grant no operation or model authority.
      // The existing HMAC writer is atomic-replace, so all cooperating writers serialize here.
      // This is not an OS no-replace guarantee against unrelated filesystem actors.
      try {
        const fd = openSync(
          claimPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        closeSync(fd);
        claim = claimPath;
      } catch {
        throw new ArchiveError('archive_conflict');
      }
      if (existsSync(path)) {
        try {
          return reuse();
        } catch {
          throw new ArchiveError('archive_conflict');
        }
      }
      const quotaPath = join(root, '.quota-claim');
      try {
        const fd = openSync(
          quotaPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        closeSync(fd);
        quotaClaim = quotaPath;
      } catch {
        throw new ArchiveError('archive_unavailable');
      }
      for (const capture of captures) if (capture.bytes !== null) writeBlob(root, capture.bytes);
      assertArchiveBudget(root, MAX_MANIFEST_BYTES);
      writeAuthenticatedServerRecordSync(path, pinnedContext, manifest);
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      if (lstatSync(path).size > MAX_MANIFEST_BYTES) throw new ArchiveError('archive_limit');
      syncAuthenticatedServerRecordSync(path, pinnedContext);
      readTrialTaskStreamEvidence(pinnedContext, pinnedOwner, ref);
      return {
        ...item,
        status: manifest.status,
        manifest: ref,
        errorCodes: manifest.errorCodes,
        streams,
      };
    } catch (error) {
      const failure = errorCode(error);
      return {
        ...item,
        status: 'unavailable',
        manifest: null,
        errorCodes: uniqueErrors([
          ...(streams?.flatMap((stream) => stream.errorCodes) ?? []),
          failure,
        ]),
        ...(streams
          ? {
              streams: streams.map((stream) => ({
                ...stream,
                state:
                  stream.state === 'unavailable' ? ('unavailable' as const) : ('unknown' as const),
                errorCodes: uniqueErrors([...stream.errorCodes, failure]),
              })),
            }
          : {}),
      };
    } finally {
      // A failed cleanup leaves a stale claim that fails closed; never retry a business action.
      for (const path of [quotaClaim, claim])
        if (path !== null) {
          try {
            unlinkSync(path);
          } catch {
            /* no exception crosses the archive sink */
          }
        }
    }
  };
}
