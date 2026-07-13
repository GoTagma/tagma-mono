// ─────────────────────────────────────────────────────────────────────────────
// pipeline-paths.ts — single source of truth for `.tagma/<stem>/<stem>.yaml`
// ─────────────────────────────────────────────────────────────────────────────
//
// Every pipeline now lives in its own folder under `.tagma/`. The folder's
// basename equals the YAML stem; sibling companion files (`.layout.json`,
// `.compile.log`, `.requirements.md`) share that stem inside the folder:
//
//   .tagma/
//     pipeline-abc1/
//       pipeline-abc1.yaml
//       pipeline-abc1.layout.json
//       pipeline-abc1.compile.log
//       pipeline-abc1.requirements.md
//
// All path construction, validation, and enumeration goes through this file.
// Other modules (workspace routes, plugin loader, chat-compile-watcher,
// migration) MUST import from here rather than hand-rolling path rules so a
// rename here propagates everywhere.
//
// Reserved sibling directories under `.tagma/` (`logs`, `plugin-runtime`,
// `plugin-store`, `.usage`, `.opencode-runtime`, `node_modules`) are NOT
// pipelines. Enumeration skips them; the strict pipeline-path validator
// rejects them as stems. This guards delete/save flows against accidentally
// treating an editor-internal directory as a pipeline.

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isPathWithin } from './path-utils.js';

