import { createHash } from 'node:crypto';

import type { ChatOperationV2Phase } from './types.js';

export const CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const CHAT_OPERATION_V2_MAX_COMPILE_DIAGNOSTICS = 200;
export const CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const MAX_DIAGNOSTIC_FIELD_CHARS = 4_096;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

export interface ChatInventoryCandidate {
  readonly id: string;
  readonly relativePath: string;
  readonly contentHash: string;
}

export interface ChatInventorySnapshot {
  readonly revision: number;
  readonly digest: string;
  readonly candidates: readonly ChatInventoryCandidate[];
}

export interface ChatCompileDiagnostic {
  readonly level: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface ChatReadSnapshotSubmission {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly generation: number;
  readonly candidateId: string;
  readonly rendererInstanceId: string;
  readonly localRevision: number;
  readonly canonicalYaml: string;
  readonly layoutJson: string | null;
  readonly requirementsMarkdown: string | null;
  readonly compileDiagnostics: readonly ChatCompileDiagnostic[];
}

export interface SealChatReadSnapshotHost {
  readonly workspaceScopeId: string;
  readonly generation: number;
  readonly inventory: ChatInventorySnapshot;
  readonly validateCanonicalYaml: (yaml: string) => void;
  readonly now?: () => number;
}

export interface ChatReadSnapshot extends ChatReadSnapshotSubmission {
  readonly version: 2;
  readonly candidateRelativePath: string;
  readonly candidateDiskHash: string;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly yamlHash: string;
  readonly layoutHash: string | null;
  readonly requirementsHash: string | null;
  readonly snapshotHash: string;
  readonly createdAt: number;
  readonly publishable: false;
}

export interface ChatReadSnapshotEvidence {
  readonly snapshotHash: string;
  readonly candidateId: string;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly rendererInstanceId: string;
  readonly localRevision: number;
  readonly yamlHash: string;
  readonly layoutHash: string | null;
  readonly requirementsHash: string | null;
  readonly yamlByteCount: number;
  readonly layoutByteCount: number;
  readonly requirementsByteCount: number;
  readonly compileDiagnosticCount: number;
}

export interface ChatArtifactEvidence {
  readonly yamlHash: string;
  readonly layoutHash: string | null;
  readonly requirementsHash: string | null;
}

export interface ChatMutationBases {
  readonly diskBase: ChatArtifactEvidence;
  readonly editorBase: ChatArtifactEvidence;
  readonly agentBase: ChatArtifactEvidence;
}

function assertId(value: string, label: string): void {
  if (!ID_RE.test(value)) throw new Error(`${label} is invalid.`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function normalizeCandidatePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    hasControlCharacter(normalized) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Chat inventory candidate relative path is invalid.');
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalInventoryPayload(candidates: readonly ChatInventoryCandidate[]): string {
  return candidates
    .map((candidate) => `${candidate.id}\0${candidate.relativePath}\0${candidate.contentHash}`)
    .join('\n');
}

export function createChatInventorySnapshot(
  revision: number,
  candidates: readonly ChatInventoryCandidate[],
): ChatInventorySnapshot {
  assertNonNegativeInteger(revision, 'Chat inventory revision');
  const normalized = candidates.map((candidate) => {
    assertId(candidate.id, 'Chat inventory candidate id');
    if (!SHA256_RE.test(candidate.contentHash)) {
      throw new Error('Chat inventory candidate content hash must be SHA-256.');
    }
    return Object.freeze({
      id: candidate.id,
      relativePath: normalizeCandidatePath(candidate.relativePath),
      contentHash: candidate.contentHash.toLowerCase(),
    });
  });
  normalized.sort((left, right) =>
    left.id === right.id
      ? left.relativePath.localeCompare(right.relativePath)
      : left.id.localeCompare(right.id),
  );
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const candidate of normalized) {
    const pathIdentity =
      process.platform === 'win32' ? candidate.relativePath.toLowerCase() : candidate.relativePath;
    if (ids.has(candidate.id) || paths.has(pathIdentity)) {
      throw new Error('Chat inventory contains a duplicate candidate identity or relative path.');
    }
    ids.add(candidate.id);
    paths.add(pathIdentity);
  }
  const frozenCandidates = Object.freeze(normalized.slice());
  return Object.freeze({
    revision,
    digest: sha256(canonicalInventoryPayload(frozenCandidates)),
    candidates: frozenCandidates,
  });
}

function assertArtifactSize(value: string | null, label: string): void {
  if (value === null) return;
  if (Buffer.byteLength(value, 'utf8') > CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES) {
    throw new Error(`${label} is too large.`);
  }
}

function optionalArtifactHash(value: string | null): string | null {
  return value === null ? null : sha256(value);
}

function normalizeDiagnostics(
  diagnostics: readonly ChatCompileDiagnostic[],
): readonly ChatCompileDiagnostic[] {
  if (diagnostics.length > CHAT_OPERATION_V2_MAX_COMPILE_DIAGNOSTICS) {
    throw new Error('Chat read snapshot contains too many compile diagnostics.');
  }
  return Object.freeze(
    diagnostics.map((diagnostic) => {
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) {
        throw new Error('Chat compile diagnostic must be a plain object.');
      }
      let keys: string[];
      try {
        const prototype = Object.getPrototypeOf(diagnostic);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new Error('Chat compile diagnostic must be a plain object.');
        }
        keys = Object.keys(diagnostic);
      } catch {
        throw new Error('Chat compile diagnostic must be a plain object.');
      }
      if (
        !['level', 'code', 'message'].every((key) => keys.includes(key)) ||
        keys.some((key) => !['level', 'code', 'message', 'path'].includes(key))
      ) {
        throw new Error('Chat compile diagnostic contains missing or unknown fields.');
      }
      if (diagnostic.level !== 'error' && diagnostic.level !== 'warning') {
        throw new Error('Chat compile diagnostic level is invalid.');
      }
      for (const [label, value] of [
        ['code', diagnostic.code],
        ['message', diagnostic.message],
        ['path', diagnostic.path],
      ] as const) {
        if (
          (label !== 'path' && (typeof value !== 'string' || value.length === 0)) ||
          (value !== undefined &&
            (typeof value !== 'string' || value.length > MAX_DIAGNOSTIC_FIELD_CHARS))
        ) {
          throw new Error(`Chat compile diagnostic ${label} is invalid.`);
        }
      }
      return Object.freeze({
        level: diagnostic.level,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      });
    }),
  );
}

