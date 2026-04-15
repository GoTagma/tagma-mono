// ─────────────────────────────────────────────────────────────────────────────
// plugin-safety.ts — security fences for the plugin loader.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every code path that turns a plugin name into a filesystem path goes through
// these helpers. Without them a request like `{ name: "../../some-dir" }` can
// escape the workspace's node_modules and read/write/delete arbitrary
// directories.
//
// Layered checks:
//   1. assertSafePluginName  — name must match the SDK's PLUGIN_NAME_RE
//      (scoped @tagma/* or tagma-plugin-*). Rejects ".." segments outright.
//   2. assertWithinNodeModules — even if the name passes the regex, the
//      resolved on-disk directory must still live under workDir/node_modules.
//      Belt-and-braces against future regex relaxations.
//
// The helpers are pure functions of (name, workDir) so they can be unit
// tested without spinning up an Express server or touching the filesystem.

import { resolve } from 'node:path';
import { isValidPluginName } from '@tagma/sdk';
import type { PluginCategory } from '@tagma/sdk';
import { isPathWithin as sharedIsPathWithin } from './path-utils.js';

export class PluginSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginSafetyError';
  }
}

/**
 * Return true when `child` resolves to a path inside `root`. Re-exported
 * from `./path-utils` so state.ts and plugin-safety.ts share one canonical
 * implementation — the previous local copy diverged by additionally
 * rejecting `child === root`, which created a silent maintenance hazard.
 */
export const isPathWithin = sharedIsPathWithin;

export function assertSafePluginName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new PluginSafetyError('plugin name is required');
  }
  if (!isValidPluginName(name)) {
    throw new PluginSafetyError(
      `Invalid plugin name "${name}". Must be a scoped npm package ` +
      `(e.g. @tagma/trigger-xyz) or tagma-plugin-*. ` +
      `Relative/absolute paths are not allowed.`
    );
  }
}

/**
 * Resolve a validated plugin name to its on-disk directory under
 * workDir/node_modules. Caller MUST have validated `name` first via
 * assertSafePluginName — passing an unvalidated name produces a path that
 * may escape workDir, and assertWithinNodeModules will then reject it.
 */
export function pluginDirFor(name: string, workDir: string): string {
  const parts = name.startsWith('@') ? name.split('/') : [name];
  return resolve(workDir, 'node_modules', ...parts);
}

export function assertWithinNodeModules(pluginDir: string, workDir: string): void {
  const nodeModulesRoot = resolve(workDir, 'node_modules');
  if (!isPathWithin(pluginDir, nodeModulesRoot)) {
    throw new PluginSafetyError(
      `Plugin directory "${pluginDir}" resolves outside ${nodeModulesRoot}. Refusing.`
    );
  }
}

/**
 * Convenience: validate the name AND fence the directory in one shot.
 * Throws PluginSafetyError on either failure.
 */
export function safePluginDir(name: unknown, workDir: string): string {
  assertSafePluginName(name);
  const dir = pluginDirFor(name, workDir);
  assertWithinNodeModules(dir, workDir);
  return dir;
}

/**
 * Infer the SDK plugin category from a package name following the
 * `@tagma/<category>-<type>` convention. Returns null for packages that
 * don't fit the convention (e.g. tagma-plugin-* or third-party scopes).
 *
 * NOTE: This helper is a best-effort fallback for legacy display paths
 * that need a category before the plugin's `package.json` has been read.
 * The canonical signal that a package is a plugin is the `tagmaPlugin`
 * field in its `package.json` — see `readPluginManifest` from @tagma/sdk.
 */
export function pluginCategoryFromName(name: string): { category: PluginCategory; type: string } | null {
  const m = name.match(/^@tagma\/(driver|trigger|completion|middleware)-(.+)$/);
  if (!m) return null;
  const [, cat, type] = m;
  return { category: (cat + 's') as PluginCategory, type };
}

/**
 * Race an importer call against a hard timeout (R11).
 *
 * Plugins with an infinite loop, a top-level fetch to a dead host, or a
 * top-level await on a never-resolving promise used to wedge the loader
 * indefinitely. This helper rejects after `timeoutMs` so the calling route
 * can return a clear error to the user.
 *
 * Important caveat: there is no way to cancel the orphaned import — it keeps
 * running on the event loop. The only way to fully isolate untrusted plugin
 * code is `worker_threads`, which is a separate refactor. This helper is the
 * "good enough" fix for the common case (well-meaning plugin with a bug).
 *
 * The importer is REQUIRED (not defaulted) so this module stays free of any
 * dynamic-import reference. That keeps the unit tests for this helper purely
 * synchronous JS — without the dependency, certain bun-test loader paths used
 * to hang at module load when a real `import(url)` literal lived in the
 * function body of a default importer.
 */
export type Importer = (url: string) => Promise<unknown>;

export async function importWithTimeout<T = unknown>(
  fileUrl: string,
  timeoutMs: number,
  pluginName: string,
  importer: Importer,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      importer(fileUrl) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `Plugin "${pluginName}" took longer than ${timeoutMs}ms to load. ` +
            `The module's top-level code may be hung (infinite loop, pending fetch, etc.).`
          )),
          timeoutMs,
        );
        // Don't keep the event loop alive just for this timer.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
