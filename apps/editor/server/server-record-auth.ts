import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import { resolveChatOperationV2ControlPaths } from './chat-operations/control-root.js';
import { atomicWriteFileSync } from './path-utils.js';

const SERVER_RECORD_AUTH_VERSION = 1;
const SERVER_RECORD_AUTH_ALGORITHM = 'hmac-sha256';
const SERVER_RECORD_AUTH_FIELD = '__tagmaServerAuth';
const MAX_SERVER_RECORD_BYTES = 5 * 1024 * 1024;
let cachedServerRecordKey: { source: string; key: Buffer } | null = null;

type JsonObject = Record<string, unknown>;

interface ServerRecordAuth {
  version: typeof SERVER_RECORD_AUTH_VERSION;
  algorithm: typeof SERVER_RECORD_AUTH_ALGORITHM;
  signature: string;
}

export interface ServerRecordContext {
  workspaceTagmaDir: string;
  controlRoot: string;
  stageId: string;
  kind: 'stage-metadata' | 'finalized' | 'trial-cache' | 'chat-bindings';
}

function authenticationError(): Error {
  return new Error('Server record authentication failed.');
}

function isLexicallyWithin(child: string, root: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  const childDrive = parse(resolvedChild).root;
  const rootDrive = parse(resolvedRoot).root;
  if (childDrive.toLowerCase() !== rootDrive.toLowerCase()) return false;
  const rel = relative(resolvedRoot, resolvedChild);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertSafeScopeValue(value: string, label: string): void {
  if (!value || value.includes('\0')) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relativeTarget = relative(root, target);
  const parts = relativeTarget ? relativeTarget.split(/[\\/]+/).filter(Boolean) : [];
  let current = root;
  const candidates = [root, ...parts.map((part) => (current = join(current, part)))];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing server record path through symbolic link: ${candidate}`);
    }
    if (index < candidates.length - 1 && !stat.isDirectory()) {
      throw new Error(`Server record ancestor is not a directory: ${candidate}`);
    }
  }
}

function assertNoSymlinksFromFilesystemRoot(target: string, label: string): void {
  const resolvedTarget = resolve(target);
  const filesystemRoot = parse(resolvedTarget).root;
  const parts = relative(filesystemRoot, resolvedTarget)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = filesystemRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing ${label} through symbolic link: ${current}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} ancestor is not a directory: ${current}`);
    }
  }
}

function configuredServerRecordKeyFile(): string {
  const explicitPath = process.env.TAGMA_STAGE_RECORD_KEY_FILE?.trim();
  if (explicitPath) {
    if (!isAbsolute(explicitPath)) {
      throw new Error('TAGMA_STAGE_RECORD_KEY_FILE must be an absolute path.');
    }
    return resolve(explicitPath);
  }
  const editorUserDir = process.env.TAGMA_EDITOR_USER_DIR?.trim();
  if (editorUserDir) {
    if (!isAbsolute(editorUserDir)) {
      throw new Error('TAGMA_EDITOR_USER_DIR must be an absolute path.');
    }
    const stableUserDataDir = dirname(resolve(editorUserDir));
    if (!existsSync(stableUserDataDir)) {
      throw new Error('TAGMA_EDITOR_USER_DIR parent was not found.');
    }
    assertNoSymlinksFromFilesystemRoot(stableUserDataDir, 'server record key root');
    const stableRootStat = lstatSync(stableUserDataDir);
    if (!stableRootStat.isDirectory()) {
      throw new Error('TAGMA_EDITOR_USER_DIR parent is not a directory.');
    }
    return join(stableUserDataDir, 'server-control', 'stage-record-hmac.key');
  }

  // Tests must not mutate a developer's OS state directory. They still use a
  // stable O_EXCL-created file instead of process-random authority.
  if (process.env.NODE_ENV === 'test' && !process.env.TAGMA_CHAT_CONTROL_DIR) {
    return join(tmpdir(), 'tagma-test-server-control', 'stage-record-hmac.key');
  }

  const { controlDir } = resolveChatOperationV2ControlPaths();
  return join(controlDir, 'stage-record-hmac.key');
}

function canonicalPersistentKeyPath(keyPath: string): string {
  const resolvedKeyPath = resolve(keyPath);
  const keyDir = dirname(resolvedKeyPath);
  assertNoSymlinksFromFilesystemRoot(keyDir, 'server record key path');
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  assertNoSymlinksFromFilesystemRoot(resolvedKeyPath, 'server record key path');
  const keyDirStat = lstatSync(keyDir);
  if (keyDirStat.isSymbolicLink() || !keyDirStat.isDirectory()) {
    throw new Error('Server record key directory must be a regular directory.');
  }
  if (process.platform !== 'win32') chmodSync(keyDir, 0o700);
  return join(realpathSync.native(keyDir), basename(resolvedKeyPath));
}