function computeReadSnapshotHash(input: {
  operationId: string;
  workspaceScopeId: string;
  generation: number;
  candidateId: string;
  candidateRelativePath: string;
  candidateDiskHash: string;
  inventoryRevision: number;
  inventoryDigest: string;
  rendererInstanceId: string;
  localRevision: number;
  yamlHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
  compileDiagnostics: readonly ChatCompileDiagnostic[];
}): string {
  return sha256(
    [
      input.operationId,
      input.workspaceScopeId,
      String(input.generation),
      input.candidateId,
      input.candidateRelativePath,
      input.candidateDiskHash,
      String(input.inventoryRevision),
      input.inventoryDigest,
      input.rendererInstanceId,
      String(input.localRevision),
      input.yamlHash,
      input.layoutHash ?? '',
      input.requirementsHash ?? '',
      JSON.stringify(input.compileDiagnostics),
    ].join('\0'),
  );
}

export function sealChatReadSnapshot(
  submission: ChatReadSnapshotSubmission,
  host: SealChatReadSnapshotHost,
): ChatReadSnapshot {
  assertId(submission.operationId, 'Chat operation id');
  assertId(submission.workspaceScopeId, 'Chat workspace scope id');
  assertId(submission.candidateId, 'Chat candidate id');
  assertId(submission.rendererInstanceId, 'Chat renderer instance id');
  assertPositiveInteger(submission.generation, 'Chat operation generation');
  assertPositiveInteger(host.generation, 'Host operation generation');
  assertNonNegativeInteger(submission.localRevision, 'Chat renderer local revision');
  if (submission.workspaceScopeId !== host.workspaceScopeId) {
    throw new Error('Chat read snapshot workspace scope does not match Host authority.');
  }
  if (submission.generation !== host.generation) {
    throw new Error('Chat read snapshot generation does not match Host authority.');
  }
  const canonicalInventory = createChatInventorySnapshot(
    host.inventory.revision,
    host.inventory.candidates,
  );
  if (canonicalInventory.digest !== host.inventory.digest) {
    throw new Error('Chat Host inventory digest does not match its candidates.');
  }
  const candidate = canonicalInventory.candidates.find(
    (entry) => entry.id === submission.candidateId,
  );
  if (!candidate) throw new Error('Chat read snapshot candidate is not in Host inventory.');
  if (!submission.canonicalYaml) throw new Error('Chat read snapshot canonical YAML is required.');
  assertArtifactSize(submission.canonicalYaml, 'Chat read snapshot canonical YAML');
  assertArtifactSize(submission.layoutJson, 'Chat read snapshot layout');
  assertArtifactSize(submission.requirementsMarkdown, 'Chat read snapshot requirements');
  if (submission.layoutJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(submission.layoutJson);
    } catch {
      throw new Error('Chat read snapshot layout is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Chat read snapshot layout must be a JSON object.');
    }
  }
  host.validateCanonicalYaml(submission.canonicalYaml);
  const compileDiagnostics = normalizeDiagnostics(submission.compileDiagnostics);
  const yamlHash = sha256(submission.canonicalYaml);
  const layoutHash = optionalArtifactHash(submission.layoutJson);
  const requirementsHash = optionalArtifactHash(submission.requirementsMarkdown);
  const createdAt = host.now?.() ?? Date.now();
  assertNonNegativeInteger(createdAt, 'Chat read snapshot timestamp');
  const snapshotHash = computeReadSnapshotHash({
    operationId: submission.operationId,
    workspaceScopeId: submission.workspaceScopeId,
    generation: submission.generation,
    candidateId: candidate.id,
    candidateRelativePath: candidate.relativePath,
    candidateDiskHash: candidate.contentHash,
    inventoryRevision: canonicalInventory.revision,
    inventoryDigest: canonicalInventory.digest,
    rendererInstanceId: submission.rendererInstanceId,
    localRevision: submission.localRevision,
    yamlHash,
    layoutHash,
    requirementsHash,
    compileDiagnostics,
  });
  return Object.freeze({
    version: 2,
    operationId: submission.operationId,
    workspaceScopeId: submission.workspaceScopeId,
    generation: submission.generation,
    candidateId: candidate.id,
    candidateRelativePath: candidate.relativePath,
    candidateDiskHash: candidate.contentHash,
    inventoryRevision: canonicalInventory.revision,
    inventoryDigest: canonicalInventory.digest,
    rendererInstanceId: submission.rendererInstanceId,
    localRevision: submission.localRevision,
    canonicalYaml: submission.canonicalYaml,
    layoutJson: submission.layoutJson,
    requirementsMarkdown: submission.requirementsMarkdown,
    compileDiagnostics,
    yamlHash,
    layoutHash,
    requirementsHash,
    snapshotHash,
    createdAt,
    publishable: false,
  });
}

