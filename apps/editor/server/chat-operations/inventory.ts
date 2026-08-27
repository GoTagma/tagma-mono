import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { relative, resolve } from 'node:path';

import yaml from 'js-yaml';

import type { ChatPipelineIntentCandidate } from '../../shared/chat-pipeline-intent-classifier.js';
import { sameFilesystemPathCoordinate } from '../../shared/filesystem-paths.js';
import {
  enumerateFlatPipelineYamls,
  enumeratePipelineYamls,
  tagmaDirOf,
} from '../pipeline-paths.js';
import {
  CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES,
  CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES,
  createChatInventorySnapshot,
  type ChatInventorySnapshot,
} from './snapshots.js';

export const CHAT_OPERATION_V2_MAX_INVENTORY_YAML_BYTES =
  CHAT_OPERATION_V2_MAX_SNAPSHOT_ARTIFACT_BYTES;
export const CHAT_OPERATION_V2_MAX_INVENTORY_BYTES = CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES;
export const CHAT_OPERATION_V2_MAX_INVENTORY_CANDIDATES = 256;
export const CHAT_OPERATION_V2_MAX_PIPELINE_NAME_BYTES = 1_024;

const CANDIDATE_ID_PREFIX = 'pipeline_';
const CANDIDATE_ID_HEX_LENGTH = 64;
const CANDIDATE_ID_PURPOSE = 'tagma-chat-operation-v2-pipeline-candidate\0';

export type ChatOperationV2InventoryErrorCode =
  | 'invalid_revision'
  | 'unsafe_workspace'
  | 'candidate_unreadable'
  | 'candidate_changed'
  | 'candidate_too_large'
  | 'inventory_too_large'
  | 'candidate_collision'
  | 'unknown_candidate';

export class ChatOperationV2InventoryError extends Error {
  constructor(
    readonly code: ChatOperationV2InventoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatOperationV2InventoryError';
  }
}

export interface ChatOperationV2HostCoordinates {
  /** Trusted sidecar state only. Renderer paths must never be forwarded here. */
  readonly currentCanvasPath?: string | null;
  /** Trusted binding registry coordinate only. */
  readonly sessionOwnedPath?: string | null;
  /** Trusted sidecar manual-draft coordinate only. */
  readonly manualNewDraftPath?: string | null;
}

export interface BuildChatOperationV2HostInventoryInput {
  /** Workspace coordinate selected and authenticated by the Host. */
  readonly canonicalWorkspaceRoot: string;
  /** Host state revision frozen with this enumeration. */
  readonly revision: number;
  /** Trusted sidecar state only. Renderer paths must never be forwarded here. */
  readonly currentCanvasPath?: string | null;
  /** Trusted binding registry coordinate only. */
  readonly sessionOwnedPath?: string | null;
  /** Trusted sidecar manual-draft coordinate only. */
  readonly manualNewDraftPath?: string | null;
}

export interface ChatOperationV2ResolvedPipelineCandidate {
  readonly id: string;
  readonly relativePath: string;
  /** Absolute canonical Host coordinate. Never serialize this record to the renderer. */
  readonly yamlPath: string;
  readonly contentHash: string;
  /** Exact, immutable UTF-8 text read when the inventory digest was formed. */
  readonly content: string;
  readonly pipelineName: string | null;
}

interface ReadCandidate extends ChatOperationV2ResolvedPipelineCandidate {
  readonly currentCanvas: boolean;
  readonly sessionOwned: boolean;
  readonly manualNewDraft: boolean;
}

export interface ChatOperationV2HostInventory {
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  resolveCandidate(candidateId: string): ChatOperationV2ResolvedPipelineCandidate;
}

/**
 * A frozen, path-private inventory projection plus a Host-only exact-id resolver.
 * The private map intentionally keeps canonical absolute coordinates out of JSON.
 */
class BuiltChatOperationV2HostInventory implements ChatOperationV2HostInventory {
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  readonly #candidateById: ReadonlyMap<string, ChatOperationV2ResolvedPipelineCandidate>;

