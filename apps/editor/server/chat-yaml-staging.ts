import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import yaml from 'js-yaml';
import type { PipelineConfig } from '@tagma/sdk';
import { loadPipeline, parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { pipelineTrialPlanPath, readChatPipelineTrialPlan } from './chat-pipeline-trial-plan.js';
import {
  buildChatPipelineTrialLiveSmokeReadiness,
  CHAT_PIPELINE_TRIAL_CACHE_VERSION,
  isChatPipelineTrialLiveSmokeReadiness,
  type ChatPipelineTrialLiveSmokeReadiness,
} from './chat-pipeline-trial-cache.js';
import {
  resolveChatPipelineDataReadiness,
  resolveChatPipelineLiveSmokeBaseline,
} from './chat-pipeline-trial-readiness.js';
import {
  buildChatPipelineTrialabilityReport,
  ChatPipelineTrialMode,
  ChatPipelineTrialabilityReport,
} from './chat-pipeline-trialability.js';
import { readEditorSettings } from './plugins/loader.js';
import { hasCurrentChatPipelineTrialLiveSmokeTestConsent } from '../shared/chat-pipeline-trial-consent.js';
import type {
  PreparedTrialHostWitnessInputs,
  TrialHostWitness,
} from './chat-pipeline-trial-witness.js';
import {
  safeCaptureTrialHostWitnessAsync,
  safePrepareTrialHostWitnessInputs,
} from './chat-pipeline-trial-witness.js';

import type { EditorLayout, WorkspaceState } from './workspace-state.js';
import { atomicWriteFileSync, isPathWithin } from './path-utils.js';
import {
  ensureServerRecordControlRootSync,
  readAuthenticatedServerRecordSync,
  writeAuthenticatedServerRecordSync,
  type ServerRecordContext,
} from './server-record-auth.js';
import {
  assertPipelineYamlPath,
  enumerateFlatPipelineYamls,
  enumeratePipelineYamls,
  pipelineCompileLogPath,
  pipelineLayoutPath,
  pipelineRequirementsPath,
  pipelineYamlPath,
  sanitizePipelineStem,
  stemFromYamlBasename,
  tagmaDirOf,
} from './pipeline-paths.js';
import { pipelineManifestPath, runPipelineManifestSync } from './pipeline-manifest.js';
import {
  assertRequirementsConsistentWithYamlChange,
  parseRequirementsMd,
  runRequirementsSync,
} from './requirements-sync.js';
import { runCompileAndWriteLog } from './compile-log.js';
import { validateChatPipelinePathCoordinates } from './chat-pipeline-path-validation.js';
import {
  beginWatching,
  broadcastStateEvent,
  bumpRevision,
  getState,
  loadLayout,
  sameFilesystemPath,
  withDefaultTrackColors,
} from './state.js';
import { getFileVersion } from './optimistic-lock.js';
import { startChatCompileWatcher, stopChatCompileWatcher } from './chat-compile-watcher.js';
import { rewriteCopiedPipelineYaml } from './pipeline-copy-paths.js';
import {
  DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
  isValidChatPipelineTrialPlanAttempts,
} from '../shared/chat-pipeline-trial-plan-limit.js';
import { CREATE_NEW_PIPELINE_ACTION_KIND } from '../shared/requested-action.js';

const STAGING_DIR_NAME = '.chat-staging';
const STAGE_METADATA_FILE = 'stage.json';
const STAGE_RESULT_FILE = 'finalized.json';
const STAGE_TARGET_RESULTS_DIR = 'finalized-results';
const STAGE_VERSION = 3;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_TREE_BYTES = 64 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_TREE_ENTRIES = 1_024;
const MAX_PIPELINE_SUPPORT_TREE_DEPTH = 32;
// Managed OpenCode may have left project runtime state at an older task cwd. It is never a
// publishable pipeline support artifact, regardless of where that cwd sits in the support tree.
const PIPELINE_SUPPORT_RUNTIME_DIRECTORY_NAMES = new Set(['.opencode']);
const STAGE_TTL_MS = 8 * 24 * 60 * 60 * 1_000;
const TRIAL_CACHE_VERSION = CHAT_PIPELINE_TRIAL_CACHE_VERSION;
const FINALIZE_TRIAL_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const FINALIZE_WITNESS_TIMEOUT_MS = 60 * 60 * 1_000;
const LEGACY_STAGE_LOCK_RECOVERY_MESSAGE =
  'This unfinished Chat result is from an older Tagma version and cannot be resumed safely ' +
  'because it has no lock ownership metadata. Choose Keep canvas, discard Chat result, ' +
  'then resend to create a fresh isolated stage.';

export type ChatYamlFinalizeWitnessFailureKind =
  'chat-yaml-finalize-witness-timeout' | 'chat-yaml-finalize-witness-aborted';

export class ChatYamlFinalizeWitnessError extends Error {
  readonly kind: ChatYamlFinalizeWitnessFailureKind;

  constructor(kind: ChatYamlFinalizeWitnessFailureKind) {
    super(
      kind === 'chat-yaml-finalize-witness-timeout'
        ? 'Final staged YAML witness verification timed out before publish.'
        : 'Final staged YAML witness verification was cancelled before publish.',
    );
    this.name = 'ChatYamlFinalizeWitnessError';
    this.kind = kind;
  }
}

export class ChatYamlStageLockOwnershipError extends Error {
  constructor(message = 'The chat YAML stage does not belong to the active YAML edit lock.') {
    super(message);
    this.name = 'ChatYamlStageLockOwnershipError';
  }
}

export type ChatYamlStageSessionRelocationPhase = 'prepared' | 'staged' | 'restoring';

export interface ChatYamlStageSessionRelocationBinding {
  version: 1;
  relocationId: string;
  stageId: string;
  sessionId: string;
  sourceDirectory: string;
  targetDirectory: string;
  phase: ChatYamlStageSessionRelocationPhase;
  updatedAt: number;
}

export interface ChatYamlStageSessionRelocationIdentity {
  stageId: string;
  sessionId: string;
  relocationId: string;
}

export interface ChatYamlStageSessionRelocationAdvanceInput extends ChatYamlStageSessionRelocationIdentity {
  expectedPhase: ChatYamlStageSessionRelocationPhase;
  phase: ChatYamlStageSessionRelocationPhase;
}

export type ChatYamlStageSessionRelocationClearInput = ChatYamlStageSessionRelocationIdentity & {
  expectedPhase: ChatYamlStageSessionRelocationPhase;
} & (
    | { verifiedHomeDirectory: string; verifiedSessionMissing?: never }
    | { verifiedSessionMissing: true; verifiedHomeDirectory?: never }
  );

export class ChatYamlStageSessionRelocationError extends Error {
  readonly kind: 'invalid' | 'conflict';

  constructor(kind: 'invalid' | 'conflict', message: string) {
    super(message);
    this.name = 'ChatYamlStageSessionRelocationError';
    this.kind = kind;
  }
}

interface ActiveFinalizeWitness {
  stageId: string;
  trialId: string;
  controller: AbortController;
  timedOut: boolean;
}

const activeFinalizeWitnessByWorkspace = new WeakMap<WorkspaceState, ActiveFinalizeWitness>();

export const __chatYamlStagingTestHooks: {
  afterDestinationYamlWrite?: (destinationYamlPath: string) => void;
  beforeFinalizeResultWrite?: (resultPath: string) => void;
  captureHostWitnessAsync?: (
    ws: WorkspaceState,
    prepared: PreparedTrialHostWitnessInputs,
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof safeCaptureTrialHostWitnessAsync>>>;
  finalizeWitnessTimeoutMsOverride?: number;
} = {};

async function captureFinalizeHostWitnessAsync(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof safeCaptureTrialHostWitnessAsync>>> {
  if (__chatYamlStagingTestHooks.captureHostWitnessAsync) {
    return await __chatYamlStagingTestHooks.captureHostWitnessAsync(ws, prepared, signal);
  }
  return await safeCaptureTrialHostWitnessAsync(ws, prepared, signal);
}

function finalizeWitnessError(active: ActiveFinalizeWitness): ChatYamlFinalizeWitnessError {
  return new ChatYamlFinalizeWitnessError(
    active.timedOut ? 'chat-yaml-finalize-witness-timeout' : 'chat-yaml-finalize-witness-aborted',
  );
}

async function captureFinalizeHostWitnessWithDeadline(
  ws: WorkspaceState,
  stageId: string,
  trialId: string,
  prepared: PreparedTrialHostWitnessInputs,
): Promise<Awaited<ReturnType<typeof safeCaptureTrialHostWitnessAsync>>> {
  if (activeFinalizeWitnessByWorkspace.has(ws)) {
    throw new Error('Another staged YAML finalize witness verification is already active.');
  }
  const controller = new AbortController();
  const active: ActiveFinalizeWitness = {
    stageId,
    trialId,
    controller,
    timedOut: false,
  };
  const timeoutMsOverride = __chatYamlStagingTestHooks.finalizeWitnessTimeoutMsOverride;
  const timeoutMs =
    typeof timeoutMsOverride === 'number'
      ? Math.max(1, timeoutMsOverride)
      : FINALIZE_WITNESS_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    active.timedOut = true;
    controller.abort('final staged YAML witness verification timeout');
  }, timeoutMs);
  if (timeoutMsOverride === undefined) timeout.unref?.();
  activeFinalizeWitnessByWorkspace.set(ws, active);
  try {
    const witness = await captureFinalizeHostWitnessAsync(ws, prepared, controller.signal);
    if (controller.signal.aborted) throw finalizeWitnessError(active);
    return witness;
  } catch (err) {
    if (controller.signal.aborted) throw finalizeWitnessError(active);
    throw err;
  } finally {
    clearTimeout(timeout);
    if (activeFinalizeWitnessByWorkspace.get(ws) === active) {
      activeFinalizeWitnessByWorkspace.delete(ws);
    }
  }
}

export function cancelChatYamlStageFinalize(
  ws: WorkspaceState,
  input: { stageId: string; trialId: string },
): boolean {
  const active = activeFinalizeWitnessByWorkspace.get(ws);
  if (!active || active.stageId !== input.stageId || active.trialId !== input.trialId) {
    return false;
  }
  active.controller.abort('user stopped final staged YAML witness verification');
  return true;
}

type ChatYamlStageConflict =
  | 'local-branch-changed'
  | 'source-changed-on-disk'
  | 'source-deleted'
  | 'path-moved'
  | 'compile-failed'
  | 'trial-run-failed'
  | 'destination-exists';

interface ChatYamlStageMetadata {
  version: typeof STAGE_VERSION;
  id: string;
  createdAt: number;
  ownerLockHash: string | null;
  trialPlanMaxAttempts: number;
  trialPlanAttempt: {
    relativePath: string;
    yamlHash: string;
    attemptId: string;
  } | null;
  activeRelativePath: string | null;
  requestedAction: typeof CREATE_NEW_PIPELINE_ACTION_KIND | null;
  createTargetRelativePath: string | null;
  sourceRelativePaths: string[];
  baseEntries: ChatYamlStageBaseEntry[];
  sessionRelocation?: ChatYamlStageSessionRelocationBinding;
}

interface ChatYamlStageBaseEntry {
  relativePath: string;
  contentHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
  supportHash: string;
}

type ChatYamlStageArtifactHashes = Omit<ChatYamlStageBaseEntry, 'relativePath'>;

export interface ChatYamlStageEntry {
  name: string;
  path: string;
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
  sourceChangedOnDisk: boolean;
  pipelineName: string | null;
  contentHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
  trialPlanHash: string | null;
  layoutMtimeMs: number | null;
  layoutSize: number | null;
  mtimeMs: number;
  size: number;
}

export interface ChatYamlStageDescriptor {
  id: string;
  rootDir: string;
  baseWorkspaceDir: string;
  agentWorkspaceDir: string;
  agentTagmaDir: string;
  trialPlanMaxAttempts: number;
  activeRelativePath: string | null;
  activeStagedPath: string | null;
  requestedAction: typeof CREATE_NEW_PIPELINE_ACTION_KIND | null;
  createTargetRelativePath: string | null;
  entries: ChatYamlStageEntry[];
  sessionRelocation?: ChatYamlStageSessionRelocationBinding;
}

export interface ChatYamlStageLocalBranch {
  sourcePath: string;
  yaml: string;
  layout?: EditorLayout | null;
  /** Compatibility hint only. Finalize compares branch content with base itself. */
  changed?: boolean;
}

export interface ChatYamlStageFinalizeInput {
  stageId: string;
  relativePath: string;
  localBranch?: ChatYamlStageLocalBranch | null;
  activeLocalBranch?: ChatYamlStageLocalBranch | null;
  forceForkReason?: Extract<ChatYamlStageConflict, 'path-moved' | 'compile-failed'>;
  trialId?: string;
  allowInvalid?: boolean;
  retainStage?: boolean;
}

export interface ChatYamlStageFinalizeResult {
  outcome: 'unchanged' | 'adopted' | 'forked' | 'created';
  entry: ChatYamlStageEntry | null;
  conflicts: ChatYamlStageConflict[];
  localBranchPersisted: boolean;
  trialVerification: 'verified' | 'prerequisite-unavailable' | 'not-verified' | 'not-required';
  compile: ReturnType<typeof runCompileAndWriteLog>;
  revision: number;
  state: ReturnType<typeof getState>;
}

interface StagePaths {
  id: string;
  workspaceTagmaDir: string;
  rootDir: string;
  baseWorkspaceDir: string;
  baseTagmaDir: string;
  agentWorkspaceDir: string;
  agentTagmaDir: string;
  metadataPath: string;
  resultPath: string;
  targetResultsDir: string;
}

interface FinalizeArtifactSnapshot {
  yamlPath: string;
  directoryExisted: boolean;
  artifacts: Array<{ path: string; content: string | null }>;
  supportTree: PipelineSupportTree;
}

interface PipelineSupportTree {
  directories: string[];
  files: Map<string, Buffer>;
}

function sha1(content: string | Uint8Array): string {
  return createHash('sha1').update(content).digest('hex');
}

function compareManifestEntryNames(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function shouldHashTrialTreeEntry(name: string): boolean {
  return !/\.(?:compile\.log|manifest\.json|layout\.json|trial-plan\.json)$/i.test(name);
}

function hashTrialRequirementsContent(content: string): string {
  const parsed = parseRequirementsMd(content);
  const frontmatter = parsed.frontmatter;
  if (!frontmatter || typeof frontmatter !== 'object') return sha1(content);
  const stableFrontmatter = { ...frontmatter } as Record<string, unknown>;
  delete stableFrontmatter.generatedAt;
  const normalized = yaml.dump(stableFrontmatter, { lineWidth: 120 }).trimEnd();
  return sha1(`---\n${normalized}\n---\n\n${parsed.body.replace(/^\n+/, '')}`);
}

function hashTrialTreeFile(path: string): string {
  return path.toLowerCase().endsWith('.requirements.md')
    ? hashTrialRequirementsContent(readFileSync(path, 'utf-8'))
    : sha1(readFileSync(path));
}

function isSha1(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isOptionalSha1(value: unknown): value is string | null {
  return value === null || isSha1(value);
}

function isLayoutArtifactHash(value: unknown): value is string | null {
  return (
    isOptionalSha1(value) || (typeof value === 'string' && /^invalid:[a-f0-9]{40}$/.test(value))
  );
}

function isBaseEntry(value: unknown): value is ChatYamlStageBaseEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ChatYamlStageBaseEntry>;
  return (
    typeof entry.relativePath === 'string' &&
    isSha1(entry.contentHash) &&
    isLayoutArtifactHash(entry.layoutHash) &&
    isOptionalSha1(entry.requirementsHash) &&
    isSha256(entry.supportHash)
  );
}

function optionalArtifactHash(path: string, label: string): string | null {
  return existsSync(path) ? sha1(assertRegularTextFile(path, label)) : null;
}

function layoutArtifactHash(path: string, label: string): string | null {
  if (!existsSync(path)) return null;
  const content = assertRegularTextFile(path, label);
  try {
    return semanticLayoutHash(JSON.parse(content));
  } catch {
    return 'invalid:' + sha1(content);
  }
}

function pipelineArtifactHashes(yamlPath: string): ChatYamlStageArtifactHashes | null {
  if (!existsSync(yamlPath)) return null;
  return {
    contentHash: sha1(assertRegularTextFile(yamlPath, 'pipeline YAML')),
    layoutHash: layoutArtifactHash(pipelineLayoutPath(yamlPath), 'pipeline layout'),
    requirementsHash: optionalArtifactHash(
      pipelineRequirementsPath(yamlPath),
      'pipeline requirements',
    ),
    supportHash: hashPipelineSupportTree(yamlPath),
  };
}

export function hashChatPipelineTrialTree(rootDir: string | null): string | null {
  if (!rootDir) return null;
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot)) return null;
  const hash = createHash('sha256');
  const visit = (directory: string, relativeDir: string) => {
    if (relativeDir) hash.update(`dir\0${relativeDir}\0`);
    const entries = readdirSync(directory, { withFileTypes: true }).sort(compareManifestEntryNames);
    for (const entry of entries) {
      if (!shouldHashTrialTreeEntry(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${hashTrialTreeFile(absolutePath)}\0`);
        continue;
      }
      hash.update(`${entry.isSymbolicLink() ? 'symlink' : 'other'}\0${relativePath}\0`);
    }
  };
  visit(resolvedRoot, '');
  return hash.digest('hex');
}

export function buildChatPipelineTrialInputHash(input: {
  stagedTreeHash: string;
  planHash: string;
  trialMode: 'sandbox' | 'sandbox-with-live-smoke';
  trialabilityReportHash: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.stagedTreeHash}\0${input.planHash}\0${input.trialMode}\0${input.trialabilityReportHash}`,
    )
    .digest('hex');
}

export function hashChatPipelineTrialabilityReport(report: ChatPipelineTrialabilityReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function buildChatPipelineTrialVerificationHash(input: {
  inputHash: string;
  hostWitnessDigest: string;
}): string {
  return createHash('sha256')
    .update(`${input.inputHash}\0${input.hostWitnessDigest}`)
    .digest('hex');
}

function sameArtifactHashes(
  left: ChatYamlStageArtifactHashes | null,
  right: ChatYamlStageArtifactHashes | null,
): boolean {
  return (
    !!left &&
    !!right &&
    left.contentHash === right.contentHash &&
    left.layoutHash === right.layoutHash &&
    left.requirementsHash === right.requirementsHash &&
    left.supportHash === right.supportHash
  );
}

export function samePipelineRelativePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function baseEntryFor(
  metadata: ChatYamlStageMetadata,
  relativePath: string,
): ChatYamlStageBaseEntry | null {
  return (
    metadata.baseEntries.find((entry) =>
      samePipelineRelativePath(entry.relativePath, relativePath),
    ) ?? null
  );
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const nativePath = (value: string): string => {
    const resolved = resolve(value);
    try {
      return realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return sameFilesystemPath(nativePath(left), nativePath(right));
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}

function assertStageId(stageId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stageId)) {
    throw new Error('Invalid chat YAML stage id.');
  }
  return stageId;
}

function stagePaths(workDir: string, stageId: string): StagePaths {
  const id = assertStageId(stageId);
  const workspaceTagmaDir = realpathSync.native(resolve(tagmaDirOf(workDir)));
  const rootDir = join(workspaceTagmaDir, STAGING_DIR_NAME, id);
  const baseWorkspaceDir = join(rootDir, 'base-workspace');
  const agentWorkspaceDir = join(rootDir, 'agent-workspace');
  return {
    id,
    workspaceTagmaDir,
    rootDir,
    baseWorkspaceDir,
    baseTagmaDir: tagmaDirOf(baseWorkspaceDir),
    agentWorkspaceDir,
    agentTagmaDir: tagmaDirOf(agentWorkspaceDir),
    metadataPath: join(rootDir, STAGE_METADATA_FILE),
    resultPath: join(rootDir, STAGE_RESULT_FILE),
    targetResultsDir: join(rootDir, STAGE_TARGET_RESULTS_DIR),
  };
}

function stageRecordContext(
  paths: StagePaths,
  kind: ServerRecordContext['kind'],
  controlRoot = paths.rootDir,
): ServerRecordContext {
  return {
    workspaceTagmaDir: paths.workspaceTagmaDir,
    controlRoot,
    stageId: paths.id,
    kind,
  };
}

function isRelocationPhase(value: unknown): value is ChatYamlStageSessionRelocationPhase {
  return value === 'prepared' || value === 'staged' || value === 'restoring';
}

function isExactRelocationString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

function invalidRelocation(message: string): ChatYamlStageSessionRelocationError {
  return new ChatYamlStageSessionRelocationError('invalid', message);
}

function relocationConflict(message: string): ChatYamlStageSessionRelocationError {
  return new ChatYamlStageSessionRelocationError('conflict', message);
}

function parseSessionRelocationBinding(
  value: unknown,
  paths: StagePaths,
): ChatYamlStageSessionRelocationBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chat YAML stage session relocation metadata is invalid.');
  }
  const raw = value as Partial<ChatYamlStageSessionRelocationBinding>;
  if (
    raw.version !== 1 ||
    raw.stageId !== paths.id ||
    !isExactRelocationString(raw.relocationId, 1_024) ||
    !isExactRelocationString(raw.sessionId, 1_024) ||
    !isExactRelocationString(raw.sourceDirectory, 32_768) ||
    !isExactRelocationString(raw.targetDirectory, 32_768) ||
    !isAbsolute(raw.sourceDirectory) ||
    !isAbsolute(raw.targetDirectory) ||
    !samePath(raw.sourceDirectory, paths.workspaceTagmaDir) ||
    !samePath(raw.targetDirectory, paths.agentTagmaDir) ||
    samePath(raw.sourceDirectory, raw.targetDirectory) ||
    !isRelocationPhase(raw.phase) ||
    !Number.isSafeInteger(raw.updatedAt) ||
    (raw.updatedAt ?? -1) < 0
  ) {
    throw new Error('Chat YAML stage session relocation metadata is invalid.');
  }
  return {
    version: 1,
    relocationId: raw.relocationId,
    stageId: paths.id,
    sessionId: raw.sessionId,
    sourceDirectory: raw.sourceDirectory,
    targetDirectory: raw.targetDirectory,
    phase: raw.phase,
    updatedAt: raw.updatedAt!,
  };
}

function validateRelocationIdentity(
  input: ChatYamlStageSessionRelocationIdentity,
  paths: StagePaths,
): ChatYamlStageSessionRelocationIdentity & {
  sourceDirectory: string;
  targetDirectory: string;
} {
  if (input.stageId !== paths.id) {
    throw invalidRelocation('Session relocation stage id does not match the authenticated stage.');
  }
  if (!isExactRelocationString(input.sessionId, 1_024)) {
    throw invalidRelocation('Session relocation sessionId must be an exact non-empty string.');
  }
  if (!isExactRelocationString(input.relocationId, 1_024)) {
    throw invalidRelocation('Session relocation relocationId must be an exact non-empty string.');
  }
  if (samePath(paths.workspaceTagmaDir, paths.agentTagmaDir)) {
    throw invalidRelocation('Session relocation source and target directories must be different.');
  }
  return {
    stageId: paths.id,
    sessionId: input.sessionId,
    relocationId: input.relocationId,
    sourceDirectory: paths.workspaceTagmaDir,
    targetDirectory: paths.agentTagmaDir,
  };
}

function assertRelocationIdentityMatches(
  binding: ChatYamlStageSessionRelocationBinding,
  identity: ChatYamlStageSessionRelocationIdentity & {
    sourceDirectory: string;
    targetDirectory: string;
  },
): void {
  if (
    binding.stageId !== identity.stageId ||
    binding.sessionId !== identity.sessionId ||
    binding.relocationId !== identity.relocationId ||
    !samePath(binding.sourceDirectory, identity.sourceDirectory) ||
    !samePath(binding.targetDirectory, identity.targetDirectory)
  ) {
    throw relocationConflict(
      'Session relocation identity does not match the authenticated stage binding.',
    );
  }
}

function nextRelocationUpdatedAt(previous?: ChatYamlStageSessionRelocationBinding): number {
  return Math.max(Date.now(), (previous?.updatedAt ?? -1) + 1);
}

function assertStageSessionRelocationInactive(metadata: ChatYamlStageMetadata): void {
  if (!metadata.sessionRelocation) return;
  throw relocationConflict(
    'Chat YAML stage session relocation is active; verify that the OpenCode session returned home and clear the binding before finalizing or discarding the stage.',
  );
}

function assertPortableRelativePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim().length === 0) {
    throw new Error('A staged YAML relative path is required.');
  }
  const normalized = relativePath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new Error('Staged YAML path must stay inside the chat stage.');
  }
  return normalized;
}

