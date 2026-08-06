import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { pipelineTrialPlanPath, readChatPipelineTrialPlan } from './chat-pipeline-trial-plan.js';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from './chat-pipeline-trial-cache.js';
import { readEditorSettings } from './plugins/loader.js';
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

const STAGING_DIR_NAME = '.chat-staging';
const STAGE_METADATA_FILE = 'stage.json';
const STAGE_RESULT_FILE = 'finalized.json';
const STAGE_VERSION = 3;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_TREE_BYTES = 64 * 1024 * 1024;
const MAX_PIPELINE_SUPPORT_TREE_ENTRIES = 1_024;
const MAX_PIPELINE_SUPPORT_TREE_DEPTH = 32;
const STAGE_TTL_MS = 8 * 24 * 60 * 60 * 1_000;
const TRIAL_CACHE_VERSION = CHAT_PIPELINE_TRIAL_CACHE_VERSION;
const FINALIZE_TRIAL_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const FINALIZE_WITNESS_TIMEOUT_MS = 60 * 60 * 1_000;

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
  | 'path-moved'
  | 'compile-failed'
  | 'trial-run-failed'
  | 'destination-exists';

interface ChatYamlStageMetadata {
  version: typeof STAGE_VERSION;
  id: string;
  createdAt: number;
  trialPlanMaxAttempts: number;
  trialPlanAttempt: {
    relativePath: string;
    yamlHash: string;
    attemptId: string;
  } | null;
  activeRelativePath: string | null;
  sourceRelativePaths: string[];
  baseEntries: ChatYamlStageBaseEntry[];
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
  entries: ChatYamlStageEntry[];
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
  forceForkReason?: Extract<ChatYamlStageConflict, 'path-moved' | 'compile-failed'>;
  trialId?: string;
  allowInvalid?: boolean;
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

function isBaseEntry(value: unknown): value is ChatYamlStageBaseEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<ChatYamlStageBaseEntry>;
  return (
    typeof entry.relativePath === 'string' &&
    isSha1(entry.contentHash) &&
    isOptionalSha1(entry.layoutHash) &&
    isOptionalSha1(entry.requirementsHash) &&
    isSha256(entry.supportHash)
  );
}

function optionalArtifactHash(path: string, label: string): string | null {
  return existsSync(path) ? sha1(assertRegularTextFile(path, label)) : null;
}

