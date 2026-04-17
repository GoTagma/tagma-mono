import type express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidPluginName, unregisterPlugin } from '@tagma/sdk';
import type { PluginCategory } from '@tagma/sdk';
import { assertSafePluginName } from '../plugin-safety.js';
import { S, getRegistrySnapshot } from '../state.js';
import {
  installPackage,
  installFromLocalPath,
  uninstallPackage,
  registryMeta,
  snapshotPluginState,
  restorePluginState,
  discardPluginSnapshot,
  type PluginStateSnapshot,
} from '../plugins/install.js';
import {
  loadedPluginMeta,
  loadedPlugins,
  getPluginInfo,
  loadPluginFromWorkDir,
  readPluginManifest,
  addToPluginManifest,
  removeFromPluginManifest,
  addToPluginBlocklist,
  removeFromPluginBlocklist,
  invalidatePluginCache,
  discoverWorkspaceDeclaredPlugins,
  autoLoadInstalledPlugins,
  readEditorSettings,
  DEFAULT_EDITOR_SETTINGS,
  classifyServerError,
  pluginErrorResponse,
  resolvePluginCategoryType,
  scanUninstallImpact,
  getLastAutoLoadErrors,
  cleanupPluginStageTree,
} from '../plugins/loader.js';
import {
  VALID_PLUGIN_CATEGORIES,
  marketplaceSearchCache,
  marketplacePackageCache,
  cacheGet,
  cacheSet,
  resolveMarketplaceEntries,
  fetchMarketplacePackage,
  NPM_SEARCH_URL,
  MARKETPLACE_SEARCH_LIMIT,
} from '../plugins/marketplace.js';
import { REGISTRY_FETCH_TIMEOUT_MS } from '../plugins/install.js';

/**
 * Per-plugin-name mutation lock. Serializes concurrent install / uninstall /
 * load / upgrade for the same plugin name so two racing requests can't
 * interleave writes to `package.json`, `.tagma/plugins.json`, the blocklist,
 * or `node_modules/<name>/`. Different names run in parallel.
 *
 * Implementation: chain each incoming op onto the prior op's promise. A
 * prior failure does not block the next op (try/catch swallows it for
 * chaining purposes; the failed op has already resolved its own response).
 * The slot is cleared when the latest chained task completes, so long-lived
 * sessions don't leak entries.
 */
const pluginOpLocks = new Map<string, Promise<unknown>>();
async function withPluginLock<T>(name: string, op: () => Promise<T>): Promise<T> {
  const prev = pluginOpLocks.get(name);
  const task = (async () => {
    if (prev) {
      try {
        await prev;
      } catch {
        /* prior op's failure is already reported; don't block this one */
      }
    }
    return op();
  })();
  pluginOpLocks.set(name, task);
  try {
    return await task;
  } finally {
    if (pluginOpLocks.get(name) === task) {
      pluginOpLocks.delete(name);
    }
  }
}