function resolveRelativeInside(root: string, relativePath: string): string {
  const normalized = assertPortableRelativePath(relativePath);
  const resolved = resolve(root, ...normalized.split('/'));
  if (!isPathWithin(resolved, root) || samePath(resolved, root)) {
    throw new Error('Staged YAML path must stay inside the chat stage.');
  }
  return resolved;
}

function resolveStagedYamlPath(paths: StagePaths, relativePath: string): string {
  const absPath = resolveRelativeInside(paths.agentTagmaDir, relativePath);
  return assertPipelineYamlPath(paths.agentWorkspaceDir, absPath, 'staged YAML');
}

function assertRegularTextFile(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`${label} is too large (${stat.size} bytes, max ${MAX_ARTIFACT_BYTES}).`);
  }
  return readFileSync(path, 'utf-8');
}

function copyTextArtifact(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) return;
  const content = assertRegularTextFile(sourcePath, basename(sourcePath));
  mkdirSync(dirname(destinationPath), { recursive: true });
  atomicWriteFileSync(destinationPath, content);
}

function pipelineArtifacts(yamlPath: string): string[] {
  return [
    yamlPath,
    pipelineLayoutPath(yamlPath),
    pipelineRequirementsPath(yamlPath),
    pipelineManifestPath(yamlPath),
    pipelineCompileLogPath(yamlPath),
  ];
}

function pipelineSupportRoot(yamlPath: string): string | null {
  const root = dirname(yamlPath);
  const expectedStem = stemFromYamlBasename(basename(yamlPath));
  const actualStem = basename(root);
  const matches =
    process.platform === 'win32'
      ? actualStem.toLowerCase() === expectedStem.toLowerCase()
      : actualStem === expectedStem;
  return matches ? root : null;
}

function pipelineSupportReservedRootNames(yamlPath: string): Set<string> {
  return new Set(
    [...pipelineArtifacts(yamlPath), pipelineTrialPlanPath(yamlPath)].map((path) =>
      basename(path).toLowerCase(),
    ),
  );
}

function resolvePipelineSupportPath(root: string, relativePath: string): string {
  const resolved = resolve(root, ...relativePath.split('/'));
  if (resolved === resolve(root) || !isPathWithin(resolved, root)) {
    throw new Error('Pipeline support path escaped its pipeline folder.');
  }
  return resolved;
}

