import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  registerPlugin,
  isValidPluginName,
  readPluginManifest as parsePluginManifestField,
} from '@tagma/sdk';
import type { PluginCategory, RegisterResult } from '@tagma/sdk';
import type {
  DriverPlugin,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
} from '@tagma/types';
import {
  PluginSafetyError,
  assertSafePluginName,
  pluginCategoryFromName,
  importWithTimeout,
} from '../plugin-safety.js';
import {
  S,
  isPathWithin,
  pluginDirFor,
  fenceWithinNodeModules,
} from '../state.js';
import { installPackage } from './install.js';

/**
 * Map of plugin package name → which (category, type) pair it occupies in the
 * SDK registry. Replaces the old `loadedPlugins: Set<string>` so we can
 * actually unregister a plugin on uninstall.
 *
 * Note: ESM module caching means we cannot reload a plugin's *code* after the
 * first import — but we CAN remove its handler from the registry, which makes
 * subsequent task references fail loudly instead of silently reusing stale
 * code. The PluginManager UI tells users they need to restart the server to
 * pick up new versions.
 */
export interface LoadedPluginMeta {
  category: PluginCategory;
  type: string;
}
export const loadedPluginMeta = new Map<string, LoadedPluginMeta>();

/** Compatibility shim for callers that just want a "loaded" check. */
export const loadedPlugins = {
  has: (name: string) => loadedPluginMeta.has(name),
  add: (name: string, meta?: LoadedPluginMeta) => {
    if (meta) loadedPluginMeta.set(name, meta);
  },
  delete: (name: string) => loadedPluginMeta.delete(name),
} as const;

/**
 * Errors collected during the most recent autoLoadInstalledPlugins() pass.
 * Surfaced to clients via /api/plugins so the UI can flag broken plugins
 * instead of silently dropping them on workspace open.
 */
let lastAutoLoadErrors: Array<{ name: string; message: string }> = [];

export function getLastAutoLoadErrors(): Array<{ name: string; message: string }> {
  return lastAutoLoadErrors;
}

export interface PluginInfo {
  name: string;
  installed: boolean;
  loaded: boolean;
  version: string | null;
  description: string | null;
  categories: string[];
}

export function getPluginInfo(name: string): PluginInfo {
  // H7: validate name BEFORE turning it into a filesystem path so an attacker
  // can't probe arbitrary on-disk paths via /api/plugins/info?name=../../...
  // For invalid names we return a non-installed stub; the route layer also
  // rejects with 400 on invalid input, but we belt-and-brace here too.
  if (!isValidPluginName(name)) {
    return { name, installed: false, loaded: false, version: null, description: null, categories: [] };
  }

  let installed = false;
  let version: string | null = null;
  let description: string | null = null;
  let manifestCategory: PluginCategory | null = null;
  try {
    const pluginDir = pluginDirFor(name);
    fenceWithinNodeModules(pluginDir);
    const pkgPath = resolve(pluginDir, 'package.json');
    if (existsSync(pkgPath)) {
      installed = true;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version ?? null;
      description = pkg.description ?? null;
      try {
        const manifest = parsePluginManifestField(pkg);
        if (manifest) manifestCategory = manifest.category;
      } catch { /* malformed tagmaPlugin field — fall through to meta/name inference */ }
    }
  } catch (_err) { /* plugin dir missing or unreadable — treat as not installed */ }

  const loaded = loadedPlugins.has(name);

  // Category resolution order:
  //   1. runtime meta (loaded plugin) — authoritative
  //   2. tagmaPlugin field from package.json — works for installed-but-not-loaded
  //   3. name-based inference — legacy fallback
  // The prior implementation gated everything on hasHandler, which meant
  // installed-but-not-loaded plugins had no category and were filtered out
  // of LocalPanel's category tabs.
  const categories: string[] = [];
  const meta = loadedPluginMeta.get(name);
  if (meta) {
    categories.push(meta.category);
  } else if (manifestCategory) {
    categories.push(manifestCategory);
  } else {
    const inferred = pluginCategoryFromName(name);
    if (inferred) categories.push(inferred.category);
  }

  return { name, installed, loaded, version, description, categories };
}