  constructor(candidates: readonly ReadCandidate[], revision: number) {
    const ordered = [...candidates].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    const byId = new Map<string, ChatOperationV2ResolvedPipelineCandidate>();
    for (const candidate of ordered) {
      if (byId.has(candidate.id)) {
        throw new ChatOperationV2InventoryError(
          'candidate_collision',
          'Host pipeline candidate identities collided.',
        );
      }
      byId.set(
        candidate.id,
        Object.freeze({
          id: candidate.id,
          relativePath: candidate.relativePath,
          yamlPath: candidate.yamlPath,
          contentHash: candidate.contentHash,
          content: candidate.content,
          pipelineName: candidate.pipelineName,
        }),
      );
    }

    this.inventory = createChatInventorySnapshot(
      revision,
      ordered.map(({ id, relativePath, contentHash }) => ({ id, relativePath, contentHash })),
    );
    this.candidates = Object.freeze(
      ordered.map((candidate) =>
        Object.freeze({
          id: candidate.id,
          path: candidate.relativePath,
          pipelineName: candidate.pipelineName,
          currentCanvas: candidate.currentCanvas,
          sessionOwned: candidate.sessionOwned,
          manualNewDraft: candidate.manualNewDraft,
        }),
      ),
    );
    this.#candidateById = byId;
    Object.freeze(this);
  }

  resolveCandidate(candidateId: string): ChatOperationV2ResolvedPipelineCandidate {
    const candidate =
      typeof candidateId === 'string' ? this.#candidateById.get(candidateId) : undefined;
    if (!candidate) {
      throw new ChatOperationV2InventoryError(
        'unknown_candidate',
        'The request selected an unknown Host pipeline candidate.',
      );
    }
    return candidate;
  }
}

function fail(code: ChatOperationV2InventoryErrorCode, message: string): never {
  throw new ChatOperationV2InventoryError(code, message);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0 || Object.is(revision, -0)) {
    fail('invalid_revision', 'Host pipeline inventory revision must be a non-negative integer.');
  }
}