function readPipelineSupportTree(yamlPath: string): PipelineSupportTree {
  const root = pipelineSupportRoot(yamlPath);
  if (!root || !existsSync(root)) return { directories: [], files: new Map() };
  const reservedRootNames = pipelineSupportReservedRootNames(yamlPath);
  const directories: string[] = [];
  const files = new Map<string, Buffer>();
  let entryCount = 0;
  let totalBytes = 0;

  const visit = (directory: string, relativeDir: string, depth: number): void => {
    if (depth > MAX_PIPELINE_SUPPORT_TREE_DEPTH) {
      throw new Error('Pipeline support tree exceeds the maximum nesting depth.');
    }
    const entries = readdirSync(directory, { withFileTypes: true }).sort(compareManifestEntryNames);
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        PIPELINE_SUPPORT_RUNTIME_DIRECTORY_NAMES.has(entry.name.toLowerCase())
      ) {
        continue;
      }
      if (!relativeDir && reservedRootNames.has(entry.name.toLowerCase())) continue;
      if (/\.trial-plan\.json$/i.test(entry.name)) continue;
      entryCount += 1;
      if (entryCount > MAX_PIPELINE_SUPPORT_TREE_ENTRIES) {
        throw new Error('Pipeline support tree exceeds the maximum entry count.');
      }
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Pipeline support artifacts must not contain symlinks: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        directories.push(relativePath);
        visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Pipeline support artifact must be a regular file: ${relativePath}`);
      }
      if (stat.size > MAX_PIPELINE_SUPPORT_FILE_BYTES) {
        throw new Error(`Pipeline support file is too large: ${relativePath}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_PIPELINE_SUPPORT_TREE_BYTES) {
        throw new Error('Pipeline support tree exceeds the maximum total size.');
      }
      files.set(relativePath, readFileSync(absolutePath));
    }
  };

  visit(root, '', 0);
  return { directories, files };
}

