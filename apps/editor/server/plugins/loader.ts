import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  cpSync,
  lstatSync,
  rmSync,
  statSync,
} from 'node:fs';
import { resolve, join as joinPath, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  isValidPluginName,
  readPluginManifest as parsePluginManifestField,
  type PluginCategory,
  type RegisteredCapability,
  type TagmaPlugin,
  type RegisterResult,
} from '@tagma/sdk/plugins';
import {
  PluginSafetyError,
  assertSafePluginName,
  pluginCategoryFromName,
} from '../plugin-safety.js';
import { enumeratePipelineYamls } from '../pipeline-paths.js';
import {
  isPathWithin,
  pluginStorePackageDirFor,
  safePluginStoreDirFor,
  safePluginStoreRoot,
  fenceWithinPluginStore,
} from '../state.js';
import type { WorkspaceState, LoadedPluginMeta } from '../workspace-state.js';
import {
  discardPluginSnapshot,
  installPackageWithRollbackSnapshot,
  packageManagerEnv,
  resolveBunBinary,
  restorePluginStateAndResync,
} from './install.js';
import { loadPluginWorker } from './worker-runtime.js';
import { atomicWriteFileSync, readContainedTextFileSync } from '../path-utils.js';
import {
  clampChatPipelineRepairAttempts,
  DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS,
  isValidChatPipelineRepairAttempts,
} from '../../shared/chat-pipeline-repair-limit.js';

/**
 * Map of plugin package name → which (category, type) pair it occupies in the
 * workspace's registry. The map itself lives on the `WorkspaceState` so two
 * windows bound to different workspaces can install / unload / upgrade the
 * same plugin package name without stepping on each other.
 *
 * Code reload: `stagePluginForImport` copies the plugin into a timestamped
 * directory under `.tagma/plugin-runtime/<name>/<ts>/` and imports from that
 * URL. Because each load gets a unique URL, the ESM cache miss forces a
 * fresh module evaluation and the new handler replaces the old one in the
 * workspace's registry — no server restart required for upgrades.
 *
 * On success the previous staging dir is dropped from disk; on failure the
 * new (failed) staging dir is dropped and the previous one is kept so the
 * old handler keeps serving until the user retries the upgrade. The full
 * `<name>/` tree is wiped on uninstall via `cleanupPluginStageTree`.
 */
export type { LoadedPluginMeta } from '../workspace-state.js';

export function getLastAutoLoadErrors(
  ws: WorkspaceState,
): Array<{ name: string; message: string }> {
  return ws.lastAutoLoadErrors;
}

export interface PluginInfo {
  name: string;
  installed: boolean;
  loaded: boolean;
  version: string | null;
  description: string | null;
  categories: string[];
}

