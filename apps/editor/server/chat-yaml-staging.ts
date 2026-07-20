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

import type { EditorLayout, WorkspaceState } from './workspace-state.js';
import { atomicWriteFileSync, isPathWithin } from './path-utils.js';
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
import { runRequirementsSync } from './requirements-sync.js';
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

const STAGING_DIR_NAME = '.chat-staging';
const STAGE_METADATA_FILE = 'stage.json';
const STAGE_RESULT_FILE = 'finalized.json';
const STAGE_VERSION = 2;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;

export const __chatYamlStagingTestHooks: {
  afterDestinationYamlWrite?: (destinationYamlPath: string) => void;
  beforeFinalizeResultWrite?: (resultPath: string) => void;
} = {};

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
  activeRelativePath: string | null;
  sourceRelativePaths: string[];
  baseEntries: ChatYamlStageBaseEntry[];
}

interface ChatYamlStageBaseEntry {
  relativePath: string;
  contentHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
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
  forceFork?: boolean;
  forceForkReason?: Extract<
    ChatYamlStageConflict,
    'path-moved' | 'compile-failed' | 'trial-run-failed'
  >;
  allowInvalid?: boolean;
}

export interface ChatYamlStageFinalizeResult {
  outcome: 'unchanged' | 'adopted' | 'forked' | 'created';
  entry: ChatYamlStageEntry | null;
  conflicts: ChatYamlStageConflict[];
  localBranchPersisted: boolean;
  compile: ReturnType<typeof runCompileAndWriteLog>;
  revision: number;
  state: ReturnType<typeof getState>;
}

interface StagePaths {
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
}

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function isSha1(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
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
    isOptionalSha1(entry.requirementsHash)
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
  };
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
    left.requirementsHash === right.requirementsHash
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
  const rootDir = join(tagmaDirOf(workDir), STAGING_DIR_NAME, id);
  const baseWorkspaceDir = join(rootDir, 'base-workspace');
  const agentWorkspaceDir = join(rootDir, 'agent-workspace');
  return {
    rootDir,
    baseWorkspaceDir,
    baseTagmaDir: tagmaDirOf(baseWorkspaceDir),
    agentWorkspaceDir,
    agentTagmaDir: tagmaDirOf(agentWorkspaceDir),
    metadataPath: join(rootDir, STAGE_METADATA_FILE),
    resultPath: join(rootDir, STAGE_RESULT_FILE),
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
}

function writeMetadata(paths: StagePaths, metadata: ChatYamlStageMetadata): void {
  mkdirSync(paths.rootDir, { recursive: true });
  atomicWriteFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n');
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
  const raw = JSON.parse(
    assertRegularTextFile(paths.metadataPath, 'chat YAML stage metadata'),
  ) as Partial<ChatYamlStageMetadata> | null;
  if (
    !raw ||
    raw.version !== STAGE_VERSION ||
    raw.id !== stageId ||
    !Array.isArray(raw.sourceRelativePaths) ||
    !raw.sourceRelativePaths.every((item) => typeof item === 'string') ||
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
      activeRelativePath:
        typeof raw.activeRelativePath === 'string' ? raw.activeRelativePath : null,
      sourceRelativePaths: raw.sourceRelativePaths.map(assertPortableRelativePath),
      baseEntries: raw.baseEntries.map((entry) => ({
        relativePath: assertPortableRelativePath(entry.relativePath),
        contentHash: entry.contentHash,
        layoutHash: entry.layoutHash,
        requirementsHash: entry.requirementsHash,
      })),
    },
  };
}

function cleanupExpiredStages(workDir: string, now = Date.now()): void {
  const stagingHome = join(tagmaDirOf(workDir), STAGING_DIR_NAME);
  if (!existsSync(stagingHome)) return;
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
      const parsed = JSON.parse(readFileSync(paths.metadataPath, 'utf-8')) as {
        createdAt?: unknown;
      };
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
  if (existsSync(paths.resultPath)) throw new Error('Chat YAML stage is already finalized.');
  return descriptor(ws, paths, metadata);
}

