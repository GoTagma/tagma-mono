import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';

import type { Stats } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { errorMessage, isPathWithin } from './path-utils.js';
import { requirementsPath, parseRequirementsMd } from './requirements-sync.js';
import { buildPipelineSecretEnv } from './secrets.js';
import { readEditorSettings } from './plugins/loader.js';
import { buildPythonAgentRunEnv } from './python-agent.js';
import { resolveOpencodeBinary } from './opencode-lifecycle.js';

import type { WorkspaceState } from './workspace-state.js';

const TRIAL_HOST_WITNESS_VERSION = 2;
const FILE_HASH_BUFFER_BYTES = 1024 * 1024;
const SKIPPED_TAGMA_WITNESS_DIRS = new Set(['.chat-staging', 'logs', '.usage']);
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
  minimalEnv: TrialWitnessValueHash[];
  requiredEnv: TrialWitnessValueHash[];
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

interface TrialHostWorkspaceFileMetadata {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface TrialHostWorkspaceManifestEntry extends TrialHostWorkspaceFileMetadata {
  sha256: string;
}

interface TrialHostWorkspaceManifestCache {
  root: string;
  entries: Map<string, TrialHostWorkspaceManifestEntry>;
  lastStats: TrialHostWorkspaceManifestCacheStats;
}

const workspaceManifestCaches = new WeakMap<WorkspaceState, TrialHostWorkspaceManifestCache>();

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function shouldSkipWorkspaceWitnessDir(relativePath: string, name: string): boolean {
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

function streamFileSha256(path: string, expectedStat: Stats, disallowSymlinks: boolean): string {
  const expectedMetadata = fileMetadata(expectedStat);
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error(`Expected a regular file: ${path}`);
    if (!sameFileMetadata(expectedMetadata, fileMetadata(before))) {
      throw new Error(`Witness file changed before hashing: ${path}`);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(FILE_HASH_BUFFER_BYTES);
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

function workspaceWitness(ws: WorkspaceState): TrialHostWorkspaceWitness {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const resolvedRoot = resolve(ws.workDir);
  const existingCache = workspaceManifestCaches.get(ws);
  const previousEntries =
    existingCache?.root === resolvedRoot
      ? existingCache.entries
      : new Map<string, TrialHostWorkspaceManifestEntry>();
  const nextEntries = new Map<string, TrialHostWorkspaceManifestEntry>();
  const hash = createHash('sha256');
  const stats: TrialHostWorkspaceManifestCacheStats = {
    fileCount: 0,
    totalBytes: 0,
    hashedFileCount: 0,
    hashedBytes: 0,
    reusedFileCount: 0,
  };
  const visit = (directory: string, relativeDir: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(compareNames);
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (!isPathWithin(absolutePath, resolvedRoot)) {
        throw new Error(`Workspace witness path escaped the workspace: ${absolutePath}`);
      }
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Workspace witness does not allow symlinks: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        if (shouldSkipWorkspaceWitnessDir(relativePath, entry.name)) continue;
        hash.update(`dir\0${relativePath}\0`);
        visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const metadata = fileMetadata(stat);
      const cached = previousEntries.get(relativePath);
      const contentHash =
        cached && sameFileMetadata(cached, metadata)
          ? (() => {
              stats.reusedFileCount += 1;
              return cached.sha256;
            })()
          : (() => {
              stats.hashedFileCount += 1;
              stats.hashedBytes += stat.size;
              return streamFileSha256(absolutePath, stat, true);
            })();
      stats.fileCount += 1;
      stats.totalBytes += stat.size;
      nextEntries.set(relativePath, { ...metadata, sha256: contentHash });
      hash.update(`file\0${relativePath}\0${stat.size}\0${contentHash}\0`);
    }
  };
  visit(resolvedRoot, '');
  workspaceManifestCaches.set(ws, {
    root: resolvedRoot,
    entries: nextEntries,
    lastStats: stats,
  });
  return {
    digest: hash.digest('hex'),
    fileCount: stats.fileCount,
    totalBytes: stats.totalBytes,
  };
}

export function getTrialHostWorkspaceManifestCacheStatsForTests(
  ws: WorkspaceState,
): TrialHostWorkspaceManifestCacheStats | null {
  const stats = workspaceManifestCaches.get(ws)?.lastStats;
  return stats ? { ...stats } : null;
}
function windowsBinaryCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  const lower = name.toLowerCase();
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
): TrialHostBinaryWitness[] {
  const env = { ...process.env, ...pythonEnv };
  return names.map((name) => {
    const resolvedPath = resolveBinaryPath(name, env);
    if (!resolvedPath) throw new Error(`Required binary witness could not resolve ${name}.`);
    return {
      name,
      identity: fileIdentity(resolvedPath),
    };
  });
}

function editorDriverBinaryWitnesses(
  names: readonly string[],
  pythonEnv: Readonly<Record<string, string>>,
): TrialHostBinaryWitness[] {
  const env = { ...process.env, ...pythonEnv };
  return names.flatMap((name) => {
    if (name !== 'opencode') return [];
    const configuredPath = resolveOpencodeBinary();
    const resolvedPath =
      configuredPath.includes('/') || configuredPath.includes('\\')
        ? configuredPath
        : resolveBinaryPath(configuredPath, env);
    if (!resolvedPath) {
      throw new Error(`Editor driver witness could not resolve ${name}.`);
    }
    return [{ name: `driver:${name}`, identity: fileIdentity(resolvedPath) }];
  });
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
    'version' | 'binaries' | 'minimalEnv' | 'requiredEnv' | 'secrets' | 'python'
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

export function captureTrialHostWitness(
  ws: WorkspaceState,
  prepared: PreparedTrialHostWitnessInputs,
): TrialHostWitness {
  if (!ws.workDir) throw new Error('Workspace directory is not set.');
  const requiredEnvEntries = prepared.requiredEnvNames.map((name) => {
    const value = resolveExecutionEnvValue(name, prepared.secretEnv, prepared.pythonEnv);
    if (value === null) {
      throw new Error(`Required environment witness value is unavailable for ${name}.`);
    }
    return [name, value] as const;
  });
  const payload: Omit<TrialHostWitness, 'prerequisiteDigest' | 'digest'> = {
    version: TRIAL_HOST_WITNESS_VERSION,
    workspace: workspaceWitness(ws),
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
    ...payload,
    prerequisiteDigest,
    digest: sha256(JSON.stringify({ ...payload, prerequisiteDigest })),
  };
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