export function getPluginInfo(ws: WorkspaceState, name: string): PluginInfo {
  // H7: validate name BEFORE turning it into a filesystem path so an attacker
  // can't probe arbitrary on-disk paths via /api/plugins/info?name=../../...
  // For invalid names we return a non-installed stub; the route layer also
  // rejects with 400 on invalid input, but we belt-and-brace here too.
  if (!isValidPluginName(name)) {
    return {
      name,
      installed: false,
      loaded: false,
      version: null,
      description: null,
      categories: [],
    };
  }

  let installed = false;
  let version: string | null = null;
  let description: string | null = null;
  let manifestCategory: PluginCategory | null = null;
  try {
    safePluginStoreDirFor(ws, name);
    const pluginDir = pluginStorePackageDirFor(ws, name);
    fenceWithinPluginStore(ws, pluginDir);
    const pkgPath = resolve(pluginDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const manifest = assertStoredPluginPackage(pkg, name);
      installed = true;
      version = typeof pkg.version === 'string' ? pkg.version : null;
      description = typeof pkg.description === 'string' ? pkg.description : null;
      manifestCategory = manifest.category;
    }
  } catch (_err) {
    /* plugin dir missing or unreadable — treat as not installed */
  }

  const loaded = ws.loadedPluginMeta.has(name);

  // Category resolution order:
  //   1. runtime meta (loaded plugin) — authoritative
  //   2. tagmaPlugin field from package.json — works for installed-but-not-loaded
  //   3. name-based inference — legacy fallback
  // The prior implementation gated everything on hasHandler, which meant
  // installed-but-not-loaded plugins had no category and were filtered out
  // of LocalPanel's category tabs.
  const categories: string[] = [];
  const meta = ws.loadedPluginMeta.get(name);
  if (meta) {
    for (const registration of meta.registrations) {
      if (!categories.includes(registration.category)) categories.push(registration.category);
    }
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
 * capability registrations so the caller can record them in loadedPluginMeta
 * and later unregister them cleanly.
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
// R11: hard cap on plugin load time. Plugins are evaluated in an isolated
// worker so a hung top-level import can be timed out and terminated instead
// of wedging the sidecar process.
const PLUGIN_IMPORT_TIMEOUT_MS = 15_000;
const CAPABILITY_CATEGORIES = [
  'drivers',
  'triggers',
  'completions',
  'middlewares',
] as const satisfies readonly PluginCategory[];

type CapabilityRef = Pick<RegisteredCapability, 'category' | 'type'>;
type ParsedPluginManifest = NonNullable<ReturnType<typeof parsePluginManifestField>>;

function assertStoredPluginPackage(
  pkg: Record<string, unknown>,
  name: string,
): ParsedPluginManifest {
  if (pkg.name !== name) {
    throw new Error(
      `Package identity mismatch: expected "${name}", got ${JSON.stringify(pkg.name)}`,
    );
  }
  const manifest = parsePluginManifestField(pkg);
  if (!manifest) {
    throw new Error(
      `Package "${name}" is not a tagma plugin (missing tagmaPlugin manifest in package.json)`,
    );
  }
  return manifest;
}

export interface LoadPluginOptions {
  methodTimeoutMs?: number;
}

function capabilityKey(category: PluginCategory, type: string): string {
  return `${category}/${type}`;
}

function extractDeclaredCapabilities(plugin: TagmaPlugin, name: string): CapabilityRef[] {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Plugin "${name}" must default-export a TagmaPlugin`);
  }
  const capabilities = plugin.capabilities as Record<string, unknown> | undefined;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error(`TagmaPlugin "${plugin.name ?? name}" must declare capabilities`);
  }
  const declared: CapabilityRef[] = [];
  for (const category of CAPABILITY_CATEGORIES) {
    const handlers = capabilities[category];
    if (handlers === undefined) continue;
    if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
      throw new Error(
        `TagmaPlugin "${plugin.name ?? name}" capabilities.${category} must be an object map`,
      );
    }
    for (const type of Object.keys(handlers)) {
      declared.push({ category, type });
    }
  }
  if (declared.length === 0) {
    throw new Error(
      `TagmaPlugin "${plugin.name ?? name}" must declare at least one supported capability`,
    );
  }
  return declared;
}

function assertPluginCapabilityOwners(
  ws: WorkspaceState,
  name: string,
  declared: readonly CapabilityRef[],
): void {
  const previous = new Set(
    (ws.loadedPluginMeta.get(name)?.registrations ?? []).map((registration) =>
      capabilityKey(registration.category, registration.type),
    ),
  );
  for (const registration of declared) {
    const key = capabilityKey(registration.category, registration.type);
    const owner = ws.pluginCapabilityOwners.get(key);
    if (owner && owner !== name) {
      throw new Error(
        `Plugin "${name}" cannot register capability "${key}"; it is already owned by "${owner}".`,
      );
    }
    if (
      !owner &&
      ws.registry.hasHandler(registration.category, registration.type) &&
      !previous.has(key)
    ) {
      throw new Error(
        `Plugin "${name}" cannot register capability "${key}"; it is already registered by built-ins or an unmanaged handler.`,
      );
    }
  }
}

function applyCapabilityOwners(
  ws: WorkspaceState,
  name: string,
  registrations: readonly CapabilityRef[],
): void {
  for (const registration of registrations) {
    ws.pluginCapabilityOwners.set(capabilityKey(registration.category, registration.type), name);
  }
}

function removeCapabilityOwners(
  ws: WorkspaceState,
  name: string,
  registrations: readonly CapabilityRef[],
): void {
  for (const registration of registrations) {
    const key = capabilityKey(registration.category, registration.type);
    if (ws.pluginCapabilityOwners.get(key) === name) {
      ws.pluginCapabilityOwners.delete(key);
    }
  }
}

function removePluginStageDir(ws: WorkspaceState, name: string, stageDir: string): void {
  if (!ws.workDir) return;
  try {
    assertSafePluginName(name);
  } catch {
    return;
  }
  const safeName = name.replace(/[\\/]/g, '__');
  const packageStageRoot = resolve(ws.workDir, '.tagma', 'plugin-runtime', safeName);
  const resolvedStageDir = resolve(stageDir);
  if (resolvedStageDir === packageStageRoot || !isPathWithin(resolvedStageDir, packageStageRoot)) {
    return;
  }
  try {
    assertSafeStagingAncestors(
      ws.workDir,
      ['.tagma', 'plugin-runtime', safeName],
      `Plugin "${name}"`,
    );
    const stageStat = lstatSync(resolvedStageDir);
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) return;
    rmSync(resolvedStageDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

export function unloadPluginFromRegistry(
  ws: WorkspaceState,
  name: string,
  options: { removeStageDir?: boolean } = {},
): boolean {
  const meta = ws.loadedPluginMeta.get(name);
  if (!meta) return false;
  for (const registration of meta.registrations) {
    ws.registry.unregisterPlugin(registration.category, registration.type);
  }
  removeCapabilityOwners(ws, name, meta.registrations);
  ws.loadedPluginMeta.delete(name);
  try {
    meta.worker?.terminate();
  } catch {
    /* best-effort */
  }
  if (options.removeStageDir && meta.stageDir) {
    removePluginStageDir(ws, name, meta.stageDir);
  }
  return true;
}

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

/**
 * Reject unsafe filesystem entries in `dir` recursively before staging a
 * plugin package. The runtime imports from the staged copy, so keeping links
 * and device files out of both installed and locally-imported packages keeps
 * the execution boundary explicit.
 */
export function assertNoSymlinksInDir(dir: string, label: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist or can't be read — let cpSync handle the error
  }
  for (const entry of entries) {
    const fullPath = joinPath(dir, entry);
    const entryLabel = `${label}: entry "${entry}"`;
    try {
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new PluginSafetyError(
          `${entryLabel} is a symbolic link. Symbolic links in plugin packages are not allowed.`,
        );
      }
      if (stat.isDirectory()) {
        assertNoSymlinksInDir(fullPath, entryLabel);
        continue;
      }
      if (!stat.isFile()) {
        throw new PluginSafetyError(
          `${entryLabel} is not a regular file or directory. Plugin packages may not contain device files, sockets, or other special entries.`,
        );
      }
      if (stat.nlink > 1) {
        throw new PluginSafetyError(
          `${entryLabel} is a hard link. Hard links in plugin packages are not allowed.`,
        );
      }
    } catch (err) {
      if (err instanceof PluginSafetyError) throw err;
      // ENOENT or other stat error — skip (race condition on fast delete)
    }
  }
}

/**
 * Walk a chain of directories from `root` and verify that each existing
 * component is a real directory rather than a symbolic link. `isPathWithin`
 * resolves symlinks in the *child* path, but it can't witness whether the
 * root chain itself was tampered with — if `<workDir>/.tagma` (or any
 * intermediate component) is pre-planted as a symlink to a path outside the
 * workspace, `mkdirSync({recursive:true})` and `cpSync` will happily traverse
 * it, landing files outside the workspace fence.
 *
 * We do not require the components to already exist — missing parents will be
 * created by `mkdirSync` below. We only refuse when an existing component is
 * a symlink or a non-directory.
 */
function assertSafeStagingAncestors(root: string, components: string[], label: string): void {
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      // Doesn't exist — mkdirSync will create it as a real directory.
      return;
    }
    if (st.isSymbolicLink()) {
      throw new PluginSafetyError(
        `${label}: refused to stage under "${current}" because the path is a symlink. ` +
          `The plugin runtime staging tree must consist of real directories only.`,
      );
    }
    if (!st.isDirectory()) {
      throw new PluginSafetyError(
        `${label}: refused to stage under "${current}" because the path is not a directory.`,
      );
    }
  }
}

function packageDirInStoreRoot(storeRoot: string, name: string): string {
  const parts = name.startsWith('@') ? name.split('/') : [name];
  return resolve(storeRoot, 'node_modules', ...parts);
}

function isRunningFromBunExecutable(): boolean {
  const execPath = process.execPath.replace(/\\/g, '/').toLowerCase();
  return execPath.endsWith('/bun') || execPath.endsWith('/bun.exe');
}

async function bundleStagedPluginEntryForImport(
  stagedRoot: string,
  stagedModulePath: string,
  name: string,
): Promise<string> {
  const bundleDir = resolve(stagedRoot, '.tagma-plugin-bundle');
  mkdirSync(bundleDir, { recursive: true });
  const bundlePath = resolve(bundleDir, 'plugin.mjs');
  const bun = resolveBunBinary();
  const proc = Bun.spawn(
    [bun, 'build', stagedModulePath, '--target=bun', '--format=esm', '--outfile', bundlePath],
    {
      cwd: stagedRoot,
      env: packageManagerEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0 || !existsSync(bundlePath)) {
    const detail = stderr.trim() || stdout.trim() || `bun build exited with code ${exitCode}`;
    throw new Error(`Plugin "${name}" failed to bundle for packaged runtime: ${detail}`);
  }
  return bundlePath;
}

function stagePluginForImport(ws: WorkspaceState, name: string, storeRoot: string): string {
  if (!ws.workDir) {
    throw new PluginSafetyError('Cannot stage plugin: workspace directory is not set');
  }
  const safeName = name.replace(/[\\/]/g, '__');
  // Walk the ancestor chain BEFORE mkdirSync so a pre-planted symlink at any
  // level (.tagma, plugin-runtime, <safeName>) is rejected instead of being
  // silently traversed.
  assertSafeStagingAncestors(
    ws.workDir,
    ['.tagma', 'plugin-runtime', safeName],
    `Plugin "${name}"`,
  );
  const packageStageRoot = resolve(ws.workDir, '.tagma', 'plugin-runtime', safeName);

  // D3 (TOCTOU fix): Do NOT rmSync the whole packageStageRoot before creating
  // the new timestamped sub-directory. A concurrent second load of the same
  // plugin might be mid-import() of a sibling staging dir; blowing up the root
  // deletes the files it still needs, producing ENOENT during ESM lazy reads.
  // Instead, each staging call gets its own unique sub-directory; old ones are
  // cleaned up lazily by unregisterPlugin / rollback paths.
  const stageDir = resolve(
    packageStageRoot,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(stageDir, { recursive: true });

  const pluginDir = packageDirInStoreRoot(storeRoot, name);
  assertNoSymlinksInDir(pluginDir, `Plugin "${name}"`);
  cpSync(storeRoot, stageDir, { recursive: true, dereference: false });
  return stageDir;
}

export async function loadPluginFromWorkDir(
  ws: WorkspaceState,
  name: string,
  options: LoadPluginOptions = {},
): Promise<{
  result: RegisterResult;
  registrations: readonly RegisteredCapability[];
  meta: LoadedPluginMeta;
}> {
  assertSafePluginName(name);
  if (!ws.workDir) {
    throw new PluginSafetyError('Cannot load plugin: workspace directory is not set');
  }

  const storeRoot = safePluginStoreDirFor(ws, name);
  const pluginDir = pluginStorePackageDirFor(ws, name);
  fenceWithinPluginStore(ws, pluginDir);

  const pluginPkgPath = resolve(pluginDir, 'package.json');
  if (!existsSync(pluginPkgPath)) {
    throw new Error(`Plugin "${name}" is not installed (no package.json at ${pluginPkgPath})`);
  }
  const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf-8')) as Record<string, unknown>;
  const manifest = assertStoredPluginPackage(pluginPkg, name);
  const fallbackManifest = {
    packageName: name,
    category: manifest.category,
    type: manifest.type,
  };
  const entryPoint = resolveEntryPoint(pluginPkg);
  if (!entryPoint) {
    throw new Error(
      `Plugin "${name}" has no resolvable entry point (package.json must declare "main" or an "exports" import/default condition).`,
    );
  }
  const modulePath = resolve(pluginDir, entryPoint);

  // B2: Validate the resolved entry point is within the plugin directory to
  // prevent a malicious plugin's "main" field from escaping (e.g. "../../../evil.js").
  if (!isPathWithin(modulePath, pluginDir)) {
    throw new Error(
      `Plugin "${name}" entry point "${entryPoint}" resolves outside its package directory. Refusing to load.`,
    );
  }

  // Remember the previously-staged copy (if this is a reload/upgrade) so we
  // can delete it *after* the new load succeeds. Doing it after, not before,
  // means a failed upgrade leaves the old working staging dir untouched and
  // the old handler keeps serving Run requests until the user retries.
  const previousMeta = ws.loadedPluginMeta.get(name);
  const previousStageDir = previousMeta?.stageDir;

  const stagedRoot = stagePluginForImport(ws, name, storeRoot);
  const stagedPluginDir = packageDirInStoreRoot(stagedRoot, name);
  let worker: Awaited<ReturnType<typeof loadPluginWorker>> | null = null;
  try {
    const stagedModulePath = resolve(stagedPluginDir, entryPoint);
    if (!isPathWithin(stagedModulePath, stagedPluginDir)) {
      throw new Error(
        `Plugin "${name}" entry point "${entryPoint}" resolves outside its staged package directory. Refusing to load.`,
      );
    }
    const importModulePath = isRunningFromBunExecutable()
      ? stagedModulePath
      : await bundleStagedPluginEntryForImport(stagedRoot, stagedModulePath, name);
    const fileUrl = pathToFileURL(importModulePath).href;
    const importRootUrl = pathToFileURL(stagedRoot).href;

    // R11: evaluate plugin code outside the sidecar isolate. A hung import or
    // long-running capability call terminates the worker instead of pinning
    // the server's event loop.
    //
    // Identity-guarded callback: an upgrade replaces ws.loadedPluginMeta.set
    // before terminating the previous worker. If the previous worker crashes
    // in that window (worker.onerror → terminate(err, true)), its
    // onUnexpectedTerminate would otherwise unload the *new* plugin from the
    // registry. Closing over `thisWorker` and comparing against the live meta
    // makes a stale callback a no-op.
    let thisWorker: Awaited<ReturnType<typeof loadPluginWorker>> | null = null;
    worker = await loadPluginWorker(fileUrl, PLUGIN_IMPORT_TIMEOUT_MS, fallbackManifest, {
      importRootUrl,
      methodTimeoutMs: options.methodTimeoutMs,
      onUnexpectedTerminate: () => {
        const liveMeta = ws.loadedPluginMeta.get(name);
        if (!liveMeta || liveMeta.worker !== thisWorker) {
          // Either we never reached the meta.set line (load failed early —
          // the catch below handles cleanup), or this worker has already
          // been displaced by a newer one. Either way, do not touch the
          // registry: the live entry is not ours to evict.
          return;
        }
        unloadPluginFromRegistry(ws, name, { removeStageDir: false });
      },
    });
    thisWorker = worker;
    const plugin = worker.plugin;
    const declared = extractDeclaredCapabilities(plugin, name);
    assertPluginCapabilityOwners(ws, name, declared);

    // SDK validates capability names, handler contracts, and replacement semantics.
    // The workspace owner map above narrows hot replacement to capabilities this
    // package already owns; attempts to take over another package's type fail
    // before touching the registry.
    const registrations: RegisteredCapability[] = ws.registry.registerTagmaPlugin(plugin, {
      replace: previousMeta !== undefined,
    });
    const result: RegisterResult = registrations.some((r) => r.result === 'replaced')
      ? 'replaced'
      : registrations.every((r) => r.result === 'unchanged')
        ? 'unchanged'
        : 'registered';
    const nextKeys = new Set(
      registrations.map((registration) => capabilityKey(registration.category, registration.type)),
    );
    if (previousMeta) {
      for (const registration of previousMeta.registrations) {
        const key = capabilityKey(registration.category, registration.type);
        if (!nextKeys.has(key)) {
          ws.registry.unregisterPlugin(registration.category, registration.type);
          if (ws.pluginCapabilityOwners.get(key) === name) {
            ws.pluginCapabilityOwners.delete(key);
          }
        }
      }
    }
    const meta: LoadedPluginMeta = {
      registrations: registrations.map(({ category, type }) => ({ category, type })),
      stageDir: stagedRoot,
      worker,
    };
    applyCapabilityOwners(ws, name, meta.registrations);
    ws.loadedPluginMeta.set(name, meta);

    // Success: the new module is imported and the handler registered. The
    // previous staging dir (if any) is no longer referenced by the workspace
    // registry — drop it so the plugin-runtime tree doesn't grow unbounded
    // across successive upgrades. Best-effort; a stray lock or permission
    // glitch is harmless because the next uninstall cleans the whole tree.
    if (previousStageDir && previousStageDir !== stagedRoot) {
      removePluginStageDir(ws, name, previousStageDir);
    }
    try {
      previousMeta?.worker?.terminate();
    } catch {
      /* best-effort */
    }
    return { result, registrations, meta };
  } catch (err) {
    // Load failed after we created the new staging copy. Remove it so the
    // plugin-runtime/ tree doesn't accumulate orphans on every failed retry.
    // The previously-staged copy (for an already-loaded plugin) is kept
    // intact so its handler continues to serve Run.
    removePluginStageDir(ws, name, stagedRoot);
    try {
      worker?.terminate();
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

/**
 * Remove every staging copy under `.tagma/plugin-runtime/<safe-name>`.
 *
 * Called on uninstall so the plugin-runtime tree doesn't accumulate orphans
 * from past upgrade cycles or failed loads. Safe to call when the tree is
 * already absent or partially cleaned — the operation is best-effort.
 *
 * The caller MUST have validated `name` via `assertSafePluginName` (all the
 * route handlers do). We re-fence here so a future caller path that forgets
 * the check still can't escape the runtime staging roots.
 */
export function cleanupPluginStageTree(ws: WorkspaceState, name: string): void {
  if (!ws.workDir) return;
  assertSafePluginName(name);
  const safeName = name.replace(/[\\/]/g, '__');
  const runtimeRoots = [
    resolve(ws.workDir, '.tagma', 'plugin-runtime'),
    resolve(ws.workDir, 'node_modules', '.tagma-plugin-runtime'),
  ];
  for (const runtimeRoot of runtimeRoots) {
    const stageRoot = resolve(runtimeRoot, safeName);
    let runtimeStat;
    try {
      runtimeStat = lstatSync(runtimeRoot);
    } catch {
      continue;
    }
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) continue;
    let stageStat;
    try {
      stageStat = lstatSync(stageRoot);
    } catch {
      continue;
    }
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) continue;
    if (!isPathWithin(stageRoot, runtimeRoot)) continue;
    try {
      rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Read/write .tagma/plugins.json — the persistent manifest of installed plugins */
export function readPluginManifest(ws: WorkspaceState): string[] {
  try {
    const tagmaDir = resolve(ws.workDir, '.tagma');
    const p = resolve(tagmaDir, 'plugins.json');
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readContainedTextFileSync(tagmaDir, p, '.tagma/plugins.json'));
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

export function writePluginManifest(ws: WorkspaceState, names: string[]): void {
  const dir = resolve(ws.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(resolve(dir, 'plugins.json'), JSON.stringify(names, null, 2) + '\n');
}

export function addToPluginManifest(ws: WorkspaceState, name: string): void {
  const list = readPluginManifest(ws);
  if (!list.includes(name)) {
    list.push(name);
    writePluginManifest(ws, list);
  }
}

export function removeFromPluginManifest(ws: WorkspaceState, name: string): void {
  const list = readPluginManifest(ws);
  const filtered = list.filter((n) => n !== name);
  if (filtered.length !== list.length) {
    writePluginManifest(ws, filtered);
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
function blocklistPath(ws: WorkspaceState): string {
  return resolve(ws.workDir, '.tagma', 'plugin-blocklist.json');
}

export function readPluginBlocklist(ws: WorkspaceState): string[] {
  if (!ws.workDir) return [];
  try {
    const p = blocklistPath(ws);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(
      readContainedTextFileSync(resolve(ws.workDir, '.tagma'), p, '.tagma/plugin-blocklist.json'),
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => isValidPluginName(n));
  } catch {
    return [];
  }
}

function writePluginBlocklist(ws: WorkspaceState, names: string[]): void {
  if (!ws.workDir) return;
  const dir = resolve(ws.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(blocklistPath(ws), JSON.stringify(names, null, 2) + '\n');
}

export function addToPluginBlocklist(ws: WorkspaceState, name: string): void {
  const list = readPluginBlocklist(ws);
  if (!list.includes(name)) {
    list.push(name);
    writePluginBlocklist(ws, list);
  }
}

export function removeFromPluginBlocklist(ws: WorkspaceState, name: string): void {
  const list = readPluginBlocklist(ws);
  const filtered = list.filter((n) => n !== name);
  if (filtered.length !== list.length) {
    writePluginBlocklist(ws, filtered);
  }
}

export function isPluginBlocked(ws: WorkspaceState, name: string): boolean {
  return readPluginBlocklist(ws).includes(name);
}

/**
 * Editor settings: per-workspace user preferences that don't belong in the
 * pipeline YAML (which is meant to be portable / committable). Stored in
 * `.tagma/editor-settings.json` next to plugins.json. Unknown keys are
 * preserved on write so a newer editor can roundtrip an older client's file.
 */
/**
 * What to do when the user has unsaved canvas edits *and* a chat-driven agent
 * writes the same YAML on disk during a chat turn. The server's file-watcher
 * detects the collision and emits `external-conflict`; the client consults
 * this setting to decide the resolution.
 *
 *   - 'ask'          — show a modal, let the user pick per-incident (default).
 *   - 'prefer-user'  — keep the user's canvas edits; the agent's disk version
 *                      gets overwritten on the next save.
 *   - 'prefer-agent' — silently adopt the agent's disk version; the user's
 *                      canvas edits are discarded. Matches the
 *                      pre-this-setting behavior.
 */
export type ChatDirtyConflictPolicy = 'ask' | 'prefer-user' | 'prefer-agent';

/** Narrow an arbitrary JSON value to the policy enum. Exported so the route
 *  handler can reject bogus payloads without duplicating the literal list. */
export function isValidChatDirtyConflictPolicy(v: unknown): v is ChatDirtyConflictPolicy {
  return v === 'ask' || v === 'prefer-user' || v === 'prefer-agent';
}

/**
 * Inspector view density. `debug` shows every field (inheritance hints,
 * dataflow editor, lifecycle hooks, etc.); `production` hides debug aids
 * and infrastructure plumbing for day-to-day pipeline operation.
 */
export type EditorViewMode = 'debug' | 'production';

export function isValidEditorViewMode(v: unknown): v is EditorViewMode {
  return v === 'debug' || v === 'production';
}

export interface PythonAgentSettings {
  enabled: boolean;
  interpreterCommand: string | null;
  interpreterArgs: string[];
  interpreterVersion: string | null;
  venvPath: string | null;
  configuredAt: string | null;
}

export const DEFAULT_PYTHON_AGENT_SETTINGS: PythonAgentSettings = {
  enabled: false,
  interpreterCommand: null,
  interpreterArgs: [],
  interpreterVersion: null,
  venvPath: null,
  configuredAt: null,
};

function cleanOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface OpenCodeChatModelSelection {
  providerID: string;
  modelID: string;
}

/**
 * OpenCode model variant id. Kept under the historical reasoning-effort
 * settings key for compatibility; `null` delegates to the model default.
 */
export type OpenCodeChatReasoningEffort = string | null;

export function parseOpenCodeChatModelSelection(value: unknown): OpenCodeChatModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const providerID = cleanOptionalString(raw.providerID);
  const modelID = cleanOptionalString(raw.modelID);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

export function isValidOpenCodeChatReasoningEffort(
  value: unknown,
): value is OpenCodeChatReasoningEffort {
  return (
    value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 256)
  );
}

export function parsePythonAgentSettings(value: unknown): PythonAgentSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') return null;
  const interpreterArgs =
    Array.isArray(raw.interpreterArgs) &&
    raw.interpreterArgs.every((arg) => typeof arg === 'string')
      ? raw.interpreterArgs
      : null;
  if (!interpreterArgs) return null;
  const venvPath = cleanOptionalString(raw.venvPath);
  if (venvPath && (venvPath.includes('..') || /^[a-zA-Z]:[\\/]/.test(venvPath))) return null;
  return {
    enabled: raw.enabled,
    interpreterCommand: cleanOptionalString(raw.interpreterCommand),
    interpreterArgs,
    interpreterVersion: cleanOptionalString(raw.interpreterVersion),
    venvPath,
    configuredAt: cleanOptionalString(raw.configuredAt),
  };
}

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
  /** Resolution strategy for dirty-canvas vs chat-driven-write conflicts. See
   *  the doc on ChatDirtyConflictPolicy above. */
  chatDirtyConflictPolicy: ChatDirtyConflictPolicy;
  /**
   * When true, the editor periodically writes the in-memory pipeline config
   * to its YAML file (the same path Ctrl+S uses). Default true.
   */
  autoSaveEnabled: boolean;
  /**
   * Interval between disk-autosave ticks, in seconds. Clamped to [5, 600].
   * Default 30.
   */
  autoSaveIntervalSec: number;
  /**
   * Inspector density. Default `production` — hides debug aids and
   * infrastructure plumbing across Track / Task / Pipeline inspectors.
   * Switch to `debug` to surface every field while building the pipeline.
   */
  viewMode: EditorViewMode;
  pythonAgent: PythonAgentSettings;
  opencodeChatModel: OpenCodeChatModelSelection | null;
  opencodeChatReasoningEffort: OpenCodeChatReasoningEffort;
  /**
   * When true (default), changed pipelines authored through OpenCode Chat are
   * trial-run in the real workspace after compiling and before finalization.
   */
  opencodeChatTrialRunEnabled: boolean;
  /**
   * Maximum hidden repair continuations shared by compile and trial-run
   * failures for one OpenCode Chat pipeline change. Default 25; range 0-50.
   * Zero disables automatic repair while preserving compile/trial evidence.
   */
  opencodeChatPipelineRepairMaxAttempts: number;
  /** Disabled means unlimited. Enabled with 0 rounds means stateless. */
  chatContextLimitEnabled: boolean;
  /**
   * Maximum number of conversation rounds (user+assistant turn pairs) kept
   * in the active opencode chat session. When the next `send()` would push
   * the count past this limit, the editor transparently creates a fresh
   * session before dispatching the prompt — keeping the model's effective
   * context window bounded without relying on opencode's internal
   * compaction (which is token-budget-driven and not round-aware).
   *
   * 0 means "unlimited" (no auto-new-session). Default 0.
   * Clamped to [0, 200] on write.
   */
  chatContextRounds: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  autoInstallDeclaredPlugins: false,
  chatDirtyConflictPolicy: 'ask',
  autoSaveEnabled: true,
  autoSaveIntervalSec: 30,
  viewMode: 'production',
  pythonAgent: DEFAULT_PYTHON_AGENT_SETTINGS,
  opencodeChatModel: null,
  opencodeChatReasoningEffort: null,
  opencodeChatTrialRunEnabled: true,
  opencodeChatPipelineRepairMaxAttempts: DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS,
  chatContextLimitEnabled: false,
  chatContextRounds: 0,
};

function editorSettingsPath(ws: WorkspaceState): string {
  return resolve(ws.workDir, '.tagma', 'editor-settings.json');
}

export function readEditorSettings(ws: WorkspaceState): EditorSettings {
  if (!ws.workDir) return { ...DEFAULT_EDITOR_SETTINGS };
  try {
    const p = editorSettingsPath(ws);
    if (!existsSync(p)) return { ...DEFAULT_EDITOR_SETTINGS };
    const parsed = JSON.parse(
      readContainedTextFileSync(resolve(ws.workDir, '.tagma'), p, '.tagma/editor-settings.json'),
    );
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
      chatDirtyConflictPolicy: isValidChatDirtyConflictPolicy(raw.chatDirtyConflictPolicy)
        ? raw.chatDirtyConflictPolicy
        : DEFAULT_EDITOR_SETTINGS.chatDirtyConflictPolicy,
      autoSaveEnabled:
        typeof raw.autoSaveEnabled === 'boolean'
          ? raw.autoSaveEnabled
          : DEFAULT_EDITOR_SETTINGS.autoSaveEnabled,
      autoSaveIntervalSec:
        typeof raw.autoSaveIntervalSec === 'number' &&
        Number.isInteger(raw.autoSaveIntervalSec) &&
        raw.autoSaveIntervalSec >= 5 &&
        raw.autoSaveIntervalSec <= 600
          ? raw.autoSaveIntervalSec
          : DEFAULT_EDITOR_SETTINGS.autoSaveIntervalSec,
      viewMode: isValidEditorViewMode(raw.viewMode)
        ? raw.viewMode
        : DEFAULT_EDITOR_SETTINGS.viewMode,
      pythonAgent: parsePythonAgentSettings(raw.pythonAgent) ?? DEFAULT_EDITOR_SETTINGS.pythonAgent,
      opencodeChatModel: parseOpenCodeChatModelSelection(raw.opencodeChatModel),
      opencodeChatReasoningEffort: isValidOpenCodeChatReasoningEffort(
        raw.opencodeChatReasoningEffort,
      )
        ? raw.opencodeChatReasoningEffort
        : DEFAULT_EDITOR_SETTINGS.opencodeChatReasoningEffort,
      opencodeChatTrialRunEnabled:
        typeof raw.opencodeChatTrialRunEnabled === 'boolean'
          ? raw.opencodeChatTrialRunEnabled
          : DEFAULT_EDITOR_SETTINGS.opencodeChatTrialRunEnabled,
      opencodeChatPipelineRepairMaxAttempts: isValidChatPipelineRepairAttempts(
        raw.opencodeChatPipelineRepairMaxAttempts,
      )
        ? raw.opencodeChatPipelineRepairMaxAttempts
        : DEFAULT_EDITOR_SETTINGS.opencodeChatPipelineRepairMaxAttempts,
      chatContextLimitEnabled:
        typeof raw.chatContextLimitEnabled === 'boolean'
          ? raw.chatContextLimitEnabled
          : DEFAULT_EDITOR_SETTINGS.chatContextLimitEnabled,
      chatContextRounds:
        typeof raw.chatContextRounds === 'number' &&
        Number.isInteger(raw.chatContextRounds) &&
        raw.chatContextRounds >= 0 &&
        raw.chatContextRounds <= 200
          ? raw.chatContextRounds
          : DEFAULT_EDITOR_SETTINGS.chatContextRounds,
    };
  } catch (err) {
    console.error('[editor-settings] failed to read .tagma/editor-settings.json:', err);
    return { ...DEFAULT_EDITOR_SETTINGS };
  }
}

export function writeEditorSettings(
  ws: WorkspaceState,
  patch: Partial<EditorSettings>,
): EditorSettings {
  if (!ws.workDir) throw new Error('Set a working directory first');
  const dir = resolve(ws.workDir, '.tagma');
  mkdirSync(dir, { recursive: true });
  const p = editorSettingsPath(ws);
  // Preserve unknown keys so a newer editor's settings survive a round-trip
  // through an older client.
  let existing: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readContainedTextFileSync(dir, p, '.tagma/editor-settings.json'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore — overwrite a corrupt file */
    }
  }
  const next: Record<string, unknown> = { ...existing };
  if (patch.autoInstallDeclaredPlugins !== undefined) {
    next.autoInstallDeclaredPlugins = patch.autoInstallDeclaredPlugins;
  }
  if (patch.chatDirtyConflictPolicy !== undefined) {
    next.chatDirtyConflictPolicy = patch.chatDirtyConflictPolicy;
  }
  if (patch.autoSaveEnabled !== undefined) {
    next.autoSaveEnabled = patch.autoSaveEnabled;
  }
  if (patch.autoSaveIntervalSec !== undefined) {
    // Truncate floats here so the value persisted on disk always satisfies
    // readEditorSettings's `Number.isInteger` guard on the next load.
    next.autoSaveIntervalSec = Math.max(5, Math.min(600, Math.trunc(patch.autoSaveIntervalSec)));
  }
  if (patch.viewMode !== undefined) {
    next.viewMode = patch.viewMode;
  }
  if (patch.pythonAgent !== undefined) {
    next.pythonAgent = patch.pythonAgent;
  }
  if (patch.opencodeChatModel !== undefined) {
    next.opencodeChatModel = patch.opencodeChatModel;
  }
  if (patch.opencodeChatReasoningEffort !== undefined) {
    next.opencodeChatReasoningEffort = patch.opencodeChatReasoningEffort;
  }
  if (patch.opencodeChatTrialRunEnabled !== undefined) {
    next.opencodeChatTrialRunEnabled = patch.opencodeChatTrialRunEnabled;
  }
  if (patch.opencodeChatPipelineRepairMaxAttempts !== undefined) {
    next.opencodeChatPipelineRepairMaxAttempts = clampChatPipelineRepairAttempts(
      patch.opencodeChatPipelineRepairMaxAttempts,
    );
  }
  if (patch.chatContextLimitEnabled !== undefined) {
    next.chatContextLimitEnabled = patch.chatContextLimitEnabled;
  }
  if (patch.chatContextRounds !== undefined) {
    next.chatContextRounds = Math.max(0, Math.min(200, Math.trunc(patch.chatContextRounds)));
  }
  atomicWriteFileSync(p, JSON.stringify(next, null, 2) + '\n');
  return readEditorSettings(ws);
}

/**
 * Discover installed tagma plugin packages under the isolated plugin store.
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
// watcher whenever the plugin store or .tagma/ changes, plus a TTL safety net.
const PLUGIN_CACHE_TTL_MS = 5_000;

export function invalidatePluginCache(ws: WorkspaceState): void {
  ws.installedPluginsCache = null;
  ws.installedPluginsCacheTime = 0;
  ws.workspaceDeclaredPluginsCache = null;
  ws.workspaceDeclaredPluginsCacheTime = 0;
}

export function discoverInstalledPlugins(ws: WorkspaceState): string[] {
  if (!ws.workDir) return [];
  const now = Date.now();
  if (
    ws.installedPluginsCache !== null &&
    now - ws.installedPluginsCacheTime < PLUGIN_CACHE_TTL_MS
  ) {
    return ws.installedPluginsCache;
  }
  const storeRoot = safePluginStoreRoot(ws);
  if (!existsSync(storeRoot)) return [];
  try {
    const plugins: string[] = [];
    for (const entry of readdirSync(storeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const installRoot = resolve(storeRoot, entry.name);
      if (!isPathWithin(installRoot, storeRoot)) continue;
      try {
        const storePkgPath = resolve(installRoot, 'package.json');
        if (!existsSync(storePkgPath)) continue;
        const storePkg = JSON.parse(readFileSync(storePkgPath, 'utf-8')) as {
          dependencies?: Record<string, string>;
        };
        const pluginNames = Object.keys(storePkg.dependencies ?? {}).filter(isValidPluginName);
        for (const name of pluginNames) {
          const depPkgPath = resolve(packageDirInStoreRoot(installRoot, name), 'package.json');
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
        }
      } catch {
        /* skip unreadable packages */
      }
    }
    ws.installedPluginsCache = plugins;
    ws.installedPluginsCacheTime = now;
    return plugins;
  } catch {
    return [];
  }
}

// Bounds for the workspace declared-plugin YAML scan. The scanner only
// extracts string plugin names, so even a small budget is plenty for any
// realistic .tagma/ layout. Caps protect every workspace-load path that calls
// `autoLoadInstalledPlugins`/`discoverWorkspaceDeclaredPlugins` from being
// stalled by a runaway YAML drop (e.g. a generated bundle, an accidental log
// dump renamed `.yaml`).
const MAX_DECLARED_PLUGIN_YAML_FILES = 64;
const MAX_DECLARED_PLUGIN_YAML_BYTES = 256 * 1024;

/**
 * Workspace-wide declared-plugin scanner: walks every YAML in `.tagma/`,
 * leniently parses each, and unions their `pipeline.plugins[]` arrays.
 *
 * This is the source of truth for "what plugins does this workspace need" —
 * intentionally NOT tied to the in-memory `config`, so opening the workspace
 * (or clicking Apply) installs plugins for every pipeline in the workspace,
 * not just the one the user happens to be looking at.
 *
 * Malformed or oversize YAMLs are skipped with a warning; we don't want one
 * broken file to block the install sweep for the rest of the workspace.
 */
export function discoverWorkspaceDeclaredPlugins(ws: WorkspaceState): string[] {
  if (!ws.workDir) return [];
  const now = Date.now();
  if (
    ws.workspaceDeclaredPluginsCache !== null &&
    now - ws.workspaceDeclaredPluginsCacheTime < PLUGIN_CACHE_TTL_MS
  ) {
    return ws.workspaceDeclaredPluginsCache;
  }
  // Pipeline YAMLs live at `.tagma/<stem>/<stem>.yaml`. enumeratePipelineYamls
  // skips reserved sibling directories (`logs`, `plugin-runtime`, …) so this
  // scan can't pick up non-pipeline YAML that may happen to sit under .tagma/.
  const pipelineEntries = enumeratePipelineYamls(ws.workDir);
  if (pipelineEntries.length === 0) {
    ws.workspaceDeclaredPluginsCache = [];
    ws.workspaceDeclaredPluginsCacheTime = now;
    return ws.workspaceDeclaredPluginsCache;
  }
  const seen = new Set<string>();
  let scannedCount = 0;
  let truncated = false;
  for (const entry of pipelineEntries) {
    if (scannedCount >= MAX_DECLARED_PLUGIN_YAML_FILES) {
      truncated = true;
      break;
    }
    const absPath = entry.yamlPath;
    const label = `${entry.stem}/${entry.yamlBasename}`;
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch (err) {
      console.warn(
        `[plugins] skipping unreadable YAML "${label}" while scanning declared plugins:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (size > MAX_DECLARED_PLUGIN_YAML_BYTES) {
      console.warn(
        `[plugins] skipping oversize YAML "${label}" (${size} bytes > ${MAX_DECLARED_PLUGIN_YAML_BYTES} cap) while scanning declared plugins`,
      );
      scannedCount += 1;
      continue;
    }
    scannedCount += 1;
    try {
      const doc = yaml.load(readFileSync(absPath, 'utf-8')) as
        { pipeline?: { plugins?: unknown }; plugins?: unknown } | null | undefined;
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
        `[plugins] skipping malformed YAML "${label}" while scanning declared plugins:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (truncated) {
    console.warn(
      `[plugins] declared-plugin scan stopped after ${MAX_DECLARED_PLUGIN_YAML_FILES} pipeline YAMLs in .tagma/; remaining files were not scanned`,
    );
  }
  ws.workspaceDeclaredPluginsCache = [...seen];
  ws.workspaceDeclaredPluginsCacheTime = now;
  return ws.workspaceDeclaredPluginsCache;
}

export interface AutoLoadInstalledPluginsOptions {
  /** Include plugin names declared in the open YAML/workspace YAML scan. */
  includeDeclared?: boolean;
  /** Honor autoInstallDeclaredPlugins for missing declared packages. */
  allowAutoInstallDeclared?: boolean;
  /** Include installed packages found on disk without a manifest entry. */
  includeDiscovered?: boolean;
}

/**
 * Auto-load trusted installed plugins into the registry.
 * Default workspace-open callers load only the persistent manifest. YAML
 * declarations are included only for explicit user refresh flows, which keeps
 * opening/importing a workspace from turning `pipeline.plugins[]` into code
 * execution or npm install by itself.
 */
export async function autoLoadInstalledPlugins(
  ws: WorkspaceState,
  options: AutoLoadInstalledPluginsOptions = {},
): Promise<string[]> {
  const manifest = readPluginManifest(ws);
  const declaredFromConfig = (ws.config.plugins ?? []).filter(isValidPluginName);
  const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins(ws);
  const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];
  const declaredSet = new Set(declared);
  const discovered = options.includeDiscovered ? discoverInstalledPlugins(ws) : [];
  const baseCandidates = [...new Set([...discovered, ...manifest])];
  const candidates = options.includeDeclared
    ? [...new Set([...baseCandidates, ...declared])]
    : baseCandidates;
  const settings = readEditorSettings(ws);
  const canAutoInstallDeclared =
    options.allowAutoInstallDeclared === true && settings.autoInstallDeclaredPlugins;
  // User-uninstalled deny list — honored for BOTH install and load so a
  // pipeline switch never resurrects a plugin the user just removed.
  // Loading an on-disk blocked plugin is also skipped so dangling copies
  // from a sibling workspace don't quietly re-register handlers.
  const blocklist = new Set(readPluginBlocklist(ws));
  const loaded: string[] = [];
  const errors: Array<{ name: string; message: string }> = [];
  for (const name of candidates) {
    if (ws.loadedPluginMeta.has(name)) continue;
    if (!isValidPluginName(name)) {
      errors.push({ name, message: 'invalid plugin name' });
      continue;
    }
    if (blocklist.has(name)) continue;
    let info = getPluginInfo(ws, name);
    let autoInstallOutcome: Awaited<ReturnType<typeof installPackageWithRollbackSnapshot>> | null =
      null;
    if (!info.installed) {
      // Only explicit refresh flows may auto-install YAML-declared plugins.
      if (!canAutoInstallDeclared || !declaredSet.has(name)) continue;
      try {
        autoInstallOutcome = await installPackageWithRollbackSnapshot(ws, name);
        addToPluginManifest(ws, name);
        invalidatePluginCache(ws);
        info = getPluginInfo(ws, name);
        if (!info.installed) {
          await restorePluginStateAndResync(ws, autoInstallOutcome.snapshot);
          autoInstallOutcome = null;
          invalidatePluginCache(ws);
          errors.push({ name, message: 'install completed but plugin still not on disk' });
          continue;
        }
      } catch (e) {
        if (autoInstallOutcome) {
          try {
            await restorePluginStateAndResync(ws, autoInstallOutcome.snapshot);
            invalidatePluginCache(ws);
          } catch (restoreErr) {
            console.error(
              `[plugins] failed to roll back auto-install for "${name}":`,
              restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            );
          }
          autoInstallOutcome = null;
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Failed to auto-install plugin "${name}":`, msg);
        errors.push({ name, message: `auto-install failed: ${msg}` });
        continue;
      }
    }
    try {
      await loadPluginFromWorkDir(ws, name);
      if (autoInstallOutcome) {
        discardPluginSnapshot(autoInstallOutcome.snapshot);
        autoInstallOutcome = null;
      }
      loaded.push(name);
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      if (autoInstallOutcome) {
        try {
          await restorePluginStateAndResync(ws, autoInstallOutcome.snapshot);
          invalidatePluginCache(ws);
          msg = `auto-install completed but plugin failed to load; reverted install changes: ${msg}`;
        } catch (restoreErr) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          console.error(`[plugins] failed to roll back auto-install for "${name}":`, restoreMsg);
          msg = `auto-install completed but plugin failed to load; rollback also failed: ${restoreMsg}; original error: ${msg}`;
        }
        autoInstallOutcome = null;
      }
      console.warn(`Failed to load plugin "${name}":`, msg);
      errors.push({ name, message: msg });
    }
  }
  ws.lastAutoLoadErrors = errors;
  return loaded;
}

