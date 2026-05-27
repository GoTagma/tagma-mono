// ─────────────────────────────────────────────────────────────────────────────
// workspace-migrate.ts — flat-`.tagma/*.yaml` → folder-`<stem>/<stem>.yaml`
// ─────────────────────────────────────────────────────────────────────────────
//
// Pipelines used to live flat under `.tagma/`:
//
//   .tagma/
//     foo.yaml
//     foo.layout.json
//     foo.compile.log
//     foo.requirements.md
//
// New layout:
//
//   .tagma/
//     foo/
//       foo.yaml
//       foo.layout.json
//       foo.compile.log
//       foo.requirements.md
//
// `migrateFlatPipelinesToFolders` runs once per workspace open, BEFORE plugin
// auto-load (otherwise the loader's YAML scan would miss declared plugins in
// flat files). Migration is idempotent, conflict-aware, and never silently
// hides data: a flat file we can't migrate (because `.tagma/<stem>/` already
// exists) stays where it is and is reported back so the UI can flag it.
//
// On success the function also fixes `ws.yamlPath` if it pointed at the old
// flat path and re-attaches the YAML / layout watchers — multi-window or
// repeated PATCH /api/workspace calls can re-trigger migration while a
// workspace is already bound, and we never want a stale yamlPath to dangle.

import { existsSync, lstatSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beginWatching, loadLayout, syncLayoutWatcherFromDisk } from './state.js';
import {
  enumerateFlatPipelineYamls,
  isValidPipelineStem,
  pipelineFolderPath,
  pipelineYamlPath,
  pipelineLayoutPath,
  pipelineCompileLogPath,
  pipelineRequirementsPath,
  tagmaDirOf,
  type FlatPipelineEntry,
} from './pipeline-paths.js';
import { pipelineManifestPath } from './pipeline-manifest.js';
import type { WorkspaceState } from './workspace-state.js';
import { readFileSync } from 'node:fs';

/** A single migration result for one flat YAML in `.tagma/`. */
export interface MigrationOutcome {
  /** Original YAML stem (before migration). */
  readonly stem: string;
  /** Old absolute path (e.g. `<wd>/.tagma/foo.yaml`). */
  readonly oldYamlPath: string;
  /** New absolute path (e.g. `<wd>/.tagma/foo/foo.yaml`), or null on failure. */
  readonly newYamlPath: string | null;
  /** Companion files that were moved (absolute new paths). */
  readonly movedSiblings: readonly string[];
  /** Why this entry could not be migrated, if applicable. */
  readonly reason?: 'conflict' | 'invalid-stem' | 'error';
  /** Human-readable detail for the reason. Only set when reason is set. */
  readonly detail?: string;
}

export interface MigrationReport {
  readonly migrated: readonly MigrationOutcome[];
  readonly conflicts: readonly MigrationOutcome[];
  readonly errors: readonly MigrationOutcome[];
}

const COMPANION_EXTENSIONS: ReadonlyArray<(yamlPath: string) => string> = [
  pipelineLayoutPath,
  pipelineCompileLogPath,
  pipelineRequirementsPath,
  pipelineManifestPath,
];

