import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, FolderOpen, Package, RefreshCw, Search, Store } from 'lucide-react';
import { api } from '../../api/client';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';
import type {
  MarketplaceEntry,
  PluginCategory,
  PluginInfo,
  PluginRegistry,
  PluginUninstallImpact,
} from '../../api/client';
import { classifyError, extractErrorMessage, type ErrorKind } from './plugin-errors';
import { LocalPanel } from './LocalPanel';
import { MarketplacePanel } from './MarketplacePanel';

type Tab = 'local' | 'marketplace';
type CategoryFilter = 'all' | PluginCategory;

const KNOWN_CATEGORIES: ReadonlySet<PluginCategory> = new Set([
  'drivers',
  'triggers',
  'completions',
  'middlewares',
]);

/**
 * Shared action state for install / uninstall / load / import operations
 * across both tabs. Lifted to the page so the same feedback flows no matter
 * which panel triggered the action, and so one panel can react to a mutation
 * fired by the other (e.g. installing from the marketplace immediately
 * updates the Local tab on return).
 */
export type PluginActionState =
  | { type: 'idle' }
  | { type: 'loading'; name: string; action: PluginAction }
  | { type: 'success'; name: string; action: PluginAction; message: string }
  | { type: 'error'; name: string; action: PluginAction; message: string; kind: ErrorKind };

export type PluginAction = 'install' | 'uninstall' | 'load' | 'import' | 'upgrade';

interface PluginsPageProps {
  workDir: string;
  declaredPlugins: readonly string[];
  onBack: () => void;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onPluginsChange: (plugins: string[]) => void;
  onRequestBrowseLocal: () => void;
  /**
   * Refetch /api/state after an install / uninstall / load so the Task
   * panel's plugin-type validation warnings reflect the new registry.
   * Without this, the user would keep seeing stale "unknown type" warnings
   * (or miss new ones) until they touched a Task field.
   */
  onRefreshServerState: () => void | Promise<void>;
}

const CATEGORY_TABS: ReadonlyArray<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'completions', label: 'Completions' },
  { key: 'middlewares', label: 'Middlewares' },
];

const SUCCESS_DISMISS_MS = 2500;

/**
 * Top-level Plugins page. Hosts two tabs — Local and Marketplace — that
 * share a single page-level state store:
 *
 *   - `plugins`       — the authoritative list of plugins currently in the
 *                       workspace (via `/api/plugins`). The Local tab
 *                       renders these directly; the Marketplace tab uses
 *                       the set of installed names to decide whether to
 *                       show Install or Uninstall on each card.
 *   - `actionState`   — in-flight / success / error state for the last
 *                       mutation (install, uninstall, load, import). Both
 *                       tabs read it so button spinners and inline errors
 *                       stay consistent.
 *
 * By lifting both pieces of state up, the two panels can be stateless views:
 * they never fetch on their own, they always render the parent's data, and
 * a mutation in one panel is immediately reflected in the other.
 */