/**
 * Map a server-side error onto a coarse error kind so the client can render a
 * localized hint without scraping English substrings out of the message body.
 * Keeps the wire format symmetric with PluginManager.classifyError.
 */
export type PluginErrorKind =
  'network' | 'permission' | 'version' | 'notfound' | 'invalid' | 'unknown';

export function classifyServerError(err: unknown): { message: string; kind: PluginErrorKind } {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof PluginSafetyError) return { message, kind: 'invalid' };
  const m = message.toLowerCase();
  if (m.includes('integrity') || m.includes('shasum')) return { message, kind: 'version' };
  if (m.includes('@tagma/types') || m.includes('peer range')) return { message, kind: 'version' };
  if (
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('econnrefused') ||
    m.includes('fetch failed') ||
    m.includes('aborted') ||
    m.includes('network')
  )
    return { message, kind: 'network' };
  if (m.includes('eacces') || m.includes('eperm') || m.includes('permission denied'))
    return { message, kind: 'permission' };
  if (m.includes('etarget') || m.includes('eresolve') || m.includes('peer dep'))
    return { message, kind: 'version' };
  if (m.includes('not found') || m.includes('e404') || m.includes('404'))
    return { message, kind: 'notfound' };
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
  ws: WorkspaceState,
  name: string,
): { category: PluginCategory; type: string } | null {
  return resolvePluginCapabilities(ws, name)[0] ?? null;
}