/**
 * Dynamically import a plugin from the workDir's node_modules. Returns the
 * (category, type) pair the plugin registered under so the caller can record
 * it in loadedPluginMeta and later unregister it cleanly.
 *
 * Layered safety:
 *   1. assertSafePluginName     — reject paths and weird unicode
 *   2. assertWithinNodeModules  — even after split('/'), pluginDir must live
 *                                 under workDir/node_modules
 *   3. isPathWithin (B2)        — entry point must live inside pluginDir
 *
 * All three are required: assertSafePluginName alone could be bypassed if the
 * regex were ever loosened, and assertWithinNodeModules alone would still let
 * a malicious package.json `main` field escape via "../../../evil.js".
 */
// R11: hard cap on how long `await import()` can hang. Plugins with an
// infinite loop or a top-level fetch to a dead host used to wedge the load
// route forever; now the import is racing against this timeout and we
// surface a clear "took longer than Xs to load" error instead.
const PLUGIN_IMPORT_TIMEOUT_MS = 15_000;

/**
 * Resolve a package.json entry point to a filesystem-relative string.
 *
 * Handles both legacy `main` and modern conditional `exports`. For conditional
 * exports we look at the "." subpath and walk standard conditions (import,
 * default, node, require) to find the first string target. Plugins built with
 * tsup/Vite commonly ship `exports: { ".": { types, import, require } }` —
 * before this fix, we were passing that object straight to `resolve()`, which
 * threw "Path must be of type string, got object" when the user clicked Load.
 */
function resolveEntryPoint(pkg: Record<string, unknown>): string | null {
  const exportsField = pkg.exports as unknown;
  if (typeof exportsField === 'string') return exportsField;
  if (exportsField && typeof exportsField === 'object') {
    const dot = (exportsField as Record<string, unknown>)['.'];
    const resolved = pickExportTarget(dot ?? exportsField);
    if (resolved) return resolved;
  }
  if (typeof pkg.main === 'string') return pkg.main;
  return './src/index.ts';
}

function pickExportTarget(target: unknown): string | null {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return null;
  const conditions = target as Record<string, unknown>;
  for (const key of ['import', 'default', 'node', 'require', 'module']) {
    const v = conditions[key];
    const picked = pickExportTarget(v);
    if (picked) return picked;
  }
  return null;
}

function stagePluginForImport(name: string, pluginDir: string): string {
  if (!S.workDir) {
    throw new PluginSafetyError('Cannot stage plugin: workspace directory is not set');
  }
  const safeName = name.replace(/[\\/]/g, '__');
  const packageStageRoot = resolve(S.workDir, '.tagma', 'plugin-runtime', safeName);
  rmSync(packageStageRoot, { recursive: true, force: true });
  const stageDir = resolve(
    packageStageRoot,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(stageDir, { recursive: true });
  cpSync(pluginDir, stageDir, { recursive: true, dereference: true });
  return stageDir;
}

export async function loadPluginFromWorkDir(name: string): Promise<{ result: RegisterResult; meta: LoadedPluginMeta }> {
  assertSafePluginName(name);
  if (!S.workDir) {
    throw new PluginSafetyError('Cannot load plugin: workspace directory is not set');
  }

  const pluginDir = pluginDirFor(name);
  fenceWithinNodeModules(pluginDir);

  const pluginPkgPath = resolve(pluginDir, 'package.json');
  if (!existsSync(pluginPkgPath)) {
    throw new Error(`Plugin "${name}" is not installed (no package.json at ${pluginPkgPath})`);
  }
  const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf-8'));
  const entryPoint = resolveEntryPoint(pluginPkg);
  if (!entryPoint) {
    throw new Error(
      `Plugin "${name}" has no resolvable entry point (package.json must declare "main" or an "exports" import/default condition).`
    );
  }
  const modulePath = resolve(pluginDir, entryPoint);

  // B2: Validate the resolved entry point is within the plugin directory to
  // prevent a malicious plugin's "main" field from escaping (e.g. "../../../evil.js").
  if (!isPathWithin(modulePath, pluginDir)) {
    throw new Error(
      `Plugin "${name}" entry point "${entryPoint}" resolves outside its package directory. Refusing to load.`
    );
  }

  const stagedPluginDir = stagePluginForImport(name, pluginDir);
  const stagedModulePath = resolve(stagedPluginDir, entryPoint);
  if (!isPathWithin(stagedModulePath, stagedPluginDir)) {
    throw new Error(
      `Plugin "${name}" entry point "${entryPoint}" resolves outside its staged package directory. Refusing to load.`
    );
  }
  const fileUrl = pathToFileURL(stagedModulePath).href;

  // R11: race the dynamic import against a hard timeout so a plugin with a
  // top-level infinite loop / pending fetch can't wedge the loader. The
  // orphaned import keeps running on the event loop after we throw — there
  // is no way to cancel it from outside without worker_threads — but the
  // route handler unblocks and returns a useful error to the user.
  const mod = await importWithTimeout<{
    pluginCategory?: unknown;
    pluginType?: unknown;
    default?: unknown;
  }>(fileUrl, PLUGIN_IMPORT_TIMEOUT_MS, name, (url) => import(url));

  if (!mod.pluginCategory || !mod.pluginType || !mod.default) {
    throw new Error(`Plugin "${name}" must export pluginCategory, pluginType, and default`);
  }
  // SDK validates the category, type, and contract — let it throw on bad shapes.
  const category = mod.pluginCategory as PluginCategory;
  const type = String(mod.pluginType);
  const handler = mod.default as DriverPlugin | TriggerPlugin | CompletionPlugin | MiddlewarePlugin;
  const result = registerPlugin(category, type, handler);
  const meta: LoadedPluginMeta = { category, type };
  loadedPluginMeta.set(name, meta);
  return { result, meta };
}

/** Read/write .tagma/plugins.json — the persistent manifest of installed plugins */
export function readPluginManifest(): string[] {
  try {
    const p = resolve(S.workDir, '.tagma', 'plugins.json');
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(parsed)) {
      console.error(`[plugins] manifest at ${p} is not an array; ignoring`);
      return [];
    }
    // Drop any entry that wouldn't survive name validation — keeps a bad
    // manifest from re-introducing a path-traversal payload on every open.
    return parsed.filter((n): n is string => isValidPluginName(n));
  } catch (err) {
    console.error('[plugins] failed to read .tagma/plugins.json:', err);
    return [];
  }
}

