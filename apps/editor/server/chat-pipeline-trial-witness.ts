import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';

import type { Stats } from 'node:fs';
import { extname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';

import { errorMessage } from './path-utils.js';
import { requirementsPath, parseRequirementsMd } from './requirements-sync.js';
import { buildPipelineSecretEnv } from './secrets.js';
import { readEditorSettings } from './plugins/loader.js';
import { buildPythonAgentRunEnv } from './python-agent.js';
import { resolveOpencodeBinary } from './opencode-lifecycle.js';
import { workspaceRegistry } from './workspace-registry.js';

import type { WorkspaceState } from './workspace-state.js';

declare const __TAGMA_TRIAL_WITNESS_WORKER_SOURCE__: string | undefined;

const TRIAL_HOST_WITNESS_VERSION = 3;
const FILE_HASH_BUFFER_BYTES = 1024 * 1024;
const SKIPPED_TAGMA_WITNESS_DIRS = new Set([
  '.chat-staging',
  '.opencode',
  '.opencode-runtime',
  '.usage',
  'logs',
  'node_modules',
  'plugin-runtime',
  'plugin-store',
]);
const ROOT_WORKSPACE_IDENTITY_FILES = new Set([
  '.bunfig.toml',
  '.npmrc',
  '.python-version',
  '.tool-versions',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
  'bunfig.toml',
  'Cargo.lock',
  'Cargo.toml',
  'composer.json',
  'composer.lock',
  'deno.json',
  'deno.jsonc',
  'deno.lock',
  'Gemfile',
  'Gemfile.lock',
  'go.mod',
  'go.sum',
  'mise.toml',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'package.json',
  'Pipfile',
  'Pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pyproject.toml',
  'requirements.txt',
  'uv.lock',
  'yarn.lock',
]);
const TRIAL_MINIMAL_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USER',
  'USERNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

interface TrialRequirementWitnessConfig {
  binaryNames: string[];
  driverNames: string[];
  requiredEnvNames: string[];
}

export interface TrialWitnessValueHash {
  name: string;
  sha256: string;
}

export interface TrialWitnessFileIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string | null;
}

export interface TrialHostWorkspaceWitness {
  digest: string;
  fileCount: number;
  totalBytes: number;
}

export interface TrialHostBinaryWitness {
  name: string;
  identity: TrialWitnessFileIdentity;
}

export interface TrialHostPythonWitness {
  env: TrialWitnessValueHash[];
  interpreter: TrialWitnessFileIdentity;
  venvPath: string;
  pyvenvCfg: TrialWitnessFileIdentity | null;
}

export interface TrialHostWitness {
  version: typeof TRIAL_HOST_WITNESS_VERSION;
  workspace: TrialHostWorkspaceWitness;
  binaries: TrialHostBinaryWitness[];
  missingBinaries: string[];
  minimalEnv: TrialWitnessValueHash[];
  requiredEnv: TrialWitnessValueHash[];
  missingRequiredEnv: string[];
  secrets: TrialWitnessValueHash[];
  python: TrialHostPythonWitness | null;
  prerequisiteDigest: string;
  digest: string;
}

export interface PreparedTrialHostWitnessInputs {
  logicalYamlPath: string;
  binaryNames: string[];
  driverNames: string[];
  requiredEnvNames: string[];
  secretEnv: Record<string, string>;
  pythonEnv: Record<string, string>;
}

export interface TrialHostWorkspaceManifestCacheStats {
  fileCount: number;
  totalBytes: number;
  hashedFileCount: number;
  hashedBytes: number;
  reusedFileCount: number;
}

export interface TrialHostWorkspaceFileMetadata {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export interface TrialHostWorkspaceFileManifestEntry extends TrialHostWorkspaceFileMetadata {
  kind: 'file';
  sha256: string;
}

export interface TrialHostWorkspaceSymlinkManifestEntry extends TrialHostWorkspaceFileMetadata {
  kind: 'symlink';
  rawTargetSize: number;
  rawTargetSha256: string;
}

export type TrialHostWorkspaceManifestEntry =
  TrialHostWorkspaceFileManifestEntry | TrialHostWorkspaceSymlinkManifestEntry;

export interface TrialHostWorkspaceManifestCache {
  root: string;
  entries: Map<string, TrialHostWorkspaceManifestEntry>;
  lastStats: TrialHostWorkspaceManifestCacheStats;
}

export interface TrialHostWitnessWorkerBaseRequest {
  workspaceRoot: string;
}

export interface TrialHostWitnessWorkerWorkspaceRequest extends TrialHostWitnessWorkerBaseRequest {
  kind: 'workspace';
}

export interface TrialHostWitnessWorkerHostRequest extends TrialHostWitnessWorkerBaseRequest {
  kind: 'host';
  prepared: PreparedTrialHostWitnessInputs;
}

export type TrialHostWitnessWorkerRequest =
  TrialHostWitnessWorkerWorkspaceRequest | TrialHostWitnessWorkerHostRequest;

export interface TrialHostWitnessWorkerWorkspaceResponse {
  kind: 'workspace';
  witness: TrialHostWorkspaceWitness;
  cacheStats: TrialHostWorkspaceManifestCacheStats;
}

export interface TrialHostWitnessWorkerHostResponse {
  kind: 'host';
  witness: TrialHostWitness;
  cacheStats: TrialHostWorkspaceManifestCacheStats;
}

export type TrialHostWitnessWorkerResponse =
  TrialHostWitnessWorkerWorkspaceResponse | TrialHostWitnessWorkerHostResponse;

const workspaceManifestCaches = new WeakMap<WorkspaceState, TrialHostWorkspaceManifestCache>();
const asyncWorkspaceManifestCacheStats = new WeakMap<
  WorkspaceState,
  TrialHostWorkspaceManifestCacheStats
>();

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function isCanonicalPathWithin(child: string, root: string): boolean {
  const relativePath = relative(root, child);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  );
}

function shouldSkipWorkspaceWitnessDir(relativePath: string): boolean {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments[0] !== '.tagma') return false;
  if (segments.length < 2) return false;
  return SKIPPED_TAGMA_WITNESS_DIRS.has(segments[1]!);
}