function pipelineArtifactHashes(yamlPath: string): ChatYamlStageArtifactHashes | null {
  if (!existsSync(yamlPath)) return null;
  return {
    contentHash: sha1(assertRegularTextFile(yamlPath, 'pipeline YAML')),
    layoutHash: optionalArtifactHash(pipelineLayoutPath(yamlPath), 'pipeline layout'),
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
}): string {
  return createHash('sha256').update(`${input.stagedTreeHash}\0${input.planHash}`).digest('hex');
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
  return sameFilesystemPath(resolve(left), resolve(right));
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
  const workspaceTagmaDir = tagmaDirOf(workDir);
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
  if (
    !raw ||
    raw.version !== STAGE_VERSION ||
    raw.id !== stageId ||
    !Array.isArray(raw.sourceRelativePaths) ||
    !raw.sourceRelativePaths.every((item) => typeof item === 'string') ||
    trialPlanMaxAttempts === null ||
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
      trialPlanMaxAttempts,
      trialPlanAttempt,
      activeRelativePath:
        typeof raw.activeRelativePath === 'string' ? raw.activeRelativePath : null,
      sourceRelativePaths: raw.sourceRelativePaths.map(assertPortableRelativePath),
      baseEntries: raw.baseEntries.map((entry) => ({
        relativePath: assertPortableRelativePath(entry.relativePath),
        contentHash: entry.contentHash,
        layoutHash: entry.layoutHash,
        requirementsHash: entry.requirementsHash,
        supportHash: entry.supportHash,
      })),
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
      const parsed = readAuthenticatedServerRecordSync<{ createdAt?: unknown }>(
        paths.metadataPath,
        stageRecordContext(paths, 'stage-metadata'),
      );
      if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
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
        layoutHash = sha1(readFileSync(layoutPath, 'utf-8'));
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
  return {
    name: basename(stagedPath),
    path: stagedPath,
    stagedPath,
    relativePath,
    sourcePath,
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
  return {
    id: metadata.id,
    rootDir: paths.rootDir,
    baseWorkspaceDir: paths.baseWorkspaceDir,
    agentWorkspaceDir: paths.agentWorkspaceDir,
    agentTagmaDir: paths.agentTagmaDir,
    trialPlanMaxAttempts: metadata.trialPlanMaxAttempts,
    activeRelativePath: metadata.activeRelativePath,
    activeStagedPath: active?.stagedPath ?? null,
    entries,
  };
}

export function createChatYamlStage(
  ws: WorkspaceState,
  options: { activePath?: string | null } = {},
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
    const metadata: ChatYamlStageMetadata = {
      version: STAGE_VERSION,
      id,
      createdAt: Date.now(),
      trialPlanMaxAttempts: readEditorSettings(ws).opencodeChatTrialPlanMaxAttempts,
      trialPlanAttempt: null,
      activeRelativePath,
      sourceRelativePaths,
      baseEntries,
    };
    writeMetadata(paths, metadata);
    startChatCompileWatcher(paths.agentTagmaDir, ws.registry, undefined, {
      compileExistingYaml: false,
    });
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
  const result = runCompileAndWriteLog(stagedPath, ws.registry);
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

function canonicalLayout(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function localBranchDiffersFromBase(
  paths: StagePaths,
  metadata: ChatYamlStageMetadata,
  relativePath: string,
  localBranch: ChatYamlStageLocalBranch,
): boolean {
  const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, relativePath);
  const expectedBase = baseEntryFor(metadata, relativePath);
  if (!expectedBase || !sameArtifactHashes(pipelineArtifactHashes(baseYamlPath), expectedBase)) {
    throw new Error('Chat YAML stage base snapshot is invalid.');
  }
  const baseYaml = assertRegularTextFile(baseYamlPath, 'base YAML');
  if (canonicalPipeline(localBranch.yaml) !== canonicalPipeline(baseYaml)) return true;
  if (localBranch.layout === undefined) return false;
  const baseLayoutPath = pipelineLayoutPath(baseYamlPath);
  const baseLayout = existsSync(baseLayoutPath)
    ? JSON.parse(assertRegularTextFile(baseLayoutPath, 'base layout'))
    : null;
  return canonicalLayout(localBranch.layout) !== canonicalLayout(baseLayout);
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
  options: { pipelineName?: string; sourceIdentityPath?: string } = {},
): void {
  const stagedYaml = assertRegularTextFile(stagedYamlPath, 'staged YAML');
  const stagedConfig = withDefaultTrackColors(parseYaml(stagedYaml));
  const stagedLayoutPath = pipelineLayoutPath(stagedYamlPath);
  const stagedLayout = existsSync(stagedLayoutPath)
    ? assertRegularTextFile(stagedLayoutPath, 'staged layout')
    : null;
  if (stagedLayout !== null) JSON.parse(stagedLayout);
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
    ws.config = initialConfig;
    ws.layout = initialLayout;
    ws.yamlVersion = initialYamlVersion;
    ws.stateRevision = initialRevision;
    if (ws.yamlPath && existsSync(ws.yamlPath)) {
      beginWatching(ws, ws.yamlPath, assertRegularTextFile(ws.yamlPath, 'rolled-back YAML'));
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

function writeLocalBranch(ws: WorkspaceState, localBranch: ChatYamlStageLocalBranch): void {
  const sourcePath = assertPipelineYamlPath(ws.workDir, localBranch.sourcePath, 'local branch');
  const nextConfig = withDefaultTrackColors(parseYaml(localBranch.yaml));
  if (Buffer.byteLength(localBranch.yaml, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error('Local branch YAML is too large.');
  }
  const layoutContent = localBranch.layout ? JSON.stringify(localBranch.layout, null, 2) : null;
  if (layoutContent && Buffer.byteLength(layoutContent, 'utf-8') > MAX_ARTIFACT_BYTES) {
    throw new Error('Local branch layout is too large.');
  }
  withPipelineArtifactTransaction(sourcePath, () => {
    atomicWriteFileSync(sourcePath, localBranch.yaml);
    if (localBranch.layout !== undefined) {
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
      layoutHash = sha1(readFileSync(layoutPath, 'utf-8'));
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

function persistFinalizeResult(paths: StagePaths, result: ChatYamlStageFinalizeResult): void {
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
  verificationHash: string;
  hostWitness: TrialHostWitness;
  result: {
    version: typeof TRIAL_CACHE_VERSION;
    success: boolean;
    kind: string;
    ran: boolean;
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
  if (readEditorSettings(ws).opencodeChatTrialRunEnabled === false) return 'not-required';
  const normalizedTrialId = normalizeFinalizeTrialId(trialId);
  if (!normalizedTrialId) return 'not-verified';
  const contentHash = sha1(assertRegularTextFile(stagedPath, 'staged YAML'));
  const planRead = readChatPipelineTrialPlan(stagedPath, relativePath, contentHash);
  if (planRead.status === 'required') return 'not-verified';
  const stagedTreeHash = hashChatPipelineTrialTree(dirname(stagedPath));
  if (!stagedTreeHash) return 'not-verified';
  const inputHash = buildChatPipelineTrialInputHash({
    stagedTreeHash,
    planHash: planRead.planHash,
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
    const authenticated =
      cached.version === TRIAL_CACHE_VERSION &&
      cached.inputHash === inputHash &&
      cached.verificationHash === verificationHash &&
      cached.hostWitness?.digest === witness.witness.digest &&
      !!cached.result &&
      cached.result.version === TRIAL_CACHE_VERSION;
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
  const previousResult = readFinalizeResult(paths);
  if (previousResult) {
    cleanupFinalizedStage(paths);
    const state = getState(ws);
    return { ...previousResult, revision: state.revision, state };
  }

  const relativePath = assertPortableRelativePath(input.relativePath);
  const stagedPath = resolveStagedYamlPath(paths, relativePath);
  if (!existsSync(stagedPath)) throw new Error('Staged YAML file was not found.');
  const changed = stageTargetChanged(paths, metadata, relativePath);
  const compile = compileChatYamlStage(ws, input.stageId, relativePath);
  if (!compile.success && !input.allowInvalid) {
    throw new Error('Staged YAML did not compile successfully.');
  }

  const sourceRelativePath = metadata.sourceRelativePaths.find((candidate) =>
    samePipelineRelativePath(candidate, relativePath),
  );
  const sourcePath = sourceRelativePath
    ? resolveRelativeInside(tagmaDirOf(ws.workDir), sourceRelativePath)
    : null;
  if (sourceRelativePath) {
    const baseYamlPath = resolveRelativeInside(paths.baseTagmaDir, sourceRelativePath);
    assertRequirementsConsistentWithYamlChange(baseYamlPath, stagedPath);
  }
  if (!changed && sourcePath && !forceForkReason) {
    const result: ChatYamlStageFinalizeResult = {
      outcome: 'unchanged',
      entry: describeRealEntry(ws, sourcePath),
      conflicts: [],
      localBranchPersisted: false,
      trialVerification: 'not-required',
      compile,
      revision: ws.stateRevision,
      state: getState(ws),
    };
    persistFinalizeResult(paths, result);
    cleanupFinalizedStage(paths);
    return result;
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
      if (input.localBranch) {
        if (!samePath(input.localBranch.sourcePath, sourcePath)) {
          throw new Error('Local branch path does not match the staged source pipeline.');
        }
        localBranchChanged = localBranchDiffersFromBase(
          paths,
          metadata,
          relativePath,
          input.localBranch,
        );
        if (localBranchChanged) conflicts.push('local-branch-changed');
      }
      const diskMatchesBase = sourceMatchesBase(metadata, sourcePath, relativePath);
      if (!diskMatchesBase) conflicts.push('source-changed-on-disk');
      const mustFork = conflicts.length > 0;
      if (!mustFork) {
        trackPipeline(sourcePath);
        writeStagedArtifactsToDestination(ws, stagedPath, sourcePath);
        refreshCurrentWorkspaceState(ws, sourcePath);
        destinationPath = sourcePath;
        outcome = 'adopted';
      } else {
        destinationPath = copyStagedAsNumberedPipeline(ws, stagedPath, sourcePath, trackPipeline);
        if (input.localBranch && localBranchChanged && diskMatchesBase) {
          trackPipeline(sourcePath);
          writeLocalBranch(ws, input.localBranch);
          localBranchPersisted = true;
        }
        outcome = 'forked';
      }
    }

    bumpRevision(ws);
    const state = getState(ws);
    const result: ChatYamlStageFinalizeResult = {
      outcome,
      entry: describeRealEntry(ws, destinationPath),
      conflicts: [...new Set(conflicts)],
      localBranchPersisted,
      trialVerification,
      compile,
      revision: state.revision,
      state,
    };
    persistFinalizeResult(paths, result);
    return { destinationPath, result, state };
  });

  cleanupFinalizedStage(paths);
  if (
    ws.yamlPath &&
    (samePath(ws.yamlPath, sourcePath) || samePath(ws.yamlPath, committed.destinationPath))
  ) {
    broadcastStateEvent(ws, { type: 'external-change', newState: committed.state });
  }
  return committed.result;
}

export function discardChatYamlStage(ws: WorkspaceState, stageId: string): boolean {
  if (!ws.workDir) return false;
  const unresolvedPaths = stagePaths(ws.workDir, stageId);
  if (!existsSync(unresolvedPaths.rootDir)) return false;
  const { paths } = readMetadata(ws, stageId);
  if (readFinalizeResult(paths)) return false;
  stopChatCompileWatcher(paths.agentTagmaDir);
  rmSync(paths.rootDir, { recursive: true, force: true });
  return true;
}