function readPersistentKey(keyPath: string): Buffer | null {
  if (!existsSync(keyPath)) return null;
  const stat = lstatSync(keyPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Server record key must be a regular file, not a symbolic link.');
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) {
    throw new Error('Server record key must contain exactly 32 bytes.');
  }
  if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
  return Buffer.from(key);
}

function loadOrCreatePersistentKey(keyPath: string): Buffer {
  const canonicalPath = canonicalPersistentKeyPath(keyPath);
  const existing = readPersistentKey(canonicalPath);
  if (existing) return existing;

  const generated = randomBytes(32);
  const keyDir = dirname(canonicalPath);
  const temporaryPath = join(
    keyDir,
    `.${basename(canonicalPath)}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  let descriptor: number | null = null;
  let retainGenerated = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    let offset = 0;
    while (offset < generated.length) {
      offset += writeSync(descriptor, generated, offset, generated.length - offset, offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600);

    try {
      // Hard-link publication is atomic and no-replace: the public name is
      // never observable until all 32 bytes are fsynced.
      linkSync(temporaryPath, canonicalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const racedKey = readPersistentKey(canonicalPath);
      if (!racedKey) throw new Error('Server record key publication race did not complete.');
      generated.fill(0);
      return racedKey;
    }
    fsyncDirectorySync(keyDir);
    retainGenerated = true;
    return generated;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[server-record-auth] key temp cleanup failed');
      }
    }
    if (!retainGenerated) generated.fill(0);
  }
}

function fsyncDirectorySync(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || !['EACCES', 'EINVAL', 'EPERM'].includes(code ?? '')) {
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function getServerRecordAuthKey(): Buffer {
  const keyFile = configuredServerRecordKeyFile();
  const source = `file:${resolve(keyFile)}`;
  if (cachedServerRecordKey?.source === source) return cachedServerRecordKey.key;
  const key = loadOrCreatePersistentKey(keyFile);
  cachedServerRecordKey = { source, key };
  return key;
}
function ensureWorkspaceTagmaDirectory(workspaceTagmaDir: string, forWrite: boolean): void {
  if (basename(workspaceTagmaDir).toLowerCase() !== '.tagma') {
    throw new Error('Server record workspace root must be the workspace .tagma directory.');
  }
  const workspaceDir = dirname(workspaceTagmaDir);
  if (!existsSync(workspaceDir)) {
    throw new Error('Server record workspace directory was not found.');
  }
  const workspaceStat = lstatSync(workspaceDir);
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error('Server record workspace directory must be a regular directory.');
  }
  if (!existsSync(workspaceTagmaDir)) {
    if (!forWrite) throw new Error('Server record workspace .tagma directory was not found.');
    mkdirSync(workspaceTagmaDir);
  }
  const tagmaStat = lstatSync(workspaceTagmaDir);
  if (tagmaStat.isSymbolicLink()) {
    throw new Error(`Refusing server record path through symbolic link: ${workspaceTagmaDir}`);
  }
  if (!tagmaStat.isDirectory()) {
    throw new Error('Server record workspace .tagma root is not a directory.');
  }
}

function resolveAuthenticatedRecordPath(
  recordPath: string,
  context: ServerRecordContext,
  forWrite: boolean,
): string {
  assertSafeScopeValue(context.kind, 'Server record kind');
  assertSafeScopeValue(context.stageId, 'Server record stage id');
  const workspaceTagmaDir = resolve(context.workspaceTagmaDir);
  const controlRoot = resolve(context.controlRoot);
  const target = resolve(recordPath);
  if (
    !isLexicallyWithin(controlRoot, workspaceTagmaDir) ||
    controlRoot === workspaceTagmaDir ||
    !isLexicallyWithin(target, controlRoot) ||
    target === controlRoot
  ) {
    throw new Error('Server record path escapes its workspace control directory.');
  }

  ensureWorkspaceTagmaDirectory(workspaceTagmaDir, forWrite);
  assertNoSymlinkComponents(workspaceTagmaDir, target);
  if (forWrite) {
    mkdirSync(dirname(target), { recursive: true });
    assertNoSymlinkComponents(workspaceTagmaDir, target);
  }
  if (!existsSync(controlRoot)) {
    throw new Error('Server record control directory was not found.');
  }
  const controlStat = lstatSync(controlRoot);
  if (controlStat.isSymbolicLink()) {
    throw new Error(`Refusing server record path through symbolic link: ${controlRoot}`);
  }
  if (!controlStat.isDirectory()) {
    throw new Error('Server record control root is not a directory.');
  }

  const realTagmaDir = realpathSync.native(workspaceTagmaDir);
  const realControlRoot = realpathSync.native(controlRoot);
  const realParent = realpathSync.native(dirname(target));
  if (
    !isLexicallyWithin(realControlRoot, realTagmaDir) ||
    !isLexicallyWithin(realParent, realControlRoot)
  ) {
    throw new Error('Server record path escapes its canonical workspace control directory.');
  }
  if (existsSync(target)) {
    const targetStat = lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing server record symbolic link target: ${target}`);
    }
    if (!targetStat.isFile()) {
      throw new Error('Server record target is not a regular file.');
    }
    const realTarget = realpathSync.native(target);
    if (!isLexicallyWithin(realTarget, realControlRoot)) {
      throw new Error('Server record target escapes its canonical control directory.');
    }
    return realTarget;
  }
  return join(realParent, basename(target));
}