/**
 * Soft-parse a `tagmaPlugin.capabilities: Array<{category, type}>` declaration
 * from a package.json blob. Used by the uninstall-impact scan when the plugin
 * is installed but not yet loaded, so the SDK's strict `readPluginManifest`
 * (single `{category, type}`) wouldn't surface a multi-capability plugin.
 *
 * Returns an empty array — not null, not throw — if the field is missing or
 * malformed: this is best-effort metadata, and impact scanning should
 * gracefully degrade to convention-based inference.
 */
function readMultiCapabilityManifestField(
  pkg: unknown,
): Array<{ category: PluginCategory; type: string }> {
  if (!pkg || typeof pkg !== 'object') return [];
  const tagmaPlugin = (pkg as Record<string, unknown>).tagmaPlugin;
  if (!tagmaPlugin || typeof tagmaPlugin !== 'object') return [];
  const caps = (tagmaPlugin as Record<string, unknown>).capabilities;
  if (!Array.isArray(caps)) return [];
  const validCategories: ReadonlySet<PluginCategory> = new Set([
    'drivers',
    'triggers',
    'completions',
    'middlewares',
  ]);
  const out: Array<{ category: PluginCategory; type: string }> = [];
  const seen = new Set<string>();
  for (const entry of caps) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const category = e.category;
    const type = e.type;
    if (typeof category !== 'string' || !validCategories.has(category as PluginCategory)) continue;
    if (typeof type !== 'string' || type.length === 0) continue;
    const key = `${category}/${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category: category as PluginCategory, type });
  }
  return out;
}

export function resolvePluginCapabilities(
  ws: WorkspaceState,
  name: string,
): Array<{ category: PluginCategory; type: string }> {
  const meta = ws.loadedPluginMeta.get(name);
  if (meta?.registrations.length) {
    return meta.registrations.map((registration) => ({
      category: registration.category,
      type: registration.type,
    }));
  }
  try {
    const pluginDir = pluginStorePackageDirFor(ws, name);
    fenceWithinPluginStore(ws, pluginDir);
    const pkgPath = resolve(pluginDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // Prefer the multi-capability declaration when present so a plugin
      // that registers e.g. drivers/foo + middlewares/bar still has both
      // surfaced in the uninstall impact, even before it's loaded.
      const multi = readMultiCapabilityManifestField(pkg);
      if (multi.length > 0) return multi;
      const manifest = parsePluginManifestField(pkg);
      if (manifest) return [{ category: manifest.category, type: manifest.type }];
    }
  } catch {
    /* fall through */
  }
  const inferred = pluginCategoryFromName(name);
  return inferred ? [inferred] : [];
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

function extractPluginList(doc: unknown): { list: unknown[]; location: string } | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const pipeline = d.pipeline;
  if (pipeline && typeof pipeline === 'object') {
    const plugins = (pipeline as Record<string, unknown>).plugins;
    if (Array.isArray(plugins)) return { list: plugins, location: 'pipeline.plugins' };
  }
  if (Array.isArray(d.plugins)) return { list: d.plugins, location: 'plugins' };
  return null;
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

function extractPipelineObject(doc: unknown): Record<string, unknown> | null {
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, unknown>;
  const pipeline = d.pipeline;
  if (pipeline && typeof pipeline === 'object') return pipeline as Record<string, unknown>;
  return d;
}

function currentConfigImpactFile(ws: WorkspaceState): string {
  if (!ws.workDir || !ws.yamlPath) return '(current pipeline)';
  try {
    if (isPathWithin(ws.yamlPath, ws.workDir)) {
      return relative(resolve(ws.workDir), resolve(ws.yamlPath)).replace(/\\/g, '/');
    }
  } catch {
    /* fall through to a stable non-path label */
  }
  return '(current pipeline)';
}

function impactEntryKey(entry: UninstallImpactEntry): string {
  return [entry.file, entry.location, entry.trackId, entry.taskId ?? ''].join('\x1f');
}

function addUniqueImpacts(
  target: UninstallImpactEntry[],
  seen: Set<string>,
  entries: readonly UninstallImpactEntry[],
): void {
  for (const entry of entries) {
    const key = impactEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
}

function scanDeclaredPluginImpactInDoc(
  doc: unknown,
  file: string,
  name: string,
): UninstallImpactEntry[] {
  const plugins = extractPluginList(doc);
  if (!plugins) return [];
  const impacts: UninstallImpactEntry[] = [];
  for (let i = 0; i < plugins.list.length; i++) {
    if (plugins.list[i] !== name) continue;
    impacts.push({
      file,
      location: `${plugins.location}[${i}]`,
      trackId: 'pipeline',
      taskId: null,
    });
  }
  return impacts;
}

export function scanDeclaredPluginImpact(ws: WorkspaceState, name: string): UninstallImpactEntry[] {
  if (!ws.workDir) return [];
  const impacts: UninstallImpactEntry[] = [];
  const seen = new Set<string>();
  const pipelineEntries = enumeratePipelineYamls(ws.workDir);
  for (const entry of pipelineEntries) {
    let doc: unknown;
    try {
      doc = yaml.load(readFileSync(entry.yamlPath, 'utf-8'));
    } catch {
      continue;
    }
    const relFile = `.tagma/${entry.stem}/${entry.yamlBasename}`;
    addUniqueImpacts(impacts, seen, scanDeclaredPluginImpactInDoc(doc, relFile, name));
  }
  addUniqueImpacts(
    impacts,
    seen,
    scanDeclaredPluginImpactInDoc(ws.config, currentConfigImpactFile(ws), name),
  );
  return impacts;
}

function scanCapabilityImpactInDoc(
  doc: unknown,
  file: string,
  category: PluginCategory,
  type: string,
): UninstallImpactEntry[] {
  const impacts: UninstallImpactEntry[] = [];
  const pipeline = extractPipelineObject(doc);
  if (category === 'drivers' && pipeline?.driver === type) {
    impacts.push({
      file,
      location: 'pipeline.driver',
      trackId: 'pipeline',
      taskId: null,
    });
  }
  const tracks = extractTracks(doc);
  if (!tracks) return impacts;

  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    if (!track || typeof track !== 'object') continue;
    const trackId =
      typeof (track as { id?: unknown }).id === 'string'
        ? (track as { id: string }).id
        : `tracks[${ti}]`;

    if (category === 'drivers' && (track as { driver?: unknown }).driver === type) {
      impacts.push({
        file,
        location: `tracks[${ti}].driver`,
        trackId,
        taskId: null,
      });
    }

    if (category === 'middlewares') {
      const trackMws = (track as { middlewares?: unknown }).middlewares;
      if (Array.isArray(trackMws)) {
        trackMws.forEach((mw, mi) => {
          if (mw && typeof mw === 'object' && (mw as { type?: unknown }).type === type) {
            impacts.push({
              file,
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
      const taskId =
        typeof (task as { id?: unknown }).id === 'string'
          ? (task as { id: string }).id
          : `tasks[${ki}]`;
      const taskObj = task as Record<string, unknown>;

      if (category === 'drivers' && taskObj.driver === type) {
        impacts.push({
          file,
          location: `tracks[${ti}].tasks[${ki}].driver`,
          trackId,
          taskId,
        });
      }

      if (category === 'triggers') {
        const trig = taskObj.trigger;
        if (trig && typeof trig === 'object' && (trig as { type?: unknown }).type === type) {
          impacts.push({
            file,
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
            file,
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
                file,
                location: `tracks[${ti}].tasks[${ki}].middlewares[${mi}]`,
                trackId,
                taskId,
              });
            }
          });
        }
      }
    }
  }
  return impacts;
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
  ws: WorkspaceState,
  category: PluginCategory,
  type: string,
): UninstallImpactEntry[] {
  if (!ws.workDir) return [];
  const impacts: UninstallImpactEntry[] = [];
  const seen = new Set<string>();
  // Walk `.tagma/<stem>/<stem>.yaml` via the shared enumerator so reserved
  // sibling dirs (`logs`, `plugin-runtime`, …) are skipped consistently with
  // the rest of the editor.
  const pipelineEntries = enumeratePipelineYamls(ws.workDir);
  for (const entry of pipelineEntries) {
    const absPath = entry.yamlPath;
    let doc: unknown;
    try {
      doc = yaml.load(readFileSync(absPath, 'utf-8'));
    } catch {
      continue;
    }
    const relFile = `.tagma/${entry.stem}/${entry.yamlBasename}`;
    addUniqueImpacts(impacts, seen, scanCapabilityImpactInDoc(doc, relFile, category, type));
  }

  addUniqueImpacts(
    impacts,
    seen,
    scanCapabilityImpactInDoc(ws.config, currentConfigImpactFile(ws), category, type),
  );
  return impacts;
}
