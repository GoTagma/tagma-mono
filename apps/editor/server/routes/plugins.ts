import type express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidPluginName, type PluginCategory } from '@tagma/sdk/plugins';
import { assertSafePluginName } from '../plugin-safety.js';
import { bumpRevision, getRegistrySnapshot } from '../state.js';
import { requireWorkspace } from '../require-workspace.js';
import { consumeFsCapability } from '../fs-capability.js';
import { errorMessage } from '../path-utils.js';
import { takeRateLimitToken } from '../rate-limit.js';
import {
  installPackageSpecWithRollbackSnapshot,
  installPluginUpgradeBatchWithRollbackSnapshot,
  installFromLocalPathWithRollbackSnapshot,
  uninstallPackage,
  assertImportablePluginSource,
  registryMeta,
  resolveLatestPluginVersion,
  planPluginUpgrade,
  parsePluginInstallSpec,
  readLocalPluginPackageName,
  restorePluginStateAndResync,
  restorePluginBatchStateAndResync,
  discardPluginSnapshot,
  discardPluginBatchSnapshot,
} from '../plugins/install.js';
import { withPluginLock, withWorkspacePluginMutationLock } from '../plugins/locks.js';
import {
  getPluginInfo,
  loadPluginFromWorkDir,
  readPluginManifest,
  addToPluginManifest,
  removeFromPluginManifest,
  addToPluginBlocklist,
  removeFromPluginBlocklist,
  invalidatePluginCache,
  discoverInstalledPlugins,
  discoverWorkspaceDeclaredPlugins,
  autoLoadInstalledPlugins,
  readEditorSettings,
  DEFAULT_EDITOR_SETTINGS,
  classifyServerError,
  pluginErrorResponse,
  resolvePluginCapabilities,
  scanDeclaredPluginImpact,
  scanUninstallImpact,
  getLastAutoLoadErrors,
  cleanupPluginStageTree,
  unloadPluginFromRegistry,
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
  OFFICIAL_MARKETPLACE_PLUGIN_NAMES,
} from '../plugins/marketplace.js';
import { REGISTRY_FETCH_TIMEOUT_MS } from '../plugins/install.js';
import type { WorkspaceState } from '../workspace-state.js';
import { getActiveYamlEditLock, shouldBlockYamlEditLockMutation } from '../yaml-edit-lock.js';

type UninstallImpactPayload = {
  name: string;
  category: PluginCategory | null;
  type: string | null;
  capabilities?: Array<{ category: PluginCategory; type: string }>;
  impacts: Array<{
    file: string;
    category?: PluginCategory;
    type?: string;
    location: string;
    trackId: string;
    taskId: string | null;
  }>;
};

function impactKey(impact: {
  file: string;
  category?: PluginCategory;
  type?: string;
  location: string;
  trackId: string;
  taskId: string | null;
}): string {
  return [
    impact.file,
    impact.category ?? '',
    impact.type ?? '',
    impact.location,
    impact.trackId,
    impact.taskId ?? '',
  ].join('\x1f');
}

function acknowledgedImpactKeys(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const keys = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    if (
      typeof rec.file !== 'string' ||
      typeof rec.location !== 'string' ||
      typeof rec.trackId !== 'string'
    )
      continue;
    keys.add(
      impactKey({
        file: rec.file,
        category: VALID_PLUGIN_CATEGORIES.has(rec.category as PluginCategory)
          ? (rec.category as PluginCategory)
          : undefined,
        type: typeof rec.type === 'string' ? rec.type : undefined,
        location: rec.location,
        trackId: rec.trackId,
        taskId: typeof rec.taskId === 'string' ? rec.taskId : null,
      }),
    );
  }
  return keys;
}