export function writePluginManifest(names: string[]): void {
  const dir = resolve(S.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'plugins.json'), JSON.stringify(names, null, 2), 'utf-8');
}

export function addToPluginManifest(name: string): void {
  const list = readPluginManifest();
  if (!list.includes(name)) {
    list.push(name);
    writePluginManifest(list);
  }
}

export function removeFromPluginManifest(name: string): void {
  const list = readPluginManifest();
  const filtered = list.filter((n) => n !== name);
  if (filtered.length !== list.length) {
    writePluginManifest(filtered);
  }
}

/**
 * Persistent user-uninstall blocklist (.tagma/plugin-blocklist.json).
 *
 * Problem this solves: autoLoadInstalledPlugins() reads *declared* plugins
 * from every workspace YAML plus `ensureDriverPlugins` auto-adds
 * `@tagma/driver-<name>` whenever a task references a driver. If the user
 * explicitly uninstalled one of those plugins and the workspace setting
 * `autoInstallDeclaredPlugins` is on, the next pipeline switch would silently
 * re-install it — the user's explicit action would be overridden by the
 * YAML declaration.
 *
 * The blocklist tracks "plugins the user intentionally removed". Auto-install
 * skips any name in the list. An explicit Install action via the UI (or a
 * manual re-import) clears the entry, so flipping the decision is just one
 * click — there's no hidden stuck state.
 *
 * This is NOT a security gate. A pipeline that references a blocked plugin
 * still fails at run time with the SDK's "not registered" error; the
 * blocklist only affects auto-install, not manual install / run.
 */
function blocklistPath(): string {
  return resolve(S.workDir, '.tagma', 'plugin-blocklist.json');
}

export function readPluginBlocklist(): string[] {
  if (!S.workDir) return [];
  try {
    const p = blocklistPath();
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => isValidPluginName(n));
  } catch {
    return [];
  }
}