export function PluginsPage({
  workDir,
  declaredPlugins,
  onBack,
  onRegistryUpdate,
  onPluginsChange,
  onRequestBrowseLocal,
  onRefreshServerState,
}: PluginsPageProps) {
  const [tab, setTab] = useState<Tab>('local');
  const [category, setCategory] = useState<CategoryFilter>('all');

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [autoLoadErrors, setAutoLoadErrors] = useState<
    ReadonlyArray<{ name: string; message: string }>
  >([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);

  const [localQuery, setLocalQuery] = useState('');
  const [marketplaceQuery, setMarketplaceQuery] = useState('');
  // Cached "All" result from the last upstream fetch. Category and search
  // filtering run purely client-side against this list — clicking a
  // sidebar category never re-hits npm, which keeps the UI snappy and
  // avoids rate-limiting on the public registry. An explicit Refresh
  // click (or workspace change) is the only way to invalidate the cache.
  const [allMarketplaceEntries, setAllMarketplaceEntries] = useState<MarketplaceEntry[]>([]);
  const [marketplaceFetched, setMarketplaceFetched] = useState(false);
  const [marketplaceLoading, setMarketplaceLoading] = useState(false);
  const [marketplaceError, setMarketplaceError] = useState<string | null>(null);
  const [marketplaceWarning, setMarketplaceWarning] = useState<string | null>(null);
  const marketplaceReloadIdRef = useRef(0);

  const [actionState, setActionState] = useState<PluginActionState>({ type: 'idle' });

  // Auto-dismiss success messages so they don't linger as visual noise.
  useEffect(() => {
    if (actionState.type !== 'success') return;
    const id = setTimeout(() => {
      setActionState((s) => (s.type === 'success' ? { type: 'idle' } : s));
    }, SUCCESS_DISMISS_MS);
    return () => clearTimeout(id);
  }, [actionState]);

  // ── Installed plugins (shared between both tabs) ──
  const refreshInstalled = useCallback(async () => {
    if (!workDir) return;
    setPluginsLoading(true);
    try {
      const res = await api.listPlugins();
      setPlugins(res.plugins);
      setAutoLoadErrors(res.autoLoadErrors ?? []);
    } catch {
      // Non-fatal — keep whatever we had.
    } finally {
      setPluginsLoading(false);
    }
  }, [workDir]);

  useEffect(() => {
    refreshInstalled();
  }, [refreshInstalled]);

  // Also refetch whenever the parent's declared list changes, e.g. after a
  // YAML import. This keeps the Installed tab honest about what the current
  // workspace claims to need.
  useEffect(() => {
    refreshInstalled();
  }, [declaredPlugins, refreshInstalled]);

  // ── Marketplace fetch ──
  //
  // Always fetches the *full* "All" list (empty query, no category filter).
  // Category and search filtering happen in `filteredMarketplaceEntries`
  // below so we don't pay a round-trip to npm every time the user clicks
  // a sidebar category. The request-id guard keeps a slower previous
  // fetch from overwriting the result of a newer one.
  const fetchMarketplace = useCallback(async () => {
    if (!workDir) return;
    const requestId = ++marketplaceReloadIdRef.current;
    setMarketplaceLoading(true);
    setMarketplaceError(null);
    try {
      const res = await api.searchMarketplace('', undefined);
      if (marketplaceReloadIdRef.current !== requestId) return;
      setAllMarketplaceEntries(res.entries);
      setMarketplaceWarning(res.upstreamError ?? null);
      setMarketplaceFetched(true);
    } catch (e: unknown) {
      if (marketplaceReloadIdRef.current !== requestId) return;
      setMarketplaceError(extractErrorMessage(e));
      setMarketplaceWarning(null);
      // Intentionally leave marketplaceFetched false so the next tab open
      // re-triggers the lazy fetch instead of silently showing an empty list.
    } finally {
      if (marketplaceReloadIdRef.current === requestId) setMarketplaceLoading(false);
    }
  }, [workDir]);

  // Lazy fetch on first marketplace tab open. Users who only care about
  // the Installed view never hit npm at all.
  useEffect(() => {
    if (tab !== 'marketplace') return;
    if (marketplaceFetched) return;
    fetchMarketplace();
  }, [tab, marketplaceFetched, fetchMarketplace]);

  // Invalidate the cache when the workspace changes so we don't keep
  // showing a previous workspace's "installed" flags layered onto the
  // marketplace list. The next tab open re-fetches from scratch.
  useEffect(() => {
    setAllMarketplaceEntries([]);
    setMarketplaceFetched(false);
    setMarketplaceError(null);
    setMarketplaceWarning(null);
  }, [workDir]);

  const installedNames = useMemo(
    () => new Set(plugins.filter((p) => p.installed).map((p) => p.name)),
    [plugins],
  );
  // Installed-version lookup for the Marketplace tab. The Marketplace card
  // compares this against the latest version reported by npm to decide
  // whether to offer Upgrade next to Uninstall. Values may be `null` when
  // the plugin is installed but its manifest version could not be parsed —
  // in that case we simply don't offer an upgrade (better than a false
  // positive that would always claim "update available").
  const installedVersions = useMemo(
    () => new Map(plugins.filter((p) => p.installed).map((p) => [p.name, p.version])),
    [plugins],
  );
  const declaredSet = useMemo(() => new Set(declaredPlugins), [declaredPlugins]);

  // Per-category counts for the sidebar rail. Computed against whichever
  // data source the active tab is viewing so the numbers in the sidebar
  // match the cards the user is about to see. Unknown category strings
  // from PluginInfo.categories are ignored — we only report the four
  // SDK-known categories plus the "all" aggregate.
  const categoryCounts = useMemo<Record<CategoryFilter, number>>(() => {
    const counts: Record<CategoryFilter, number> = {
      all: 0,
      drivers: 0,
      triggers: 0,
      completions: 0,
      middlewares: 0,
    };
    if (tab === 'local') {
      counts.all = plugins.length;
      for (const p of plugins) {
        for (const cat of p.categories) {
          if (KNOWN_CATEGORIES.has(cat as PluginCategory)) {
            counts[cat as PluginCategory] += 1;
          }
        }
      }
    } else {
      counts.all = allMarketplaceEntries.length;
      for (const e of allMarketplaceEntries) {
        counts[e.category] += 1;
      }
    }
    return counts;
  }, [tab, plugins, allMarketplaceEntries]);

  // Client-side filter over the cached "All" list. Runs on every category
  // or query change; since the list is small and `useMemo` is cheap, this
  // feels instant even for hundreds of cached entries.
  const filteredMarketplaceEntries = useMemo(() => {
    const q = marketplaceQuery.trim().toLowerCase();
    return allMarketplaceEntries.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (!q) return true;
      const haystack = [
        entry.name,
        entry.description ?? '',
        entry.type,
        entry.author ?? '',
        entry.keywords.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allMarketplaceEntries, category, marketplaceQuery]);

  // ── Mutations ──
  //
  // Every write path funnels through one of these handlers so the action
  // state machine stays consistent. Each handler:
  //   1. Sets `loading` so both panels can show a spinner
  //   2. Calls the server
  //   3. Updates the registry + (if applicable) pipeline.plugins YAML
  //   4. Refetches the authoritative installed list
  //   5. Sets a `success` or `error` state for the same plugin name
  //
  // The YAML `pipeline.plugins[]` update is done client-side because the
  // server install endpoint only touches node_modules + .tagma/plugins.json.

  // Pending uninstall awaiting user confirmation. Holds the impact payload
  // so the dialog can list affected YAML locations. `null` means no dialog.
  const [uninstallConfirm, setUninstallConfirm] = useState<PluginUninstallImpact | null>(null);

  const handleInstall = useCallback(
    async (name: string) => {
      setActionState({ type: 'loading', name, action: 'install' });
      try {
        const result = await api.installPlugin(name);
        onRegistryUpdate(result.registry);
        if (!declaredPlugins.includes(name)) {
          onPluginsChange([...declaredPlugins, name]);
        }
        // Re-fetch the authoritative registry after the declared-plugins write.
        // `updatePipelineFields` fires an async /api/pipeline PATCH whose
        // applyState() does not touch `registry`, but the refetch here gives us
        // the same hydration path Apply Now / workspace-open uses so the Task
        // panel's trigger/completion/middleware dropdowns pick up the new type
        // immediately instead of waiting for a reload.
        try {
          onRegistryUpdate(await api.getRegistry());
        } catch {
          /* install already recorded; dropdowns will refresh on next fetch */
        }
        await refreshInstalled();
        // Re-fetch server state so validateRaw re-runs with the new known-types
        // snapshot and any pre-existing "unknown type" warnings clear out.
        await onRefreshServerState();
        setActionState({
          type: 'success',
          name,
          action: 'install',
          message:
            result.warning ??
            (result.plugin.version ? `Installed v${result.plugin.version}` : 'Installed'),
        });
      } catch (e: unknown) {
        const message = extractErrorMessage(e);
        setActionState({
          type: 'error',
          name,
          action: 'install',
          message,
          kind: classifyError(e, message),
        });
      }
    },
    [declaredPlugins, onRegistryUpdate, onPluginsChange, refreshInstalled, onRefreshServerState],
  );

  // Upgrade is a re-install against the latest registry version. The
  // install endpoint always wipes node_modules/<name> before extracting the
  // freshly-downloaded tarball, so re-hitting it on an already-installed
  // plugin is the supported upgrade path. A separate action label keeps the
  // busy spinner, success banner, and error classification distinct from a
  // fresh install so the user sees accurate feedback.
  const handleUpgrade = useCallback(
    async (name: string) => {
      setActionState({ type: 'loading', name, action: 'upgrade' });
      try {
        const result = await api.installPlugin(name);
        onRegistryUpdate(result.registry);
        try {
          onRegistryUpdate(await api.getRegistry());
        } catch {
          /* next refetch will reconcile */
        }
        await refreshInstalled();
        await onRefreshServerState();
        setActionState({
          type: 'success',
          name,
          action: 'upgrade',
          message:
            result.warning ??
            (result.plugin.version ? `Upgraded to v${result.plugin.version}` : 'Upgraded'),
        });
      } catch (e: unknown) {
        const message = extractErrorMessage(e);
        setActionState({
          type: 'error',
          name,
          action: 'upgrade',
          message,
          kind: classifyError(e, message),
        });
      }
    },
    [onRegistryUpdate, refreshInstalled, onRefreshServerState],
  );

  const performUninstall = useCallback(
    async (name: string) => {
      setActionState({ type: 'loading', name, action: 'uninstall' });
      try {
        const result = await api.uninstallPlugin(name);
        onRegistryUpdate(result.registry);
        // Intentionally do NOT strip `name` from pipeline.plugins[]. Tasks may
        // still reference the plugin's driver/type; removing the declaration
        // here would leave an inconsistent YAML (driver: codex but no
        // @tagma/driver-codex in plugins). Keeping the declaration means
        // validateRaw surfaces a soft warning immediately and Run fails fast
        // with a clear "Plugin load error" instead of silently drifting.
        // Re-installing the plugin restores the working state in one click.
        try {
          onRegistryUpdate(await api.getRegistry());
        } catch {
          /* next refetch will reconcile */
        }
        await refreshInstalled();
        // Re-run server-side validation so newly-orphaned task references
        // surface as warnings immediately, without having to touch the Task.
        await onRefreshServerState();
        setActionState({
          type: 'success',
          name,
          action: 'uninstall',
          message: 'Uninstalled',
        });
      } catch (e: unknown) {
        const message = extractErrorMessage(e);
        setActionState({
          type: 'error',
          name,
          action: 'uninstall',
          message,
          kind: classifyError(e, message),
        });
      }
    },
    [onRegistryUpdate, refreshInstalled, onRefreshServerState],
  );

  /**
   * Top-level uninstall entry point. Runs a pre-flight impact scan against
   * the workspace YAMLs; if any tasks reference this plugin's type the
   * dialog is shown and the real uninstall waits for user confirmation.
   * Otherwise it proceeds straight through — no nag dialogs for truly
   * unused plugins.
   */
  const handleUninstall = useCallback(
    async (name: string) => {
      // Probe first with a loading banner so the user sees *something* even
      // if the scan takes a beat. The dialog (if shown) will replace it.
      setActionState({ type: 'loading', name, action: 'uninstall' });
      let impact: PluginUninstallImpact;
      try {
        impact = await api.uninstallImpact(name);
      } catch (e: unknown) {
        // Impact scan is best-effort — if it fails, fall through to the
        // real uninstall rather than blocking the user.
        console.warn('[plugins] uninstall-impact scan failed:', e);
        await performUninstall(name);
        return;
      }
      if (impact.impacts.length === 0) {
        await performUninstall(name);
        return;
      }
      setUninstallConfirm(impact);
      // Reset the action state so the confirm dialog owns the UI; the loading
      // spinner will reappear when the user clicks "Uninstall anyway".
      setActionState({ type: 'idle' });
    },
    [performUninstall],
  );

  const handleLoad = useCallback(
    async (name: string) => {
      setActionState({ type: 'loading', name, action: 'load' });
      try {
        const result = await api.loadPlugin(name);
        onRegistryUpdate(result.registry);
        try {
          onRegistryUpdate(await api.getRegistry());
        } catch {
          /* next refetch will reconcile */
        }
        await refreshInstalled();
        await onRefreshServerState();
        setActionState({
          type: 'success',
          name,
          action: 'load',
          message: 'Loaded into registry',
        });
      } catch (e: unknown) {
        const message = extractErrorMessage(e);
        setActionState({
          type: 'error',
          name,
          action: 'load',
          message,
          kind: classifyError(e, message),
        });
      }
    },
    [onRegistryUpdate, refreshInstalled, onRefreshServerState],
  );

  // Explicit user-triggered refresh is the only way to re-hit npm once
  // we've cached a result. Clicking it always re-fetches; the flag is
  // set again by fetchMarketplace itself on success.
  const handleRefresh = useCallback(() => {
    refreshInstalled();
    if (tab === 'marketplace') fetchMarketplace();
  }, [refreshInstalled, fetchMarketplace, tab]);

  if (!workDir) {
    return (
      <div className="h-full flex flex-col bg-tagma-bg">
        <PluginsHeader
          tab={tab}
          onTab={setTab}
          onBack={onBack}
          onRefresh={handleRefresh}
          refreshing={pluginsLoading || marketplaceLoading}
          onImportLocal={onRequestBrowseLocal}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-tagma-muted gap-3">
          <Package size={48} className="opacity-30" />
          <p className="text-[12px] tracking-wide">Open a workspace to manage plugins.</p>
          <button
            onClick={onBack}
            className="px-4 py-2 text-[11px] tracking-wide uppercase text-tagma-muted hover:text-tagma-accent border border-tagma-border hover:border-tagma-accent transition-colors"
          >
            Back to Editor
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-tagma-bg">
      <PluginsHeader
        tab={tab}
        onTab={setTab}
        onBack={onBack}
        onRefresh={handleRefresh}
        refreshing={pluginsLoading || marketplaceLoading}
        onImportLocal={onRequestBrowseLocal}
        searchQuery={tab === 'local' ? localQuery : marketplaceQuery}
        onSearchQueryChange={tab === 'local' ? setLocalQuery : setMarketplaceQuery}
        searchPlaceholder={
          tab === 'local' ? 'Search installed plugins…' : 'Search the npm marketplace…'
        }
      />

      <div className="flex-1 min-h-0 flex">
        <CategorySidebar active={category} counts={categoryCounts} onSelect={setCategory} />

        <section className="flex-1 min-h-0 overflow-hidden">
          {tab === 'local' ? (
            <LocalPanel
              plugins={plugins}
              autoLoadErrors={autoLoadErrors}
              declaredSet={declaredSet}
              category={category}
              query={localQuery}
              loading={pluginsLoading}
              actionState={actionState}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              onLoad={handleLoad}
              onDismissAction={() => setActionState({ type: 'idle' })}
            />
          ) : (
            <MarketplacePanel
              entries={filteredMarketplaceEntries}
              loading={marketplaceLoading}
              loadError={marketplaceError}
              upstreamWarning={marketplaceWarning}
              query={marketplaceQuery}
              category={category}
              installedNames={installedNames}
              installedVersions={installedVersions}
              declaredSet={declaredSet}
              actionState={actionState}
              onInstall={handleInstall}
              onUpgrade={handleUpgrade}
              onUninstall={handleUninstall}
              onDismissAction={() => setActionState({ type: 'idle' })}
              onRetry={fetchMarketplace}
            />
          )}
        </section>
      </div>

      {uninstallConfirm && (
        <UninstallConfirmDialog
          impact={uninstallConfirm}
          onCancel={() => setUninstallConfirm(null)}
          onConfirm={() => {
            const name = uninstallConfirm.name;
            setUninstallConfirm(null);
            performUninstall(name);
          }}
        />
      )}
    </div>
  );
}

// ─── Uninstall confirm dialog ──────────────────────────────────────────
//
// Shown only when the pre-flight scan found at least one workspace YAML
// that still references the plugin's trigger/completion/middleware type.
// The list lets users see *which* tasks would break before clicking
// through, and grouping by file keeps the dialog readable even when the
// same plugin is used across multiple pipelines.
function UninstallConfirmDialog({
  impact,
  onCancel,
  onConfirm,
}: {
  impact: PluginUninstallImpact;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const byFile = useMemo(() => {
    const map = new Map<string, typeof impact.impacts>();
    for (const entry of impact.impacts) {
      const bucket = map.get(entry.file);
      if (bucket) {
        (bucket as unknown as (typeof impact.impacts)[number][]).push(entry);
      } else {
        map.set(entry.file, [entry] as unknown as typeof impact.impacts);
      }
    }
    return [...map.entries()];
  }, [impact]);

  const total = impact.impacts.length;
  const fileCount = byFile.length;

  return (
    <div
      className="fixed inset-0 z-[240] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[520px] max-h-[80vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 className="panel-title">Uninstall plugin?</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="text-[11px] text-tagma-text">
            <span className="font-mono text-tagma-accent">{impact.name}</span>
            {impact.category && impact.type && (
              <span className="text-tagma-muted">
                {' '}
                ({impact.category.replace(/s$/, '')}.
                <span className="font-mono">{impact.type}</span>)
              </span>
            )}
          </div>
          <div className="text-[11px] text-tagma-warning">
            {total} reference{total === 1 ? '' : 's'} in {fileCount} file
            {fileCount === 1 ? '' : 's'} will be left dangling. The tasks will still save but fail
            at run time until the plugin is reinstalled or the reference is removed.
          </div>
          <div className="border border-tagma-border bg-tagma-bg">
            {byFile.map(([file, entries]) => (
              <div key={file} className="border-b border-tagma-border last:border-b-0">
                <div className="px-3 py-1.5 bg-tagma-surface/40 text-[10px] font-mono text-tagma-text">
                  {file}
                </div>
                <ul className="px-3 py-1.5 space-y-0.5">
                  {entries.map((entry) => (
                    <li
                      key={`${entry.file}:${entry.location}`}
                      className="text-[10px] font-mono text-tagma-muted"
                    >
                      <span className="text-tagma-accent">{entry.trackId}</span>
                      {entry.taskId && (
                        <>
                          <span className="text-tagma-muted-dim">.</span>
                          <span className="text-tagma-text">{entry.taskId}</span>
                        </>
                      )}
                      <span className="text-tagma-muted-dim"> — {entry.location}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-tagma-border">
          <button
            onClick={onCancel}
            className="text-[11px] px-3 py-1 border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-accent transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="text-[11px] px-3 py-1 border border-tagma-error/60 text-tagma-error hover:bg-tagma-error/10 transition-colors"
          >
            Uninstall anyway
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ───────────────────────────────────────────────────────────
//
// Editorial category rail: each row is a numbered index (01..05) with
// a per-tab count pinned to the right. The active row lights up with
// a copper left-rule and a subtly raised surface, treating the index
// like a table-of-contents column in a print catalog rather than a
// stack of tiny toggleable chips.
function CategorySidebar({
  active,
  counts,
  onSelect,
}: {
  active: CategoryFilter;
  counts: Record<CategoryFilter, number>;
  onSelect: (category: CategoryFilter) => void;
}) {
  return (
    <aside className="w-48 shrink-0 border-r border-tagma-border bg-tagma-surface/25 py-5">
      <div className="px-5 pb-3 text-[9px] tracking-[0.22em] uppercase text-tagma-muted-dim">
        Categories
      </div>
      <nav className="flex flex-col">
        {CATEGORY_TABS.map((c, i) => {
          const isActive = active === c.key;
          const count = counts[c.key];
          return (
            <button
              key={c.key}
              onClick={() => onSelect(c.key)}
              className={`group relative flex items-baseline gap-3 py-2 pl-5 pr-4 text-left transition-colors ${
                isActive
                  ? 'text-tagma-text bg-tagma-surface/80'
                  : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-surface/40'
              }`}
            >
              {isActive && (
                <span
                  className="absolute left-0 top-1 bottom-1 w-[2px] bg-tagma-accent"
                  aria-hidden="true"
                />
              )}
              <span
                className={`w-5 text-[9px] font-mono tabular-nums leading-none ${
                  isActive ? 'text-tagma-accent' : 'text-tagma-muted-dim'
                }`}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="flex-1 text-[12px] tracking-wide leading-tight">{c.label}</span>
              <span
                className={`text-[10px] font-mono tabular-nums leading-none ${
                  isActive ? 'text-tagma-accent' : 'text-tagma-muted-dim'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// ─── Header ────────────────────────────────────────────────────────────
//
// Two-row header aligned with the editor / run toolbars:
//
//   1. Utility row — h-11 strip with back button on the left, refresh +
//      (Local-only) import-local on the right. Matches the h-11 Toolbar
//      used by Editor and RunView so switching pages doesn't shift the
//      canvas vertically.
//   2. Tab row — underline-style tabs. The active tab's copper border
//      aligns flush with the header's bottom border.
function PluginsHeader({
  tab,
  onTab,
  onBack,
  onRefresh,
  refreshing,
  onImportLocal,
  searchQuery,
  onSearchQueryChange,
  searchPlaceholder,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onBack: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  onImportLocal?: () => void;
  searchQuery?: string;
  onSearchQueryChange?: (q: string) => void;
  searchPlaceholder?: string;
}) {
  const isDesktop = hasDesktopBridge();
  return (
    <header className="shrink-0 bg-tagma-surface/60 border-b border-tagma-border">
      <div
        className={`h-11 flex items-center gap-2 border-b border-tagma-border/60 ${isDesktop ? 'app-drag-region pl-2 pr-0' : 'px-2'}`}
        onDoubleClick={(e) => {
          if (!isDesktop) return;
          if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
        }}
      >
        <UtilityLink onClick={onBack} icon={<ArrowLeft size={12} />} label="Back to Editor" />
        <div className="w-px h-5 bg-tagma-border" />
        <div className="flex items-center gap-1.5 px-2">
          <Package size={13} className="text-tagma-accent" />
          <span className="text-xs font-medium text-tagma-text truncate max-w-[160px]">
            Plugins
          </span>
        </div>
        <div className="flex-1 min-w-[32px]" />
        {tab === 'local' && onImportLocal && (
          <UtilityLink
            onClick={onImportLocal}
            icon={<FolderOpen size={12} />}
            label="Import Local"
            title="Import a plugin from a local directory"
          />
        )}
        <UtilityLink
          onClick={onRefresh}
          icon={<RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />}
          label="Refresh"
          title="Refresh plugin list"
          disabled={refreshing}
        />
        {isDesktop && <DesktopWindowControls />}
      </div>

      <div className="px-6 pt-2">
        <div className="flex items-end gap-7 -mb-px">
          <HeaderTab
            active={tab === 'local'}
            onClick={() => onTab('local')}
            icon={<Package size={13} />}
            label="Local"
          />
          <HeaderTab
            active={tab === 'marketplace'}
            onClick={() => onTab('marketplace')}
            icon={<Store size={13} />}
            label="Marketplace"
          />
          <div className="flex-1" />
          {onSearchQueryChange && (
            <div className="pb-2 w-64">
              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tagma-muted-dim pointer-events-none"
                />
                <input
                  type="text"
                  value={searchQuery ?? ''}
                  onChange={(e) => onSearchQueryChange(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full pl-7 pr-2 py-1 text-[11px] bg-tagma-bg border border-tagma-border text-tagma-text placeholder:text-tagma-muted-dim focus:border-tagma-accent focus:outline-none transition-colors"
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// Matches the button style used by the Back to Editor / toolbar controls in
// RunView and RunHistoryBrowser: plain `text-xs` in `tagma-muted`, hover to
// `tagma-text`, with `px-2 py-1 gap-1.5` padding. Keeping the three pages
// visually unified so switching between Editor / Run / History / Plugins
// feels like a single toolbar shifting contents, not four redesigns.
function UtilityLink({
  onClick,
  icon,
  label,
  title,
  disabled,
}: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function HeaderTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-0.5 pb-2.5 text-[12px] font-medium tracking-wide transition-colors border-b-2 ${
        active
          ? 'text-tagma-text border-tagma-accent'
          : 'text-tagma-muted border-transparent hover:text-tagma-text hover:border-tagma-border'
      }`}
    >
      <span className={active ? 'text-tagma-accent' : ''}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}