function portableRelativePath(parent: string, child: string): string {
  const value = relative(parent, child).replace(/\\/g, '/');
  if (
    !value ||
    hasControlCharacter(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:\//.test(value) ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return fail('candidate_unreadable', 'A pipeline candidate escaped the Host inventory root.');
  }
  return value;
}

function pathIdentity(value: string): string {
  const portable = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? portable.toLowerCase() : portable;
}

function candidateId(relativePath: string): string {
  const digest = createHash('sha256')
    .update(CANDIDATE_ID_PURPOSE)
    .update(pathIdentity(relativePath))
    .digest('hex')
    .slice(0, CANDIDATE_ID_HEX_LENGTH);
  return `${CANDIDATE_ID_PREFIX}${digest}`;
}

function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readStableRegularFile(yamlPath: string): Buffer {
  let descriptor: number | null = null;
  try {
    const direct = lstatSync(yamlPath);
    if (direct.isSymbolicLink() || !direct.isFile()) {
      return fail('candidate_unreadable', 'A pipeline candidate is not a regular file.');
    }
    if (direct.size > CHAT_OPERATION_V2_MAX_INVENTORY_YAML_BYTES) {
      return fail(
        'candidate_too_large',
        'A pipeline candidate exceeds the V2 inventory byte limit.',
      );
    }

    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(yamlPath, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor);
    if (!before.isFile() || !sameFileIdentity(direct, before)) {
      return fail('candidate_changed', 'A pipeline candidate changed during Host enumeration.');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const finalDirect = lstatSync(yamlPath);
    if (
      bytes.byteLength !== before.size ||
      !sameFileIdentity(before, after) ||
      finalDirect.isSymbolicLink() ||
      !sameFileIdentity(after, finalDirect)
    ) {
      return fail('candidate_changed', 'A pipeline candidate changed during Host enumeration.');
    }
    return bytes;
  } catch (error) {
    if (error instanceof ChatOperationV2InventoryError) throw error;
    return fail('candidate_unreadable', 'A pipeline candidate could not be read safely.');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function pipelineNameFromYaml(source: string): string | null {
  try {
    const document = yaml.load(source);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
    const record = document as Record<string, unknown>;
    const pipeline =
      record.pipeline && typeof record.pipeline === 'object' && !Array.isArray(record.pipeline)
        ? (record.pipeline as Record<string, unknown>)
        : null;
    const rawName =
      (pipeline && typeof pipeline.name === 'string' ? pipeline.name : null) ??
      (typeof record.name === 'string' ? record.name : null);
    if (rawName === null) return null;
    const name = rawName.trim();
    if (
      name.length === 0 ||
      hasControlCharacter(name) ||
      Buffer.byteLength(name, 'utf8') > CHAT_OPERATION_V2_MAX_PIPELINE_NAME_BYTES
    ) {
      return null;
    }
    return name;
  } catch {
    return null;
  }
}

function canonicalHostCoordinate(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const direct = lstatSync(value);
    if (direct.isSymbolicLink() || !direct.isFile()) return null;
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

function candidateCoordinateMatches(
  candidatePath: string,
  coordinate: string | null | undefined,
): boolean {
  const canonicalCoordinate = canonicalHostCoordinate(coordinate);
  return sameFilesystemPathCoordinate(candidatePath, canonicalCoordinate, process.platform);
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    return fail('unsafe_workspace', 'The Host workspace root is unavailable.');
  }
  try {
    const canonical = realpathSync.native(workspaceRoot);
    const stat = lstatSync(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return fail('unsafe_workspace', 'The Host workspace root is not a regular directory.');
    }
    return canonical;
  } catch (error) {
    if (error instanceof ChatOperationV2InventoryError) throw error;
    return fail('unsafe_workspace', 'The Host workspace root could not be authenticated.');
  }
}

function assertSafeTagmaRoot(workspaceRoot: string): string | null {
  const tagmaRoot = tagmaDirOf(workspaceRoot);
  let direct: Stats;
  try {
    direct = lstatSync(tagmaRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return fail('unsafe_workspace', 'The workspace .tagma root could not be inspected safely.');
  }
  try {
    if (direct.isSymbolicLink() || !direct.isDirectory()) {
      return fail('unsafe_workspace', 'The workspace .tagma root is not a regular directory.');
    }
    const canonical = realpathSync.native(tagmaRoot);
    if (!sameFilesystemPathCoordinate(tagmaRoot, canonical, process.platform)) {
      return fail('unsafe_workspace', 'The workspace .tagma root has an unsafe filesystem alias.');
    }
    // Ensure an unreadable Host inventory never degrades into an authoritative empty list.
    readdirSync(canonical);
    return canonical;
  } catch (error) {
    if (error instanceof ChatOperationV2InventoryError) throw error;
    return fail('unsafe_workspace', 'The workspace .tagma root could not be read safely.');
  }
}

function readCandidate(
  tagmaRoot: string,
  yamlPath: string,
  coordinates: ChatOperationV2HostCoordinates,
): ReadCandidate {
  const expectedPath = resolve(yamlPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(expectedPath);
  } catch {
    return fail('candidate_unreadable', 'A pipeline candidate could not be authenticated.');
  }
  if (!sameFilesystemPathCoordinate(expectedPath, canonicalPath, process.platform)) {
    return fail('candidate_unreadable', 'A pipeline candidate has an unsafe filesystem alias.');
  }
  const relativePath = portableRelativePath(tagmaRoot, canonicalPath);
  const bytes = readStableRegularFile(canonicalPath);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail('candidate_unreadable', 'A pipeline candidate is not valid UTF-8 text.');
  }
  return Object.freeze({
    id: candidateId(relativePath),
    relativePath,
    yamlPath: canonicalPath,
    contentHash: contentHash(bytes),
    content,
    pipelineName: pipelineNameFromYaml(content),
    currentCanvas: candidateCoordinateMatches(canonicalPath, coordinates.currentCanvasPath),
    sessionOwned: candidateCoordinateMatches(canonicalPath, coordinates.sessionOwnedPath),
    manualNewDraft: candidateCoordinateMatches(canonicalPath, coordinates.manualNewDraftPath),
  });
}

export function buildChatOperationV2HostInventory(
  input: BuildChatOperationV2HostInventoryInput,
): ChatOperationV2HostInventory {
  assertRevision(input.revision);
  const workspaceRoot = canonicalWorkspaceRoot(input.canonicalWorkspaceRoot);
  const tagmaRoot = assertSafeTagmaRoot(workspaceRoot);
  if (tagmaRoot === null) return new BuiltChatOperationV2HostInventory([], input.revision);

  const coordinates: ChatOperationV2HostCoordinates = {
    currentCanvasPath: input.currentCanvasPath,
    sessionOwnedPath: input.sessionOwnedPath,
    manualNewDraftPath: input.manualNewDraftPath,
  };
  const entries = [
    ...enumeratePipelineYamls(workspaceRoot),
    ...enumerateFlatPipelineYamls(workspaceRoot),
  ];
  if (entries.length > CHAT_OPERATION_V2_MAX_INVENTORY_CANDIDATES) {
    return fail('inventory_too_large', 'The Host pipeline inventory has too many candidates.');
  }
  const candidates: ReadCandidate[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const candidate = readCandidate(tagmaRoot, entry.yamlPath, coordinates);
    totalBytes += Buffer.byteLength(candidate.content, 'utf8');
    if (totalBytes > CHAT_OPERATION_V2_MAX_INVENTORY_BYTES) {
      return fail('inventory_too_large', 'The Host pipeline inventory exceeds its byte limit.');
    }
    candidates.push(candidate);
  }
  return new BuiltChatOperationV2HostInventory(candidates, input.revision);
}