function writePluginBlocklist(names: string[]): void {
  if (!S.workDir) return;
  const dir = resolve(S.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  writeFileSync(blocklistPath(), JSON.stringify(names, null, 2), 'utf-8');
}

export function addToPluginBlocklist(name: string): void {
  const list = readPluginBlocklist();
  if (!list.includes(name)) {
    list.push(name);
    writePluginBlocklist(list);
  }
}

export function removeFromPluginBlocklist(name: string): void {
  const list = readPluginBlocklist();
  const filtered = list.filter((n) => n !== name);
  if (filtered.length !== list.length) {
    writePluginBlocklist(filtered);
  }
}

export function isPluginBlocked(name: string): boolean {
  return readPluginBlocklist().includes(name);
}

/**
 * Editor settings: per-workspace user preferences that don't belong in the
 * pipeline YAML (which is meant to be portable / committable). Stored in
 * `.tagma/editor-settings.json` next to plugins.json. Unknown keys are
 * preserved on write so a newer editor can roundtrip an older client's file.
 */
export interface EditorSettings {
  /**
   * When true, opening a workspace will auto-install plugins that are
   * declared in the pipeline YAML's `plugins` array but not yet present in
   * `node_modules`. When false (default), declared-but-missing plugins are
   * skipped and the user must install them manually via the Plugins panel.
   *
   * Trade-off: convenient for trusted personal workspaces, but auto-pulling
   * arbitrary npm packages on YAML open is a security smell — that's why
   * the default is off.
   */
  autoInstallDeclaredPlugins: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autoInstallDeclaredPlugins: false,
};

function editorSettingsPath(): string {
  return resolve(S.workDir, '.tagma', 'editor-settings.json');
}

export function readEditorSettings(): EditorSettings {
  if (!S.workDir) return { ...DEFAULT_EDITOR_SETTINGS };
  try {
    const p = editorSettingsPath();
    if (!existsSync(p)) return { ...DEFAULT_EDITOR_SETTINGS };
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[editor-settings] ${p} is not an object; using defaults`);
      return { ...DEFAULT_EDITOR_SETTINGS };
    }
    const raw = parsed as Record<string, unknown>;
    return {
      autoInstallDeclaredPlugins:
        typeof raw.autoInstallDeclaredPlugins === 'boolean'
          ? raw.autoInstallDeclaredPlugins
          : DEFAULT_EDITOR_SETTINGS.autoInstallDeclaredPlugins,
    };
  } catch (err) {
    console.error('[editor-settings] failed to read .tagma/editor-settings.json:', err);
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

export function writeEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  if (!S.workDir) throw new Error('Set a working directory first');
  const dir = resolve(S.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  const p = editorSettingsPath();
  // Preserve unknown keys so a newer editor's settings survive a round-trip
  // through an older client.
  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch { /* ignore — overwrite a corrupt file */ }
  }
  const next: Record<string, unknown> = { ...existing };
  if (patch.autoInstallDeclaredPlugins !== undefined) {
    next.autoInstallDeclaredPlugins = patch.autoInstallDeclaredPlugins;
  }
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8');
  return readEditorSettings();
}

/**
 * Discover installed tagma plugin packages under workDir/node_modules.
 *
 * A package is a plugin iff its `package.json` declares the `tagmaPlugin`
 * field (parsed via `parsePluginManifestField` from @tagma/sdk). That field
 * is the single source of truth — no name regex, no `@tagma/types` dep
 * sniffing. SDK-adjacent libraries like `@tagma/sdk`, `@tagma/types`, or
 * non-plugin packages under the `@tagma/*` scope simply don't declare it, so
 * they're never picked up.
 *
 * Reading only `package.json` (no `import()`) keeps discovery fast and avoids
 * executing top-level side effects of unverified packages.
 *
 * Names are still gated by `isValidPluginName` for filesystem safety —
 * anyone who can edit package.json could plant a path-traversal name, so
 * we drop anything that wouldn't survive the SDK's own loadPlugins guard.
 */
// M6: Cache plugin discovery results. The cache is invalidated by the file
// watcher whenever node_modules or .tagma/ changes, plus a TTL safety net.
let installedPluginsCache: string[] | null = null;
let installedPluginsCacheTime = 0;
const PLUGIN_CACHE_TTL_MS = 5_000;

export function invalidatePluginCache(): void {
  installedPluginsCache = null;
  installedPluginsCacheTime = 0;
  workspaceDeclaredPluginsCache = null;
  workspaceDeclaredPluginsCacheTime = 0;
}

export function discoverInstalledPlugins(): string[] {
  if (!S.workDir) return [];
  const now = Date.now();
  if (installedPluginsCache !== null && now - installedPluginsCacheTime < PLUGIN_CACHE_TTL_MS) {
    return installedPluginsCache;
  }
  const pkgPath = resolve(S.workDir, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const plugins: string[] = [];
    for (const name of Object.keys(allDeps)) {
      if (!isValidPluginName(name)) continue;
      try {
        const depPkgPath = resolve(pluginDirFor(name), 'package.json');
        if (!existsSync(depPkgPath)) continue;
        const depPkg = JSON.parse(readFileSync(depPkgPath, 'utf-8'));
        // A throwing parse means the package shipped a malformed
        // tagmaPlugin field — log it loud so the author can fix it,
        // then skip rather than crashing the whole discovery sweep.
        let manifest;
        try {
          manifest = parsePluginManifestField(depPkg);
        } catch (err) {
          console.warn(
            `[plugins] "${name}" has an invalid tagmaPlugin field, skipping:`,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
        if (manifest) plugins.push(name);
      } catch { /* skip unreadable packages */ }
    }
    installedPluginsCache = plugins;
    installedPluginsCacheTime = now;
    return plugins;
  } catch {
    return [];
  }
}

/**
 * Workspace-wide declared-plugin scanner: walks every YAML in `.tagma/`,
 * leniently parses each, and unions their `pipeline.plugins[]` arrays.
 *
 * This is the source of truth for "what plugins does this workspace need" —
 * intentionally NOT tied to the in-memory `config`, so opening the workspace
 * (or clicking Apply) installs plugins for every pipeline in the workspace,
 * not just the one the user happens to be looking at.
 *
 * Malformed YAMLs are silently skipped; we don't want one broken file to
 * block the install sweep for the rest of the workspace.
 */
// M6: Cache workspace-declared plugins alongside the installed-plugins cache.
let workspaceDeclaredPluginsCache: string[] | null = null;
let workspaceDeclaredPluginsCacheTime = 0;

export function discoverWorkspaceDeclaredPlugins(): string[] {
  if (!S.workDir) return [];
  const now = Date.now();
  if (workspaceDeclaredPluginsCache !== null && now - workspaceDeclaredPluginsCacheTime < PLUGIN_CACHE_TTL_MS) {
    return workspaceDeclaredPluginsCache;
  }
  const tagmaDir = resolve(S.workDir, '.tagma');
  if (!existsSync(tagmaDir)) return [];
  const seen = new Set<string>();
  let entries;
  try {
    entries = readdirSync(tagmaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const absPath = resolve(tagmaDir, entry.name);
    try {
      const doc = yaml.load(readFileSync(absPath, 'utf-8')) as
        | { pipeline?: { plugins?: unknown }; plugins?: unknown }
        | null
        | undefined;
      // Accept both `pipeline.plugins` (canonical) and a top-level `plugins`
      // (some hand-written YAMLs use the flat shape).
      const list =
        (doc && typeof doc === 'object' && doc.pipeline && typeof doc.pipeline === 'object'
          ? (doc.pipeline as { plugins?: unknown }).plugins
          : undefined) ??
        (doc && typeof doc === 'object' ? (doc as { plugins?: unknown }).plugins : undefined);
      if (Array.isArray(list)) {
        for (const name of list) {
          if (typeof name === 'string' && isValidPluginName(name)) {
            seen.add(name);
          }
        }
      }
    } catch (err) {
      console.warn(
        `[plugins] skipping malformed YAML "${entry.name}" while scanning declared plugins:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  workspaceDeclaredPluginsCache = [...seen];
  workspaceDeclaredPluginsCacheTime = now;
  return workspaceDeclaredPluginsCache;
}

/**
 * Auto-load all installed plugins into the registry.
 * Sources: node_modules scan + manifest + workspace YAML scan + in-memory config.plugins.
 * Skips already-loaded plugins. Errors are recorded in `lastAutoLoadErrors`
 * so the UI can surface them via /api/plugins instead of dropping silently.
 *
 * When the workspace's editor settings opt into `autoInstallDeclaredPlugins`,
 * any plugin that is declared anywhere in the workspace's YAMLs but missing
 * from node_modules is fetched from the npm registry first, then loaded.
 * Plugins that aren't declared (only present in the manifest or discovered on
 * disk) are never installed — this keeps the auto-install scope tied to the
 * workspace's YAMLs, not arbitrary on-disk packages.
 */
export async function autoLoadInstalledPlugins(): Promise<string[]> {
  const manifest = readPluginManifest();
  const declaredFromConfig = (S.config.plugins ?? []).filter(isValidPluginName);
  const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins();
  const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];
  const declaredSet = new Set(declared);
  const discovered = discoverInstalledPlugins();
  const candidates = [...new Set([...discovered, ...manifest, ...declared])];
  const settings = readEditorSettings();
  // User-uninstalled deny list — honored for BOTH install and load so a
  // pipeline switch never resurrects a plugin the user just removed.
  // Loading an on-disk blocked plugin is also skipped so dangling copies
  // from a sibling workspace don't quietly re-register handlers.
  const blocklist = new Set(readPluginBlocklist());
  const loaded: string[] = [];
  const errors: Array<{ name: string; message: string }> = [];
  for (const name of candidates) {
    if (loadedPlugins.has(name)) continue;
    if (!isValidPluginName(name)) {
      errors.push({ name, message: 'invalid plugin name' });
      continue;
    }
    if (blocklist.has(name)) continue;
    let info = getPluginInfo(name);
    if (!info.installed) {
      // Only auto-install plugins that are explicitly declared in the YAML —
      // the manifest/discovered sources can carry stale entries from a
      // previous workspace state, and we don't want to silently re-pull them.
      if (!settings.autoInstallDeclaredPlugins || !declaredSet.has(name)) continue;
      try {
        await installPackage(name);
        addToPluginManifest(name);
        info = getPluginInfo(name);
        if (!info.installed) {
          errors.push({ name, message: 'install completed but plugin still not on disk' });
          continue;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Failed to auto-install plugin "${name}":`, msg);
        errors.push({ name, message: `auto-install failed: ${msg}` });
        continue;
      }
    }
    try {
      await loadPluginFromWorkDir(name);
      loaded.push(name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Failed to load plugin "${name}":`, msg);
      errors.push({ name, message: msg });
    }
  }
  lastAutoLoadErrors = errors;
  return loaded;
}

/**
 * Map a server-side error onto a coarse error kind so the client can render a
 * localized hint without scraping English substrings out of the message body.
 * Keeps the wire format symmetric with PluginManager.classifyError.
 */
export type PluginErrorKind = 'network' | 'permission' | 'version' | 'notfound' | 'invalid' | 'unknown';

export function classifyServerError(err: unknown): { message: string; kind: PluginErrorKind } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PluginSafetyError) return { message, kind: 'invalid' };
  const m = message.toLowerCase();
  if (m.includes('integrity') || m.includes('shasum')) return { message, kind: 'version' };
  if (m.includes('enotfound') || m.includes('etimedout') || m.includes('econnrefused') || m.includes('fetch failed') || m.includes('aborted') || m.includes('network')) return { message, kind: 'network' };
  if (m.includes('eacces') || m.includes('eperm') || m.includes('permission denied')) return { message, kind: 'permission' };
  if (m.includes('etarget') || m.includes('eresolve') || m.includes('peer dep')) return { message, kind: 'version' };
  if (m.includes('not found') || m.includes('e404') || m.includes('404')) return { message, kind: 'notfound' };
  return { message, kind: 'unknown' };
}

export function pluginErrorResponse(err: unknown, action: string) {
  const { message, kind } = classifyServerError(err);
  return { error: `${action} failed: ${message}`, kind };
}

/**
 * Resolve the (category, type) pair a plugin package owns, preferring the
 * runtime registration metadata and falling back to the package.json
 * `tagmaPlugin` field (which works for installed-but-unloaded plugins) and
 * then to the name-based convention inference.
 *
 * This is used by the uninstall-impact scan to decide which trigger /
 * completion / middleware `type` values in the workspace YAMLs would be
 * orphaned by removing this package.
 */
export function resolvePluginCategoryType(
  name: string,
): { category: PluginCategory; type: string } | null {
  const meta = loadedPluginMeta.get(name);
  if (meta) return { category: meta.category, type: meta.type };
  try {
    const pluginDir = pluginDirFor(name);
    fenceWithinNodeModules(pluginDir);
    const pkgPath = resolve(pluginDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const manifest = parsePluginManifestField(pkg);
      if (manifest) return { category: manifest.category, type: manifest.type };
    }
  } catch { /* fall through */ }
  return pluginCategoryFromName(name);
}

export interface UninstallImpactEntry {
  /** Workspace-relative YAML path, e.g. ".tagma/build.yaml". */
  file: string;
  /** Human-readable location within the file, e.g. "tracks[0].tasks[2].middlewares[0]". */
  location: string;
  /** The track id + optional task id pair, for UI grouping. */
  trackId: string;
  taskId: string | null;
}

function extractTracks(doc: unknown): unknown[] | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  // Accept both `pipeline.tracks` (canonical) and top-level `tracks`
  // (legacy / flat shape), matching discoverWorkspaceDeclaredPlugins.
  const pipeline = d.pipeline;
  if (pipeline && typeof pipeline === 'object') {
    const t = (pipeline as Record<string, unknown>).tracks;
    if (Array.isArray(t)) return t;
  }
  if (Array.isArray(d.tracks)) return d.tracks;
  return null;
}

/**
 * Scan every .tagma/*.yaml in the workspace for task/track entries that
 * reference a given (category, type) pair. Used by the uninstall flow so
 * the UI can warn the user before leaving dangling references.
 *
 * Parsing is best-effort: malformed YAMLs are silently skipped (same
 * policy as `discoverWorkspaceDeclaredPlugins`). This is a confirmation
 * aid, not a gate — if a file fails to parse here it will also show up
 * as a parse error elsewhere in the UI.
 */
export function scanUninstallImpact(
  category: PluginCategory,
  type: string,
): UninstallImpactEntry[] {
  if (!S.workDir) return [];
  const tagmaDir = resolve(S.workDir, '.tagma');
  if (!existsSync(tagmaDir)) return [];
  const impacts: UninstallImpactEntry[] = [];
  let entries;
  try {
    entries = readdirSync(tagmaDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
    const absPath = resolve(tagmaDir, entry.name);
    let doc: unknown;
    try {
      doc = yaml.load(readFileSync(absPath, 'utf-8'));
    } catch {
      continue;
    }
    const relFile = `.tagma/${entry.name}`;
    const tracks = extractTracks(doc);
    if (!tracks) continue;

    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      if (!track || typeof track !== 'object') continue;
      const trackId = typeof (track as { id?: unknown }).id === 'string'
        ? (track as { id: string }).id
        : `tracks[${ti}]`;

      // Track-level middlewares
      if (category === 'middlewares') {
        const trackMws = (track as { middlewares?: unknown }).middlewares;
        if (Array.isArray(trackMws)) {
          trackMws.forEach((mw, mi) => {
            if (mw && typeof mw === 'object' && (mw as { type?: unknown }).type === type) {
              impacts.push({
                file: relFile,
                location: `tracks[${ti}].middlewares[${mi}]`,
                trackId,
                taskId: null,
              });
            }
          });
        }
      }

      const tasks = (track as { tasks?: unknown }).tasks;
      if (!Array.isArray(tasks)) continue;

      for (let ki = 0; ki < tasks.length; ki++) {
        const task = tasks[ki];
        if (!task || typeof task !== 'object') continue;
        const taskId = typeof (task as { id?: unknown }).id === 'string'
          ? (task as { id: string }).id
          : `tasks[${ki}]`;
        const taskObj = task as Record<string, unknown>;

        if (category === 'triggers') {
          const trig = taskObj.trigger;
          if (trig && typeof trig === 'object' && (trig as { type?: unknown }).type === type) {
            impacts.push({
              file: relFile,
              location: `tracks[${ti}].tasks[${ki}].trigger`,
              trackId,
              taskId,
            });
          }
        }
        if (category === 'completions') {
          const comp = taskObj.completion;
          if (comp && typeof comp === 'object' && (comp as { type?: unknown }).type === type) {
            impacts.push({
              file: relFile,
              location: `tracks[${ti}].tasks[${ki}].completion`,
              trackId,
              taskId,
            });
          }
        }
        if (category === 'middlewares') {
          const taskMws = taskObj.middlewares;
          if (Array.isArray(taskMws)) {
            taskMws.forEach((mw, mi) => {
              if (mw && typeof mw === 'object' && (mw as { type?: unknown }).type === type) {
                impacts.push({
                  file: relFile,
                  location: `tracks[${ti}].tasks[${ki}].middlewares[${mi}]`,
                  trackId,
                  taskId,
                });
              }
            });
          }
        }
        // Drivers are referenced by name, not by a registered type key —
        // we skip driver-category scans here. Users uninstalling a driver
        // plugin still see the run-time "not registered" error.
      }
    }
  }

  return impacts;
}