function normalizeJsonObject(value: object): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server record payload must be a JSON object.');
  }
  if (Object.prototype.hasOwnProperty.call(value, SERVER_RECORD_AUTH_FIELD)) {
    throw new Error(`Server record payload may not contain ${SERVER_RECORD_AUTH_FIELD}.`);
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Server record payload is not JSON serializable.');
  const normalized = JSON.parse(serialized) as unknown;
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new Error('Server record payload must be a JSON object.');
  }
  return normalized as JsonObject;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('Server record payload is not canonical JSON.');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function signingInput(
  canonicalPath: string,
  context: ServerRecordContext,
  payload: JsonObject,
): string {
  return [
    String(SERVER_RECORD_AUTH_VERSION),
    context.kind,
    context.stageId,
    canonicalPath,
    canonicalJson(payload),
  ].join('\0');
}

function sign(canonicalPath: string, context: ServerRecordContext, payload: JsonObject): string {
  return createHmac('sha256', getServerRecordAuthKey())
    .update(signingInput(canonicalPath, context, payload))
    .digest('hex');
}

function isValidAuth(value: unknown): value is ServerRecordAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as Partial<ServerRecordAuth>;
  return (
    auth.version === SERVER_RECORD_AUTH_VERSION &&
    auth.algorithm === SERVER_RECORD_AUTH_ALGORITHM &&
    typeof auth.signature === 'string' &&
    /^[0-9a-f]{64}$/i.test(auth.signature)
  );
}

export function writeAuthenticatedServerRecordSync(
  recordPath: string,
  context: ServerRecordContext,
  payload: object,
): void {
  const canonicalPath = resolveAuthenticatedRecordPath(recordPath, context, true);
  const normalizedPayload = normalizeJsonObject(payload);
  const record = {
    ...normalizedPayload,
    [SERVER_RECORD_AUTH_FIELD]: {
      version: SERVER_RECORD_AUTH_VERSION,
      algorithm: SERVER_RECORD_AUTH_ALGORITHM,
      signature: sign(canonicalPath, context, normalizedPayload),
    } satisfies ServerRecordAuth,
  };
  atomicWriteFileSync(canonicalPath, JSON.stringify(record, null, 2) + '\n');
  resolveAuthenticatedRecordPath(recordPath, context, false);
}

export function readAuthenticatedServerRecordSync<T extends object>(
  recordPath: string,
  context: ServerRecordContext,
): T {
  const canonicalPath = resolveAuthenticatedRecordPath(recordPath, context, false);
  if (statSync(canonicalPath).size > MAX_SERVER_RECORD_BYTES) throw authenticationError();
  let parsed: JsonObject;
  try {
    const value = JSON.parse(readFileSync(canonicalPath, 'utf-8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw authenticationError();
    parsed = value as JsonObject;
  } catch {
    throw authenticationError();
  }
  const auth = parsed[SERVER_RECORD_AUTH_FIELD];
  if (!isValidAuth(auth)) throw authenticationError();
  const payload = { ...parsed };
  delete payload[SERVER_RECORD_AUTH_FIELD];
  const expected = Buffer.from(sign(canonicalPath, context, payload), 'hex');
  const actual = Buffer.from(auth.signature, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw authenticationError();
  }
  return payload as T;
}

export function ensureServerRecordControlRootSync(context: ServerRecordContext): void {
  resolveAuthenticatedRecordPath(
    join(context.controlRoot, '.server-record-boundary'),
    context,
    true,
  );
}

export const __serverRecordAuthTestHooks = {
  resetKeyCache(): void {
    cachedServerRecordKey = null;
  },
};
