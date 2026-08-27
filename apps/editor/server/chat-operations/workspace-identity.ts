import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';

const CONTROL_HMAC_KEY_BYTES = 32;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_WORKSPACE_SCOPE_ID_LENGTH = 128;
const MAX_CANONICAL_PATH_LENGTH = 32_768;
const WORKSPACE_SCOPE_RECORD_HMAC_DOMAIN = 'tagma.chat-operation-v2.workspace-scope-record';

export const WORKSPACE_SCOPE_RECORD_HMAC_VERSION = 1;

export interface WorkspaceIdentityOptions {
  /** Override only for cross-platform contract tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `realpathSync.native`; callers do not supply this in production. */
  realpathNative?: (workspacePath: string) => string;
}

export interface WorkspaceRecordValidationOptions {
  /** Override only when validating another platform's persisted shape in tests. */
  platform?: NodeJS.Platform;
}

export interface CanonicalWorkspaceIdentity {
  canonicalPath: string;
  canonicalPathHmac: string;
}

export interface TrustedWorkspaceScopeRecord extends CanonicalWorkspaceIdentity {
  workspaceScopeId: string;
  createdAt: number;
  controlGeneration: number;
  recordHmac: string;
}

export interface CreateTrustedWorkspaceScopeRecordInput {
  workspaceScopeId: string;
  workspacePath: string;
  createdAt: number;
  controlGeneration: number;
}

export interface WorkspaceScopeRecordAuthorityFields {
  workspaceScopeId: string;
  canonicalPath: string;
  createdAt: number;
  controlGeneration: number;
}

function assertControlHmacKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== CONTROL_HMAC_KEY_BYTES) {
    throw new Error(`Chat control HMAC key must be exactly ${CONTROL_HMAC_KEY_BYTES} bytes.`);
  }
}

function pathDialect(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function canonicalizeRealPath(realPath: string, platform: NodeJS.Platform): string {
  if (typeof realPath !== 'string' || realPath.length === 0 || realPath.includes('\0')) {
    throw new Error('Canonical workspace path must be a non-empty filesystem path.');
  }

  const dialect = pathDialect(platform);
  let normalized = dialect.normalize(realPath);
  if (!dialect.isAbsolute(normalized)) {
    throw new Error('Canonical workspace path must be absolute.');
  }

  const root = dialect.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(dialect.sep)) {
    normalized = normalized.slice(0, -1);
  }

  const portable = platform === 'win32' ? normalized.replace(/\\/g, '/').toLowerCase() : normalized;
  if (portable.length > MAX_CANONICAL_PATH_LENGTH) {
    throw new Error('Canonical workspace path is too long.');
  }
  return portable;
}

/**
 * Resolve one existing workspace into the stable filesystem coordinate used by
 * ChatTurn Operation V2. The default resolver is deliberately strict: a
 * missing or unreadable workspace is not assigned an identity.
 */
export function canonicalizeWorkspacePath(
  workspacePath: string,
  options: WorkspaceIdentityOptions = {},
): string {
  if (
    typeof workspacePath !== 'string' ||
    workspacePath.length === 0 ||
    workspacePath.includes('\0')
  ) {
    throw new Error('Workspace path must be a non-empty filesystem path.');
  }

  const platform = options.platform ?? process.platform;
  const realpathNative = options.realpathNative ?? ((value: string) => realpathSync.native(value));
  return canonicalizeRealPath(realpathNative(workspacePath), platform);
}

/** Compute the path-only identity authenticator from an already canonical coordinate. */
export function computeCanonicalPathHmac(canonicalPath: string, key: Uint8Array): string {
  assertControlHmacKey(key);
  if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) {
    throw new Error('Canonical workspace path must be a non-empty string.');
  }
  return createHmac('sha256', key).update(canonicalPath, 'utf8').digest('hex');
}

export function createWorkspaceIdentity(
  workspacePath: string,
  key: Uint8Array,
  options: WorkspaceIdentityOptions = {},
): CanonicalWorkspaceIdentity {
  const canonicalPath = canonicalizeWorkspacePath(workspacePath, options);
  return {
    canonicalPath,
    canonicalPathHmac: computeCanonicalPathHmac(canonicalPath, key),
  };
}

function isValidWorkspaceScopeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_WORKSPACE_SCOPE_ID_LENGTH &&
    value.trim() === value &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isValidCreatedAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidControlGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertWorkspaceScopeMetadata(value: {
  workspaceScopeId: unknown;
  createdAt: unknown;
  controlGeneration: unknown;
}): void {
  if (!isValidWorkspaceScopeId(value.workspaceScopeId)) {
    throw new Error('Trusted workspace scope record has an invalid workspaceScopeId.');
  }
  if (!isValidCreatedAt(value.createdAt)) {
    throw new Error('Trusted workspace scope record has an invalid createdAt.');
  }
  if (!isValidControlGeneration(value.controlGeneration)) {
    throw new Error('Trusted workspace scope record has an invalid controlGeneration.');
  }
}

/**
 * Authenticate an already-canonical workspace scope tuple. The JSON array is
 * a stable, unambiguous positional encoding; the independent domain and
 * version prevent this MAC from being confused with the path lookup HMAC or a
 * future record format.
 */