function buildUninstallImpact(ws: WorkspaceState, name: string): UninstallImpactPayload {
  const capabilities = resolvePluginCapabilities(ws, name);
  const declaredImpacts = scanDeclaredPluginImpact(ws, name);
  if (capabilities.length === 0) {
    return { name, category: null, type: null, impacts: declaredImpacts };
  }
  const impacts = capabilities.flatMap((capability) =>
    scanUninstallImpact(ws, capability.category, capability.type).map((impact) => ({
      ...impact,
      category: capability.category,
      type: capability.type,
    })),
  );
  return {
    name,
    category: capabilities[0]!.category,
    type: capabilities[0]!.type,
    capabilities,
    impacts: [...declaredImpacts, ...impacts],
  };
}

export function registerPluginRoutes(app: express.Express): void {
  /** List all managed plugins (from pipeline config + manifest + loaded this session) */
  app.get('/api/plugins', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const declared = ws.config.plugins ?? [];
    const manifest = readPluginManifest(ws);
    // Include node_modules-discovered plugins so packages installed manually
    // (e.g. via `bun add`) appear in Local even when they aren't yet listed
    // in the manifest or YAML and haven't been loaded this session.
    const discovered = discoverInstalledPlugins(ws);
    const allNames = [
      ...new Set([...declared, ...manifest, ...discovered, ...ws.loadedPluginMeta.keys()]),
    ];
    const plugins = allNames.map((n) => getPluginInfo(ws, n));
    res.json({ plugins, autoLoadErrors: getLastAutoLoadErrors(ws) });
  });

  /** Look up a single plugin from npm registry */
  app.get('/api/plugins/info', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const name = req.query.name as string;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }

    const local = getPluginInfo(ws, name);
    if (local.installed) return res.json(local);

    try {
      // Two-step lookup since registryMeta no longer silently substitutes
      // dist-tags.latest: resolve the latest tag explicitly first, then
      // fetch the per-version metadata. This keeps the latest-fallback
      // path visible at every call site that wants it.
      const latest = await resolveLatestPluginVersion(name);
      const meta = await registryMeta(name, latest);
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
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name, version } = req.body;
    let spec: ReturnType<typeof parsePluginInstallSpec>;
    try {
      spec = parsePluginInstallSpec(name, version);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    // The install pipeline now refuses unpinned specs (no silent
    // dist-tags.latest fallback). When the renderer's "Install" button
    // didn't ask for a specific version we resolve latest at the route
    // boundary and pin it before proceeding - the pinned value flows into
    // the lockfile and the response so the user sees exactly which
    // version landed.
    if (!spec.version) {
      try {
        const resolvedLatest = await resolveLatestPluginVersion(spec.name);
        spec = { name: spec.name, version: resolvedLatest };
      } catch (err) {
        const { message, kind } = classifyServerError(err);
        return res.status(404).json({
          error: `Could not resolve latest version for "${spec.name}": ${message}`,
          kind,
        });
      }
    }

    await withPluginLock(ws, spec.name, async () => {
      // The installer owns the single on-disk snapshot for this operation.
      // The route keeps it only long enough to roll back a post-install load
      // failure, then discards it on every response path.
      let installOutcome: Awaited<
        ReturnType<typeof installPackageSpecWithRollbackSnapshot>
      > | null = null;
      try {
        installOutcome = await installPackageSpecWithRollbackSnapshot(ws, spec, {
          preferLocked: false,
        });
      } catch (snapErr) {
        // Install failed before the route received a rollback snapshot. The
        // installer has already restored anything it mutated.
        invalidatePluginCache(ws);
        return res.status(500).json(pluginErrorResponse(snapErr, 'Install'));
      }

      try {
        if (!installOutcome) throw new Error('Install did not produce rollback state');
        addToPluginManifest(ws, spec.name);
        // Clicking Install is an explicit opt-in - clear any prior user-
        // uninstall block so the plugin can be auto-loaded on future opens.
        removeFromPluginBlocklist(ws, spec.name);
        invalidatePluginCache(ws);

        // Load into SDK registry
        try {
          const { result } = await loadPluginFromWorkDir(ws, spec.name);
          discardPluginSnapshot(installOutcome.snapshot);
          const note =
            result === 'replaced'
              ? 'Replaced the existing handler for this (category, type). The new code is live.'
              : undefined;
          res.json({
            plugin: getPluginInfo(ws, spec.name),
            registry: getRegistrySnapshot(ws),
            note,
          });
        } catch (loadErr: unknown) {
          const { message, kind } = classifyServerError(loadErr);
          // A plugin is installed into its own dependency store and becomes
          // observable only after it loads. If loading fails, roll the store
          // back even for a fresh install so the workspace never keeps a
          // half-installed plugin that will fail again on next open.
          await restorePluginStateAndResync(ws, installOutcome.snapshot);
          discardPluginSnapshot(installOutcome.snapshot);
          invalidatePluginCache(ws);
          const rollbackAction = installOutcome.snapshot.hadPriorFiles ? 'Upgrade' : 'Install';
          return res.json({
            plugin: getPluginInfo(ws, spec.name),
            registry: getRegistrySnapshot(ws),
            warning: `${rollbackAction} failed to load; reverted plugin install changes. Error: ${message}`,
            kind,
          });
        }
      } catch (e: unknown) {
        // Install failures are restored inside the installer. If a route step
        // after install failed before the load-specific handler ran, use the
        // retained snapshot to put the workspace back.
        if (installOutcome) {
          await restorePluginStateAndResync(ws, installOutcome.snapshot);
          discardPluginSnapshot(installOutcome.snapshot);
        }
        invalidatePluginCache(ws);
        res.status(500).json(pluginErrorResponse(e, 'Install'));
      }
    });
  });

  app.post('/api/plugins/upgrade-plan', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name } = req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    try {
      res.json(await planPluginUpgrade(ws, name));
    } catch (e: unknown) {
      res.status(500).json(pluginErrorResponse(e, 'Upgrade plan'));
    }
  });

  app.post('/api/plugins/upgrade', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name } = req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withWorkspacePluginMutationLock(ws, async () => {
      const wasLoaded = new Set(ws.loadedPluginMeta.keys());
      let installOutcome: Awaited<
        ReturnType<typeof installPluginUpgradeBatchWithRollbackSnapshot>
      > | null = null;
      try {
        installOutcome = await installPluginUpgradeBatchWithRollbackSnapshot(ws, name);
      } catch (installErr) {
        invalidatePluginCache(ws);
        return res.status(409).json(pluginErrorResponse(installErr, 'Upgrade'));
      }

      const loadedDuringUpgrade: string[] = [];
      try {
        for (const entry of installOutcome.plan.upgrades) {
          addToPluginManifest(ws, entry.name);
          removeFromPluginBlocklist(ws, entry.name);
        }
        invalidatePluginCache(ws);

        const toLoad = installOutcome.plan.upgrades
          .filter((entry) => entry.name === name || wasLoaded.has(entry.name))
          .map((entry) => entry.name);
        for (const pluginName of toLoad) {
          await loadPluginFromWorkDir(ws, pluginName);
          loadedDuringUpgrade.push(pluginName);
        }

        discardPluginBatchSnapshot(installOutcome.snapshot);
        invalidatePluginCache(ws);
        res.json({
          plugin: getPluginInfo(ws, name),
          registry: getRegistrySnapshot(ws),
          note:
            installOutcome.plan.upgrades.length > 1
              ? `Upgraded ${installOutcome.plan.upgrades.length} compatible plugins.`
              : undefined,
          upgradePlan: installOutcome.plan,
          upgraded: installOutcome.plan.upgrades,
        });
      } catch (loadErr: unknown) {
        const { message, kind } = classifyServerError(loadErr);
        await restorePluginBatchStateAndResync(ws, installOutcome.snapshot);
        for (const pluginName of loadedDuringUpgrade) {
          try {
            if (wasLoaded.has(pluginName)) {
              await loadPluginFromWorkDir(ws, pluginName);
            } else {
              unloadPluginFromRegistry(ws, pluginName, { removeStageDir: true });
            }
          } catch (restoreErr) {
            console.error(
              `[plugins] failed to restore loaded plugin "${pluginName}" after upgrade rollback:`,
              restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            );
          }
        }
        invalidatePluginCache(ws);
        return res.json({
          plugin: getPluginInfo(ws, name),
          registry: getRegistrySnapshot(ws),
          warning: `Upgrade failed to load; reverted plugin install changes. Error: ${message}`,
          kind,
          upgradePlan: installOutcome.plan,
          upgraded: [],
        });
      }
    });
  });

  /**
   * Return the list of YAML locations that would be broken if the given
   * plugin were uninstalled right now. The client shows this in a confirm
   * dialog so the user can bail out before orphaning declarations or task
   * capability references.
   *
   * Returns `{ category: null }` when the plugin can't be classified -
   * the uninstall is still safe to attempt but impact scanning is a no-op.
   */
  app.get('/api/plugins/uninstall-impact', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    res.json(buildUninstallImpact(ws, name));
  });

  /** Uninstall a plugin from workDir via direct filesystem ops (no package manager required) */
  app.post('/api/plugins/uninstall', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name } = req.body;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withPluginLock(ws, name, async () => {
      try {
        const acknowledged = acknowledgedImpactKeys(
          (req.body as { acknowledgedImpacts?: unknown }).acknowledgedImpacts,
        );
        const impact = buildUninstallImpact(ws, name);
        const unacknowledged = impact.impacts.filter(
          (entry) => !acknowledged.has(impactKey(entry)),
        );
        if (unacknowledged.length > 0) {
          return res.status(409).json({
            error:
              'Plugin references changed since the uninstall impact check. Review the latest impact list and try again.',
            kind: 'impact-changed',
            impact: { ...impact, impacts: unacknowledged },
          });
        }

        // Order: cheap/in-memory reversible steps first, irreversible
        // filesystem deletes last. If any step throws after the registry
        // unload, the user retries and the disk delete catches up; if the
        // disk delete throws first, the registry/manifest still match the
        // on-disk state (plugin still installed).

        // C4: remove the handler from the workspace registry first so
        // in-flight Run requests fail fast against the now-orphaned package.
        unloadPluginFromRegistry(ws, name);

        // Record the user's explicit uninstall so a subsequent workspace /
        // pipeline open won't silently re-install this plugin via the
        // `autoInstallDeclaredPlugins` path or reload it from a stray
        // on-disk copy. Cleared the moment the user clicks Install again.
        addToPluginBlocklist(ws, name);
        removeFromPluginManifest(ws, name);

        // Filesystem mutations: package.json edit (recoverable) precedes
        // node_modules rm (irreversible) inside uninstallPackage, so a
        // JSON parse error doesn't strand on-disk files referenced by a
        // package.json that still names them.
        uninstallPackage(ws, name);

        // Drop every staging copy under `.tagma/plugin-runtime/<name>/`. This
        // covers the currently-loaded one plus any orphans left behind by past
        // upgrade cycles or failed loads. Without this, repeated install /
        // upgrade / uninstall churn grows the plugin-runtime tree unboundedly.
        cleanupPluginStageTree(ws, name);

        invalidatePluginCache(ws);

        res.json({
          plugin: getPluginInfo(ws, name),
          registry: getRegistrySnapshot(ws),
          note: 'Plugin uninstalled.',
        });
      } catch (e: unknown) {
        res.status(500).json(pluginErrorResponse(e, 'Uninstall'));
      }
    });
  });

  /** Import a plugin from a local directory or .tgz file */
  app.post('/api/plugins/import-local', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const {
      path: localPath,
      declareInPipeline,
      capabilityToken,
    } = req.body as {
      path?: unknown;
      declareInPipeline?: unknown;
      capabilityToken?: unknown;
    };
    if (typeof localPath !== 'string' || !localPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    // C-IMPORT-PLUGIN: this endpoint loads arbitrary local code into the
    // workspace's plugin runtime. Treat it like /api/save-as: the path must
    // come from a user-driven file picker, gated by a one-shot capability
    // token bound to (workspaceKey, purpose='import-plugin', path). Without
    // this, any page that can reach the sidecar (via CSRF or a stray
    // unauthenticated origin) could trick the user into installing a plugin
    // off a path of the attacker's choosing.
    const absPath = resolve(localPath);
    try {
      consumeFsCapability(capabilityToken, absPath, 'import-plugin', ws);
    } catch (err) {
      return res.status(403).json({ error: errorMessage(err) });
    }
    if (!existsSync(absPath)) {
      return res.status(400).json({ error: `Path does not exist: ${absPath}` });
    }

    // Reject symlinks, special files, and any source that isn't a plain
    // directory or regular file. tarballs flow through the same handler
    // because the inspector recognises both. This blocks a class of
    // attacks where a symlink under the user's home would point at e.g.
    // `/etc` and trick the importer into reading config files; we are
    // careful not to silently follow that link.
    try {
      assertImportablePluginSource(absPath);
    } catch (err) {
      return res.status(400).json({ error: errorMessage(err) });
    }

    try {
      const pkgName = readLocalPluginPackageName(absPath);
      await withPluginLock(ws, pkgName, async () => {
        let installOutcome: Awaited<
          ReturnType<typeof installFromLocalPathWithRollbackSnapshot>
        > | null = null;
        try {
          installOutcome = await installFromLocalPathWithRollbackSnapshot(ws, absPath);
        } catch (snapErr) {
          return res.status(500).json(pluginErrorResponse(snapErr, 'Local import'));
        }

        let loaded = false;
        try {
          if (!installOutcome) throw new Error('Local import did not produce rollback state');
          const { result } = await loadPluginFromWorkDir(ws, pkgName);
          loaded = true;
          addToPluginManifest(ws, pkgName);
          removeFromPluginBlocklist(ws, pkgName);
          invalidatePluginCache(ws);
          let declaredPluginAdded = false;
          const canDeclareInPipeline =
            declareInPipeline === true &&
            !shouldBlockYamlEditLockMutation(getActiveYamlEditLock(ws), {
              // Declaring a local plugin updates the in-memory current
              // pipeline config, so keep that write behind the YAML lock even
              // though plugin package management itself remains available.
              path: '/api/pipeline',
              currentYamlPath: ws.yamlPath,
              workDir: ws.workDir,
            });
          if (canDeclareInPipeline) {
            const existing = ws.config.plugins ?? [];
            if (!existing.includes(pkgName)) {
              ws.config = { ...ws.config, plugins: [...existing, pkgName] };
              bumpRevision(ws);
              declaredPluginAdded = true;
            }
          }
          discardPluginSnapshot(installOutcome.snapshot);
          const note =
            result === 'replaced'
              ? 'Replaced the existing handler for this (category, type). The new code is live.'
              : undefined;
          res.json({
            plugin: getPluginInfo(ws, pkgName),
            registry: getRegistrySnapshot(ws),
            note,
            declaredPluginAdded,
            revision: ws.stateRevision,
          });
        } catch (loadErr: unknown) {
          const { message, kind } = classifyServerError(loadErr);
          if (loaded) {
            unloadPluginFromRegistry(ws, pkgName, { removeStageDir: true });
          }
          if (installOutcome) {
            await restorePluginStateAndResync(ws, installOutcome.snapshot);
            discardPluginSnapshot(installOutcome.snapshot);
            invalidatePluginCache(ws);
          }
          return res.status(500).json({
            plugin: getPluginInfo(ws, pkgName),
            registry: getRegistrySnapshot(ws),
            error: `Local import failed and was rolled back: ${message}`,
            kind,
          });
        }
      });
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
   * currently-loaded in-memory pipeline, which is the same declared set used by
   * an explicit plugin refresh.
   */
  app.get('/api/plugins/declared', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.json({
        declared: [],
        installed: [],
        missing: [],
        loaded: [],
        settings: { ...DEFAULT_EDITOR_SETTINGS },
      });
    }
    const declaredFromConfig = (ws.config.plugins ?? []).filter(isValidPluginName);
    const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins(ws);
    const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];
    const installed = declared.filter((n) => getPluginInfo(ws, n).installed);
    const missing = declared.filter((n) => !getPluginInfo(ws, n).installed);
    const loaded = declared.filter((n) => ws.loadedPluginMeta.has(n));
    res.json({
      declared,
      installed,
      missing,
      loaded,
      settings: readEditorSettings(ws),
    });
  });

  /**
   * Re-run the auto-load + auto-install sweep on demand. The Editor Settings
   * panel's "Install / Load Plugins" button uses this so the user can re-run the install
   * without having to close+reopen the workspace.
   *
   * Pulls declared plugins from BOTH the workspace's `.tagma/*.yaml` files
   * (so it covers every pipeline in the workspace, not just the one the user
   * happens to be editing) AND the in-memory pipeline. This explicit refresh
   * path is the only place declared plugins may be auto-installed or loaded.
   */
  app.post('/api/plugins/refresh', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }
    try {
      await withWorkspacePluginMutationLock(ws, async () => {
        const settings = readEditorSettings(ws);
        const declaredFromConfig = (ws.config.plugins ?? []).filter(isValidPluginName);
        const declaredFromWorkspace = discoverWorkspaceDeclaredPlugins(ws);
        const declared = [...new Set([...declaredFromConfig, ...declaredFromWorkspace])];

        // Snapshot pre-state so we can report what was already there vs. what
        // this call actually changed.
        const wasInstalled = new Set(declared.filter((n) => getPluginInfo(ws, n).installed));
        const wasLoaded = new Set(ws.loadedPluginMeta.keys());

        const loaded = await autoLoadInstalledPlugins(ws, {
          includeDeclared: true,
          allowAutoInstallDeclared: true,
          includeDiscovered: true,
        });

        const installed = declared.filter(
          (n) => getPluginInfo(ws, n).installed && !wasInstalled.has(n),
        );
        const newlyLoaded = loaded.filter((n) => !wasLoaded.has(n));
        const missing = declared.filter((n) => !getPluginInfo(ws, n).installed);

        res.json({
          settings,
          declared,
          missing,
          installed,
          loaded: newlyLoaded,
          errors: getLastAutoLoadErrors(ws),
          registry: getRegistrySnapshot(ws),
        });
      });
    } catch (e: unknown) {
      res.status(500).json(pluginErrorResponse(e, 'Refresh'));
    }
  });

  app.post('/api/plugins/load', async (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { name } = req.body;
    // `force: true` re-stages and re-imports even when the plugin is already
    // loaded. Local plugin authors editing under file:/link: specs need this
    // to pick up their latest changes without an uninstall/install cycle.
    const force = (req.body as { force?: unknown }).force === true;
    try {
      assertSafePluginName(name);
    } catch (err) {
      const { message } = classifyServerError(err);
      return res.status(400).json({ error: message });
    }
    if (!ws.workDir) {
      return res.status(400).json({ error: 'Set a working directory first' });
    }

    await withPluginLock(ws, name, async () => {
      const info = getPluginInfo(ws, name);
      if (!info.installed) {
        return res
          .status(404)
          .json({ error: `Plugin "${name}" is not installed. Install it first.` });
      }

      if (!force && ws.loadedPluginMeta.has(name)) {
        return res.json({ plugin: getPluginInfo(ws, name), registry: getRegistrySnapshot(ws) });
      }

      try {
        const { result } = await loadPluginFromWorkDir(ws, name);
        const note =
          result === 'replaced'
            ? 'Replaced the existing handler for this (category, type). The new code is live.'
            : undefined;
        res.json({ plugin: getPluginInfo(ws, name), registry: getRegistrySnapshot(ws), note });
      } catch (e: unknown) {
        res.status(500).json(pluginErrorResponse(e, 'Load'));
      }
    });
  });

  /** GET /api/marketplace/search?q=&category= */
  app.get('/api/marketplace/search', async (req, res) => {
    // Rate limit per workspace so a runaway script can't push the editor's
    // npm registry quota into 429 territory. We cap at 60 searches per
    // minute - the dashboard debounces user typing aggressively, so even a
    // patient human won't hit this.
    const wsKey = req.workspace?.key ?? 'default';
    const decision = takeRateLimitToken(`marketplace-search:${wsKey}`, {
      windowMs: 60_000,
      max: 60,
    });
    if (!decision.ok) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(decision.retryAfterMs / 1000)).toString());
      return res.status(429).json({
        error: 'Too many marketplace searches; slow down.',
        retryAfterMs: decision.retryAfterMs,
      });
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length > 256) {
      return res.status(400).json({ error: 'Marketplace query is too long (max 256 chars).' });
    }
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
    // We hit two upstream queries, add deterministic first-party package
    // names, and merge everything before fetching exact package manifests.
    //
    //   1. `keywords:tagma-plugin` - the canonical discovery channel. Plugin
    //      authors (including third parties) opt in by adding the keyword
    //      to their package.json. This is the long-term right answer.
    //
    //   2. Free-text "tagma" filtered to the @tagma/* scope - backstop for
    //      official packages that haven't declared the keyword yet. Note
    //      that not every @tagma/* package is a plugin (e.g. @tagma/sdk,
    //      @tagma/types are libraries) - the manifest check below
    //      discards any candidate whose package.json doesn't carry a
    //      `tagmaPlugin` field, so this scope-based discovery is safe.
    //
    //   3. First-party names - direct manifest fetches keep official plugins
    //      visible while npm search indexing catches up immediately after
    //      publish. These still pass the same tagmaPlugin validation below.
    const keywordText = q ? `keywords:tagma-plugin ${q}` : 'keywords:tagma-plugin';
    const scopeText = q ? `tagma ${q}` : 'tagma';
    const queryNeedle = q.toLowerCase();
    const compactQueryNeedle = queryNeedle.replace(/[\s_-]+/g, '');
    const officialHits = compactQueryNeedle
      ? OFFICIAL_MARKETPLACE_PLUGIN_NAMES.filter((name) => {
          const lower = name.toLowerCase();
          return (
            lower.includes(queryNeedle) ||
            lower.replace(/[\s_-]+/g, '').includes(compactQueryNeedle)
          );
        })
      : OFFICIAL_MARKETPLACE_PLUGIN_NAMES;
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
      let upstreamError: unknown = null;
      const keywordHits = await fetchSearch(keywordText, false).catch((e) => {
        upstreamError = e;
        return [] as string[];
      });
      const scopeHits = await fetchSearch(scopeText, true).catch((e) => {
        if (!upstreamError) upstreamError = e;
        return [] as string[];
      });
      const rawNames = Array.from(new Set([...officialHits, ...keywordHits, ...scopeHits]));
      const resolved = await resolveMarketplaceEntries(rawNames);
      const filtered = category ? resolved.filter((e) => e.category === category) : resolved;
      // Sort: weekly downloads desc (null goes to the bottom), then name asc.
      filtered.sort((a, b) => {
        const ad = a.weeklyDownloads ?? -1;
        const bd = b.weeklyDownloads ?? -1;
        if (bd !== ad) return bd - ad;
        return a.name.localeCompare(b.name);
      });
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