const READ_SNAPSHOT_KEYS = [
  'version',
  'operationId',
  'workspaceScopeId',
  'generation',
  'candidateId',
  'candidateRelativePath',
  'candidateDiskHash',
  'inventoryRevision',
  'inventoryDigest',
  'rendererInstanceId',
  'localRevision',
  'canonicalYaml',
  'layoutJson',
  'requirementsMarkdown',
  'compileDiagnostics',
  'yamlHash',
  'layoutHash',
  'requirementsHash',
  'snapshotHash',
  'createdAt',
  'publishable',
] as const;

function exactReadSnapshotRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat read snapshot must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Chat read snapshot must be a plain object.');
  }
  const actual = Object.keys(value).sort();
  const expected = [...READ_SNAPSHOT_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Chat read snapshot contains missing or unknown fields.');
  }
  return value as Record<string, unknown>;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be SHA-256.`);
  }
  return value.toLowerCase();
}

/** Parse persisted snapshot bytes without trusting authored hashes or mutable coordinates. */
export function parseChatReadSnapshot(value: unknown): ChatReadSnapshot {
  const record = exactReadSnapshotRecord(value);
  if (record.version !== 2) throw new Error('Chat read snapshot version is unsupported.');
  if (record.publishable !== false) {
    throw new Error('Chat read snapshot must remain non-publishable.');
  }
  for (const [field, label] of [
    ['operationId', 'Chat operation id'],
    ['workspaceScopeId', 'Chat workspace scope id'],
    ['candidateId', 'Chat candidate id'],
    ['rendererInstanceId', 'Chat renderer instance id'],
  ] as const) {
    if (typeof record[field] !== 'string') throw new Error(`${label} is invalid.`);
    assertId(record[field], label);
  }
  for (const [field, label] of [
    ['inventoryRevision', 'Chat inventory revision'],
    ['localRevision', 'Chat renderer local revision'],
    ['createdAt', 'Chat read snapshot timestamp'],
  ] as const) {
    if (typeof record[field] !== 'number') throw new Error(`${label} is invalid.`);
    assertNonNegativeInteger(record[field], label);
  }
  if (typeof record.generation !== 'number') {
    throw new Error('Chat operation generation is invalid.');
  }
  assertPositiveInteger(record.generation, 'Chat operation generation');
  if (typeof record.candidateRelativePath !== 'string') {
    throw new Error('Chat candidate relative path is invalid.');
  }
  const candidateRelativePath = normalizeCandidatePath(record.candidateRelativePath);
  if (candidateRelativePath !== record.candidateRelativePath) {
    throw new Error('Chat candidate relative path is not canonical.');
  }
  if (typeof record.canonicalYaml !== 'string' || !record.canonicalYaml) {
    throw new Error('Chat read snapshot canonical YAML is required.');
  }
  if (record.layoutJson !== null && typeof record.layoutJson !== 'string') {
    throw new Error('Chat read snapshot layout must be a string or null.');
  }
  if (record.requirementsMarkdown !== null && typeof record.requirementsMarkdown !== 'string') {
    throw new Error('Chat read snapshot requirements must be a string or null.');
  }
  assertArtifactSize(record.canonicalYaml, 'Chat read snapshot canonical YAML');
  assertArtifactSize(record.layoutJson, 'Chat read snapshot layout');
  assertArtifactSize(record.requirementsMarkdown, 'Chat read snapshot requirements');
  if (record.layoutJson !== null) {
    let parsedLayout: unknown;
    try {
      parsedLayout = JSON.parse(record.layoutJson);
    } catch {
      throw new Error('Chat read snapshot layout is not valid JSON.');
    }
    if (!parsedLayout || typeof parsedLayout !== 'object' || Array.isArray(parsedLayout)) {
      throw new Error('Chat read snapshot layout must be a JSON object.');
    }
  }
  if (!Array.isArray(record.compileDiagnostics)) {
    throw new Error('Chat read snapshot compile diagnostics must be an array.');
  }
  const compileDiagnostics = normalizeDiagnostics(
    record.compileDiagnostics as readonly ChatCompileDiagnostic[],
  );
  const yamlHash = requireSha256(record.yamlHash, 'Chat read snapshot YAML hash');
  const layoutHash =
    record.layoutHash === null
      ? null
      : requireSha256(record.layoutHash, 'Chat read snapshot layout hash');
  const requirementsHash =
    record.requirementsHash === null
      ? null
      : requireSha256(record.requirementsHash, 'Chat read snapshot requirements hash');
  if (yamlHash !== sha256(record.canonicalYaml)) {
    throw new Error('Chat read snapshot YAML hash does not match its bytes.');
  }
  if (layoutHash !== optionalArtifactHash(record.layoutJson)) {
    throw new Error('Chat read snapshot layout hash does not match its bytes.');
  }
  if (requirementsHash !== optionalArtifactHash(record.requirementsMarkdown)) {
    throw new Error('Chat read snapshot requirements hash does not match its bytes.');
  }
  const candidateDiskHash = requireSha256(record.candidateDiskHash, 'Chat candidate disk hash');
  const inventoryDigest = requireSha256(record.inventoryDigest, 'Chat inventory digest');
  const snapshotHash = requireSha256(record.snapshotHash, 'Chat read snapshot hash');
  const normalized: Omit<ChatReadSnapshot, 'snapshotHash'> = {
    version: 2,
    operationId: record.operationId as string,
    workspaceScopeId: record.workspaceScopeId as string,
    generation: record.generation as number,
    candidateId: record.candidateId as string,
    candidateRelativePath,
    candidateDiskHash,
    inventoryRevision: record.inventoryRevision as number,
    inventoryDigest,
    rendererInstanceId: record.rendererInstanceId as string,
    localRevision: record.localRevision as number,
    canonicalYaml: record.canonicalYaml,
    layoutJson: record.layoutJson,
    requirementsMarkdown: record.requirementsMarkdown,
    compileDiagnostics,
    yamlHash,
    layoutHash,
    requirementsHash,
    createdAt: record.createdAt as number,
    publishable: false,
  };
  const expectedSnapshotHash = computeReadSnapshotHash(normalized);
  if (snapshotHash !== expectedSnapshotHash) {
    throw new Error('Chat read snapshot hash does not match its evidence.');
  }
  return Object.freeze({ ...normalized, snapshotHash });
}

export function encodeChatReadSnapshot(value: unknown): Uint8Array {
  const encoded = textEncoder.encode(JSON.stringify(parseChatReadSnapshot(value)));
  if (encoded.byteLength > CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES) {
    throw new Error('Chat read snapshot canonical bytes are too large.');
  }
  return encoded;
}

export function decodeChatReadSnapshot(value: unknown): ChatReadSnapshot {
  if (!(value instanceof Uint8Array)) {
    throw new Error('Chat read snapshot canonical bytes must be Uint8Array.');
  }
  if (value.byteLength > CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES) {
    throw new Error('Chat read snapshot canonical bytes are too large.');
  }
  let text: string;
  try {
    text = fatalTextDecoder.decode(value);
  } catch {
    throw new Error('Chat read snapshot canonical bytes are not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Chat read snapshot canonical bytes are not valid JSON.');
  }
  const snapshot = parseChatReadSnapshot(parsed);
  const canonical = encodeChatReadSnapshot(snapshot);
  if (!Buffer.from(canonical).equals(Buffer.from(value))) {
    throw new Error('Chat read snapshot canonical bytes are not canonical JSON.');
  }
  return snapshot;
}

export function toChatReadSnapshotEvidence(value: unknown): ChatReadSnapshotEvidence {
  const snapshot = parseChatReadSnapshot(value);
  return Object.freeze({
    snapshotHash: snapshot.snapshotHash,
    candidateId: snapshot.candidateId,
    inventoryRevision: snapshot.inventoryRevision,
    inventoryDigest: snapshot.inventoryDigest,
    rendererInstanceId: snapshot.rendererInstanceId,
    localRevision: snapshot.localRevision,
    yamlHash: snapshot.yamlHash,
    layoutHash: snapshot.layoutHash,
    requirementsHash: snapshot.requirementsHash,
    yamlByteCount: Buffer.byteLength(snapshot.canonicalYaml, 'utf8'),
    layoutByteCount:
      snapshot.layoutJson === null ? 0 : Buffer.byteLength(snapshot.layoutJson, 'utf8'),
    requirementsByteCount:
      snapshot.requirementsMarkdown === null
        ? 0
        : Buffer.byteLength(snapshot.requirementsMarkdown, 'utf8'),
    compileDiagnosticCount: snapshot.compileDiagnostics.length,
  });
}

function sealArtifactEvidence(value: ChatArtifactEvidence, label: string): ChatArtifactEvidence {
  if (!SHA256_RE.test(value.yamlHash)) throw new Error(`${label} YAML hash must be SHA-256.`);
  if (value.layoutHash !== null && !SHA256_RE.test(value.layoutHash)) {
    throw new Error(`${label} layout hash must be SHA-256 or null.`);
  }
  if (value.requirementsHash !== null && !SHA256_RE.test(value.requirementsHash)) {
    throw new Error(`${label} requirements hash must be SHA-256 or null.`);
  }
  return Object.freeze({
    yamlHash: value.yamlHash.toLowerCase(),
    layoutHash: value.layoutHash?.toLowerCase() ?? null,
    requirementsHash: value.requirementsHash?.toLowerCase() ?? null,
  });
}

export function sealChatMutationBases(value: ChatMutationBases): ChatMutationBases {
  return Object.freeze({
    diskBase: sealArtifactEvidence(value.diskBase, 'Chat disk base'),
    editorBase: sealArtifactEvidence(value.editorBase, 'Chat editor base'),
    agentBase: sealArtifactEvidence(value.agentBase, 'Chat agent base'),
  });
}

const MUTATION_BASES_IMMUTABLE_PHASES = new Set([
  'reserving',
  'staging',
  'authoring',
  'verifying',
  'repairing',
  'commit_preparing',
  'commit_decided',
  'commit_applying',
  'commit_recovering',
  'terminal',
]);

export function assertChatMutationBasesMayChange(phase: ChatOperationV2Phase): void {
  if (MUTATION_BASES_IMMUTABLE_PHASES.has(phase)) {
    throw new Error('Chat mutation baselines are immutable from reserving onward.');
  }
}