function readRequirementsWitnessConfig(stagedYamlPath: string): TrialRequirementWitnessConfig {
  const path = requirementsPath(stagedYamlPath);
  if (!existsSync(path)) {
    return { binaryNames: [], driverNames: [], requiredEnvNames: [] };
  }
  const parsed = parseRequirementsMd(readFileSync(path, 'utf-8'));
  const frontmatter = parsed.frontmatter;
  if (!frontmatter) {
    return { binaryNames: [], driverNames: [], requiredEnvNames: [] };
  }
  const binaryNames = Array.isArray(frontmatter.binaries)
    ? [
        ...new Set(frontmatter.binaries.flatMap((entry) => (entry?.name ? [entry.name] : []))),
      ].sort()
    : [];
  const driverNames = Array.isArray(frontmatter.binaries)
    ? [
        ...new Set(
          frontmatter.binaries.flatMap((entry) =>
            typeof entry?.fromDriver === 'string' && entry.fromDriver ? [entry.fromDriver] : [],
          ),
        ),
      ].sort()
    : [];
  const requiredEnvNames = Array.isArray(frontmatter.env)
    ? [
        ...new Set(
          frontmatter.env.flatMap((entry) =>
            entry?.required === true && entry.name ? [entry.name] : [],
          ),
        ),
      ].sort()
    : [];
  return { binaryNames, driverNames, requiredEnvNames };
}

function resolveExecutionEnvValue(
  name: string,
  secretEnv: Readonly<Record<string, string>>,
  pythonEnv: Readonly<Record<string, string>>,
): string | null {
  const fromSecrets = secretEnv[name];
  if (typeof fromSecrets === 'string' && fromSecrets.length > 0) return fromSecrets;
  const fromPython = pythonEnv[name];
  if (typeof fromPython === 'string' && fromPython.length > 0) return fromPython;
  const fromProcess = process.env[name];
  if (typeof fromProcess === 'string' && fromProcess.length > 0) return fromProcess;
  return null;
}

function fileMetadata(stat: Stats): TrialHostWorkspaceFileMetadata {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  };
}

function sameFileMetadata(
  left: TrialHostWorkspaceFileMetadata,
  right: TrialHostWorkspaceFileMetadata,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function streamFileSha256(
  path: string,
  expectedStat: Stats,
  disallowSymlinks: boolean,
  buffer: Buffer<ArrayBufferLike> = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES),
): string {
  const expectedMetadata = fileMetadata(expectedStat);
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (!sameFileMetadata(expectedMetadata, fileMetadata(before))) {
      throw new Error(`Witness file changed before hashing: ${path}`);
    }

    const hash = createHash('sha256');
    let totalRead = 0;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      totalRead += bytesRead;
    }

    const after = fstatSync(fd);
    if (totalRead !== before.size || !sameFileMetadata(fileMetadata(before), fileMetadata(after))) {
      throw new Error(`Witness file changed while hashing: ${path}`);
    }
    const pathAfter = disallowSymlinks ? lstatSync(path) : statSync(path);
    if (disallowSymlinks && pathAfter.isSymbolicLink()) {
      throw new Error(`Workspace witness does not allow symlinks: ${path}`);
    }
    if (!pathAfter.isFile() || !sameFileMetadata(fileMetadata(after), fileMetadata(pathAfter))) {
      throw new Error(`Witness file changed while hashing: ${path}`);
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function fileIdentity(path: string): TrialWitnessFileIdentity {
  const resolvedPath = resolve(path);
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${resolvedPath}`);
  return {
    path: resolvedPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: streamFileSha256(resolvedPath, stat, false),
  };
}

interface GitWorkspaceSourceSnapshot {
  controlDigest: string;
  paths: string[];
}
interface GitWorkspaceControlLayout {
  root: string;
  identityPaths: string[];
  lockPaths: string[];
  refsPath: string;
}

const GIT_WITNESS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function gitWitnessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  return env;
}

function spawnGitWitness(
  gitPath: string,
  root: string,
  args: readonly string[],
): { status: number | null; stdout: Buffer; stderr: Buffer } {
  const result = spawnSync(gitPath, ['-C', root, ...args], {
    env: gitWitnessEnv(),
    windowsHide: true,
    maxBuffer: GIT_WITNESS_MAX_BUFFER_BYTES,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ''),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ''),
  };
}

function successfulGitWitnessCommand(
  gitPath: string,
  root: string,
  args: readonly string[],
): Buffer {
  const result = spawnGitWitness(gitPath, root, args);
  if (result.status !== 0) {
    throw new Error(
      `Git workspace witness command failed (${args.join(' ')}): ${result.stderr.toString('utf-8').trim() || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout;
}

function nullTerminatedGitRecords(output: Buffer, label: string): string[] {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(output);
  } catch {
    throw new Error(`Git workspace witness ${label} output was not valid UTF-8.`);
  }
  const records = decoded.split('\0');
  if (records.pop() !== '') {
    throw new Error(`Git workspace witness ${label} output was not NUL-terminated.`);
  }
  return records;
}

function assertGitWorkspacePath(root: string, path: string): string {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path)) {
    throw new Error(`Git workspace witness returned an invalid path: ${path}`);
  }
  const absolutePath = resolve(root, ...path.split('/'));
  if (!isCanonicalPathWithin(absolutePath, root)) {
    throw new Error(`Git workspace witness path escaped the workspace: ${path}`);
  }
  return absolutePath;
}