function hasExistingPipelineFolder(workDir: string, stem: string): boolean {
  const folder = pipelineFolderPath(workDir, stem);
  if (!existsSync(folder)) return false;
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

function moveCompanion(srcPath: string, destPath: string, movedSinks: string[]): void {
  if (!existsSync(srcPath)) return;
  try {
    // Reject symlinks — rename across a symlink would silently move the link,
    // not the target. The flat layout never produced symlinked companions
    // legitimately, so refusing is safe and prevents surprises.
    if (lstatSync(srcPath).isSymbolicLink()) {
      console.warn(`[workspace-migrate] skipping symlinked sibling ${srcPath}`);
      return;
    }
    renameSync(srcPath, destPath);
    movedSinks.push(destPath);
  } catch (err) {
    console.warn(`[workspace-migrate] failed to move sibling ${srcPath} → ${destPath}:`, err);
  }
}

/**
 * Move every flat-layout pipeline into a `<stem>/` folder. Returns a structured
 * report so callers can surface unmigratable items to the UI instead of
 * silently dropping them.
 *
 * Order matters: this MUST run before plugin auto-load. The plugin loader's
 * `discoverWorkspaceDeclaredPlugins` reads pipeline YAMLs to compute the
 * "what plugins does this workspace need" union; if a YAML is still flat at
 * that point, the new folder-based scanner will not see it.
 */
export function migrateFlatPipelinesToFolders(ws: WorkspaceState): MigrationReport {
  const migrated: MigrationOutcome[] = [];
  const conflicts: MigrationOutcome[] = [];
  const errors: MigrationOutcome[] = [];

  if (!ws.workDir) {
    return { migrated, conflicts, errors };
  }
  const tagmaDir = tagmaDirOf(ws.workDir);
  if (!existsSync(tagmaDir)) {
    return { migrated, conflicts, errors };
  }

  const flat = enumerateFlatPipelineYamls(ws.workDir);
  if (flat.length === 0) {
    return { migrated, conflicts, errors };
  }

  let needsYamlPathRebind = false;
  let newYamlPathForWs: string | null = null;

  for (const entry of flat) {
    const outcome = migrateOne(ws.workDir, entry);
    if (outcome.reason === 'conflict') {
      conflicts.push(outcome);
      continue;
    }
    if (outcome.reason === 'invalid-stem') {
      errors.push(outcome);
      continue;
    }
    if (outcome.reason === 'error') {
      errors.push(outcome);
      continue;
    }
    migrated.push(outcome);
    // Track ws.yamlPath rebind: the renamed file is the same workspace yaml
    // the editor was showing pre-migration.
    if (ws.yamlPath && resolveCaseInsensitive(ws.yamlPath, entry.yamlPath)) {
      needsYamlPathRebind = true;
      newYamlPathForWs = outcome.newYamlPath;
    }
  }

  if (needsYamlPathRebind && newYamlPathForWs) {
    rebindWorkspaceYamlPath(ws, newYamlPathForWs);
  }

  return { migrated, conflicts, errors };
}

/** Case-insensitive path equality (Windows-friendly). */
function resolveCaseInsensitive(a: string, b: string): boolean {
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function migrateOne(workDir: string, entry: FlatPipelineEntry): MigrationOutcome {
  const { stem, yamlPath: oldYamlPath } = entry;
  if (!isValidPipelineStem(stem)) {
    return {
      stem,
      oldYamlPath,
      newYamlPath: null,
      movedSiblings: [],
      reason: 'invalid-stem',
      detail: `Stem "${stem}" failed sanitization; rename the file manually.`,
    };
  }

  if (hasExistingPipelineFolder(workDir, stem)) {
    return {
      stem,
      oldYamlPath,
      newYamlPath: null,
      movedSiblings: [],
      reason: 'conflict',
      detail: `Folder .tagma/${stem}/ already exists; flat file left in place.`,
    };
  }

  const newYamlPath = pipelineYamlPath(workDir, stem);
  const folder = pipelineFolderPath(workDir, stem);
  const moved: string[] = [];
  try {
    mkdirSync(folder, { recursive: true });
    // YAML first — if this rename fails we don't want orphan siblings inside
    // a new folder pointing at nothing.
    if (lstatSync(oldYamlPath).isSymbolicLink()) {
      return {
        stem,
        oldYamlPath,
        newYamlPath: null,
        movedSiblings: [],
        reason: 'error',
        detail: 'Flat YAML is a symbolic link; refusing to migrate automatically.',
      };
    }
    renameSync(oldYamlPath, newYamlPath);
    moved.push(newYamlPath);
  } catch (err) {
    return {
      stem,
      oldYamlPath,
      newYamlPath: null,
      movedSiblings: [],
      reason: 'error',
      detail: `Failed to move YAML: ${(err as Error).message}`,
    };
  }

  for (const deriveSiblingPath of COMPANION_EXTENSIONS) {
    const srcCompanion = deriveSiblingPath(oldYamlPath);
    const destCompanion = deriveSiblingPath(newYamlPath);
    moveCompanion(srcCompanion, destCompanion, moved);
  }

  return {
    stem,
    oldYamlPath,
    newYamlPath,
    movedSiblings: moved.filter((p) => p !== newYamlPath),
  };
}

/**
 * The editor was already pointing at the old flat YAML when migration ran
 * (Electron window restore, multi-window second PATCH on the same workspace,
 * etc.). Re-bind without re-parsing: just update yamlPath, reload the layout
 * file off disk, and re-seed the watchers against the new sibling paths.
 *
 * We deliberately do NOT re-parse the YAML or touch ws.config — the content
 * is byte-identical post-rename, so the in-memory state stays correct.
 */
function rebindWorkspaceYamlPath(ws: WorkspaceState, newYamlPath: string): void {
  ws.yamlPath = newYamlPath;
  // Refresh layout from the (newly-relocated) .layout.json sibling. Safe to
  // call even when the sibling didn't exist — loadLayout falls back to an
  // empty positions map.
  loadLayout(ws);
  try {
    const content = readFileSync(newYamlPath, 'utf-8');
    // Reattach the YAML watcher with the new path AND seed its baseline using
    // the content we just read; without this the next file-watcher tick on
    // the same content would parse-and-rewrite ws.config from disk.
    beginWatching(ws, newYamlPath, content);
  } catch (err) {
    console.warn('[workspace-migrate] failed to rebind YAML watcher:', err);
  }
  // beginWatching already kicks off the layout watcher via syncLayoutWatcherFromDisk;
  // call it explicitly too in case beginWatching threw before reaching that line.
  try {
    syncLayoutWatcherFromDisk(ws);
  } catch {
    /* best-effort */
  }
}

/**
 * Render a structured report as user-facing warning lines. Returns an empty
 * array when there's nothing to surface. Used by route handlers to attach a
 * `migrationWarnings: string[]` to PATCH /api/workspace responses.
 */
export function formatMigrationWarnings(report: MigrationReport): string[] {
  const lines: string[] = [];
  for (const c of report.conflicts) {
    lines.push(
      `Pipeline "${c.stem}" could not be migrated: ${c.detail ?? 'folder already exists'}.`,
    );
  }
  for (const e of report.errors) {
    lines.push(`Pipeline "${e.stem}" failed to migrate: ${e.detail ?? 'unknown error'}.`);
  }
  return lines;
}

/**
 * Quick membership test used by `/api/workspace/yamls` to mark a flat YAML as
 * "still flat, can't migrate". Excludes flat files whose migration target
 * folder doesn't conflict — those would be migrated on the next workspace
 * open, so they're transient rather than stuck.
 */
export function isUnmigratableFlatYaml(workDir: string, entry: FlatPipelineEntry): boolean {
  if (!isValidPipelineStem(entry.stem)) return true;
  return hasExistingPipelineFolder(workDir, entry.stem);
}

// Re-export tagmaDir-relative join for routes that need it without pulling
// path-utils transitively.
export function withinTagma(workDir: string, ...segments: string[]): string {
  return join(tagmaDirOf(workDir), ...segments);
}