export function computeWorkspaceScopeRecordHmac(
  fields: WorkspaceScopeRecordAuthorityFields,
  key: Uint8Array,
  options: WorkspaceRecordValidationOptions = {},
): string {
  assertControlHmacKey(key);
  assertWorkspaceScopeMetadata(fields);
  if (!hasValidCanonicalPathShape(fields.canonicalPath, options.platform ?? process.platform)) {
    throw new Error('Trusted workspace scope record has an invalid canonicalPath.');
  }
  const canonicalRecord = JSON.stringify([
    WORKSPACE_SCOPE_RECORD_HMAC_VERSION,
    fields.workspaceScopeId,
    fields.canonicalPath,
    fields.createdAt,
    fields.controlGeneration,
  ]);
  return createHmac('sha256', key)
    .update(WORKSPACE_SCOPE_RECORD_HMAC_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalRecord, 'utf8')
    .digest('hex');
}

export function createTrustedWorkspaceScopeRecord(
  input: CreateTrustedWorkspaceScopeRecordInput,
  key: Uint8Array,
  options: WorkspaceIdentityOptions = {},
): TrustedWorkspaceScopeRecord {
  assertWorkspaceScopeMetadata(input);
  const identity = createWorkspaceIdentity(input.workspacePath, key, options);
  const authorityFields = {
    workspaceScopeId: input.workspaceScopeId,
    canonicalPath: identity.canonicalPath,
    createdAt: input.createdAt,
    controlGeneration: input.controlGeneration,
  } satisfies WorkspaceScopeRecordAuthorityFields;
  return {
    workspaceScopeId: authorityFields.workspaceScopeId,
    canonicalPathHmac: identity.canonicalPathHmac,
    canonicalPath: authorityFields.canonicalPath,
    createdAt: authorityFields.createdAt,
    controlGeneration: authorityFields.controlGeneration,
    recordHmac: computeWorkspaceScopeRecordHmac(authorityFields, key, options),
  };
}

function workspaceScopeRecordError(): Error {
  return new Error('Trusted workspace scope record validation failed.');
}

function hasExactWorkspaceScopeFields(value: Record<string, unknown>): boolean {
  const expected = [
    'canonicalPath',
    'canonicalPathHmac',
    'controlGeneration',
    'createdAt',
    'recordHmac',
    'workspaceScopeId',
  ];
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length && actual.every((field, index) => field === expected[index])
  );
}

function hasValidCanonicalPathShape(canonicalPath: string, platform: NodeJS.Platform): boolean {
  try {
    return canonicalizeRealPath(canonicalPath, platform) === canonicalPath;
  } catch {
    return false;
  }
}

function matchesHmac(actualHex: string, expectedHex: string): boolean {
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Validate an untrusted row before treating it as a workspace ownership
 * coordinate. This independently authenticates the path lookup identity and
 * the complete authority tuple; it intentionally performs no move/clone/adopt
 * inference and does not touch the filesystem.
 */
export function parseTrustedWorkspaceScopeRecord(
  value: unknown,
  key: Uint8Array,
  options: WorkspaceRecordValidationOptions = {},
): TrustedWorkspaceScopeRecord {
  assertControlHmacKey(key);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw workspaceScopeRecordError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw workspaceScopeRecordError();
  }

  const record = value as Record<string, unknown>;
  if (!hasExactWorkspaceScopeFields(record)) throw workspaceScopeRecordError();
  try {
    assertWorkspaceScopeMetadata({
      workspaceScopeId: record.workspaceScopeId,
      createdAt: record.createdAt,
      controlGeneration: record.controlGeneration,
    });
  } catch {
    throw workspaceScopeRecordError();
  }
  if (
    typeof record.canonicalPath !== 'string' ||
    !hasValidCanonicalPathShape(record.canonicalPath, options.platform ?? process.platform) ||
    typeof record.canonicalPathHmac !== 'string' ||
    !SHA256_HEX_PATTERN.test(record.canonicalPathHmac) ||
    typeof record.recordHmac !== 'string' ||
    !SHA256_HEX_PATTERN.test(record.recordHmac)
  ) {
    throw workspaceScopeRecordError();
  }

  const expectedPathHmac = computeCanonicalPathHmac(record.canonicalPath, key);
  const expectedRecordHmac = computeWorkspaceScopeRecordHmac(
    {
      workspaceScopeId: record.workspaceScopeId as string,
      canonicalPath: record.canonicalPath,
      createdAt: record.createdAt as number,
      controlGeneration: record.controlGeneration as number,
    },
    key,
    options,
  );
  const pathHmacMatches = matchesHmac(record.canonicalPathHmac, expectedPathHmac);
  const recordHmacMatches = matchesHmac(record.recordHmac, expectedRecordHmac);
  if (!pathHmacMatches || !recordHmacMatches) {
    throw workspaceScopeRecordError();
  }

  return {
    workspaceScopeId: record.workspaceScopeId as string,
    canonicalPathHmac: record.canonicalPathHmac,
    canonicalPath: record.canonicalPath,
    createdAt: record.createdAt as number,
    controlGeneration: record.controlGeneration as number,
    recordHmac: record.recordHmac,
  };
}

export function isTrustedWorkspaceScopeRecord(
  value: unknown,
  key: Uint8Array,
  options: WorkspaceRecordValidationOptions = {},
): value is TrustedWorkspaceScopeRecord {
  try {
    parseTrustedWorkspaceScopeRecord(value, key, options);
    return true;
  } catch {
    return false;
  }
}