function sameResolvedPath(leftPath: string, rightPath: string): boolean {
  const left = resolve(leftPath);
  const right = resolve(rightPath);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Directory names under `.tagma/` that are NOT pipelines. */
export const RESERVED_TAGMA_NAMES: ReadonlySet<string> = new Set([
  'logs',
  'plugin-runtime',
  'plugin-store',
  '.usage',
  '.opencode-runtime',
  'node_modules',
]);

export function isReservedTagmaName(name: string): boolean {
  return RESERVED_TAGMA_NAMES.has(name.toLowerCase());
}

/** Max length for a sanitized stem. Keeps filesystem paths well under typical
 *  Windows MAX_PATH after concatenating `<workDir>/.tagma/<stem>/<stem>.yaml`. */
const MAX_STEM_LENGTH = 96;

/**
 * Validate and normalize a user-provided pipeline stem.
 *
 * Rejected:
 *   - empty / whitespace-only / too long
 *   - any of `/\:*?"<>|` (Windows-illegal + path separators)
 *   - any whitespace anywhere (tab/newline/space)
 *   - leading dot (`.foo`, `..foo`) — would hide the folder and collide with
 *     reserved dotdirs like `.usage`
 *   - exact `.` or `..` (relative path traversal)
 *   - reserved directory names under `.tagma/`
 *
 * The accepted stem can contain letters, digits, `_`, `-`, and embedded `.`
 * (so `foo.windows` from platform export still works), but never starts with
 * a dot and never contains a path separator.
 *
 * Returns the sanitized stem unchanged on success. Throws Error on rejection.
 */
export function sanitizePipelineStem(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('pipeline stem must be a string');
  }
  const stem = input;
  if (stem.length === 0) {
    throw new Error('pipeline stem must not be empty');
  }
  if (stem.length > MAX_STEM_LENGTH) {
    throw new Error(`pipeline stem must be ${MAX_STEM_LENGTH} characters or fewer`);
  }
  if (/\s/.test(stem)) {
    throw new Error('pipeline stem must not contain whitespace');
  }
  // Reject `/ \ : * ? " < > |` plus null. The first three are path separators
  // / drive marker; the rest are Windows-illegal filename chars.
  if (/[\\/:*?"<>|\0]/.test(stem)) {
    throw new Error('pipeline stem contains an illegal character');
  }
  if (stem === '.' || stem === '..') {
    throw new Error('pipeline stem must not be "." or ".."');
  }
  if (stem.startsWith('.')) {
    throw new Error('pipeline stem must not start with "."');
  }
  if (isReservedTagmaName(stem)) {
    throw new Error(`pipeline stem "${stem}" is reserved`);
  }
  return stem;
}

/** True when `stem` is a valid pipeline stem; false otherwise. Non-throwing. */
export function isValidPipelineStem(input: unknown): boolean {
  try {
    sanitizePipelineStem(input);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to `<workDir>/.tagma/`. */
export function tagmaDirOf(workDir: string): string {
  return resolve(workDir, '.tagma');
}

/** Absolute path to a pipeline's folder: `<workDir>/.tagma/<stem>/`. */
export function pipelineFolderPath(workDir: string, stem: string): string {
  return join(tagmaDirOf(workDir), sanitizePipelineStem(stem));
}

/** Absolute path to the YAML inside a pipeline folder. */
export function pipelineYamlPath(workDir: string, stem: string): string {
  const safe = sanitizePipelineStem(stem);
  return join(pipelineFolderPath(workDir, safe), `${safe}.yaml`);
}

/** Companion `.layout.json` path next to a pipeline YAML. */
export function pipelineLayoutPath(yamlPath: string): string {
  return yamlPath.replace(/\.ya?ml$/i, '.layout.json');
}

/** Companion `.compile.log` path next to a pipeline YAML. */
export function pipelineCompileLogPath(yamlPath: string): string {
  return yamlPath.replace(/\.ya?ml$/i, '.compile.log');
}

/** Companion `.requirements.md` path next to a pipeline YAML. */
export function pipelineRequirementsPath(yamlPath: string): string {
  return yamlPath.replace(/\.ya?ml$/i, '.requirements.md');
}

/** Strip `.yaml`/`.yml` from a basename to derive the stem. */
export function stemFromYamlBasename(name: string): string {
  return name.replace(/\.ya?ml$/i, '');
}

/** Strip a YAML extension off an absolute path (returns the path with no ext). */
export function stemFromYamlPath(yamlPath: string): string {
  return stemFromYamlBasename(basename(yamlPath));
}

/**
 * Describes a discovered pipeline. `stem === basename of folder === basename
 * of yaml without extension`; sibling paths are derived once so callers don't
 * have to re-compute them.
 */
export interface PipelineFolderEntry {
  readonly stem: string;
  readonly folderPath: string;
  readonly yamlPath: string;
  readonly yamlBasename: string;
  readonly layoutPath: string;
  readonly compileLogPath: string;
  readonly requirementsPath: string;
}

/**
 * Walk `<workDir>/.tagma/`, return every folder that contains a same-named
 * `.yaml`/`.yml`. Skips reserved directory names, dotfiles/dotdirs, regular
 * files at the top level, and symlinked directories (cheap guard against
 * symlink-driven escapes — strict per-route validation still applies).
 *
 * Best-effort: a malformed directory (unreadable, vanished) is logged and
 * skipped without throwing, so a hostile entry never blocks workspace open.
 */
export function enumeratePipelineYamls(workDir: string): PipelineFolderEntry[] {
  if (!workDir) return [];
  const tagmaDir = tagmaDirOf(workDir);
  if (!existsSync(tagmaDir)) return [];
  let entries;
  try {
    entries = readdirSync(tagmaDir, { withFileTypes: true });
  } catch (err) {
    console.warn('[pipeline-paths] failed to read .tagma/:', err);
    return [];
  }

  const out: PipelineFolderEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (isReservedTagmaName(name)) continue;
    if (name.startsWith('.')) continue;
    if (!isValidPipelineStem(name)) continue;
    const folderPath = join(tagmaDir, name);
    // Reject symlinked pipeline folders. The realpath check inside
    // assertPipelineYamlPath will catch escapes per-write; here we just want
    // the enumeration to skip obviously-suspicious folders so the picker
    // doesn't list them.
    try {
      if (lstatSync(folderPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // Accept `<stem>.yaml` first, fall back to `<stem>.yml`.
    const candidates = [`${name}.yaml`, `${name}.yml`];
    let yamlBasename: string | null = null;
    for (const candidate of candidates) {
      const candidatePath = join(folderPath, candidate);
      if (!existsSync(candidatePath)) continue;
      try {
        const st = lstatSync(candidatePath);
        if (st.isSymbolicLink() || !st.isFile()) continue;
      } catch {
        continue;
      }
      yamlBasename = candidate;
      break;
    }
    if (!yamlBasename) continue;
    const yamlPath = join(folderPath, yamlBasename);
    out.push({
      stem: name,
      folderPath,
      yamlPath,
      yamlBasename,
      layoutPath: pipelineLayoutPath(yamlPath),
      compileLogPath: pipelineCompileLogPath(yamlPath),
      requirementsPath: pipelineRequirementsPath(yamlPath),
    });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
}

/** Describes a legacy flat YAML still sitting at the top of `.tagma/`. */
export interface FlatPipelineEntry {
  readonly stem: string;
  readonly yamlPath: string;
  readonly yamlBasename: string;
  readonly layoutPath: string;
  readonly compileLogPath: string;
  readonly requirementsPath: string;
}

/**
 * Walk `<workDir>/.tagma/` for top-level `*.yaml` / `*.yml` files. These are
 * either pre-migration legacy pipelines OR — when paired with an existing
 * `<stem>/<stem>.yaml` — unmigratable conflicts the UI should surface.
 */
export function enumerateFlatPipelineYamls(workDir: string): FlatPipelineEntry[] {
  if (!workDir) return [];
  const tagmaDir = tagmaDirOf(workDir);
  if (!existsSync(tagmaDir)) return [];
  let entries;
  try {
    entries = readdirSync(tagmaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: FlatPipelineEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    const stem = stemFromYamlBasename(entry.name);
    if (!isValidPipelineStem(stem)) continue;
    const yamlPath = join(tagmaDir, entry.name);
    try {
      if (lstatSync(yamlPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    out.push({
      stem,
      yamlPath,
      yamlBasename: entry.name,
      layoutPath: pipelineLayoutPath(yamlPath),
      compileLogPath: pipelineCompileLogPath(yamlPath),
      requirementsPath: pipelineRequirementsPath(yamlPath),
    });
  }
  return out.sort((a, b) => a.stem.localeCompare(b.stem));
}

/**
 * Strict validator for any path the editor is about to write/read as a
 * pipeline YAML. Replaces the older `assertEditorManagedYamlPath` for
 * pipeline-managed routes (save/new/save-as/import/delete/compile/open).
 *
 * Required shape — `.tagma/<stem>/<stem>.{yaml,yml}`:
 *   - resolved path lives under workspace
 *   - resolved path lives under `.tagma/`
 *   - exactly one directory level under `.tagma/` (the pipeline folder)
 *   - parent folder name === yaml stem (folder and file share an identity)
 *   - stem passes `sanitizePipelineStem` (rejects reserved names and bad chars)
 *
 * Symlink check: any existing component on the resolved path must not be a
 * symlink. We walk from `.tagma/` down to the closest existing ancestor and
 * `lstat` each. Targets that don't exist yet (e.g. Save As / New) pass cleanly;
 * targets whose parent IS a symlink are rejected before the write.
 *
 * Throws Error with a caller-supplied label on rejection. Returns the resolved
 * absolute path on success.
 */
export function assertPipelineYamlPath(workDir: string, absPath: string, label: string): string {
  if (!workDir) {
    throw new Error(`Workspace directory is not set; cannot resolve ${label}.`);
  }
  const resolved = resolve(absPath);
  if (!isPathWithin(resolved, workDir)) {
    throw new Error(`${label} is outside the workspace directory.`);
  }
  const tagmaDir = tagmaDirOf(workDir);
  if (!isPathWithin(resolved, tagmaDir)) {
    throw new Error(`${label} must be inside the workspace .tagma directory.`);
  }
  if (sameResolvedPath(tagmaDir, resolved)) {
    throw new Error(`${label} cannot be the .tagma directory itself.`);
  }
  if (!/\.ya?ml$/i.test(resolved)) {
    throw new Error(`${label} must be a .yaml or .yml file.`);
  }
  const fileStem = stemFromYamlPath(resolved);
  if (!isValidPipelineStem(fileStem)) {
    throw new Error(`${label} has an invalid pipeline stem.`);
  }
  const parentDir = dirname(resolved);
  const parentName = basename(parentDir);
  // Exactly one level under .tagma/. Grand-parent must equal tagmaDir.
  if (!sameResolvedPath(dirname(parentDir), tagmaDir)) {
    throw new Error(`${label} must sit one level under .tagma/ (as .tagma/<stem>/<stem>.yaml).`);
  }
  if (parentName !== fileStem) {
    throw new Error(`${label} folder name "${parentName}" must match the YAML stem "${fileStem}".`);
  }

  // Walk existing ancestors from .tagma/ → parent → file, rejecting symlinks.
  const segments: string[] = [tagmaDir, parentDir, resolved];
  for (const segment of segments) {
    if (!existsSync(segment)) continue;
    try {
      const st = lstatSync(segment);
      if (st.isSymbolicLink()) {
        throw new Error(`${label} traverses a symbolic link at ${segment}.`);
      }
      // If parent/file exist already, also ensure parentDir is actually a
      // directory and the yaml is a regular file.
      if (sameResolvedPath(segment, parentDir) && !st.isDirectory()) {
        throw new Error(`${label} parent must be a directory.`);
      }
      if (sameResolvedPath(segment, resolved) && !st.isFile()) {
        throw new Error(`${label} must be a regular file.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(label)) throw err;
      throw new Error(`${label} could not stat ${segment}: ${(err as Error).message}`);
    }
  }
  return resolved;
}

/**
 * Strict validator for a pipeline FOLDER (e.g. for delete). Same shape rules
 * as `assertPipelineYamlPath` minus the YAML extension; rejects reserved
 * names and symlinks. Returns the resolved folder path on success.
 */
export function assertPipelineFolderPath(
  workDir: string,
  absFolderPath: string,
  label: string,
): string {
  if (!workDir) {
    throw new Error(`Workspace directory is not set; cannot resolve ${label}.`);
  }
  const resolved = resolve(absFolderPath);
  const tagmaDir = tagmaDirOf(workDir);
  if (!isPathWithin(resolved, tagmaDir)) {
    throw new Error(`${label} must be inside the workspace .tagma directory.`);
  }
  if (sameResolvedPath(tagmaDir, resolved)) {
    throw new Error(`${label} cannot be the .tagma directory itself.`);
  }
  if (!sameResolvedPath(dirname(resolved), tagmaDir)) {
    throw new Error(`${label} must sit one level under .tagma/.`);
  }
  const stem = basename(resolved);
  if (!isValidPipelineStem(stem)) {
    throw new Error(`${label} has an invalid pipeline stem.`);
  }
  for (const segment of [tagmaDir, resolved]) {
    if (!existsSync(segment)) continue;
    try {
      if (lstatSync(segment).isSymbolicLink()) {
        throw new Error(`${label} traverses a symbolic link at ${segment}.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(label)) throw err;
      throw new Error(`${label} could not stat ${segment}: ${(err as Error).message}`);
    }
  }
  return resolved;
}