function hashPipelineSupportTree(yamlPath: string): string {
  const tree = readPipelineSupportTree(yamlPath);
  const hash = createHash('sha256');
  for (const relativePath of [...tree.directories].sort()) {
    hash.update(`dir\0${relativePath}\0`);
  }
  for (const [relativePath, content] of [...tree.files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(`file\0${relativePath}\0${sha1(content)}\0`);
  }
  return hash.digest('hex');
}

function writePipelineSupportTree(tree: PipelineSupportTree, destinationYamlPath: string): void {
  const root = pipelineSupportRoot(destinationYamlPath);
  if (!root) {
    if (tree.directories.length > 0 || tree.files.size > 0) {
      throw new Error('Flat legacy pipelines cannot publish pipeline-folder support artifacts.');
    }
    return;
  }
  mkdirSync(root, { recursive: true });
  const current = readPipelineSupportTree(destinationYamlPath);
  for (const relativePath of current.files.keys()) {
    if (!tree.files.has(relativePath)) {
      rmSync(resolvePipelineSupportPath(root, relativePath), { force: true });
    }
  }
  const desiredDirectories = new Set(tree.directories);
  for (const relativePath of [...current.directories].sort(
    (left, right) => right.split('/').length - left.split('/').length,
  )) {
    if (!desiredDirectories.has(relativePath)) {
      rmSync(resolvePipelineSupportPath(root, relativePath), { recursive: true, force: true });
    }
  }
  for (const relativePath of [...tree.directories].sort()) {
    mkdirSync(resolvePipelineSupportPath(root, relativePath), { recursive: true });
  }
  for (const [relativePath, content] of tree.files) {
    const destination = resolvePipelineSupportPath(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    atomicWriteFileSync(destination, content);
  }
}

function syncPipelineSupportTree(sourceYamlPath: string, destinationYamlPath: string): void {
  writePipelineSupportTree(readPipelineSupportTree(sourceYamlPath), destinationYamlPath);
}

function copyPipelineArtifacts(
  realTagmaDir: string,
  sourceYamlPath: string,
  destinationTagmaDir: string,
): void {
  for (const sourceArtifact of pipelineArtifacts(sourceYamlPath)) {
    if (!existsSync(sourceArtifact)) continue;
    const relativeArtifact = portableRelative(realTagmaDir, sourceArtifact);
    copyTextArtifact(sourceArtifact, resolveRelativeInside(destinationTagmaDir, relativeArtifact));
  }
  const relativeYamlPath = portableRelative(realTagmaDir, sourceYamlPath);
  syncPipelineSupportTree(
    sourceYamlPath,
    resolveRelativeInside(destinationTagmaDir, relativeYamlPath),
  );
}

function writeMetadata(paths: StagePaths, metadata: ChatYamlStageMetadata): void {
  writeAuthenticatedServerRecordSync(
    paths.metadataPath,
    stageRecordContext(paths, 'stage-metadata'),
    metadata,
  );
}

function readMetadata(
  ws: WorkspaceState,
  stageId: string,
): {
  paths: StagePaths;
  metadata: ChatYamlStageMetadata;
} {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const paths = stagePaths(ws.workDir, stageId);
  if (!existsSync(paths.metadataPath)) throw new Error('Chat YAML stage was not found.');
  const raw = readAuthenticatedServerRecordSync<Partial<ChatYamlStageMetadata>>(
    paths.metadataPath,
    stageRecordContext(paths, 'stage-metadata'),
  );
  const trialPlanMaxAttempts = isValidChatPipelineTrialPlanAttempts(raw.trialPlanMaxAttempts)
    ? raw.trialPlanMaxAttempts
    : raw.trialPlanMaxAttempts === undefined
      ? DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS
      : null;
  const rawTrialPlanAttempt =
    raw.trialPlanAttempt && typeof raw.trialPlanAttempt === 'object'
      ? (raw.trialPlanAttempt as Record<string, unknown>)
      : null;
  const trialPlanAttempt =
    rawTrialPlanAttempt &&
    typeof rawTrialPlanAttempt.relativePath === 'string' &&
    typeof rawTrialPlanAttempt.yamlHash === 'string' &&
    /^[0-9a-f]{40}$/.test(rawTrialPlanAttempt.yamlHash) &&
    typeof rawTrialPlanAttempt.attemptId === 'string' &&
    FINALIZE_TRIAL_ID_RE.test(rawTrialPlanAttempt.attemptId)
      ? {
          relativePath: assertPortableRelativePath(rawTrialPlanAttempt.relativePath),
          yamlHash: rawTrialPlanAttempt.yamlHash,
          attemptId: rawTrialPlanAttempt.attemptId,
        }
      : null;
  const requestedAction =
    raw.requestedAction === CREATE_NEW_PIPELINE_ACTION_KIND
      ? CREATE_NEW_PIPELINE_ACTION_KIND
      : null;
  const createTargetRelativePath =
    typeof raw.createTargetRelativePath === 'string'
      ? assertPortableRelativePath(raw.createTargetRelativePath)
      : null;
  let sessionRelocation: ChatYamlStageSessionRelocationBinding | undefined;
  if (raw.sessionRelocation !== undefined && raw.sessionRelocation !== null) {
    sessionRelocation = parseSessionRelocationBinding(raw.sessionRelocation, paths);
  }
  if (
    !raw ||
    raw.version !== STAGE_VERSION ||
    raw.id !== stageId ||
    !Array.isArray(raw.sourceRelativePaths) ||
    !raw.sourceRelativePaths.every((item) => typeof item === 'string') ||
    trialPlanMaxAttempts === null ||
    (requestedAction === CREATE_NEW_PIPELINE_ACTION_KIND
      ? createTargetRelativePath === null || raw.activeRelativePath !== createTargetRelativePath
      : createTargetRelativePath !== null ||
        (raw.requestedAction !== null && raw.requestedAction !== undefined)) ||
    !Array.isArray(raw.baseEntries) ||
    !raw.baseEntries.every(isBaseEntry)
  ) {
    throw new Error('Chat YAML stage metadata is invalid.');
  }
  return {
    paths,
    metadata: {
      version: STAGE_VERSION,
      id: stageId,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
      ownerLockHash:
        typeof raw.ownerLockHash === 'string' && /^[0-9a-f]{64}$/.test(raw.ownerLockHash)
          ? raw.ownerLockHash
          : null,
      trialPlanMaxAttempts,
      trialPlanAttempt,
      activeRelativePath:
        typeof raw.activeRelativePath === 'string' ? raw.activeRelativePath : null,
      requestedAction,
      createTargetRelativePath,
      sourceRelativePaths: raw.sourceRelativePaths.map(assertPortableRelativePath),
      baseEntries: raw.baseEntries.map((entry) => ({
        relativePath: assertPortableRelativePath(entry.relativePath),
        contentHash: entry.contentHash,
        layoutHash: entry.layoutHash,
        requirementsHash: entry.requirementsHash,
        supportHash: entry.supportHash,
      })),
      ...(sessionRelocation ? { sessionRelocation } : {}),
    },
  };
}

function cleanupExpiredStages(workDir: string, now = Date.now()): void {
  const stagingHome = join(tagmaDirOf(workDir), STAGING_DIR_NAME);
  if (!existsSync(stagingHome)) return;
  const stagingStat = lstatSync(stagingHome);
  if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(stagingHome, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let paths: StagePaths;
    try {
      paths = stagePaths(workDir, entry.name);
    } catch {
      continue;
    }
    let createdAt = 0;
    try {
      const parsed = readAuthenticatedServerRecordSync<{
        createdAt?: unknown;
        sessionRelocation?: unknown;
      }>(paths.metadataPath, stageRecordContext(paths, 'stage-metadata'));
      if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
      if (parsed.sessionRelocation !== undefined && parsed.sessionRelocation !== null) {
        try {
          parseSessionRelocationBinding(parsed.sessionRelocation, paths);
        } catch {
          // An authenticated but malformed relocation record may still represent
          // a session whose persisted cwd points into this stage. Retain it for
          // explicit recovery instead of turning metadata damage into deletion.
        }
        continue;
      }
    } catch {
      try {
        createdAt = statSync(paths.rootDir).mtimeMs;
      } catch {
        createdAt = now;
      }
    }
    if (now - createdAt <= STAGE_TTL_MS) continue;
    stopChatCompileWatcher(paths.agentTagmaDir);
    rmSync(paths.rootDir, { recursive: true, force: true });
  }
}

function pipelineNameFromYaml(content: string): string | null {
  try {
    const doc = yaml.load(content) as Record<string, unknown> | null;
    const pipeline =
      doc && typeof doc === 'object' && 'pipeline' in doc
        ? (doc.pipeline as Record<string, unknown>)
        : null;
    const candidate =
      (pipeline && typeof pipeline.name === 'string' && pipeline.name) ||
      (doc && typeof doc.name === 'string' && doc.name) ||
      null;
    return candidate && String(candidate).trim() ? String(candidate).trim() : null;
  } catch {
    return null;
  }
}

function describeStageEntry(
  ws: WorkspaceState,
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
  stagedPath: string,
): ChatYamlStageEntry {
  const stat = statSync(stagedPath);
  const content = assertRegularTextFile(stagedPath, 'staged YAML');
  const layoutPath = pipelineLayoutPath(stagedPath);
  let layoutHash: string | null = null;
  let layoutMtimeMs: number | null = null;
  let layoutSize: number | null = null;
  if (existsSync(layoutPath)) {
    const layoutStat = lstatSync(layoutPath);
    if (!layoutStat.isSymbolicLink() && layoutStat.isFile()) {
      layoutSize = layoutStat.size;
      layoutMtimeMs = layoutStat.mtimeMs;
      if (layoutStat.size <= MAX_ARTIFACT_BYTES) {
        layoutHash = layoutArtifactHash(layoutPath, 'staged layout');
      }
    }
  }
  const requirementsPath = pipelineRequirementsPath(stagedPath);
  const requirementsHash = existsSync(requirementsPath)
    ? sha1(assertRegularTextFile(requirementsPath, 'staged requirements'))
    : null;
  const trialPlanHash = optionalArtifactHash(
    pipelineTrialPlanPath(stagedPath),
    'staged trial plan',
  );
  const relativePath = portableRelative(paths.agentTagmaDir, stagedPath);
  const isSource = metadata.sourceRelativePaths.some((candidate) =>
    samePipelineRelativePath(candidate, relativePath),
  );
  const sourcePath = isSource ? resolveRelativeInside(tagmaDirOf(ws.workDir), relativePath) : null;
  const isActiveSource =
    sourcePath !== null &&
    metadata.activeRelativePath !== null &&
    samePipelineRelativePath(relativePath, metadata.activeRelativePath);
  return {
    name: basename(stagedPath),
    path: stagedPath,
    stagedPath,
    relativePath,
    sourcePath,
    sourceChangedOnDisk: isActiveSource
      ? !sourceMatchesBase(metadata, sourcePath, relativePath)
      : false,
    pipelineName: pipelineNameFromYaml(content),
    contentHash: sha1(content),
    layoutHash,
    requirementsHash,
    trialPlanHash,
    layoutMtimeMs,
    layoutSize,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function listStageEntries(
  ws: WorkspaceState,
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
): ChatYamlStageEntry[] {
  const foldered = enumeratePipelineYamls(paths.agentWorkspaceDir).map((entry) =>
    describeStageEntry(ws, paths, metadata, entry.yamlPath),
  );
  const flat = enumerateFlatPipelineYamls(paths.agentWorkspaceDir).map((entry) =>
    describeStageEntry(ws, paths, metadata, entry.yamlPath),
  );
  return [...foldered, ...flat].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function descriptor(
  ws: WorkspaceState,
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
): ChatYamlStageDescriptor {
  const entries = listStageEntries(ws, paths, metadata);
  const active = metadata.activeRelativePath
    ? entries.find((entry) =>
        samePipelineRelativePath(entry.relativePath, metadata.activeRelativePath!),
      )
    : null;
  const reservedCreateTarget = metadata.createTargetRelativePath
    ? resolveRelativeInside(paths.agentTagmaDir, metadata.createTargetRelativePath)
    : null;
  return {
    id: metadata.id,
    rootDir: paths.rootDir,
    baseWorkspaceDir: paths.baseWorkspaceDir,
    agentWorkspaceDir: paths.agentWorkspaceDir,
    agentTagmaDir: paths.agentTagmaDir,
    trialPlanMaxAttempts: metadata.trialPlanMaxAttempts,
    activeRelativePath: metadata.activeRelativePath,
    activeStagedPath: active?.stagedPath ?? reservedCreateTarget,
    requestedAction: metadata.requestedAction,
    createTargetRelativePath: metadata.createTargetRelativePath,
    entries,
    ...(metadata.sessionRelocation ? { sessionRelocation: metadata.sessionRelocation } : {}),
  };
}

function runChatStageCompileAndWriteLog(
  ws: WorkspaceState,
  paths: StagePaths,
  yamlPath: string,
): ReturnType<typeof runCompileAndWriteLog> {
  const relativeYamlPath = portableRelative(paths.agentTagmaDir, yamlPath);
  return runCompileAndWriteLog(yamlPath, ws.registry, {
    additionalValidation(content) {
      try {
        return validateChatPipelinePathCoordinates(parseYaml(content), {
          workspaceRoot: ws.workDir,
          relativeYamlPath,
        });
      } catch {
        // The base compiler owns YAML/envelope/shape diagnostics. This
        // context-aware check only augments structurally walkable pipelines.
        return [];
      }
    },
  });
}

function reserveCreateTargetRelativePath(sourceRelativePaths: readonly string[]): string {
  const unavailable = new Set(sourceRelativePaths.map((path) => path.toLowerCase()));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stem = `pipeline-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const relativePath = `${stem}/${stem}.yaml`;
    if (!unavailable.has(relativePath.toLowerCase())) return relativePath;
  }
  throw new Error('Could not reserve a unique staged path for the new pipeline.');
}

export function createChatYamlStage(
  ws: WorkspaceState,
  options: {
    activePath?: string | null;
    requestedAction?: typeof CREATE_NEW_PIPELINE_ACTION_KIND | null;
  } = {},
): ChatYamlStageDescriptor {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  cleanupExpiredStages(ws.workDir);
  const id = randomUUID();
  const paths = stagePaths(ws.workDir, id);
  const realTagmaDir = tagmaDirOf(ws.workDir);
  const sourceEntries = [
    ...enumeratePipelineYamls(ws.workDir),
    ...enumerateFlatPipelineYamls(ws.workDir),
  ];
  const sourceRelativePaths: string[] = [];
  const baseEntries: ChatYamlStageBaseEntry[] = [];
  let activeRelativePath: string | null = null;
  try {
    ensureServerRecordControlRootSync(stageRecordContext(paths, 'stage-metadata'));
    mkdirSync(paths.baseTagmaDir, { recursive: true });
    mkdirSync(paths.agentTagmaDir, { recursive: true });
    for (const source of sourceEntries) {
      const relativeYamlPath = portableRelative(realTagmaDir, source.yamlPath);
      sourceRelativePaths.push(relativeYamlPath);
      copyPipelineArtifacts(realTagmaDir, source.yamlPath, paths.baseTagmaDir);
      const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, relativeYamlPath);
      copyPipelineArtifacts(paths.baseTagmaDir, baseYamlPath, paths.agentTagmaDir);
      const hashes = pipelineArtifactHashes(baseYamlPath);
      if (!hashes) throw new Error(`Failed to capture chat YAML base for ${relativeYamlPath}.`);
      baseEntries.push({ relativePath: relativeYamlPath, ...hashes });
      if (samePath(options.activePath, source.yamlPath)) activeRelativePath = relativeYamlPath;
    }
    const requestedAction =
      options.requestedAction === CREATE_NEW_PIPELINE_ACTION_KIND
        ? CREATE_NEW_PIPELINE_ACTION_KIND
        : null;
    const createTargetRelativePath = requestedAction
      ? reserveCreateTargetRelativePath(sourceRelativePaths)
      : null;
    if (createTargetRelativePath) activeRelativePath = createTargetRelativePath;
    const metadata: ChatYamlStageMetadata = {
      version: STAGE_VERSION,
      id,
      createdAt: Date.now(),
      ownerLockHash: ws.yamlEditLock
        ? createHash('sha256').update(ws.yamlEditLock.id).digest('hex')
        : null,
      trialPlanMaxAttempts: readEditorSettings(ws).opencodeChatTrialPlanMaxAttempts,
      trialPlanAttempt: null,
      activeRelativePath,
      requestedAction,
      createTargetRelativePath,
      sourceRelativePaths,
      baseEntries,
    };
    writeMetadata(paths, metadata);
    startChatCompileWatcher(
      paths.agentTagmaDir,
      ws.registry,
      (yamlPath) => runChatStageCompileAndWriteLog(ws, paths, yamlPath),
      { compileExistingYaml: false },
    );
    return descriptor(ws, paths, metadata);
  } catch (err) {
    stopChatCompileWatcher(paths.agentTagmaDir);
    rmSync(paths.rootDir, { recursive: true, force: true });
    throw err;
  }
}

export function listChatYamlStage(ws: WorkspaceState, stageId: string): ChatYamlStageDescriptor {
  const { paths, metadata } = readMetadata(ws, stageId);
  if (readFinalizeResult(paths)) throw new Error('Chat YAML stage is already finalized.');
  return descriptor(ws, paths, metadata);
}

export function readChatYamlStageSessionRelocation(
  ws: WorkspaceState,
  stageId: string,
): ChatYamlStageSessionRelocationBinding | null {
  return readMetadata(ws, stageId).metadata.sessionRelocation ?? null;
}

export function listChatYamlStageSessionRelocations(
  ws: WorkspaceState,
): ChatYamlStageSessionRelocationBinding[] {
  if (!ws.workDir) return [];
  const stagingHome = join(tagmaDirOf(ws.workDir), STAGING_DIR_NAME);
  if (!existsSync(stagingHome)) return [];
  try {
    const stat = lstatSync(stagingHome);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
  } catch {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(stagingHome, { withFileTypes: true });
  } catch {
    return [];
  }
  const bindings: ChatYamlStageSessionRelocationBinding[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const binding = readMetadata(ws, entry.name).metadata.sessionRelocation;
      if (binding) bindings.push(binding);
    } catch {
      // Recovery discovery is best-effort across independent authenticated
      // stage records. One missing, tampered, or malformed stage must not hide
      // a different valid relocation that still needs to be restored.
    }
  }
  return bindings.sort(
    (left, right) => left.updatedAt - right.updatedAt || left.stageId.localeCompare(right.stageId),
  );
}

export function prepareChatYamlStageSessionRelocation(
  ws: WorkspaceState,
  input: ChatYamlStageSessionRelocationIdentity,
): ChatYamlStageSessionRelocationBinding {
  const { paths, metadata } = readMetadata(ws, input.stageId);
  if (readFinalizeResult(paths)) throw invalidRelocation('Chat YAML stage is already finalized.');
  const identity = validateRelocationIdentity(input, paths);
  if (metadata.sessionRelocation) {
    assertRelocationIdentityMatches(metadata.sessionRelocation, identity);
    if (metadata.sessionRelocation.phase === 'prepared') return metadata.sessionRelocation;
    throw relocationConflict('Chat YAML stage already has an active session relocation.');
  }
  const binding: ChatYamlStageSessionRelocationBinding = {
    version: 1,
    ...identity,
    phase: 'prepared',
    updatedAt: nextRelocationUpdatedAt(),
  };
  writeMetadata(paths, { ...metadata, sessionRelocation: binding });
  return binding;
}

export function advanceChatYamlStageSessionRelocation(
  ws: WorkspaceState,
  input: ChatYamlStageSessionRelocationAdvanceInput,
): ChatYamlStageSessionRelocationBinding {
  const { paths, metadata } = readMetadata(ws, input.stageId);
  const identity = validateRelocationIdentity(input, paths);
  if (!isRelocationPhase(input.expectedPhase) || !isRelocationPhase(input.phase)) {
    throw invalidRelocation('Session relocation phases are invalid.');
  }
  const validTransition =
    (input.expectedPhase === 'prepared' && input.phase === 'staged') ||
    (input.expectedPhase === 'prepared' && input.phase === 'restoring') ||
    (input.expectedPhase === 'staged' && input.phase === 'restoring') ||
    input.expectedPhase === input.phase;
  if (!validTransition) {
    throw invalidRelocation('Session relocation transition is invalid.');
  }
  const current = metadata.sessionRelocation;
  if (!current) throw relocationConflict('Chat YAML stage has no active session relocation.');
  assertRelocationIdentityMatches(current, identity);
  if (current.phase === input.phase) return current;
  if (current.phase !== input.expectedPhase) {
    throw relocationConflict(
      `Session relocation phase does not match: expected ${input.expectedPhase}, found ${current.phase}.`,
    );
  }
  const binding: ChatYamlStageSessionRelocationBinding = {
    ...current,
    phase: input.phase,
    updatedAt: nextRelocationUpdatedAt(current),
  };
  writeMetadata(paths, { ...metadata, sessionRelocation: binding });
  return binding;
}

export function clearChatYamlStageSessionRelocation(
  ws: WorkspaceState,
  input: ChatYamlStageSessionRelocationClearInput,
): boolean {
  const { paths, metadata } = readMetadata(ws, input.stageId);
  const identity = validateRelocationIdentity(input, paths);
  if (!isRelocationPhase(input.expectedPhase)) {
    throw invalidRelocation('Session relocation expected phase is invalid.');
  }
  if (input.expectedPhase !== 'prepared' && input.expectedPhase !== 'restoring') {
    throw invalidRelocation(
      'Session relocation may be cleared only from prepared or restoring after home verification.',
    );
  }
  if (input.verifiedSessionMissing !== true) {
    if (
      !isExactRelocationString(input.verifiedHomeDirectory, 32_768) ||
      !isAbsolute(input.verifiedHomeDirectory) ||
      input.verifiedHomeDirectory !== identity.sourceDirectory
    ) {
      throw invalidRelocation(
        'Session relocation verified home directory must exactly match the source directory.',
      );
    }
  }
  const current = metadata.sessionRelocation;
  if (!current) return false;
  assertRelocationIdentityMatches(current, identity);
  if (current.phase !== input.expectedPhase) {
    throw relocationConflict(
      `Session relocation phase does not match: expected ${input.expectedPhase}, found ${current.phase}.`,
    );
  }
  const { sessionRelocation: _removed, ...cleared } = metadata;
  writeMetadata(paths, cleared);
  return true;
}

/** Resolve the server-authenticated write root for a staged chat turn. */
export function resolveChatYamlStageAgentRoot(ws: WorkspaceState, stageId: string): string {
  const { paths } = readMetadata(ws, stageId);
  if (readFinalizeResult(paths)) throw new Error('Chat YAML stage is already finalized.');
  return paths.agentTagmaDir;
}

/** Verify that a staged write request carries the lock that created the stage. */
export function assertChatYamlStageLockOwner(
  ws: WorkspaceState,
  stageId: string,
  lockId: string | undefined,
): void {
  const { metadata } = readMetadata(ws, stageId);
  const requestLockHash = lockId ? createHash('sha256').update(lockId).digest('hex') : null;
  if (!metadata.ownerLockHash) {
    throw new ChatYamlStageLockOwnershipError(LEGACY_STAGE_LOCK_RECOVERY_MESSAGE);
  }
  if (metadata.ownerLockHash !== requestLockHash) {
    throw new ChatYamlStageLockOwnershipError();
  }
}

export function issueChatYamlStageTrialPlanAttempt(
  ws: WorkspaceState,
  input: {
    stageId: string;
    relativePath: string;
    yamlHash: string;
    attemptId: string;
  },
): void {
  const { paths, metadata } = readMetadata(ws, input.stageId);
  const relativePath = assertPortableRelativePath(input.relativePath);
  if (!/^[0-9a-f]{40}$/.test(input.yamlHash)) {
    throw new Error('Trial plan YAML hash must be SHA-1.');
  }
  if (!FINALIZE_TRIAL_ID_RE.test(input.attemptId)) {
    throw new Error('Trial plan attempt ID is invalid.');
  }
  const stagedPath = resolveStagedYamlPath(paths, relativePath);
  const currentHash = sha1(assertRegularTextFile(stagedPath, 'staged YAML'));
  if (currentHash !== input.yamlHash) {
    throw new Error('Staged YAML changed before the Trial plan attempt was issued.');
  }
  writeMetadata(paths, {
    ...metadata,
    trialPlanAttempt: {
      relativePath,
      yamlHash: input.yamlHash,
      attemptId: input.attemptId,
    },
  });
}

export function compileChatYamlStage(
  ws: WorkspaceState,
  stageId: string,
  relativePath: string,
): ReturnType<typeof runCompileAndWriteLog> {
  const { paths } = readMetadata(ws, stageId);
  if (readFinalizeResult(paths)) throw new Error('Chat YAML stage is already finalized.');
  const stagedPath = resolveStagedYamlPath(paths, relativePath);
  if (!existsSync(stagedPath)) throw new Error('Staged YAML file was not found.');
  const result = runChatStageCompileAndWriteLog(ws, paths, stagedPath);
  try {
    runPipelineManifestSync(stagedPath);
    runRequirementsSync(stagedPath);
  } catch {
    // Compile output is still authoritative; companion sync errors are
    // surfaced again during finalize where writes are transactional.
  }
  return result;
}

function canonicalPipeline(content: string): string {
  return JSON.stringify(withDefaultTrackColors(parseYaml(content)));
}

function isEmptyLayoutRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableJsonValue(item));
  if (typeof value !== 'object' || value === null) return value;

  const result: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    result[key] = stableJsonValue(item);
  }
  return result;
}

function normalizeSemanticLayout(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return stableJsonValue(value);

  const layout = { ...(value as Record<string, unknown>) };
  if (isEmptyLayoutRecord(layout.positions)) delete layout.positions;
  if (Array.isArray(layout.folders) && layout.folders.length === 0) delete layout.folders;
  if (isEmptyLayoutRecord(layout.trackHeights)) delete layout.trackHeights;

  const normalized = stableJsonValue(layout) as Record<string, unknown>;
  return Object.keys(normalized).length === 0 ? null : normalized;
}

function canonicalLayout(value: unknown): string {
  return JSON.stringify(normalizeSemanticLayout(value));
}

function normalizeLayoutArtifactContent(content: string | null): string | null {
  if (content === null) return null;
  return normalizeSemanticLayout(JSON.parse(content)) === null ? null : content;
}

function serializeLayoutArtifact(value: unknown): string | null {
  const normalized = normalizeSemanticLayout(value);
  return normalized === null ? null : JSON.stringify(normalized, null, 2);
}

function semanticLayoutHash(value: unknown): string | null {
  const canonical = canonicalLayout(value);
  return canonical === 'null' ? null : sha1(canonical);
}

const MISSING_LAYOUT_VALUE = Symbol('missing-layout-value');
type MissingLayoutValue = typeof MISSING_LAYOUT_VALUE;

interface PipelineLayoutTopology {
  taskIds: Set<string>;
  trackIds: Set<string>;
}

interface ThreeWayLayoutMergeResult {
  layout: EditorLayout | null;
  conflict: boolean;
}

function readSemanticLayout(yamlPath: string, label: string): unknown {
  const path = pipelineLayoutPath(yamlPath);
  if (!existsSync(path)) return null;
  return normalizeSemanticLayout(JSON.parse(assertRegularTextFile(path, label)));
}

function pipelineLayoutTopology(yamlPath: string): PipelineLayoutTopology | null {
  if (!existsSync(yamlPath)) return null;
  try {
    const config = withDefaultTrackColors(
      parseYaml(assertRegularTextFile(yamlPath, 'pipeline YAML')),
    );
    const trackIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const track of config.tracks) {
      trackIds.add(track.id);
      for (const task of track.tasks) taskIds.add(`${track.id}.${task.id}`);
    }
    return { taskIds, trackIds };
  } catch {
    return null;
  }
}

function layoutValue(
  record: Record<string, unknown> | undefined,
  key: string,
): unknown | MissingLayoutValue {
  return record && Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : MISSING_LAYOUT_VALUE;
}

function sameLayoutValue(left: unknown | MissingLayoutValue, right: unknown | MissingLayoutValue) {
  if (left === MISSING_LAYOUT_VALUE || right === MISSING_LAYOUT_VALUE) return left === right;
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

function mergeLayoutValue(
  base: unknown | MissingLayoutValue,
  staged: unknown | MissingLayoutValue,
  local: unknown | MissingLayoutValue,
): { value: unknown | MissingLayoutValue; conflict: boolean } {
  if (sameLayoutValue(staged, local)) return { value: staged, conflict: false };
  if (sameLayoutValue(local, base)) return { value: staged, conflict: false };
  if (sameLayoutValue(staged, base)) return { value: local, conflict: false };
  return { value: local, conflict: true };
}

function asLayoutRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergePosition(
  base: unknown | MissingLayoutValue,
  staged: unknown | MissingLayoutValue,
  local: unknown | MissingLayoutValue,
): { value: unknown | MissingLayoutValue; conflict: boolean } {
  if (staged === MISSING_LAYOUT_VALUE || local === MISSING_LAYOUT_VALUE) {
    return mergeLayoutValue(base, staged, local);
  }

  const basePosition = base === MISSING_LAYOUT_VALUE ? {} : asLayoutRecord(base);
  const stagedPosition = asLayoutRecord(staged);
  const localPosition = asLayoutRecord(local);
  const merged: Record<string, unknown> = {};
  let conflict = false;
  for (const field of ['x', 'y']) {
    const result = mergeLayoutValue(
      layoutValue(basePosition, field),
      layoutValue(stagedPosition, field),
      layoutValue(localPosition, field),
    );
    conflict ||= result.conflict;
    if (result.value !== MISSING_LAYOUT_VALUE) merged[field] = result.value;
  }
  return {
    value: Object.keys(merged).length > 0 ? merged : MISSING_LAYOUT_VALUE,
    conflict,
  };
}

function mergeLayoutMap(
  base: unknown,
  staged: unknown,
  local: unknown,
  survivingKeys: Set<string>,
  mergeEntry: typeof mergeLayoutValue | typeof mergePosition,
): { value: Record<string, unknown>; conflict: boolean } {
  const baseRecord = asLayoutRecord(base);
  const stagedRecord = asLayoutRecord(staged);
  const localRecord = asLayoutRecord(local);
  const merged: Record<string, unknown> = {};
  let conflict = false;
  for (const key of [...survivingKeys].sort()) {
    const result = mergeEntry(
      layoutValue(baseRecord, key),
      layoutValue(stagedRecord, key),
      layoutValue(localRecord, key),
    );
    conflict ||= result.conflict;
    if (result.value !== MISSING_LAYOUT_VALUE) merged[key] = result.value;
  }
  return { value: merged, conflict };
}

function pruneLayoutFolders(value: unknown, survivingTrackIds: Set<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((folder) => {
    if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return folder;
    const record = folder as Record<string, unknown>;
    return {
      ...record,
      trackIds: Array.isArray(record.trackIds)
        ? record.trackIds.filter(
            (trackId): trackId is string =>
              typeof trackId === 'string' && survivingTrackIds.has(trackId),
          )
        : [],
    };
  });
}

function pruneLayoutMap(value: unknown, survivingKeys: Set<string>): Record<string, unknown> {
  const record = asLayoutRecord(value);
  const pruned: Record<string, unknown> = {};
  for (const key of [...survivingKeys].sort()) {
    if (Object.prototype.hasOwnProperty.call(record, key)) pruned[key] = record[key];
  }
  return pruned;
}

function prunePipelineLayout(
  value: unknown,
  finalTopology: PipelineLayoutTopology,
): EditorLayout | null {
  const layout = { ...asLayoutRecord(normalizeSemanticLayout(value)) };
  if (Object.prototype.hasOwnProperty.call(layout, 'positions')) {
    const positions = pruneLayoutMap(layout.positions, finalTopology.taskIds);
    if (Object.keys(positions).length > 0) layout.positions = positions;
    else delete layout.positions;
  }
  if (Object.prototype.hasOwnProperty.call(layout, 'trackHeights')) {
    const trackHeights = pruneLayoutMap(layout.trackHeights, finalTopology.trackIds);
    if (Object.keys(trackHeights).length > 0) layout.trackHeights = trackHeights;
    else delete layout.trackHeights;
  }
  if (Object.prototype.hasOwnProperty.call(layout, 'folders')) {
    layout.folders = pruneLayoutFolders(layout.folders, finalTopology.trackIds);
  }
  return normalizeSemanticLayout(layout) as EditorLayout | null;
}

function pruneLayoutArtifactContent(
  content: string | null,
  finalTopology: PipelineLayoutTopology,
): string | null {
  if (content === null) return null;
  const normalized = normalizeSemanticLayout(JSON.parse(content));
  if (normalized === null) return null;
  const pruned = prunePipelineLayout(normalized, finalTopology);
  return canonicalLayout(pruned) === canonicalLayout(normalized)
    ? content
    : serializeLayoutArtifact(pruned);
}

function mergePipelineLayouts(
  baseYamlPath: string,
  stagedYamlPath: string,
  localLayout: EditorLayout | null,
): ThreeWayLayoutMergeResult | null {
  const finalTopology = pipelineLayoutTopology(stagedYamlPath);
  if (!finalTopology) return null;

  try {
    const baseLayout = asLayoutRecord(readSemanticLayout(baseYamlPath, 'base layout'));
    const stagedLayout = asLayoutRecord(readSemanticLayout(stagedYamlPath, 'staged layout'));
    const normalizedLocalLayout = asLayoutRecord(normalizeSemanticLayout(localLayout));
    const positions = mergeLayoutMap(
      baseLayout.positions,
      stagedLayout.positions,
      normalizedLocalLayout.positions,
      finalTopology.taskIds,
      mergePosition,
    );
    const trackHeights = mergeLayoutMap(
      baseLayout.trackHeights,
      stagedLayout.trackHeights,
      normalizedLocalLayout.trackHeights,
      finalTopology.trackIds,
      mergeLayoutValue,
    );
    const folders = mergeLayoutValue(
      baseLayout.folders ?? MISSING_LAYOUT_VALUE,
      stagedLayout.folders ?? MISSING_LAYOUT_VALUE,
      normalizedLocalLayout.folders ?? MISSING_LAYOUT_VALUE,
    );
    const mergedLayout: Record<string, unknown> = {};
    if (Object.keys(positions.value).length > 0) mergedLayout.positions = positions.value;
    if (Object.keys(trackHeights.value).length > 0) {
      mergedLayout.trackHeights = trackHeights.value;
    }
    if (folders.value !== MISSING_LAYOUT_VALUE) {
      const prunedFolders = pruneLayoutFolders(folders.value, finalTopology.trackIds);
      if (!Array.isArray(prunedFolders) || prunedFolders.length > 0) {
        mergedLayout.folders = prunedFolders;
      }
    }
    const normalizedMerged = normalizeSemanticLayout(mergedLayout);
    return {
      layout: normalizedMerged as EditorLayout | null,
      conflict: positions.conflict || trackHeights.conflict || folders.conflict,
    };
  } catch {
    return null;
  }
}

function hasReadableLayoutArtifact(yamlPath: string): boolean {
  const path = pipelineLayoutPath(yamlPath);
  if (!existsSync(path)) return true;
  try {
    const value = JSON.parse(assertRegularTextFile(path, 'pipeline layout'));
    return !!value && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

function localBranchChangesFromBase(
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
  relativePath: string,
  localBranch: ChatYamlStageLocalBranch,
): { yaml: boolean; layout: boolean } {
  const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, relativePath);
  const expectedBase = baseEntryFor(metadata, relativePath);
  if (!expectedBase || !sameArtifactHashes(pipelineArtifactHashes(baseYamlPath), expectedBase)) {
    throw new Error('Chat YAML stage base snapshot is invalid.');
  }
  const baseYaml = assertRegularTextFile(baseYamlPath, 'base YAML');
  const yamlChanged = canonicalPipeline(localBranch.yaml) !== canonicalPipeline(baseYaml);
  if (localBranch.layout === undefined) return { yaml: yamlChanged, layout: false };
  const baseLayoutPath = pipelineLayoutPath(baseYamlPath);
  let baseLayout: unknown = null;
  if (existsSync(baseLayoutPath)) {
    try {
      baseLayout = JSON.parse(assertRegularTextFile(baseLayoutPath, 'base layout'));
    } catch {
      return { yaml: yamlChanged, layout: true };
    }
  }
  return {
    yaml: yamlChanged,
    layout: canonicalLayout(localBranch.layout) !== canonicalLayout(baseLayout),
  };
}

function stageTargetChanged(
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
  relativePath: string,
): boolean {
  const stagedPath = resolveStagedYamlPath(paths, relativePath);
  return !sameArtifactHashes(
    pipelineArtifactHashes(stagedPath),
    baseEntryFor(metadata, relativePath),
  );
}

function sourceMatchesBase(
  metadata: ChatYamlStageMetadata,
  sourcePath: string,
  relativePath: string,
): boolean {
  return sameArtifactHashes(
    pipelineArtifactHashes(sourcePath),
    baseEntryFor(metadata, relativePath),
  );
}

function sourceMatchesCapturedLocalBranch(
  metadata: ChatYamlStageMetadata,
  sourcePath: string,
  relativePath: string,
  localBranch: ChatYamlStageLocalBranch | null | undefined,
): boolean {
  if (!localBranch || !samePath(localBranch.sourcePath, sourcePath) || !existsSync(sourcePath)) {
    return false;
  }
  const expectedBase = baseEntryFor(metadata, relativePath);
  const sourceHashes = pipelineArtifactHashes(sourcePath);
  if (
    !expectedBase ||
    !sourceHashes ||
    sourceHashes.requirementsHash !== expectedBase.requirementsHash ||
    sourceHashes.supportHash !== expectedBase.supportHash
  ) {
    return false;
  }
  try {
    if (
      canonicalPipeline(assertRegularTextFile(sourcePath, 'source YAML')) !==
      canonicalPipeline(localBranch.yaml)
    ) {
      return false;
    }
    if (localBranch.layout === undefined) {
      return sourceHashes.layoutHash === expectedBase.layoutHash;
    }
    return (
      canonicalLayout(readSemanticLayout(sourcePath, 'source layout')) ===
      canonicalLayout(localBranch.layout)
    );
  } catch {
    return false;
  }
}

function pipelineCopyName(
  baseName: string | null,
  copyNumber: number,
  fallbackStem: string,
): string {
  const base = baseName && baseName.trim() ? baseName.trim() : fallbackStem.replace(/[-_]/g, ' ');
  return `${base} Copy ${copyNumber}`;
}

function yamlWithPipelineName(content: string, nextName: string): string {
  try {
    const config = withDefaultTrackColors(parseYaml(content));
    return serializePipeline({ ...config, name: nextName });
  } catch {
    return content;
  }
}

function nextPipelineCopyTarget(
  workDir: string,
  sourceYamlPath: string,
): {
  copyNumber: number;
  yamlPath: string;
} {
  const sourceStem = stemFromYamlBasename(basename(sourceYamlPath));
  for (let copyNumber = 1; copyNumber < 1000; copyNumber += 1) {
    const stem = sanitizePipelineStem(`${sourceStem}-copy-${copyNumber}`);
    const yamlPath = pipelineYamlPath(workDir, stem);
    if (!existsSync(dirname(yamlPath))) return { copyNumber, yamlPath };
  }
  throw new Error(`Too many copies already exist for ${sourceStem}.`);
}

function writeStagedArtifactsToDestination(
  ws: WorkspaceState,
  stagedYamlPath: string,
  destinationYamlPath: string,
  options: {
    pipelineName?: string;
    sourceIdentityPath?: string;
    discardUnreadableLayout?: boolean;
  } = {},
): void {
  const stagedYaml = assertRegularTextFile(stagedYamlPath, 'staged YAML');
  const stagedConfig = withDefaultTrackColors(parseYaml(stagedYaml));
  const stagedLayoutPath = pipelineLayoutPath(stagedYamlPath);
  const stagedLayoutContent =
    options.discardUnreadableLayout && !hasReadableLayoutArtifact(stagedYamlPath)
      ? null
      : normalizeLayoutArtifactContent(
          existsSync(stagedLayoutPath)
            ? assertRegularTextFile(stagedLayoutPath, 'staged layout')
            : null,
        );
  const finalTopology = pipelineLayoutTopology(stagedYamlPath);
  const stagedLayout = finalTopology
    ? pruneLayoutArtifactContent(stagedLayoutContent, finalTopology)
    : stagedLayoutContent;
  const stagedRequirementsPath = pipelineRequirementsPath(stagedYamlPath);
  const stagedRequirements = existsSync(stagedRequirementsPath)
    ? assertRegularTextFile(stagedRequirementsPath, 'staged requirements')
    : null;
  const stagedSupportTree = readPipelineSupportTree(stagedYamlPath);
  withPipelineArtifactTransaction(destinationYamlPath, () => {
    mkdirSync(dirname(destinationYamlPath), { recursive: true });
    const renamedYaml = options.pipelineName
      ? yamlWithPipelineName(stagedYaml, options.pipelineName)
      : stagedYaml;
    const destinationYaml = rewriteCopiedPipelineYaml(renamedYaml, {
      workDir: ws.workDir,
      sourceContentPath: stagedYamlPath,
      sourceIdentityPath: options.sourceIdentityPath ?? destinationYamlPath,
      destinationYamlPath,
      pipelineName: options.pipelineName ?? stagedConfig.name,
    });
    atomicWriteFileSync(destinationYamlPath, destinationYaml);
    __chatYamlStagingTestHooks.afterDestinationYamlWrite?.(destinationYamlPath);
    replaceOptionalArtifact(pipelineLayoutPath(destinationYamlPath), stagedLayout);
    replaceOptionalArtifact(pipelineRequirementsPath(destinationYamlPath), stagedRequirements);
    writePipelineSupportTree(stagedSupportTree, destinationYamlPath);
    runPipelineManifestSync(destinationYamlPath);
    runRequirementsSync(destinationYamlPath);
    runCompileAndWriteLog(destinationYamlPath, ws.registry);
  });
}

function replaceOptionalArtifact(path: string, content: string | null): void {
  if (content === null) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFileSync(path, content);
}

function withPipelineArtifactTransaction<T>(yamlPath: string, op: () => T): T {
  const snapshot = captureFinalizeArtifactSnapshot(yamlPath);
  try {
    return op();
  } catch (err) {
    restoreFinalizeArtifactSnapshot(snapshot);
    throw err;
  }
}

function captureFinalizeArtifactSnapshot(yamlPath: string): FinalizeArtifactSnapshot {
  return {
    yamlPath,
    directoryExisted: existsSync(dirname(yamlPath)),
    artifacts: pipelineArtifacts(yamlPath).map((path) => ({
      path,
      content: existsSync(path) ? assertRegularTextFile(path, basename(path)) : null,
    })),
    supportTree: readPipelineSupportTree(yamlPath),
  };
}

function restoreFinalizeArtifactSnapshot(snapshot: FinalizeArtifactSnapshot): void {
  if (!snapshot.directoryExisted) {
    rmSync(dirname(snapshot.yamlPath), { recursive: true, force: true });
    return;
  }
  let firstError: unknown = null;
  for (const artifact of snapshot.artifacts) {
    try {
      if (artifact.content === null) {
        rmSync(artifact.path, { force: true });
      } else {
        mkdirSync(dirname(artifact.path), { recursive: true });
        atomicWriteFileSync(artifact.path, artifact.content);
      }
    } catch (err) {
      firstError ??= err;
      console.error('[chat-yaml-staging] failed to roll back', artifact.path, err);
    }
  }
  try {
    writePipelineSupportTree(snapshot.supportTree, snapshot.yamlPath);
  } catch (err) {
    firstError ??= err;
    console.error('[chat-yaml-staging] failed to roll back pipeline support files', err);
  }
  if (firstError) throw firstError;
}

function withFinalizeMutationTransaction<T>(
  ws: WorkspaceState,
  op: (trackPipeline: (yamlPath: string) => void) => T,
): T {
  const snapshots: FinalizeArtifactSnapshot[] = [];
  const initialConfig = ws.config;
  const initialLayout = ws.layout;
  const initialYamlVersion = ws.yamlVersion;
  const initialRevision = ws.stateRevision;
  const trackPipeline = (yamlPath: string): void => {
    if (snapshots.some((snapshot) => samePath(snapshot.yamlPath, yamlPath))) return;
    snapshots.push(captureFinalizeArtifactSnapshot(yamlPath));
  };

  try {
    return op(trackPipeline);
  } catch (err) {
    let rollbackError: unknown = null;
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFinalizeArtifactSnapshot(snapshot);
      } catch (restoreErr) {
        rollbackError ??= restoreErr;
      }
    }
    ws.stateRevision = initialRevision;
    if (ws.yamlPath && existsSync(ws.yamlPath)) {
      try {
        const currentContent = assertRegularTextFile(ws.yamlPath, 'rolled-back YAML');
        const currentLayoutPath = pipelineLayoutPath(ws.yamlPath);
        const currentLayout = existsSync(currentLayoutPath)
          ? JSON.parse(assertRegularTextFile(currentLayoutPath, 'rolled-back layout'))
          : null;
        const matchesInitialMemory =
          canonicalPipeline(currentContent) ===
            canonicalPipeline(serializePipeline(initialConfig)) &&
          canonicalLayout(currentLayout) === canonicalLayout(initialLayout);
        if (matchesInitialMemory) {
          ws.config = initialConfig;
          ws.layout = initialLayout;
          beginWatching(ws, ws.yamlPath, currentContent);
        } else {
          refreshCurrentWorkspaceState(ws, ws.yamlPath);
        }
      } catch {
        ws.config = initialConfig;
        ws.layout = initialLayout;
        try {
          beginWatching(ws, ws.yamlPath, assertRegularTextFile(ws.yamlPath, 'rolled-back YAML'));
        } catch {
          ws.yamlVersion = initialYamlVersion;
        }
      }
    } else {
      ws.config = initialConfig;
      ws.layout = initialLayout;
      ws.yamlVersion = ws.yamlPath ? getFileVersion(ws.yamlPath) : initialYamlVersion;
    }
    if (rollbackError) {
      console.error('[chat-yaml-staging] finalize rollback was incomplete', rollbackError);
    }
    throw err;
  }
}

function copyStagedAsNumberedPipeline(
  ws: WorkspaceState,
  stagedYamlPath: string,
  sourceIdentityPath: string,
  beforeWrite?: (destinationYamlPath: string) => void,
): string {
  const target = nextPipelineCopyTarget(ws.workDir, sourceIdentityPath);
  const sourceStem = stemFromYamlBasename(basename(sourceIdentityPath));
  const stagedName = pipelineNameFromYaml(readFileSync(stagedYamlPath, 'utf-8'));
  const nextName = pipelineCopyName(stagedName, target.copyNumber, sourceStem);
  beforeWrite?.(target.yamlPath);
  try {
    writeStagedArtifactsToDestination(ws, stagedYamlPath, target.yamlPath, {
      pipelineName: nextName,
      sourceIdentityPath,
    });
    return target.yamlPath;
  } catch (err) {
    rmSync(dirname(target.yamlPath), { recursive: true, force: true });
    throw err;
  }
}

function copyPreservedPipelineAsNumbered(
  ws: WorkspaceState,
  sourceYamlPath: string,
  sourceIdentityPath: string,
  sourceCompile: ReturnType<typeof runCompileAndWriteLog>,
  beforeWrite?: (destinationYamlPath: string) => void,
): { path: string; compile: ReturnType<typeof runCompileAndWriteLog> } {
  if (sourceCompile.success && hasReadableLayoutArtifact(sourceYamlPath)) {
    const path = copyStagedAsNumberedPipeline(ws, sourceYamlPath, sourceIdentityPath, beforeWrite);
    return { path, compile: runCompileAndWriteLog(path, ws.registry) };
  }

  const target = nextPipelineCopyTarget(ws.workDir, sourceIdentityPath);
  beforeWrite?.(target.yamlPath);
  try {
    mkdirSync(dirname(target.yamlPath), { recursive: true });
    const sourceYaml = assertRegularTextFile(sourceYamlPath, 'preserved YAML');
    const sourceName = pipelineNameFromYaml(sourceYaml);
    let copiedYaml = sourceYaml;
    if (sourceName) {
      try {
        copiedYaml = yamlWithPipelineName(
          sourceYaml,
          pipelineCopyName(
            sourceName,
            target.copyNumber,
            stemFromYamlBasename(basename(sourceYamlPath)),
          ),
        );
      } catch {
        copiedYaml = sourceYaml;
      }
    }
    atomicWriteFileSync(target.yamlPath, copiedYaml);
    const sourceLayoutPath = pipelineLayoutPath(sourceYamlPath);
    replaceOptionalArtifact(
      pipelineLayoutPath(target.yamlPath),
      existsSync(sourceLayoutPath)
        ? assertRegularTextFile(sourceLayoutPath, 'preserved layout')
        : null,
    );
    const sourceRequirementsPath = pipelineRequirementsPath(sourceYamlPath);
    replaceOptionalArtifact(
      pipelineRequirementsPath(target.yamlPath),
      existsSync(sourceRequirementsPath)
        ? assertRegularTextFile(sourceRequirementsPath, 'preserved requirements')
        : null,
    );
    writePipelineSupportTree(readPipelineSupportTree(sourceYamlPath), target.yamlPath);
    const copiedCompile = runCompileAndWriteLog(target.yamlPath, ws.registry);
    return {
      path: target.yamlPath,
      compile: sourceCompile.success
        ? copiedCompile
        : {
            ...copiedCompile,
            success: false,
            summary: sourceCompile.summary,
          },
    };
  } catch (err) {
    rmSync(dirname(target.yamlPath), { recursive: true, force: true });
    throw err;
  }
}

function writeLocalBranch(ws: WorkspaceState, localBranch: ChatYamlStageLocalBranch): void {
  const sourcePath = assertPipelineYamlPath(ws.workDir, localBranch.sourcePath, 'local branch');
  const nextConfig = withDefaultTrackColors(parseYaml(localBranch.yaml));
  if (Buffer.byteLength(localBranch.yaml, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error('Local branch YAML is too large.');
  }
  const layoutContent =
    localBranch.layout === undefined ? undefined : serializeLayoutArtifact(localBranch.layout);
  if (layoutContent && Buffer.byteLength(layoutContent, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error('Local branch layout is too large.');
  }
  withPipelineArtifactTransaction(sourcePath, () => {
    atomicWriteFileSync(sourcePath, localBranch.yaml);
    if (layoutContent !== undefined) {
      replaceOptionalArtifact(pipelineLayoutPath(sourcePath), layoutContent);
    }
    runPipelineManifestSync(sourcePath);
    runRequirementsSync(sourcePath);
    runCompileAndWriteLog(sourcePath, ws.registry);
  });
  if (ws.yamlPath && samePath(ws.yamlPath, sourcePath)) {
    ws.config = nextConfig;
    ws.yamlVersion = getFileVersion(sourcePath);
    loadLayout(ws);
    beginWatching(ws, sourcePath, localBranch.yaml);
  }
}

function restoreRendererBranchFromBase(
  ws: WorkspaceState,
  baseYamlPath: string,
  sourcePath: string,
  localBranch?: ChatYamlStageLocalBranch | null,
): void {
  writeStagedArtifactsToDestination(ws, baseYamlPath, sourcePath, {
    discardUnreadableLayout: true,
  });
  if (localBranch) {
    writeLocalBranch(ws, localBranch);
  } else {
    refreshCurrentWorkspaceState(ws, sourcePath);
  }
}

interface ActiveSourceDriftReconciliation {
  conflicts: ChatYamlStageConflict[];
  localBranchPersisted: boolean;
  sourcePath: string | null;
}

function reconcileDifferentActiveSourceDrift(
  ws: WorkspaceState,
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
  finalizedRelativePath: string,
  activeLocalBranch: ChatYamlStageLocalBranch | null | undefined,
  trackPipeline: (yamlPath: string) => void,
): ActiveSourceDriftReconciliation {
  const activeRelativePath = metadata.activeRelativePath;
  if (!activeRelativePath || samePipelineRelativePath(activeRelativePath, finalizedRelativePath)) {
    return { conflicts: [], localBranchPersisted: false, sourcePath: null };
  }
  if (readTargetFinalizeResult(paths, activeRelativePath)) {
    return { conflicts: [], localBranchPersisted: false, sourcePath: null };
  }

  const sourceRelativePath = metadata.sourceRelativePaths.find((candidate) =>
    samePipelineRelativePath(candidate, activeRelativePath),
  );
  if (!sourceRelativePath) {
    throw new Error('Chat YAML stage active source snapshot is invalid.');
  }
  const sourcePath = resolveRelativeInside(tagmaDirOf(ws.workDir), sourceRelativePath);
  if (sourceMatchesBase(metadata, sourcePath, activeRelativePath)) {
    return { conflicts: [], localBranchPersisted: false, sourcePath: null };
  }

  let localChanges = { yaml: false, layout: false };
  if (activeLocalBranch) {
    if (!samePath(activeLocalBranch.sourcePath, sourcePath)) {
      throw new Error('Active local branch path does not match the staged active pipeline.');
    }
    localChanges = localBranchChangesFromBase(
      paths,
      metadata,
      activeRelativePath,
      activeLocalBranch,
    );
  }

  const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, activeRelativePath);
  const sourceExisted = existsSync(sourcePath);
  trackPipeline(sourcePath);
  if (sourceExisted) {
    let sourceCompile = runCompileAndWriteLog(sourcePath, ws.registry);
    if (!hasReadableLayoutArtifact(sourcePath)) {
      sourceCompile = {
        ...sourceCompile,
        success: false,
        summary: 'Source layout could not be read safely.',
      };
    }
    copyPreservedPipelineAsNumbered(ws, sourcePath, sourcePath, sourceCompile, trackPipeline);
  }
  // Preserve a user deletion when there is no explicit renderer branch to
  // persist. A missing source is a tombstone, not a request to restore base.
  if (sourceExisted || activeLocalBranch) {
    restoreRendererBranchFromBase(ws, baseYamlPath, sourcePath, activeLocalBranch);
  }

  const conflicts: ChatYamlStageConflict[] = ['source-changed-on-disk'];
  if (!sourceExisted) conflicts.push('source-deleted');
  if (localChanges.yaml || localChanges.layout) conflicts.unshift('local-branch-changed');
  return {
    conflicts,
    localBranchPersisted: !!activeLocalBranch,
    sourcePath,
  };
}

function writeLocalBranchLayout(
  ws: WorkspaceState,
  sourcePath: string,
  layout: EditorLayout | null,
): void {
  const layoutContent = serializeLayoutArtifact(layout);
  if (layoutContent && Buffer.byteLength(layoutContent, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error('Local branch layout is too large.');
  }
  replaceOptionalArtifact(pipelineLayoutPath(sourcePath), layoutContent);
  if (ws.yamlPath && samePath(ws.yamlPath, sourcePath)) loadLayout(ws);
}

function refreshCurrentWorkspaceState(ws: WorkspaceState, yamlPath: string): void {
  if (!ws.yamlPath || !samePath(ws.yamlPath, yamlPath)) return;
  const content = assertRegularTextFile(yamlPath, 'adopted YAML');
  ws.config = withDefaultTrackColors(parseYaml(content));
  ws.yamlVersion = getFileVersion(yamlPath);
  loadLayout(ws);
  beginWatching(ws, yamlPath, content);
}

function describeRealEntry(ws: WorkspaceState, yamlPath: string): ChatYamlStageEntry {
  const stat = statSync(yamlPath);
  const content = assertRegularTextFile(yamlPath, 'pipeline YAML');
  const layoutPath = pipelineLayoutPath(yamlPath);
  let layoutHash: string | null = null;
  let layoutMtimeMs: number | null = null;
  let layoutSize: number | null = null;
  if (existsSync(layoutPath)) {
    const layoutStat = statSync(layoutPath);
    layoutMtimeMs = layoutStat.mtimeMs;
    layoutSize = layoutStat.size;
    if (layoutStat.size <= MAX_ARTIFACT_BYTES) {
      layoutHash = layoutArtifactHash(layoutPath, 'pipeline layout');
    }
  }
  const requirementsPath = pipelineRequirementsPath(yamlPath);
  const requirementsHash = existsSync(requirementsPath)
    ? sha1(assertRegularTextFile(requirementsPath, 'pipeline requirements'))
    : null;
  return {
    name: basename(yamlPath),
    path: yamlPath,
    stagedPath: yamlPath,
    relativePath: portableRelative(tagmaDirOf(ws.workDir), yamlPath),
    sourcePath: yamlPath,
    sourceChangedOnDisk: false,
    pipelineName: pipelineNameFromYaml(content),
    contentHash: sha1(content),
    layoutHash,
    requirementsHash,
    trialPlanHash: null,
    layoutMtimeMs,
    layoutSize,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

interface TargetFinalizeRecord {
  relativePath: string;
  result: ChatYamlStageFinalizeResult;
}

function targetFinalizeResultPath(paths: StagePaths, relativePath: string): string {
  const normalized = assertPortableRelativePath(relativePath);
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return join(paths.targetResultsDir, `${sha1(identity)}.json`);
}

function targetFinalizeResultContext(paths: StagePaths): ServerRecordContext {
  return stageRecordContext(paths, 'finalized', paths.targetResultsDir);
}

function persistFinalizeResult(
  paths: StagePaths,
  result: ChatYamlStageFinalizeResult,
  relativePath: string,
  retainStage: boolean,
): void {
  const targetPath = targetFinalizeResultPath(paths, relativePath);
  __chatYamlStagingTestHooks.beforeFinalizeResultWrite?.(targetPath);
  try {
    writeAuthenticatedServerRecordSync(targetPath, targetFinalizeResultContext(paths), {
      relativePath: assertPortableRelativePath(relativePath),
      result,
    } satisfies TargetFinalizeRecord);
    if (!retainStage) {
      writeAuthenticatedServerRecordSync(
        paths.resultPath,
        stageRecordContext(paths, 'finalized'),
        result,
      );
    }
  } catch (err) {
    rmSync(targetPath, { force: true });
    if (!retainStage) rmSync(paths.resultPath, { force: true });
    throw err;
  }
}

function readTargetFinalizeResult(
  paths: StagePaths,
  relativePath: string,
): ChatYamlStageFinalizeResult | null {
  const targetPath = targetFinalizeResultPath(paths, relativePath);
  if (!existsSync(targetPath)) return null;
  const record = readAuthenticatedServerRecordSync<TargetFinalizeRecord>(
    targetPath,
    targetFinalizeResultContext(paths),
  );
  if (
    typeof record.relativePath !== 'string' ||
    !samePipelineRelativePath(record.relativePath, assertPortableRelativePath(relativePath)) ||
    !record.result ||
    typeof record.result !== 'object'
  ) {
    throw new Error('Finalized target record does not match the requested staged pipeline.');
  }
  return record.result;
}

function persistLegacyFinalizeResult(paths: StagePaths, result: ChatYamlStageFinalizeResult): void {
  __chatYamlStagingTestHooks.beforeFinalizeResultWrite?.(paths.resultPath);
  writeAuthenticatedServerRecordSync(
    paths.resultPath,
    stageRecordContext(paths, 'finalized'),
    result,
  );
}

function cleanupFinalizedStage(paths: StagePaths): void {
  try {
    stopChatCompileWatcher(paths.agentTagmaDir);
  } catch (err) {
    console.error('[chat-yaml-staging] failed to stop finalized compile watcher', err);
  }
  for (const workspaceDir of [paths.agentWorkspaceDir, paths.baseWorkspaceDir]) {
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err) {
      console.error('[chat-yaml-staging] failed to clean finalized workspace', workspaceDir, err);
    }
  }
}

function readFinalizeResult(paths: StagePaths): ChatYamlStageFinalizeResult | null {
  if (!existsSync(paths.resultPath)) return null;
  return readAuthenticatedServerRecordSync<ChatYamlStageFinalizeResult>(
    paths.resultPath,
    stageRecordContext(paths, 'finalized'),
  );
}

interface CachedTrialFinalizeRecord {
  version: typeof TRIAL_CACHE_VERSION;
  inputHash: string;
  trialabilityReportHash: string;
  verificationHash: string;
  hostWitness: TrialHostWitness;
  liveSmokeReadiness: ChatPipelineTrialLiveSmokeReadiness | null;
  result: {
    version: typeof TRIAL_CACHE_VERSION;
    success: boolean;
    kind: string;
    ran: boolean;
    trialMode?: ChatPipelineTrialMode;
    trialabilityReport?: ChatPipelineTrialabilityReport;
    repairAuthorization?: 'pipeline-change-allowed' | 'diagnostic-only';
    prerequisiteState?: unknown;
  };
}

const AUTHENTICATED_TRIAL_BLOCKER_KINDS = new Set([
  'binary',
  'environment',
  'external-data-path',
  'service',
  'credential',
  'approval',
]);

function isBlockedTrialPrerequisiteState(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as { state?: unknown; blockers?: unknown };
  if (
    record.state !== 'blocked' ||
    !Array.isArray(record.blockers) ||
    record.blockers.length === 0
  ) {
    return false;
  }
  return record.blockers.every((blocker) => {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) return false;
    const candidate = blocker as { kind?: unknown; name?: unknown; taskId?: unknown };
    return (
      typeof candidate.kind === 'string' &&
      AUTHENTICATED_TRIAL_BLOCKER_KINDS.has(candidate.kind) &&
      typeof candidate.name === 'string' &&
      candidate.name.trim().length > 0 &&
      (candidate.taskId === undefined ||
        (typeof candidate.taskId === 'string' && candidate.taskId.trim().length > 0))
    );
  });
}

function normalizeFinalizeTrialId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trialId = value.trim();
  if (!FINALIZE_TRIAL_ID_RE.test(trialId)) {
    throw new Error('trialId must contain only letters, digits, underscores, or hyphens.');
  }
  return trialId;
}

function normalizeFinalizeForceForkReason(
  value: unknown,
): ChatYamlStageFinalizeInput['forceForkReason'] {
  if (value === undefined) return undefined;
  if (value === 'path-moved' || value === 'compile-failed') return value;
  if (value === 'trial-run-failed') {
    throw new Error(
      'Trial verification is decided by the server; the renderer cannot declare trial-run-failed.',
    );
  }
  throw new Error('forceForkReason must be path-moved or compile-failed.');
}

function trialFinalizeCachePath(
  paths: StagePaths,
  trialId: string,
  relativePath: string,
  inputHash: string,
): string {
  const digest = createHash('sha256')
    .update(`${trialId}\0${relativePath}\0${inputHash}`)
    .digest('hex');
  return join(paths.rootDir, '.trial-runs', `${digest}.json`);
}

async function verifiedTrialDisposition(
  ws: WorkspaceState,
  paths: StagePaths,
  stagedPath: string,
  relativePath: string,
  sourcePath: string | null,
  trialId: string | undefined,
): Promise<ChatYamlStageFinalizeResult['trialVerification']> {
  const editorSettings = readEditorSettings(ws);
  if (editorSettings.opencodeChatTrialRunEnabled === false) return 'not-required';
  const trialMode = hasCurrentChatPipelineTrialLiveSmokeTestConsent(editorSettings)
    ? ('sandbox-with-live-smoke' as const)
    : ('sandbox' as const);
  const normalizedTrialId = normalizeFinalizeTrialId(trialId);
  if (!normalizedTrialId) return 'not-verified';
  const contentHash = sha1(assertRegularTextFile(stagedPath, 'staged YAML'));
  const planRead = readChatPipelineTrialPlan(stagedPath, relativePath, contentHash);
  if (planRead.status === 'required') return 'not-verified';
  const stagedTreeHash = hashChatPipelineTrialTree(dirname(stagedPath));
  if (!stagedTreeHash) return 'not-verified';
  let pipelineConfig: PipelineConfig;
  let trialabilityReport: ChatPipelineTrialabilityReport;
  try {
    pipelineConfig = await loadPipeline(readFileSync(stagedPath, 'utf-8'), ws.workDir);
    trialabilityReport = buildChatPipelineTrialabilityReport({
      pipelineConfig,
      registry: ws.registry,
      capabilityOwners: ws.pluginCapabilityOwners,
      mode: trialMode,
    });
  } catch {
    return 'not-verified';
  }
  const trialabilityReportHash = hashChatPipelineTrialabilityReport(trialabilityReport);
  const inputHash = buildChatPipelineTrialInputHash({
    stagedTreeHash,
    planHash: planRead.planHash,
    trialMode,
    trialabilityReportHash,
  });
  const cachePath = trialFinalizeCachePath(paths, normalizedTrialId, relativePath, inputHash);
  if (!existsSync(cachePath)) return 'not-verified';
  const prepared = safePrepareTrialHostWitnessInputs(ws, {
    relativePath,
    sourcePath,
    stagedYamlPath: stagedPath,
  });
  if (!prepared.prepared) return 'not-verified';
  const witness = await captureFinalizeHostWitnessWithDeadline(
    ws,
    paths.id,
    normalizedTrialId,
    prepared.prepared,
  );
  if (!witness.witness) return 'not-verified';
  const verificationHash = buildChatPipelineTrialVerificationHash({
    inputHash,
    hostWitnessDigest: witness.witness.digest,
  });
  try {
    const cached = readAuthenticatedServerRecordSync<Partial<CachedTrialFinalizeRecord>>(
      cachePath,
      stageRecordContext(paths, 'trial-cache', dirname(cachePath)),
    );
    const currentLiveSmokeReadiness =
      trialMode === 'sandbox-with-live-smoke'
        ? (() => {
            const dataReadiness = resolveChatPipelineDataReadiness(
              pipelineConfig,
              ws.workDir,
              relativePath,
            );
            const baseline = resolveChatPipelineLiveSmokeBaseline(
              pipelineConfig,
              dataReadiness,
              ws.workDir,
              {
                livePipelineDir: dirname(sourcePath ?? resolve(ws.workDir, '.tagma', relativePath)),
                stagedPipelineDir: dirname(stagedPath),
                targetPipelineIsNew: sourcePath === null,
              },
            );
            return buildChatPipelineTrialLiveSmokeReadiness({
              targetPipelineIsNew: sourcePath === null,
              dataReadiness,
              baseline,
            });
          })()
        : null;
    const authenticated =
      cached.version === TRIAL_CACHE_VERSION &&
      cached.inputHash === inputHash &&
      cached.trialabilityReportHash === trialabilityReportHash &&
      cached.verificationHash === verificationHash &&
      cached.hostWitness?.digest === witness.witness.digest &&
      (cached.liveSmokeReadiness === null ||
        isChatPipelineTrialLiveSmokeReadiness(cached.liveSmokeReadiness)) &&
      isDeepStrictEqual(cached.liveSmokeReadiness, currentLiveSmokeReadiness) &&
      !!cached.result &&
      cached.result.version === TRIAL_CACHE_VERSION &&
      cached.result.trialMode === trialMode &&
      cached.result.trialabilityReport?.mode === trialMode &&
      hashChatPipelineTrialabilityReport(cached.result.trialabilityReport) ===
        trialabilityReportHash;
    if (!authenticated) return 'not-verified';
    if (cached.result!.success === true) return 'verified';
    if (
      cached.result!.success === false &&
      cached.result!.kind === 'blocked' &&
      typeof cached.result!.ran === 'boolean' &&
      cached.result!.repairAuthorization === 'diagnostic-only' &&
      isBlockedTrialPrerequisiteState(cached.result!.prerequisiteState)
    ) {
      return 'prerequisite-unavailable';
    }
    return 'not-verified';
  } catch {
    return 'not-verified';
  }
}

export async function finalizeChatYamlStage(
  ws: WorkspaceState,
  input: ChatYamlStageFinalizeInput,
): Promise<ChatYamlStageFinalizeResult> {
  const forceForkReason = normalizeFinalizeForceForkReason(input.forceForkReason);
  const { paths, metadata } = readMetadata(ws, input.stageId);
  assertStageSessionRelocationInactive(metadata);
  const relativePath = assertPortableRelativePath(input.relativePath);
  const retainStage = input.retainStage === true;
  const previousTargetResult = readTargetFinalizeResult(paths, relativePath);
  if (previousTargetResult) {
    if (!retainStage) {
      if (!readFinalizeResult(paths)) {
        persistLegacyFinalizeResult(paths, previousTargetResult);
      }
      cleanupFinalizedStage(paths);
    }
    const state = getState(ws);
    return { ...previousTargetResult, revision: state.revision, state };
  }
  const previousResult = readFinalizeResult(paths);
  if (previousResult) {
    cleanupFinalizedStage(paths);
    const state = getState(ws);
    return { ...previousResult, revision: state.revision, state };
  }

  const sourceRelativePath = metadata.sourceRelativePaths.find((candidate) =>
    samePipelineRelativePath(candidate, relativePath),
  );
  if (metadata.requestedAction === CREATE_NEW_PIPELINE_ACTION_KIND) {
    if (sourceRelativePath) {
      throw new Error(
        'A create-new pipeline turn cannot modify an existing pipeline; write the reserved current-file target instead.',
      );
    }
    if (
      !metadata.createTargetRelativePath ||
      !samePipelineRelativePath(metadata.createTargetRelativePath, relativePath)
    ) {
      throw new Error(
        'A create-new pipeline turn may finalize only its Host-reserved current-file target.',
      );
    }
  }
  const stagedPath = resolveStagedYamlPath(paths, relativePath);
  if (!existsSync(stagedPath)) throw new Error('Staged YAML file was not found.');
  const changed = stageTargetChanged(paths, metadata, relativePath);
  const compile = compileChatYamlStage(ws, input.stageId, relativePath);

  const sourcePath = sourceRelativePath
    ? resolveRelativeInside(tagmaDirOf(ws.workDir), sourceRelativePath)
    : null;
  if (sourcePath && input.localBranch && !samePath(input.localBranch.sourcePath, sourcePath)) {
    throw new Error('Local branch path does not match the staged source pipeline.');
  }
  if (sourceRelativePath) {
    const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, sourceRelativePath);
    assertRequirementsConsistentWithYamlChange(baseYamlPath, stagedPath);
  }
  if (!changed) {
    const state = getState(ws);
    const result: ChatYamlStageFinalizeResult = {
      outcome: 'unchanged',
      entry: sourcePath && existsSync(sourcePath) ? describeRealEntry(ws, sourcePath) : null,
      conflicts: [],
      localBranchPersisted: false,
      trialVerification: 'not-required',
      compile,
      revision: state.revision,
      state,
    };
    persistFinalizeResult(paths, result, relativePath, retainStage);
    if (!retainStage) cleanupFinalizedStage(paths);
    return result;
  }

  if (!compile.success && !input.allowInvalid) {
    throw new Error('Staged YAML did not compile successfully.');
  }

  const trialVerification = !compile.success
    ? ('not-verified' as const)
    : await verifiedTrialDisposition(
        ws,
        paths,
        stagedPath,
        relativePath,
        sourcePath,
        input.trialId,
      );
  const trialVerificationAccepted =
    trialVerification === 'verified' ||
    trialVerification === 'prerequisite-unavailable' ||
    trialVerification === 'not-required';

  const conflicts: ChatYamlStageConflict[] = [];
  if (forceForkReason) conflicts.push(forceForkReason);
  if (!compile.success && !conflicts.includes('compile-failed')) conflicts.push('compile-failed');
  if (!trialVerificationAccepted && !conflicts.includes('trial-run-failed')) {
    conflicts.push('trial-run-failed');
  }

  const committed = withFinalizeMutationTransaction(ws, (trackPipeline) => {
    let outcome: ChatYamlStageFinalizeResult['outcome'];
    let destinationPath: string;
    let localBranchPersisted = false;
    let resultCompile = compile;

    if (!sourcePath) {
      const desiredPath = assertPipelineYamlPath(
        ws.workDir,
        resolveRelativeInside(tagmaDirOf(ws.workDir), relativePath),
        'new staged pipeline destination',
      );
      const destinationExists = existsSync(dirname(desiredPath));
      if (destinationExists) conflicts.push('destination-exists');
      const mustFork = conflicts.length > 0;
      if (!mustFork) {
        trackPipeline(desiredPath);
        writeStagedArtifactsToDestination(ws, stagedPath, desiredPath);
        destinationPath = desiredPath;
        outcome = 'created';
      } else {
        destinationPath = copyStagedAsNumberedPipeline(ws, stagedPath, desiredPath, trackPipeline);
        outcome = 'forked';
      }
    } else {
      let localBranchChanged = false;
      let mergedLocalLayout: EditorLayout | null | undefined;
      if (input.localBranch) {
        if (!samePath(input.localBranch.sourcePath, sourcePath)) {
          throw new Error('Local branch path does not match the staged source pipeline.');
        }
        const localChanges = localBranchChangesFromBase(
          paths,
          metadata,
          relativePath,
          input.localBranch,
        );
        localBranchChanged = localChanges.yaml || localChanges.layout;
        const layoutMerge =
          input.localBranch.layout !== undefined && !localChanges.yaml && localChanges.layout
            ? mergePipelineLayouts(
                resolveRelativeInside(paths.baseTagmaDir, relativePath),
                stagedPath,
                input.localBranch.layout ?? null,
              )
            : null;
        if (layoutMerge && !layoutMerge.conflict) mergedLocalLayout = layoutMerge.layout;
        if (localBranchChanged && mergedLocalLayout === undefined) {
          conflicts.push('local-branch-changed');
        }
      }
      const diskMatchesBase = sourceMatchesBase(metadata, sourcePath, relativePath);
      const diskMatchesCapturedLocal = sourceMatchesCapturedLocalBranch(
        metadata,
        sourcePath,
        relativePath,
        input.localBranch,
      );
      const sourceDeleted = !existsSync(sourcePath);
      if (!diskMatchesBase && !diskMatchesCapturedLocal) {
        conflicts.push('source-changed-on-disk');
        if (sourceDeleted) conflicts.push('source-deleted');
      }
      const mustFork = conflicts.length > 0;
      if (!mustFork) {
        trackPipeline(sourcePath);
        writeStagedArtifactsToDestination(ws, stagedPath, sourcePath);
        if (mergedLocalLayout !== undefined) {
          writeLocalBranchLayout(ws, sourcePath, mergedLocalLayout);
          localBranchPersisted = true;
        }
        refreshCurrentWorkspaceState(ws, sourcePath);
        destinationPath = sourcePath;
        outcome = 'adopted';
      } else {
        destinationPath = copyStagedAsNumberedPipeline(ws, stagedPath, sourcePath, trackPipeline);
        resultCompile = runCompileAndWriteLog(destinationPath, ws.registry);
        if (!diskMatchesBase && !diskMatchesCapturedLocal) {
          trackPipeline(sourcePath);
          // A missing live source is an authoritative user deletion. Preserve that
          // tombstone while publishing Chat's branch as a numbered copy; restoring
          // the base here would silently undo the user's delete operation.
          if (!sourceDeleted || input.localBranch) {
            let sourceCompile: ReturnType<typeof runCompileAndWriteLog> | null = null;
            if (existsSync(sourcePath)) {
              sourceCompile = runCompileAndWriteLog(sourcePath, ws.registry);
              if (!hasReadableLayoutArtifact(sourcePath)) {
                sourceCompile = {
                  ...sourceCompile,
                  success: false,
                  summary: 'Source layout could not be read safely.',
                };
              }
            }
            if (input.localBranch || !sourceCompile?.success) {
              if (sourceCompile) {
                copyPreservedPipelineAsNumbered(
                  ws,
                  sourcePath,
                  sourcePath,
                  sourceCompile,
                  trackPipeline,
                );
              }
              restoreRendererBranchFromBase(
                ws,
                resolveRelativeInside(paths.baseTagmaDir, relativePath),
                sourcePath,
                input.localBranch,
              );
              localBranchPersisted = localBranchPersisted || !!input.localBranch;
            } else {
              refreshCurrentWorkspaceState(ws, sourcePath);
            }
          }
        } else if (input.localBranch && localBranchChanged) {
          trackPipeline(sourcePath);
          writeLocalBranch(ws, input.localBranch);
          localBranchPersisted = true;
        }
        outcome = 'forked';
      }
    }

    const activeSourceReconciliation = reconcileDifferentActiveSourceDrift(
      ws,
      paths,
      metadata,
      relativePath,
      input.activeLocalBranch,
      trackPipeline,
    );
    localBranchPersisted = localBranchPersisted || activeSourceReconciliation.localBranchPersisted;
    bumpRevision(ws);
    const state = getState(ws);
    const result: ChatYamlStageFinalizeResult = {
      outcome,
      entry: describeRealEntry(ws, destinationPath),
      conflicts: [...new Set([...conflicts, ...activeSourceReconciliation.conflicts])],
      localBranchPersisted,
      trialVerification,
      compile: resultCompile,
      revision: state.revision,
      state,
    };
    persistFinalizeResult(paths, result, relativePath, retainStage);
    return {
      destinationPath,
      reconciledActiveSourcePath: activeSourceReconciliation.sourcePath,
      result,
      state,
    };
  });

  if (!retainStage) cleanupFinalizedStage(paths);
  if (
    ws.yamlPath &&
    (samePath(ws.yamlPath, sourcePath) ||
      samePath(ws.yamlPath, committed.destinationPath) ||
      samePath(ws.yamlPath, committed.reconciledActiveSourcePath))
  ) {
    broadcastStateEvent(ws, {
      type: 'external-change',
      origin: 'chat-yaml-finalize',
      newState: committed.state,
    });
  }
  return committed.result;
}

export type ChatYamlStageDiscardDisposition = 'discarded' | 'finalized' | 'missing';

export function readFinalizedChatYamlStageResult(
  ws: WorkspaceState,
  stageId: string,
): ChatYamlStageFinalizeResult | null {
  if (!ws.workDir) return null;
  const unresolvedPaths = stagePaths(ws.workDir, stageId);
  if (!existsSync(unresolvedPaths.rootDir)) return null;
  const { paths, metadata } = readMetadata(ws, stageId);
  assertStageSessionRelocationInactive(metadata);
  const result = readFinalizeResult(paths);
  if (!result) return null;
  cleanupFinalizedStage(paths);
  const state = getState(ws);
  return { ...result, revision: state.revision, state };
}

export function discardChatYamlStageWithDisposition(
  ws: WorkspaceState,
  stageId: string,
): ChatYamlStageDiscardDisposition {
  if (!ws.workDir) return 'missing';
  const unresolvedPaths = stagePaths(ws.workDir, stageId);
  if (!existsSync(unresolvedPaths.rootDir)) return 'missing';
  const { paths, metadata } = readMetadata(ws, stageId);
  assertStageSessionRelocationInactive(metadata);
  if (readFinalizeResult(paths)) return 'finalized';
  stopChatCompileWatcher(paths.agentTagmaDir);
  rmSync(paths.rootDir, { recursive: true, force: true });
  return 'discarded';
}

export function discardChatYamlStage(ws: WorkspaceState, stageId: string): boolean {
  return discardChatYamlStageWithDisposition(ws, stageId) === 'discarded';
}