function rootWorkspaceIdentityPaths(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        (ROOT_WORKSPACE_IDENTITY_FILES.has(entry.name) ||
          entry.name === '.env' ||
          entry.name.startsWith('.env.') ||
          /^requirements(?:[-.][A-Za-z0-9_-]+)?\.(?:in|txt)$/iu.test(entry.name)),
    )
    .map((entry) => entry.name)
    .sort();
}
function authoredTagmaWorkspacePaths(root: string): string[] {
  const tagmaRoot = join(root, '.tagma');
  if (!existsSync(tagmaRoot)) return [];
  const rootStat = lstatSync(tagmaRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Git workspace witness requires .tagma to be a regular directory.');
  }
  const paths: string[] = [];
  const visit = (directory: string, relativeDir: string): void => {
    const directoryBefore = lstatSync(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(`Git workspace witness authored directory changed: ${relativeDir}`);
    }
    const canonicalDirectoryBefore = realpathSync.native(directory);
    if (!isCanonicalPathWithin(canonicalDirectoryBefore, root)) {
      throw new Error(`Git workspace witness authored directory escaped: ${relativeDir}`);
    }
    const metadataBefore = fileMetadata(directoryBefore);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      const relativePath = `${relativeDir}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        if (shouldSkipWorkspaceWitnessDir(relativePath)) continue;
        visit(absolutePath, relativePath);
      } else if (stat.isFile() || stat.isSymbolicLink()) {
        paths.push(relativePath);
      }
    }
    const directoryAfter = lstatSync(directory);
    if (
      directoryAfter.isSymbolicLink() ||
      !directoryAfter.isDirectory() ||
      !sameFileMetadata(metadataBefore, fileMetadata(directoryAfter)) ||
      realpathSync.native(directory) !== canonicalDirectoryBefore
    ) {
      throw new Error(`Git workspace witness authored directory changed: ${relativeDir}`);
    }
  };
  visit(tagmaRoot, '.tagma');
  return paths.sort();
}

const GIT_CONTROL_IDENTITY_NAMES = [
  'HEAD',
  'index',
  'config',
  'config.worktree',
  'info/exclude',
  'info/sparse-checkout',
  'packed-refs',
  'shallow',
  'commondir',
] as const;

function gitControlFileIdentities(layout: GitWorkspaceControlLayout): Array<{
  name: (typeof GIT_CONTROL_IDENTITY_NAMES)[number];
  identity: TrialWitnessFileIdentity;
}> {
  return GIT_CONTROL_IDENTITY_NAMES.flatMap((name, index) => {
    const path = layout.identityPaths[index];
    if (!path) throw new Error('Git workspace witness returned incomplete control-file paths.');
    return existsSync(path) ? [{ name, identity: fileIdentity(path) }] : [];
  });
}
const GIT_CONTROL_LOCK_NAMES = [
  'index.lock',
  'HEAD.lock',
  'packed-refs.lock',
  'config.lock',
  'shallow.lock',
] as const;

function readGitWorkspaceControlLayout(
  gitPath: string,
  root: string,
  required: boolean,
): GitWorkspaceControlLayout | null {
  const args = ['rev-parse', '--path-format=absolute', '--show-toplevel'];
  for (const name of GIT_CONTROL_IDENTITY_NAMES) args.push('--git-path', name);
  for (const name of GIT_CONTROL_LOCK_NAMES) args.push('--git-path', name);
  args.push('--git-path', 'refs');
  const result = spawnGitWitness(gitPath, root, args);
  if (result.status !== 0) {
    if (required) {
      throw new Error(
        `Git workspace witness could not inspect repository layout: ${result.stderr.toString('utf-8').trim() || `exit ${String(result.status)}`}`,
      );
    }
    return null;
  }
  const output = result.stdout.toString('utf-8').trimEnd().split(/\r?\n/u);
  const expectedCount = 1 + GIT_CONTROL_IDENTITY_NAMES.length + GIT_CONTROL_LOCK_NAMES.length + 1;
  if (output.length !== expectedCount) {
    throw new Error('Git workspace witness returned incomplete repository layout paths.');
  }
  let gitRoot: string;
  try {
    gitRoot = realpathSync.native(output[0]!);
  } catch {
    throw new Error('Git workspace witness repository root is unavailable.');
  }
  const identityStart = 1;
  const lockStart = identityStart + GIT_CONTROL_IDENTITY_NAMES.length;
  const refsIndex = lockStart + GIT_CONTROL_LOCK_NAMES.length;
  return {
    root: gitRoot,
    identityPaths: output.slice(identityStart, lockStart).map((path) => resolve(root, path)),
    lockPaths: output.slice(lockStart, refsIndex).map((path) => resolve(root, path)),
    refsPath: resolve(root, output[refsIndex]!),
  };
}
function assertNoGitWorkspaceControlLocks(layout: GitWorkspaceControlLayout): void {
  for (let index = 0; index < layout.lockPaths.length; index += 1) {
    if (!existsSync(layout.lockPaths[index]!)) continue;
    throw new Error(
      `Git workspace witness refused repository control lock: ${GIT_CONTROL_LOCK_NAMES[index] ?? 'unknown lock'}`,
    );
  }
  if (!existsSync(layout.refsPath)) return;
  let visitedEntries = 0;
  const visitRefs = (directory: string): void => {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Git workspace witness requires refs to be a regular directory tree.');
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareNames)) {
      visitedEntries += 1;
      if (visitedEntries > 10_000) {
        throw new Error('Git workspace witness refused an unexpectedly large refs tree.');
      }
      if (entry.name.endsWith('.lock')) {
        throw new Error(`Git workspace witness refused repository reference lock: ${entry.name}`);
      }
      if (entry.isDirectory()) visitRefs(join(directory, entry.name));
    }
  };
  visitRefs(layout.refsPath);
}
function gitWorkspaceSourceSnapshot(root: string): GitWorkspaceSourceSnapshot | null {
  const gitPath = resolveBinaryPath('git', {});
  const hasGitMarker = existsSync(join(root, '.git'));
  if (!gitPath) {
    if (hasGitMarker) throw new Error('Git workspace witness could not resolve git from PATH.');
    return null;
  }

  const layout = readGitWorkspaceControlLayout(gitPath, root, hasGitMarker);
  if (!layout) return null;
  if (!sameCanonicalPath(layout.root, root)) {
    if (hasGitMarker) {
      throw new Error('Git workspace witness requires an exact Git root workspace.');
    }
    return null;
  }
  assertNoGitWorkspaceControlLocks(layout);
  const controlFilesBefore = gitControlFileIdentities(layout);

  const staged = successfulGitWitnessCommand(gitPath, root, ['ls-files', '--stage', '-z']);
  const indexFlags = successfulGitWitnessCommand(gitPath, root, ['ls-files', '-v', '-z']);
  const untracked = successfulGitWitnessCommand(gitPath, root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const status = successfulGitWitnessCommand(gitPath, root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
    '--ignored=matching',
  ]);
  const authoredTagmaPaths = authoredTagmaWorkspacePaths(root);
  const rootIdentityPaths = rootWorkspaceIdentityPaths(root);
  const paths = new Set<string>();
  const addSourcePath = (path: string): void => {
    if (!shouldSkipWorkspaceWitnessDir(path)) paths.add(path);
  };
  for (const record of nullTerminatedGitRecords(staged, 'index')) {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('Git workspace witness returned an invalid index record.');
    addSourcePath(record.slice(separator + 1));
  }
  for (const path of nullTerminatedGitRecords(untracked, 'untracked files')) addSourcePath(path);
  for (const path of authoredTagmaPaths) paths.add(path);
  for (const path of rootIdentityPaths) paths.add(path);
  const gitIdentity = fileIdentity(gitPath);
  const controlHash = createHash('sha256');
  controlHash.update(`git-binary\0${JSON.stringify(gitIdentity)}\0`);
  controlHash.update(`git-control-files\0${JSON.stringify(controlFilesBefore)}\0`);
  for (const [label, value] of [
    ['index', staged],
    ['index-flags', indexFlags],
    ['status', status],
    ['untracked', untracked],
  ] as const) {
    controlHash.update(`${label}\0${value.byteLength}\0`);
    controlHash.update(value);
  }
  controlHash.update(`authored-tagma\0${authoredTagmaPaths.length}\0`);
  controlHash.update(`${authoredTagmaPaths.join('\0')}\0`);
  controlHash.update(`root-identities\0${rootIdentityPaths.length}\0`);
  controlHash.update(`${rootIdentityPaths.join('\0')}\0`);
  const controlFilesAfter = gitControlFileIdentities(layout);
  if (JSON.stringify(controlFilesAfter) !== JSON.stringify(controlFilesBefore)) {
    throw new Error('Git workspace control files changed while hashing.');
  }
  assertNoGitWorkspaceControlLocks(layout);
  return {
    controlDigest: controlHash.digest('hex'),
    paths: [...paths].sort(),
  };
}

function manifestCacheEntries(
  cache: TrialHostWorkspaceManifestCache | null,
  resolvedRoot: string,
): Map<string, TrialHostWorkspaceManifestEntry> {
  return cache?.root === resolvedRoot
    ? cache.entries
    : new Map<string, TrialHostWorkspaceManifestEntry>();
}

function gitWorkspaceWitness(
  resolvedRoot: string,
  previousCache: TrialHostWorkspaceManifestCache | null,
): { witness: TrialHostWorkspaceWitness; cache: TrialHostWorkspaceManifestCache } | null {
  const before = gitWorkspaceSourceSnapshot(resolvedRoot);
  if (!before) return null;
  const sourcePaths = new Set(before.paths);
  const previousEntries = manifestCacheEntries(previousCache, resolvedRoot);
  const nextEntries = new Map<string, TrialHostWorkspaceManifestEntry>();
  let fileHashBuffer: Buffer | undefined;
  const hash = createHash('sha256');
  hash.update(`git-source-v1\0${before.controlDigest}\0`);
  const stats: TrialHostWorkspaceManifestCacheStats = {
    fileCount: 0,
    totalBytes: 0,
    hashedFileCount: 0,
    hashedBytes: 0,
    reusedFileCount: 0,
  };
  for (const relativePath of before.paths) {
    const absolutePath = assertGitWorkspacePath(resolvedRoot, relativePath);
    let stat: Stats;
    try {
      stat = lstatSync(absolutePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(`missing\0${relativePath}\0`);
        continue;
      }
      throw err;
    }
    if (stat.isDirectory()) {
      throw new Error(
        `Git workspace witness does not support nested repositories: ${relativePath}`,
      );
    }
    if (stat.isSymbolicLink()) {
      let canonicalTarget: string;
      try {
        canonicalTarget = realpathSync.native(absolutePath);
      } catch {
        throw new Error(`Workspace witness symlink target is unavailable: ${relativePath}`);
      }
      if (!isCanonicalPathWithin(canonicalTarget, resolvedRoot)) {
        throw new Error(
          `Workspace witness symlink target is outside the workspace: ${relativePath}`,
        );
      }
      const canonicalTargetRelative = relative(resolvedRoot, canonicalTarget).split(sep).join('/');
      if (shouldSkipWorkspaceWitnessDir(canonicalTargetRelative)) {
        throw new Error(
          `Workspace witness symlink points into an excluded workspace path: ${relativePath}`,
        );
      }
      const targetStat = lstatSync(canonicalTarget);
      if (!targetStat.isFile() && !targetStat.isDirectory()) {
        throw new Error(`Workspace witness symlink target is not a regular path: ${relativePath}`);
      }
      const targetInSourceScope = targetStat.isFile()
        ? sourcePaths.has(canonicalTargetRelative)
        : canonicalTargetRelative === '' ||
          before.paths.some((path) => path.startsWith(`${canonicalTargetRelative}/`));
      if (!targetInSourceScope) {
        throw new Error(
          `Workspace witness symlink points into an excluded workspace path: ${relativePath}`,
        );
      }

      const metadata = fileMetadata(stat);
      const cached = previousEntries.get(relativePath);
      let rawTargetSize: number;
      let rawTargetSha256: string;
      if (cached?.kind === 'symlink' && sameFileMetadata(cached, metadata)) {
        stats.reusedFileCount += 1;
        rawTargetSize = cached.rawTargetSize;
        rawTargetSha256 = cached.rawTargetSha256;
      } else {
        const rawTarget = readlinkSync(absolutePath, { encoding: 'buffer' });
        stats.hashedFileCount += 1;
        stats.hashedBytes += rawTarget.byteLength;
        rawTargetSize = rawTarget.byteLength;
        rawTargetSha256 = sha256(rawTarget);
      }
      const symlinkAfter = lstatSync(absolutePath);
      if (
        !symlinkAfter.isSymbolicLink() ||
        !sameFileMetadata(metadata, fileMetadata(symlinkAfter))
      ) {
        throw new Error(`Workspace witness symlink changed while hashing: ${relativePath}`);
      }
      let canonicalTargetAfter: string;
      try {
        canonicalTargetAfter = realpathSync.native(absolutePath);
      } catch {
        throw new Error(`Workspace witness symlink target is unavailable: ${relativePath}`);
      }
      if (canonicalTargetAfter !== canonicalTarget) {
        throw new Error(`Workspace witness symlink changed while hashing: ${relativePath}`);
      }
      const canonicalTargetBytes = Buffer.from(canonicalTarget, 'utf-8');
      stats.fileCount += 1;
      stats.totalBytes += rawTargetSize;
      nextEntries.set(relativePath, {
        ...metadata,
        kind: 'symlink',
        rawTargetSize,
        rawTargetSha256,
      });
      hash.update(
        `symlink\0${relativePath}\0${rawTargetSize}\0${rawTargetSha256}\0${canonicalTargetBytes.byteLength}\0${sha256(canonicalTargetBytes)}\0`,
      );
      continue;
    }
    if (!stat.isFile()) continue;
    const canonicalPath = realpathSync.native(absolutePath);
    if (!isCanonicalPathWithin(canonicalPath, resolvedRoot)) {
      throw new Error(`Git workspace witness file escaped the workspace: ${relativePath}`);
    }
    const canonicalRelativePath = relative(resolvedRoot, canonicalPath).split(sep).join('/');
    if (
      shouldSkipWorkspaceWitnessDir(canonicalRelativePath) ||
      !sourcePaths.has(canonicalRelativePath)
    ) {
      throw new Error(
        `Workspace witness symlink points into an excluded workspace path: ${relativePath}`,
      );
    }

    const metadata = fileMetadata(stat);
    const cached = previousEntries.get(relativePath);
    const contentHash =
      cached?.kind === 'file' && sameFileMetadata(cached, metadata)
        ? (() => {
            stats.reusedFileCount += 1;
            return cached.sha256;
          })()
        : (() => {
            stats.hashedFileCount += 1;
            stats.hashedBytes += stat.size;
            return streamFileSha256(
              absolutePath,
              stat,
              true,
              (fileHashBuffer ??= Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)),
            );
          })();
    stats.fileCount += 1;
    stats.totalBytes += stat.size;
    nextEntries.set(relativePath, { ...metadata, kind: 'file', sha256: contentHash });
    hash.update(`file\0${relativePath}\0${stat.size}\0${contentHash}\0`);
  }
  const after = gitWorkspaceSourceSnapshot(resolvedRoot);
  if (!after || after.controlDigest !== before.controlDigest) {
    throw new Error('Git workspace source changed while hashing.');
  }
  return {
    witness: {
      digest: hash.digest('hex'),
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
    },
    cache: { root: resolvedRoot, entries: nextEntries, lastStats: stats },
  };
}

function filesystemWorkspaceWitness(
  resolvedRoot: string,
  previousCache: TrialHostWorkspaceManifestCache | null,
): { witness: TrialHostWorkspaceWitness; cache: TrialHostWorkspaceManifestCache } {
  const previousEntries = manifestCacheEntries(previousCache, resolvedRoot);
  const nextEntries = new Map<string, TrialHostWorkspaceManifestEntry>();
  let fileHashBuffer: Buffer | undefined;
  const hash = createHash('sha256');
  const stats: TrialHostWorkspaceManifestCacheStats = {
    fileCount: 0,
    totalBytes: 0,
    hashedFileCount: 0,
    hashedBytes: 0,
    reusedFileCount: 0,
  };
  const visit = (directory: string, relativeDir: string): void => {
    const directoryBefore = lstatSync(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new Error(
        `Workspace witness directory changed before traversal: ${relativeDir || '.'}`,
      );
    }
    const canonicalDirectoryBefore = realpathSync.native(directory);
    if (!isCanonicalPathWithin(canonicalDirectoryBefore, resolvedRoot)) {
      throw new Error(`Workspace witness directory escaped the workspace: ${relativeDir || '.'}`);
    }
    const directoryMetadataBefore = fileMetadata(directoryBefore);
    const entries = readdirSync(directory, { withFileTypes: true }).sort(compareNames);
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        let canonicalTarget: string;
        try {
          canonicalTarget = realpathSync.native(absolutePath);
        } catch {
          throw new Error(`Workspace witness symlink target is unavailable: ${relativePath}`);
        }
        if (!isCanonicalPathWithin(canonicalTarget, resolvedRoot)) {
          throw new Error(
            `Workspace witness symlink target is outside the workspace: ${relativePath}`,
          );
        }
        const canonicalTargetRelative = relative(resolvedRoot, canonicalTarget)
          .split(sep)
          .join('/');
        if (shouldSkipWorkspaceWitnessDir(canonicalTargetRelative)) {
          throw new Error(
            `Workspace witness symlink points into an excluded workspace path: ${relativePath}`,
          );
        }
        const targetStat = lstatSync(canonicalTarget);
        if (!targetStat.isFile() && !targetStat.isDirectory()) {
          throw new Error(
            `Workspace witness symlink target is not a regular path: ${relativePath}`,
          );
        }

        const metadata = fileMetadata(stat);
        const cached = previousEntries.get(relativePath);
        let rawTargetSize: number;
        let rawTargetSha256: string;
        if (cached?.kind === 'symlink' && sameFileMetadata(cached, metadata)) {
          stats.reusedFileCount += 1;
          rawTargetSize = cached.rawTargetSize;
          rawTargetSha256 = cached.rawTargetSha256;
        } else {
          const rawTarget = readlinkSync(absolutePath, { encoding: 'buffer' });
          stats.hashedFileCount += 1;
          stats.hashedBytes += rawTarget.byteLength;
          rawTargetSize = rawTarget.byteLength;
          rawTargetSha256 = sha256(rawTarget);
        }
        const symlinkAfter = lstatSync(absolutePath);
        if (
          !symlinkAfter.isSymbolicLink() ||
          !sameFileMetadata(metadata, fileMetadata(symlinkAfter))
        ) {
          throw new Error(`Workspace witness symlink changed while hashing: ${relativePath}`);
        }
        let canonicalTargetAfter: string;
        try {
          canonicalTargetAfter = realpathSync.native(absolutePath);
        } catch {
          throw new Error(`Workspace witness symlink target is unavailable: ${relativePath}`);
        }
        if (canonicalTargetAfter !== canonicalTarget) {
          throw new Error(`Workspace witness symlink changed while hashing: ${relativePath}`);
        }
        const canonicalTargetBytes = Buffer.from(canonicalTarget, 'utf-8');
        stats.fileCount += 1;
        stats.totalBytes += rawTargetSize;
        nextEntries.set(relativePath, {
          ...metadata,
          kind: 'symlink',
          rawTargetSize,
          rawTargetSha256,
        });
        hash.update(
          `symlink\0${relativePath}\0${rawTargetSize}\0${rawTargetSha256}\0${canonicalTargetBytes.byteLength}\0${sha256(canonicalTargetBytes)}\0`,
        );
        continue;
      }
      if (stat.isDirectory()) {
        if (shouldSkipWorkspaceWitnessDir(relativePath)) continue;
        hash.update(`dir\0${relativePath}\0`);
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const metadata = fileMetadata(stat);
      const cached = previousEntries.get(relativePath);
      const contentHash =
        cached?.kind === 'file' && sameFileMetadata(cached, metadata)
          ? (() => {
              stats.reusedFileCount += 1;
              return cached.sha256;
            })()
          : (() => {
              stats.hashedFileCount += 1;
              stats.hashedBytes += stat.size;
              return streamFileSha256(
                absolutePath,
                stat,
                true,
                (fileHashBuffer ??= Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES)),
              );
            })();
      stats.fileCount += 1;
      stats.totalBytes += stat.size;
      nextEntries.set(relativePath, { ...metadata, kind: 'file', sha256: contentHash });
      hash.update(`file\0${relativePath}\0${stat.size}\0${contentHash}\0`);
    }

    const directoryAfter = lstatSync(directory);
    if (
      directoryAfter.isSymbolicLink() ||
      !directoryAfter.isDirectory() ||
      !sameFileMetadata(directoryMetadataBefore, fileMetadata(directoryAfter))
    ) {
      throw new Error(
        `Workspace witness directory changed while traversing: ${relativeDir || '.'}`,
      );
    }
    const canonicalDirectoryAfter = realpathSync.native(directory);
    if (canonicalDirectoryAfter !== canonicalDirectoryBefore) {
      throw new Error(
        `Workspace witness directory changed while traversing: ${relativeDir || '.'}`,
      );
    }
  };
  visit(resolvedRoot, '');
  return {
    witness: {
      digest: hash.digest('hex'),
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
    },
    cache: {
      root: resolvedRoot,
      entries: nextEntries,
      lastStats: stats,
    },
  };
}

export function trialWorkspaceWitnessScopeIssue(workspaceRoot: string): string | null {
  const normalizedWindowsPath = win32.normalize(workspaceRoot);
  const windowsRoot = win32.parse(normalizedWindowsPath).root;
  const isWindowsRoot =
    win32.isAbsolute(normalizedWindowsPath) &&
    (normalizedWindowsPath.toLowerCase() === windowsRoot.toLowerCase() ||
      /^\\\\\?\\UNC\\[^\\]+\\[^\\]+\\?$/iu.test(normalizedWindowsPath));
  const resolvedNativePath = isAbsolute(workspaceRoot) ? resolve(workspaceRoot) : null;
  const isNativeRoot =
    resolvedNativePath !== null && parse(resolvedNativePath).root === resolvedNativePath;
  if (!isWindowsRoot && !isNativeRoot) return null;
  return `Trial host witness refused workspace root ${workspaceRoot} because a full-filesystem witness would have to scan the entire volume or network share. Select a narrower project directory and retry; Tagma will not silently narrow the witness scope.`;
}

export function captureTrialWorkspaceWitnessForRoot(
  workspaceRoot: string,
  previousCache: TrialHostWorkspaceManifestCache | null,
): { witness: TrialHostWorkspaceWitness; cache: TrialHostWorkspaceManifestCache } {
  const resolvedRoot = realpathSync.native(resolve(workspaceRoot));
  const gitWitness = gitWorkspaceWitness(resolvedRoot, previousCache);
  if (gitWitness) return gitWitness;
  if (existsSync(join(resolvedRoot, '.git'))) {
    throw new Error('Git workspace witness could not resolve git from PATH.');
  }
  const scopeIssue = trialWorkspaceWitnessScopeIssue(resolvedRoot);
  if (scopeIssue) throw new Error(scopeIssue);
  return filesystemWorkspaceWitness(resolvedRoot, previousCache);
}

function captureTrialWorkspaceWitnessWithCache(ws: WorkspaceState): {
  witness: TrialHostWorkspaceWitness;
  cache: TrialHostWorkspaceManifestCache;
} {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const result = captureTrialWorkspaceWitnessForRoot(
    ws.workDir,
    workspaceManifestCaches.get(ws) ?? null,
  );
  workspaceManifestCaches.set(ws, result.cache);
  asyncWorkspaceManifestCacheStats.delete(ws);
  return result;
}

export function getTrialHostWorkspaceManifestCacheStatsForTests(
  ws: WorkspaceState,
): TrialHostWorkspaceManifestCacheStats | null {
  const stats =
    asyncWorkspaceManifestCacheStats.get(ws) ?? workspaceManifestCaches.get(ws)?.lastStats;
  return stats ? { ...stats } : null;
}

export function safeCaptureTrialWorkspaceWitness(ws: WorkspaceState): {
  witness: TrialHostWorkspaceWitness | null;
  reason: string | null;
} {
  try {
    return { witness: captureTrialWorkspaceWitnessWithCache(ws).witness, reason: null };
  } catch (err) {
    return { witness: null, reason: errorMessage(err) };
  }
}
function windowsBinaryCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const pathext = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (extname(name)) return [name];
  return [name, ...pathext.map((ext) => `${name}${ext}`)];
}

function resolveBinaryPath(name: string, env: NodeJS.ProcessEnv): string | null {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const pathValue =
    process.platform === 'win32'
      ? (env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? '')
      : (env.PATH ?? process.env.PATH ?? '');
  const pathEntries = [
    ...new Set(pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)),
  ];
  const candidates = process.platform === 'win32' ? windowsBinaryCandidates(name, env) : [name];
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = resolve(directory, candidate);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) return fullPath;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

function binaryWitnesses(
  names: readonly string[],
  pythonEnv: Readonly<Record<string, string>>,
): { available: TrialHostBinaryWitness[]; missing: string[] } {
  const env = { ...process.env, ...pythonEnv };
  const available: TrialHostBinaryWitness[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const resolvedPath = resolveBinaryPath(name, env);
    if (!resolvedPath) {
      missing.push(name);
      continue;
    }
    available.push({
      name,
      identity: fileIdentity(resolvedPath),
    });
  }
  return { available, missing };
}

function editorDriverBinaryWitnesses(
  names: readonly string[],
  pythonEnv: Readonly<Record<string, string>>,
): { available: TrialHostBinaryWitness[]; missing: string[] } {
  const env = { ...process.env, ...pythonEnv };
  const available: TrialHostBinaryWitness[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (name !== 'opencode') continue;
    const configuredPath = resolveOpencodeBinary();
    const resolvedPath =
      configuredPath.includes('/') || configuredPath.includes('\\')
        ? configuredPath
        : resolveBinaryPath(configuredPath, env);
    if (!resolvedPath) {
      missing.push(`driver:${name}`);
      continue;
    }
    available.push({ name: `driver:${name}`, identity: fileIdentity(resolvedPath) });
  }
  return { available, missing };
}

function hashedValues(entries: Iterable<readonly [string, string]>): TrialWitnessValueHash[] {
  return [...entries]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, value]) => ({ name, sha256: sha256(value) }));
}

function minimalEnvWitnessEntries(
  secretEnv: Readonly<Record<string, string>>,
  pythonEnv: Readonly<Record<string, string>>,
): TrialWitnessValueHash[] {
  const entries: Array<readonly [string, string]> = [];
  for (const key of TRIAL_MINIMAL_ENV_KEYS) {
    const value = resolveExecutionEnvValue(key, secretEnv, pythonEnv);
    if (value !== null) entries.push([key, value] as const);
  }
  return hashedValues(entries);
}

function buildTrialHostPrerequisiteDigest(
  input: Pick<
    TrialHostWitness,
    | 'version'
    | 'binaries'
    | 'missingBinaries'
    | 'minimalEnv'
    | 'requiredEnv'
    | 'missingRequiredEnv'
    | 'secrets'
    | 'python'
  >,
): string {
  return sha256(JSON.stringify(input));
}

function pythonWitness(pythonEnv: Readonly<Record<string, string>>): TrialHostPythonWitness | null {
  if (Object.keys(pythonEnv).length === 0) return null;
  const venvPath = pythonEnv.TAGMA_PYTHON_AGENT_VENV ?? pythonEnv.VIRTUAL_ENV;
  const interpreterPath = pythonEnv.TAGMA_PYTHON_AGENT_PYTHON;
  if (!venvPath || !interpreterPath) {
    throw new Error(
      'Python witness requires both TAGMA_PYTHON_AGENT_VENV and TAGMA_PYTHON_AGENT_PYTHON.',
    );
  }
  const resolvedVenvPath = resolve(venvPath);
  const interpreter = fileIdentity(interpreterPath);
  const pyvenvCfgPath = join(resolvedVenvPath, 'pyvenv.cfg');
  return {
    env: hashedValues(Object.entries(pythonEnv)),
    interpreter,
    venvPath: resolvedVenvPath,
    pyvenvCfg: existsSync(pyvenvCfgPath) ? fileIdentity(pyvenvCfgPath) : null,
  };
}

export function prepareTrialHostWitnessInputs(
  ws: WorkspaceState,
  input: { relativePath: string; sourcePath: string | null; stagedYamlPath: string },
): PreparedTrialHostWitnessInputs {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const requirements = readRequirementsWitnessConfig(input.stagedYamlPath);
  const logicalYamlPath = input.sourcePath ?? resolve(ws.workDir, '.tagma', input.relativePath);
  const pythonSettings = readEditorSettings(ws).pythonAgent;
  const pythonEnv = buildPythonAgentRunEnv(ws.workDir, pythonSettings);
  const secretEnv = buildPipelineSecretEnv(ws.workDir, logicalYamlPath, undefined);
  return {
    logicalYamlPath,
    binaryNames: requirements.binaryNames,
    driverNames: requirements.driverNames,
    requiredEnvNames: requirements.requiredEnvNames,
    secretEnv,
    pythonEnv,
  };
}

function requiredEnvWitnessEntries(
  prepared: PreparedTrialHostWitnessInputs,
): Array<readonly [string, string]> {
  return prepared.requiredEnvNames.map((name) => {
    const value = resolveExecutionEnvValue(name, prepared.secretEnv, prepared.pythonEnv);
    if (value === null) {
      throw new Error(`Required environment witness value is unavailable for ${name}.`);
    }
    return [name, value] as const;
  });
}

export function captureTrialHostWitnessForRoot(
  workspaceRoot: string,
  prepared: PreparedTrialHostWitnessInputs,
  previousCache: TrialHostWorkspaceManifestCache | null,
): { witness: TrialHostWitness; cache: TrialHostWorkspaceManifestCache } {
  const workspaceCapture = captureTrialWorkspaceWitnessForRoot(workspaceRoot, previousCache);
  const requiredEnvEntries = requiredEnvWitnessEntries(prepared);
  const payload: Omit<TrialHostWitness, 'prerequisiteDigest' | 'digest'> = {
    version: TRIAL_HOST_WITNESS_VERSION,
    workspace: workspaceCapture.witness,
    binaries: [
      ...binaryWitnesses(prepared.binaryNames, prepared.pythonEnv),
      ...editorDriverBinaryWitnesses(prepared.driverNames, prepared.pythonEnv),
    ].sort(compareNames),
    minimalEnv: minimalEnvWitnessEntries(prepared.secretEnv, prepared.pythonEnv),
    requiredEnv: hashedValues(requiredEnvEntries),
    secrets: hashedValues(Object.entries(prepared.secretEnv)),
    python: pythonWitness(prepared.pythonEnv),
  };
  const prerequisiteDigest = buildTrialHostPrerequisiteDigest({
    version: payload.version,
    binaries: payload.binaries,
    minimalEnv: payload.minimalEnv,
    requiredEnv: payload.requiredEnv,
    secrets: payload.secrets,
    python: payload.python,
  });
  return {
    witness: {
      ...payload,
      prerequisiteDigest,
      digest: sha256(JSON.stringify({ ...payload, prerequisiteDigest })),
    },
    cache: workspaceCapture.cache,
  };
}

export function captureTrialHostWitness(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
): TrialHostWitness {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const result = captureTrialHostWitnessForRoot(
    ws.workDir,
    prepared,
    workspaceManifestCaches.get(ws) ?? null,
  );
  workspaceManifestCaches.set(ws, result.cache);
  asyncWorkspaceManifestCacheStats.delete(ws);
  return result.witness;
}

export function safePrepareTrialHostWitnessInputs(
  ws: WorkspaceState,
  input: { relativePath: string; sourcePath: string | null; stagedYamlPath: string },
): { prepared: PreparedTrialHostWitnessInputs | null; reason: string | null } {
  try {
    return { prepared: prepareTrialHostWitnessInputs(ws, input), reason: null };
  } catch (err) {
    return { prepared: null, reason: errorMessage(err) };
  }
}

export function safeCaptureTrialHostWitness(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
): { witness: TrialHostWitness | null; reason: string | null } {
  try {
    return { witness: captureTrialHostWitness(ws, prepared), reason: null };
  } catch (err) {
    return { witness: null, reason: errorMessage(err) };
  }
}

interface SerializedTrialWitnessWorkerError {
  message: string;
  name?: string;
  stack?: string;
}

interface TrialWitnessWorkerEnvelope {
  id: number;
  ok: boolean;
  response?: TrialHostWitnessWorkerResponse;
  error?: SerializedTrialWitnessWorkerError;
}

interface TrialWitnessWorkerPendingRequest {
  resolve: (response: TrialHostWitnessWorkerResponse) => void;
  reject: (error: Error) => void;
}

interface TrialWitnessWorkerState {
  worker: Worker | null;
  workerObjectUrl: string | null;
  nextRequestId: number;
  pending: Map<number, TrialWitnessWorkerPendingRequest>;
  queue: Promise<void>;
}

const trialWitnessWorkerStates = new WeakMap<WorkspaceState, TrialWitnessWorkerState>();

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason.trim().length > 0
      ? reason
      : 'Trial witness capture aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function deserializeTrialWitnessWorkerError(
  payload?: SerializedTrialWitnessWorkerError,
  fallback = 'Trial witness worker failed.',
): Error {
  const error = new Error(payload?.message || fallback);
  if (payload?.name) error.name = payload.name;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function trialWitnessWorkerState(ws: WorkspaceState): TrialWitnessWorkerState {
  let state = trialWitnessWorkerStates.get(ws);
  if (!state) {
    state = {
      worker: null,
      workerObjectUrl: null,
      nextRequestId: 1,
      pending: new Map(),
      queue: Promise.resolve(),
    };
    trialWitnessWorkerStates.set(ws, state);
  }
  return state;
}

function terminateTrialWitnessWorker(state: TrialWitnessWorkerState, error: Error): void {
  const worker = state.worker;
  const workerObjectUrl = state.workerObjectUrl;
  state.worker = null;
  state.workerObjectUrl = null;
  if (worker) worker.terminate();
  if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
  for (const pending of state.pending.values()) {
    pending.reject(error);
  }
  state.pending.clear();
}

function ensureTrialWitnessWorker(state: TrialWitnessWorkerState): Worker {
  if (state.worker) return state.worker;
  const embeddedSource =
    typeof __TAGMA_TRIAL_WITNESS_WORKER_SOURCE__ === 'string'
      ? __TAGMA_TRIAL_WITNESS_WORKER_SOURCE__
      : '';
  const workerObjectUrl = embeddedSource
    ? URL.createObjectURL(new Blob([embeddedSource], { type: 'text/javascript' }))
    : null;
  let worker: Worker;
  try {
    worker = new Worker(
      workerObjectUrl ?? new URL('./chat-pipeline-trial-witness-worker.js', import.meta.url),
      { type: 'module' },
    );
  } catch (error) {
    if (workerObjectUrl) URL.revokeObjectURL(workerObjectUrl);
    throw error;
  }
  state.workerObjectUrl = workerObjectUrl;
  worker.onmessage = (event: MessageEvent<TrialWitnessWorkerEnvelope>) => {
    const message = event.data;
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    if (message.ok && message.response) {
      pending.resolve(message.response);
      return;
    }
    pending.reject(deserializeTrialWitnessWorkerError(message.error));
  };
  worker.onerror = (event: ErrorEvent) => {
    terminateTrialWitnessWorker(
      state,
      deserializeTrialWitnessWorkerError(
        {
          message: event.message || 'Trial witness worker error.',
          name: event.error?.name,
          stack: event.error?.stack,
        },
        'Trial witness worker error.',
      ),
    );
  };
  worker.onmessageerror = () => {
    terminateTrialWitnessWorker(
      state,
      new Error('Trial witness worker returned an unreadable response.'),
    );
  };
  state.worker = worker;
  return worker;
}

function queueTrialWitnessWorkerCall<T>(
  ws: WorkspaceState,
  signal: AbortSignal | undefined,
  run: (state: TrialWitnessWorkerState) => Promise<T>,
): Promise<T> {
  const state = trialWitnessWorkerState(ws);
  const task = state.queue
    .catch(() => undefined)
    .then(async () => {
      if (signal?.aborted) {
        asyncWorkspaceManifestCacheStats.delete(ws);
        throw abortError(signal.reason);
      }
      return await run(state);
    });
  state.queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function postTrialWitnessWorkerRequest(
  ws: WorkspaceState,
  request: TrialHostWitnessWorkerRequest,
  signal?: AbortSignal,
): Promise<TrialHostWitnessWorkerResponse> {
  return queueTrialWitnessWorkerCall(ws, signal, async (state) => {
    if (signal?.aborted) throw abortError(signal.reason);
    const worker = ensureTrialWitnessWorker(state);
    const requestId = state.nextRequestId;
    state.nextRequestId += 1;
    return await new Promise<TrialHostWitnessWorkerResponse>((resolve, reject) => {
      const cleanupAbort = () => {
        if (!signal) return;
        signal.removeEventListener('abort', onAbort);
      };
      const onResolve = (response: TrialHostWitnessWorkerResponse) => {
        cleanupAbort();
        resolve(response);
      };
      const onReject = (error: Error) => {
        cleanupAbort();
        reject(error);
      };
      const onAbort = () => {
        asyncWorkspaceManifestCacheStats.delete(ws);
        terminateTrialWitnessWorker(state, abortError(signal?.reason));
      };
      state.pending.set(requestId, { resolve: onResolve, reject: onReject });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        worker.postMessage({ id: requestId, request });
      } catch (err) {
        state.pending.delete(requestId);
        cleanupAbort();
        onReject(err instanceof Error ? err : new Error(errorMessage(err)));
      }
    });
  });
}

export function disposeTrialWitnessWorker(ws: WorkspaceState): void {
  const state = trialWitnessWorkerStates.get(ws);
  asyncWorkspaceManifestCacheStats.delete(ws);
  if (!state) return;
  terminateTrialWitnessWorker(state, abortError('Trial witness worker disposed.'));
  trialWitnessWorkerStates.delete(ws);
}

workspaceRegistry.setOnDrop(disposeTrialWitnessWorker);

export async function captureTrialWorkspaceWitnessAsync(
  ws: WorkspaceState,
  signal?: AbortSignal,
): Promise<TrialHostWorkspaceWitness> {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const response = await postTrialWitnessWorkerRequest(
    ws,
    {
      kind: 'workspace',
      workspaceRoot: ws.workDir,
    },
    signal,
  );
  if (response.kind !== 'workspace') {
    throw new Error('Trial witness worker returned an unexpected workspace response.');
  }
  asyncWorkspaceManifestCacheStats.set(ws, response.cacheStats);
  return response.witness;
}

export async function safeCaptureTrialWorkspaceWitnessAsync(
  ws: WorkspaceState,
  signal?: AbortSignal,
): Promise<{ witness: TrialHostWorkspaceWitness | null; reason: string | null }> {
  try {
    return { witness: await captureTrialWorkspaceWitnessAsync(ws, signal), reason: null };
  } catch (err) {
    return { witness: null, reason: errorMessage(err) };
  }
}

export async function verifyTrialWitnessWorkerForBuild(rootDir: string): Promise<void> {
  const smokeWorkspace = { workDir: rootDir } as WorkspaceState;
  try {
    const witness = await captureTrialWorkspaceWitnessAsync(
      smokeWorkspace,
      AbortSignal.timeout(30_000),
    );
    if (!witness.digest) {
      throw new Error('Trial witness worker returned an empty workspace digest.');
    }
  } finally {
    disposeTrialWitnessWorker(smokeWorkspace);
  }
}

export async function captureTrialHostWitnessAsync(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
  signal?: AbortSignal,
): Promise<TrialHostWitness> {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const response = await postTrialWitnessWorkerRequest(
    ws,
    {
      kind: 'host',
      workspaceRoot: ws.workDir,
      prepared,
    },
    signal,
  );
  if (response.kind !== 'host') {
    throw new Error('Trial witness worker returned an unexpected host response.');
  }
  asyncWorkspaceManifestCacheStats.set(ws, response.cacheStats);
  return response.witness;
}

export async function safeCaptureTrialHostWitnessAsync(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
  signal?: AbortSignal,
): Promise<{ witness: TrialHostWitness | null; reason: string | null }> {
  try {
    return { witness: await captureTrialHostWitnessAsync(ws, prepared, signal), reason: null };
  } catch (err) {
    return { witness: null, reason: errorMessage(err) };
  }
}