export function compileChatYamlStage(
  ws: WorkspaceState,
  stageId: string,
  relativePath: string,
): ReturnType<typeof runCompileAndWriteLog> {
  const { paths } = readMetadata(ws, stageId);
  if (existsSync(paths.resultPath)) throw new Error('Chat YAML stage is already finalized.');
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
  options: { pipelineName?: string } = {},
): void {
  const stagedYaml = assertRegularTextFile(stagedYamlPath, 'staged YAML');
  withDefaultTrackColors(parseYaml(stagedYaml));
  const stagedLayoutPath = pipelineLayoutPath(stagedYamlPath);
  const stagedLayout = existsSync(stagedLayoutPath)
    ? assertRegularTextFile(stagedLayoutPath, 'staged layout')
    : null;
  if (stagedLayout !== null) JSON.parse(stagedLayout);
  const stagedRequirementsPath = pipelineRequirementsPath(stagedYamlPath);
  const stagedRequirements = existsSync(stagedRequirementsPath)
    ? assertRegularTextFile(stagedRequirementsPath, 'staged requirements')
    : null;
  withPipelineArtifactTransaction(destinationYamlPath, () => {
    mkdirSync(dirname(destinationYamlPath), { recursive: true });
    atomicWriteFileSync(
      destinationYamlPath,
      options.pipelineName ? yamlWithPipelineName(stagedYaml, options.pipelineName) : stagedYaml,
    );
    __chatYamlStagingTestHooks.afterDestinationYamlWrite?.(destinationYamlPath);
    replaceOptionalArtifact(pipelineLayoutPath(destinationYamlPath), stagedLayout);
    replaceOptionalArtifact(pipelineRequirementsPath(destinationYamlPath), stagedRequirements);
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
  const snapshots = pipelineArtifacts(yamlPath).map((path) => ({
    path,
    content: existsSync(path) ? assertRegularTextFile(path, basename(path)) : null,
  }));
  try {
    return op();
  } catch (err) {
    for (const snapshot of snapshots) {
      try {
        if (snapshot.content === null) {
          rmSync(snapshot.path, { force: true });
        } else {
          mkdirSync(dirname(snapshot.path), { recursive: true });
          atomicWriteFileSync(snapshot.path, snapshot.content);
        }
      } catch (rollbackErr) {
        console.error('[chat-yaml-staging] failed to roll back', snapshot.path, rollbackErr);
      }
    }
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
  };
}

function restoreFinalizeArtifactSnapshot(snapshot: FinalizeArtifactSnapshot): void {
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
  if (!snapshot.directoryExisted) {
    try {
      rmSync(dirname(snapshot.yamlPath), { recursive: true, force: true });
    } catch (err) {
      firstError ??= err;
      console.error(
        '[chat-yaml-staging] failed to remove rolled-back pipeline directory',
        dirname(snapshot.yamlPath),
        err,
      );
    }
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
    layoutMtimeMs,
    layoutSize,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function persistFinalizeResult(paths: StagePaths, result: ChatYamlStageFinalizeResult): void {
  __chatYamlStagingTestHooks.beforeFinalizeResultWrite?.(paths.resultPath);
  atomicWriteFileSync(paths.resultPath, JSON.stringify(result, null, 2) + '\n');
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
  return JSON.parse(
    assertRegularTextFile(paths.resultPath, 'chat YAML finalize result'),
  ) as ChatYamlStageFinalizeResult;
}

export function finalizeChatYamlStage(
  ws: WorkspaceState,
  input: ChatYamlStageFinalizeInput,
): ChatYamlStageFinalizeResult {
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
  if (!changed && sourcePath && !input.forceFork && !input.forceForkReason) {
    const result: ChatYamlStageFinalizeResult = {
      outcome: 'unchanged',
      entry: describeRealEntry(ws, sourcePath),
      conflicts: [],
      localBranchPersisted: false,
      compile,
      revision: ws.stateRevision,
      state: getState(ws),
    };
    persistFinalizeResult(paths, result);
    cleanupFinalizedStage(paths);
    return result;
  }

  const conflicts: ChatYamlStageConflict[] = [];
  if (input.forceForkReason) conflicts.push(input.forceForkReason);
  if (!compile.success && !conflicts.includes('compile-failed')) conflicts.push('compile-failed');

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
      const mustFork = Boolean(input.forceFork) || conflicts.length > 0;
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
      const mustFork = Boolean(input.forceFork) || conflicts.length > 0;
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
  const paths = stagePaths(ws.workDir, stageId);
  if (!existsSync(paths.rootDir)) return false;
  if (existsSync(paths.resultPath)) return false;
  stopChatCompileWatcher(paths.agentTagmaDir);
  rmSync(paths.rootDir, { recursive: true, force: true });
  return true;
}
