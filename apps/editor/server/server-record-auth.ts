import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import { atomicWriteFileSync } from './path-utils.js';

const SERVER_RECORD_AUTH_VERSION = 1;
const SERVER_RECORD_AUTH_ALGORITHM = 'hmac-sha256';
const SERVER_RECORD_AUTH_FIELD = '__tagmaServerAuth';
const MAX_SERVER_RECORD_BYTES = 5 * 1024 * 1024;
const serverRecordAuthKey = randomBytes(32);

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
  kind: 'stage-metadata' | 'finalized' | 'trial-cache';
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

function normalizeJsonObject(value: JsonObject): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server record payload must be a JSON object.');
  }
  if (Object.hasOwn(value, SERVER_RECORD_AUTH_FIELD)) {
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
  return createHmac('sha256', serverRecordAuthKey)
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
  payload: JsonObject,
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

export function readAuthenticatedServerRecordSync<T extends JsonObject>(
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