export function registerPluginRoutes(app: express.Express): void {
  /** List all managed plugins (from pipeline config + manifest + loaded this session) */
  app.get('/api/plugins', (_req, res) => {
    const declared = S.config.plugins ?? [];
    const manifest = readPluginManifest();
    const allNames = [...new Set([...declared, ...manifest, ...loadedPluginMeta.keys()])];
    const plugins = allNames.map(getPluginInfo);
    res.json({ plugins, autoLoadErrors: getLastAutoLoadErrors() });
  });

  /** Look up a single plugin from npm registry */
  app.get('/api/plugins/info', async (req, res) => {
    const name = req.query.name as string;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }

    const local = getPluginInfo(name);
    if (local.installed) return res.json(local);

    try {
      const meta = await registryMeta(name);
      res.json({
        name,
        installed: false,
        loaded: false,
        version: meta.version,
        description: meta.description,
        categories: [],
      });
    } catch (e: unknown) {
      const { message, kind } = classifyServerError(e);
      res.status(404).json({ error: `Package "${name}" not found on registry: ${message}`, kind });
    }
  });

  /** Install a plugin into workDir and load it into the registry */
  app.post('/api/plugins/install', async (req, res) => {
    const { name } = req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withPluginLock(name, async () => {
      // Snapshot the prior on-disk state so an upgrade failure can roll back
      // to a working version. Fresh installs also snapshot (trivially — no
      // files) so the code path is uniform; restore on fresh-install failure
      // is a no-op plus a dep-spec cleanup.
      let snapshot: PluginStateSnapshot | null = null;
      try {
        snapshot = snapshotPluginState(name);
      } catch (snapErr) {
        // Snapshot failure is non-fatal — proceed without rollback ability
        // rather than blocking the user's install. Log so the cause is
        // diagnosable from the server output.
        console.warn(
          `[plugins] failed to snapshot "${name}" before install; rollback disabled for this op:`,
          snapErr instanceof Error ? snapErr.message : String(snapErr),
        );
      }

      try {
        await installPackage(name);
        addToPluginManifest(name);
        // Clicking Install is an explicit opt-in — clear any prior user-
        // uninstall block so the plugin can be auto-loaded on future opens.
        removeFromPluginBlocklist(name);
        invalidatePluginCache();

        // Load into SDK registry
        try {
          const { result } = await loadPluginFromWorkDir(name);
          discardPluginSnapshot(snapshot);
          const note =
            result === 'replaced'
              ? 'Replaced the existing handler for this (category, type). The new code is live.'
              : undefined;
          res.json({ plugin: getPluginInfo(name), registry: getRegistrySnapshot(), note });
        } catch (loadErr: unknown) {
          const { message, kind } = classifyServerError(loadErr);
          // Upgrade case: restore the previous working version so the SDK
          // registry (which still holds the old handler) stays consistent
          // with what's on disk. Without this, subsequent Run requests use a
          // handler backed by v1 code that no longer exists in node_modules,
          // and the next workspace reopen fails to auto-load the plugin at
          // all because discoverInstalledPlugins sees v2 and retries the
          // load that just failed.
          if (snapshot?.hadPriorFiles) {
            restorePluginState(snapshot);
            invalidatePluginCache();
            return res.json({
              plugin: getPluginInfo(name),
              registry: getRegistrySnapshot(),
              warning: `Upgrade failed to load; reverted to previous on-disk version. Error: ${message}`,
              kind,
            });
          }
          // Fresh install: nothing working to keep, so the partial install
          // stays on disk and the user gets a load warning as before.
          discardPluginSnapshot(snapshot);
          return res.json({
            plugin: getPluginInfo(name),
            registry: getRegistrySnapshot(),
            warning: `Installed but failed to load: ${message}`,
            kind,
          });
        }
      } catch (e: unknown) {
        // installPackage itself failed (registry error, integrity mismatch,
        // bun install error, etc). If the plugin was installed before, the
        // previous version may have been partially overwritten — restore it.
        if (snapshot?.hadPriorFiles) {
          restorePluginState(snapshot);
          invalidatePluginCache();
        } else {
          discardPluginSnapshot(snapshot);
        }
        res.status(500).json(pluginErrorResponse(e, 'Install'));
      }
    });
  });

  /**
   * Return the list of YAML locations that would be broken if the given
   * plugin were uninstalled right now. The client shows this in a confirm
   * dialog so the user can bail out before orphaning tasks.
   *
   * Returns `{ category: null }` when the plugin can't be classified —
   * the uninstall is still safe to attempt but impact scanning is a no-op.
   */
  app.get('/api/plugins/uninstall-impact', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    const resolved = resolvePluginCategoryType(name);
    if (!resolved) {
      return res.json({ name, category: null, type: null, impacts: [] });
    }
    const impacts = scanUninstallImpact(resolved.category, resolved.type);
    res.json({
      name,
      category: resolved.category,
      type: resolved.type,
      impacts,
    });
  });

  /** Uninstall a plugin from workDir via direct filesystem ops (no package manager required) */
  app.post('/api/plugins/uninstall', async (_req, res) => {
    const { name } = _req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withPluginLock(name, async () => {
      try {
        uninstallPackage(name);
        removeFromPluginManifest(name);
        // Record the user's explicit uninstall so a subsequent workspace /
        // pipeline open won't silently re-install this plugin via the
        // `autoInstallDeclaredPlugins` path or reload it from a stray
        // on-disk copy. Cleared the moment the user clicks Install again.
        addToPluginBlocklist(name);
        invalidatePluginCache();
        // C4: actually remove the handler from the SDK registry so subsequent
        // task references fail fast instead of silently using stale code.
        const meta = loadedPluginMeta.get(name);
        if (meta) {
          unregisterPlugin(meta.category, meta.type);
          loadedPluginMeta.delete(name);
        }
        // Drop every staging copy under `.tagma/plugin-runtime/<name>/`. This
        // covers the currently-loaded one plus any orphans left behind by past
        // upgrade cycles or failed loads. Without this, repeated install /
        // upgrade / uninstall churn grows the plugin-runtime tree unboundedly.
        cleanupPluginStageTree(name);

        res.json({
          plugin: getPluginInfo(name),
          registry: getRegistrySnapshot(),
          note: 'Plugin uninstalled.',
        });
      } catch (e: unknown) {
        res.status(500).json(pluginErrorResponse(e, 'Uninstall'));
      }
    });
  });

  /** Import a plugin from a local directory or .tgz file */
  app.post('/api/plugins/import-local', async (req, res) => {
    const { path: localPath } = req.body;
    if (!localPath || typeof localPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    const absPath = resolve(localPath);
    if (!existsSync(absPath)) {
      return res.status(400).json({ error: `Path does not exist: ${absPath}` });
    }

    try {
      const pkgName = await installFromLocalPath(absPath);
      addToPluginManifest(pkgName);
      removeFromPluginBlocklist(pkgName);

      // Load into SDK registry
      try {
        const { result } = await loadPluginFromWorkDir(pkgName);
        const note =
          result === 'replaced'
            ? 'Replaced the existing handler for this (category, type). The new code is live.'
            : undefined;
        res.json({ plugin: getPluginInfo(pkgName), registry: getRegistrySnapshot(), note });
      } catch (loadErr: unknown) {
        const { message, kind } = classifyServerError(loadErr);
        return res.json({
          plugin: getPluginInfo(pkgName),
          registry: getRegistrySnapshot(),
          warning: `Installed but failed to load: ${message}`,
          kind,
        });
      }
    } catch (e: unknown) {
      res.status(500).json(pluginErrorResponse(e, 'Local import'));
    }
  });

  /** Load an already-installed plugin from workDir into the registry */
  /**
   * Read-only preview of the workspace's declared plugins. Used by the Editor
   * Settings panel on open to show "what would Apply install?" without
   * actually installing anything.
   *
   * `declared` is the union of every YAML in `.tagma/` (via
   * discoverWorkspaceDeclaredPlugins) and any plugins declared by the
   * currently-loaded in-memory pipeline — same source that
   * `autoLoadInstalledPlugins()` uses, so the preview matches reality.
   */
  app.get('/api/plugins/declared', (_req, res) => {
    if (!S.workDir) {
      return res.json({
        declared: [],
        installed: [],
        missing: [],
        loaded: [],
        settings: { ...DEFAULT_EDITOR_SETTINGS },
      });
    }
    const declaredFromConfig = (S.config.plugins ?? []).filter(isValidPluginName);
    const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins();
    const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];
    const installed = declared.filter((n) => getPluginInfo(n).installed);
    const missing = declared.filter((n) => !getPluginInfo(n).installed);
    const loaded = declared.filter((n) => loadedPlugins.has(n));
    res.json({
      declared,
      installed,
      missing,
      loaded,
      settings: readEditorSettings(),
    });
  });

  /**
   * Re-run the auto-load + auto-install sweep on demand. The Editor Settings
   * panel's "Apply Now" button uses this so the user can re-run the install
   * without having to close+reopen the workspace.
   *
   * Pulls declared plugins from BOTH the workspace's `.tagma/*.yaml` files
   * (so it covers every pipeline in the workspace, not just the one the user
   * happens to be editing) AND the in-memory pipeline. Same source that
   * `autoLoadInstalledPlugins()` uses on workspace open, so the on-demand and
   * on-open paths stay in lockstep.
   */
  app.post('/api/plugins/refresh', async (_req, res) => {
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    try {
      const settings = readEditorSettings();
      const declaredFromConfig = (S.config.plugins ?? []).filter(isValidPluginName);
      const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins();
      const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];

      // Snapshot pre-state so we can report what was already there vs. what
      // this call actually changed. `loadedPlugins` is a non-iterable shim;
      // the underlying iterable storage is `loadedPluginMeta` (a Map).
      const wasInstalled = new Set(declared.filter((n) => getPluginInfo(n).installed));
      const wasLoaded = new Set(loadedPluginMeta.keys());

      const loaded = await autoLoadInstalledPlugins();

      const installed = declared.filter((n) => getPluginInfo(n).installed && !wasInstalled.has(n));
      const newlyLoaded = loaded.filter((n) => !wasLoaded.has(n));
      const missing = declared.filter((n) => !getPluginInfo(n).installed);

      res.json({
        settings,
        declared,
        missing,
        installed,
        loaded: newlyLoaded,
        errors: getLastAutoLoadErrors(),
        registry: getRegistrySnapshot(),
      });
    } catch (e: unknown) {
      res.status(500).json(pluginErrorResponse(e, 'Refresh'));
    }
  });

  app.post('/api/plugins/load', async (req, res) => {
    const { name } = req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!S.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withPluginLock(name, async () => {
      const info = getPluginInfo(name);
      if (!info.installed) {
        return res
          .status(404)
          .json({ error: `Plugin "${name}" is not installed. Install it first.` });
      }

      if (loadedPlugins.has(name)) {
        return res.json({ plugin: getPluginInfo(name), registry: getRegistrySnapshot() });
      }

      try {
        const { result } = await loadPluginFromWorkDir(name);
        const note =
          result === 'replaced'
            ? 'Replaced the existing handler for this (category, type). The new code is live.'
            : undefined;
        res.json({ plugin: getPluginInfo(name), registry: getRegistrySnapshot(), note });
      } catch (e: unknown) {
        res.status(500).json(pluginErrorResponse(e, 'Load'));
      }
    });
  });

  /** GET /api/marketplace/search?q=&category= */
  app.get('/api/marketplace/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : '';
    const category: PluginCategory | null = VALID_PLUGIN_CATEGORIES.has(
      rawCategory as PluginCategory,
    )
      ? (rawCategory as PluginCategory)
      : null;
    const cacheKey = `q=${q}|cat=${category ?? ''}`;
    const cached = cacheGet(marketplaceSearchCache, cacheKey);
    if (cached) {
      res.json({
        query: q,
        category,
        entries: cached,
        totalRaw: cached.length,
        fetchedAt: new Date().toISOString(),
      });
      return;
    }
    // We hit two upstream queries in parallel and merge them.
    //
    //   1. `keywords:tagma-plugin` — the canonical discovery channel. Plugin
    //      authors (including third parties) opt in by adding the keyword
    //      to their package.json. This is the long-term right answer.
    //
    //   2. Free-text "tagma" filtered to the @tagma/* scope — backstop for
    //      official packages that haven't declared the keyword yet. Note
    //      that not every @tagma/* package is a plugin (e.g. @tagma/sdk,
    //      @tagma/types are libraries) — the manifest check below
    //      discards any candidate whose package.json doesn't carry a
    //      `tagmaPlugin` field, so this scope-based discovery is safe.
    const keywordText = q ? `keywords:tagma-plugin ${q}` : 'keywords:tagma-plugin';
    const scopeText = q ? `tagma ${q}` : 'tagma';
    async function fetchSearch(text: string, scopeOnly: boolean): Promise<string[]> {
      const params = new URLSearchParams({ text, size: String(MARKETPLACE_SEARCH_LIMIT) });
      const r = await fetch(`${NPM_SEARCH_URL}?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`npm search returned ${r.status}`);
      const data = (await r.json()) as { objects?: Array<{ package?: { name?: unknown } }> };
      const out: string[] = [];
      for (const obj of data.objects ?? []) {
        const name = obj?.package?.name;
        if (typeof name !== 'string') continue;
        if (!isValidPluginName(name)) continue;
        if (scopeOnly && !name.startsWith('@tagma/')) continue;
        out.push(name);
      }
      return out;
    }
    try {
      // Track per-upstream failures explicitly so we can surface the error in
      // the response and — critically — decline to cache an empty payload when
      // the upstream fetch actually errored. Caching "" on failure is a trap:
      // one transient network hiccup locks the user out of the marketplace for
      // the full TTL even after the registry recovers.
      let upstreamError: unknown = null;
      const keywordHits = await fetchSearch(keywordText, false).catch((e) => {
        upstreamError = e;
        return [] as string[];
      });
      const scopeHits = await fetchSearch(scopeText, true).catch((e) => {
        if (!upstreamError) upstreamError = e;
        return [] as string[];
      });
      const rawNames = Array.from(new Set([...keywordHits, ...scopeHits]));
      const resolved = await resolveMarketplaceEntries(rawNames);
      const filtered = category ? resolved.filter((e) => e.category === category) : resolved;
      // Sort: weekly downloads desc (null goes to the bottom), then name asc.
      filtered.sort((a, b) => {
        const ad = a.weeklyDownloads ?? -1;
        const bd = b.weeklyDownloads ?? -1;
        if (bd !== ad) return bd - ad;
        return a.name.localeCompare(b.name);
      });
      // Only cache when we actually got something from the upstream. Empty
      // results from a successful search (e.g. narrow category with no plugins)
      // are cheap enough to re-fetch, and skipping the cache means a flaky
      // upstream call can recover on the next request instead of sticking for
      // the whole TTL window.
      if (filtered.length > 0) {
        cacheSet(marketplaceSearchCache, cacheKey, filtered);
      }
      res.json({
        query: q,
        category,
        entries: filtered,
        totalRaw: rawNames.length,
        fetchedAt: new Date().toISOString(),
        upstreamError: upstreamError
          ? upstreamError instanceof Error
            ? upstreamError.message
            : String(upstreamError)
          : null,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: `Marketplace search failed: ${message}` });
    }
  });

  /** GET /api/marketplace/package?name=... */
  app.get('/api/marketplace/package', async (req, res) => {
    const rawName = typeof req.query.name === 'string' ? req.query.name : '';
    if (!rawName || !isValidPluginName(rawName)) {
      return res.status(400).json({
        error:
          'Invalid plugin name. Names must be scoped (@scope/name) or prefixed (tagma-plugin-*).',
      });
    }
    const cached = cacheGet(marketplacePackageCache, rawName);
    if (cached) return res.json(cached);
    try {
      const detail = await fetchMarketplacePackage(rawName);
      if (!detail) {
        return res.status(404).json({
          error: `Package "${rawName}" is not a valid tagma plugin (missing tagmaPlugin field or unknown to npm).`,
        });
      }
      cacheSet(marketplacePackageCache, rawName, detail);
      res.json(detail);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: `Marketplace fetch failed: ${message}` });
    }
  });
}
