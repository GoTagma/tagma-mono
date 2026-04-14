import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, FolderOpen, Package, RefreshCw, Store,
} from 'lucide-react';
import { api } from '../../api/client';
import type {
  MarketplaceEntry,
  PluginCategory,
  PluginInfo,
  PluginRegistry,
} from '../../api/client';
import {
  classifyError,
  extractErrorMessage,
  type ErrorKind,
} from './plugin-errors';
import { LocalPanel } from './LocalPanel';
import { MarketplacePanel } from './MarketplacePanel';

type Tab = 'local' | 'marketplace';
type CategoryFilter = 'all' | PluginCategory;

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

export type PluginAction = 'install' | 'uninstall' | 'load' | 'import';

interface PluginsPageProps {
  workDir: string;
  declaredPlugins: readonly string[];
  onBack: () => void;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onPluginsChange: (plugins: string[]) => void;
  onRequestBrowseLocal: () => void;
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
}: PluginsPageProps) {
  const [tab, setTab] = useState<Tab>('local');
  const [category, setCategory] = useState<CategoryFilter>('all');

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [autoLoadErrors, setAutoLoadErrors] = useState<ReadonlyArray<{ name: string; message: string }>>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);

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
  const declaredSet = useMemo(() => new Set(declaredPlugins), [declaredPlugins]);

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
      ].join(' ').toLowerCase();
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

  const handleInstall = useCallback(async (name: string) => {
    setActionState({ type: 'loading', name, action: 'install' });
    try {
      const result = await api.installPlugin(name);
      onRegistryUpdate(result.registry);
      if (!declaredPlugins.includes(name)) {
        onPluginsChange([...declaredPlugins, name]);
      }
      await refreshInstalled();
      setActionState({
        type: 'success',
        name,
        action: 'install',
        message: result.warning
          ?? (result.plugin.version ? `Installed v${result.plugin.version}` : 'Installed'),
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
  }, [declaredPlugins, onRegistryUpdate, onPluginsChange, refreshInstalled]);

  const handleUninstall = useCallback(async (name: string) => {
    setActionState({ type: 'loading', name, action: 'uninstall' });
    try {
      const result = await api.uninstallPlugin(name);
      onRegistryUpdate(result.registry);
      if (declaredPlugins.includes(name)) {
        onPluginsChange(declaredPlugins.filter((p) => p !== name));
      }
      await refreshInstalled();
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
  }, [declaredPlugins, onRegistryUpdate, onPluginsChange, refreshInstalled]);

  const handleLoad = useCallback(async (name: string) => {
    setActionState({ type: 'loading', name, action: 'load' });
    try {
      const result = await api.loadPlugin(name);
      onRegistryUpdate(result.registry);
      await refreshInstalled();
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
  }, [onRegistryUpdate, refreshInstalled]);

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
        />
        <div className="flex-1 flex flex-col items-center justify-center text-tagma-muted gap-3">
          <Package size={48} className="opacity-30" />
          <p className="text-sm">Open a workspace to manage plugins.</p>
          <button
            onClick={onBack}
            className="px-3 py-1.5 text-xs bg-tagma-bg border border-tagma-border hover:border-tagma-accent transition-colors"
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
      />

      <div className="flex-1 min-h-0 flex">
        <aside className="w-44 shrink-0 border-r border-tagma-border bg-tagma-surface/40 py-3 px-2">
          <div className="text-[10px] uppercase tracking-wide text-tagma-muted mb-2 px-2">
            Categories
          </div>
          <nav className="flex flex-col gap-0.5">
            {CATEGORY_TABS.map((c) => (
              <button
                key={c.key}
                onClick={() => setCategory(c.key)}
                className={`text-left px-2 py-1 text-[11px] transition-colors ${
                  category === c.key
                    ? 'bg-blue-500/15 text-blue-300 border-l-2 border-blue-400'
                    : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-bg border-l-2 border-transparent'
                }`}
              >
                {c.label}
              </button>
            ))}
          </nav>

          {tab === 'local' && (
            <div className="mt-4 px-2">
              <button
                onClick={onRequestBrowseLocal}
                className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] bg-orange-500/10 border border-orange-500/25 text-orange-300 hover:bg-orange-500/20 transition-colors"
                title="Import a plugin from a local directory"
              >
                <FolderOpen size={11} />
                <span>Import local…</span>
              </button>
            </div>
          )}
        </aside>

        <section className="flex-1 min-h-0 overflow-hidden">
          {tab === 'local' ? (
            <LocalPanel
              plugins={plugins}
              autoLoadErrors={autoLoadErrors}
              declaredSet={declaredSet}
              category={category}
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
              onQueryChange={setMarketplaceQuery}
              category={category}
              installedNames={installedNames}
              declaredSet={declaredSet}
              actionState={actionState}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              onDismissAction={() => setActionState({ type: 'idle' })}
              onRetry={fetchMarketplace}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function PluginsHeader({
  tab,
  onTab,
  onBack,
  onRefresh,
  refreshing,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onBack: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="h-11 bg-tagma-surface border-b border-tagma-border flex items-center px-2 gap-2 shrink-0">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-tagma-muted hover:text-tagma-text transition-colors px-2 py-1"
      >
        <ArrowLeft size={12} />
        <span>Back to Editor</span>
      </button>
      <div className="w-px h-5 bg-tagma-border" />
      <div className="flex items-center gap-1.5 px-2">
        <Package size={13} className="text-tagma-accent" />
        <span className="text-xs font-medium text-tagma-text">Plugins</span>
      </div>
      <div className="w-px h-5 bg-tagma-border" />
      <div className="flex items-center gap-1">
        <TabButton
          active={tab === 'local'}
          onClick={() => onTab('local')}
          icon={<Package size={12} />}
          label="Local"
        />
        <TabButton
          active={tab === 'marketplace'}
          onClick={() => onTab('marketplace')}
          icon={<Store size={12} />}
          label="Marketplace"
        />
      </div>
      <div className="flex-1" />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="flex items-center gap-1 px-2 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-accent/60 transition-colors disabled:opacity-50"
        title="Refresh plugin list"
      >
        <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
        <span>Refresh</span>
      </button>
    </header>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium border transition-colors ${
        active
          ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
          : 'bg-transparent text-tagma-muted border-transparent hover:text-tagma-text hover:bg-tagma-bg'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
