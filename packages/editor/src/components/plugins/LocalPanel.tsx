import { useMemo, useState } from 'react';
import { AlertCircle, Check, Download, Loader2, Package, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { PluginCategory, PluginInfo } from '../../api/client';
import { errorHint } from './plugin-errors';
import type { PluginActionState } from './PluginsPage';
import {
  ActionButton,
  BusyLabel,
  PLUGIN_CARD_GRID_CLASSES,
  PluginCardShell,
  StatusBadge,
} from './plugin-card';

interface LocalPanelProps {
  plugins: readonly PluginInfo[];
  autoLoadErrors: ReadonlyArray<{ name: string; message: string }>;
  declaredSet: ReadonlySet<string>;
  category: 'all' | PluginCategory;
  loading: boolean;
  actionState: PluginActionState;
  onInstall: (name: string) => void;
  onUninstall: (name: string) => void;
  onLoad: (name: string) => void;
  onDismissAction: () => void;
}

const KNOWN_CATEGORIES: ReadonlySet<PluginCategory> = new Set([
  'drivers', 'triggers', 'completions', 'middlewares',
]);

/**
 * Stateless card view of the workspace's local plugins. All data (plugins,
 * auto-load errors, action state) flows in from PluginsPage — this component
 * only renders and forwards button clicks.
 *
 * "Local" here means "anything the server knows about for this workspace":
 * a plugin may live in `node_modules` without appearing in `pipeline.plugins[]`,
 * or be declared in YAML but not yet installed. The panel shows the union of
 * those sources and annotates whether each is installed, loaded into the
 * runtime registry, and/or declared in YAML.
 */
export function LocalPanel({
  plugins,
  autoLoadErrors,
  declaredSet,
  category,
  loading,
  actionState,
  onInstall,
  onUninstall,
  onLoad,
  onDismissAction,
}: LocalPanelProps) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return plugins.filter((p) => {
      if (category !== 'all' && !p.categories.includes(category)) return false;
      if (!q) return true;
      const haystack = `${p.name} ${p.description ?? ''} ${p.categories.join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [plugins, search, category]);

  const actionBannerVisible =
    actionState.type === 'error' || actionState.type === 'success';

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="shrink-0 px-6 pt-3 pb-3 border-b border-tagma-border bg-tagma-surface/20">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tagma-muted-dim pointer-events-none" />
            <input
              type="text"
              className="w-full pl-10 pr-3 py-2 text-[12px] bg-tagma-bg border border-tagma-border text-tagma-text placeholder:text-tagma-muted-dim focus:border-tagma-accent focus:outline-none transition-colors"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search installed plugins…"
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-tagma-muted-dim tracking-[0.14em] uppercase">
            <Package size={11} />
            <span>Workspace</span>
          </div>
        </div>
      </div>

      {autoLoadErrors.length > 0 && (
        <div className="shrink-0 mx-6 mt-4 relative flex items-start gap-3 px-4 py-3 bg-tagma-error/5 border border-tagma-error/30">
          <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-tagma-error" aria-hidden="true" />
          <AlertCircle size={13} className="shrink-0 mt-0.5 text-tagma-error" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-medium text-tagma-error tracking-wide">
              {autoLoadErrors.length} plugin{autoLoadErrors.length === 1 ? '' : 's'} failed to auto-load
            </p>
            <ul className="mt-1 space-y-0.5">
              {autoLoadErrors.map((err) => (
                <li key={err.name} className="text-[10px] font-mono text-tagma-muted-dim truncate" title={err.message}>
                  <span className="text-tagma-error/80">{err.name}</span>
                  <span className="text-tagma-border mx-1">—</span>
                  {err.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {loading && plugins.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted-dim gap-3">
            <Loader2 size={26} className="animate-spin opacity-70" />
            <p className="text-[11px] tracking-wide">Loading plugins…</p>
          </div>
        ) : filtered.length > 0 ? (
          <div className={PLUGIN_CARD_GRID_CLASSES}>
            {filtered.map((p) => (
              <LocalPluginCard
                key={p.name}
                plugin={p}
                declared={declaredSet.has(p.name)}
                actionState={actionState}
                onInstall={onInstall}
                onUninstall={onUninstall}
                onLoad={onLoad}
              />
            ))}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted-dim gap-3">
            <Package size={36} className="opacity-30" />
            <p className="text-[11px] tracking-wide text-tagma-muted">
              {search
                ? 'No plugins match your search.'
                : category !== 'all'
                  ? `No ${category} plugins installed.`
                  : 'No plugins installed in this workspace.'}
            </p>
            <p className="text-[10px] text-tagma-muted-dim">
              Open the <span className="text-tagma-accent">Marketplace</span> tab to discover and install plugins.
            </p>
          </div>
        )}
      </div>

      {actionBannerVisible && (
        <div className="shrink-0 mx-6 mb-4">
          <ActionBanner state={actionState} onDismiss={onDismissAction} />
        </div>
      )}
    </div>
  );
}

function LocalPluginCard({
  plugin,
  declared,
  actionState,
  onInstall,
  onUninstall,
  onLoad,
}: {
  plugin: PluginInfo;
  declared: boolean;
  actionState: PluginActionState;
  onInstall: (name: string) => void;
  onUninstall: (name: string) => void;
  onLoad: (name: string) => void;
}) {
  const isBusy =
    actionState.type === 'loading' && actionState.name === plugin.name;
  const busyAction = isBusy ? actionState.action : null;
  const disabled = actionState.type === 'loading';

  // Pick the first known category for the glyph; unknown/empty → fallback.
  const primaryCategory: PluginCategory | null = useMemo(() => {
    for (const c of plugin.categories) {
      if (KNOWN_CATEGORIES.has(c as PluginCategory)) return c as PluginCategory;
    }
    return null;
  }, [plugin.categories]);

  const statuses = (
    <>
      {plugin.installed
        ? <StatusBadge variant="installed" />
        : <StatusBadge variant="missing" />}
      {plugin.loaded && <StatusBadge variant="loaded" />}
      {declared && <StatusBadge variant="declared" />}
    </>
  );

  const actions = isBusy ? (
    <BusyLabel label={busyActionLabel(busyAction)} />
  ) : (
    <div className="flex flex-col gap-1.5 items-end">
      {!plugin.installed && (
        <ActionButton
          variant="primary"
          icon={<Download size={12} />}
          label="Install"
          onClick={() => onInstall(plugin.name)}
          disabled={disabled}
          title="Install — downloads from npm and records in the workspace manifest"
        />
      )}
      {plugin.installed && !plugin.loaded && (
        <ActionButton
          variant="primary"
          icon={<RefreshCw size={12} />}
          label="Load"
          onClick={() => onLoad(plugin.name)}
          disabled={disabled}
          title="Load into registry — runtime only"
        />
      )}
      {plugin.installed && (
        <ActionButton
          variant="danger"
          icon={<Trash2 size={12} />}
          label="Uninstall"
          onClick={() => onUninstall(plugin.name)}
          disabled={disabled}
        />
      )}
    </div>
  );

  return (
    <PluginCardShell
      category={primaryCategory}
      accent={declared}
      name={plugin.name}
      version={plugin.version}
      description={plugin.description}
      statuses={statuses}
      actions={actions}
    />
  );
}

function busyActionLabel(action: string | null): string {
  switch (action) {
    case 'install': return 'Installing…';
    case 'uninstall': return 'Uninstalling…';
    case 'load': return 'Loading…';
    case 'import': return 'Importing…';
    default: return 'Working…';
  }
}

function ActionBanner({
  state,
  onDismiss,
}: {
  state: PluginActionState;
  onDismiss: () => void;
}) {
  if (state.type !== 'error' && state.type !== 'success') return null;

  const isError = state.type === 'error';
  const Icon = isError ? AlertCircle : Check;

  return (
    <div
      className={`relative flex items-start gap-3 px-4 py-3 border ${
        isError
          ? 'bg-tagma-error/5 border-tagma-error/30'
          : 'bg-tagma-success/5 border-tagma-success/30'
      }`}
    >
      <span
        className={`absolute left-0 top-0 bottom-0 w-[2px] ${
          isError ? 'bg-tagma-error' : 'bg-tagma-success'
        }`}
        aria-hidden="true"
      />
      <Icon
        size={13}
        className={`shrink-0 mt-0.5 ${isError ? 'text-tagma-error' : 'text-tagma-success'}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-tagma-text truncate">{state.name}</span>
          <span className="text-[10px] text-tagma-muted-dim">
            {isError ? `${capitalize(state.action)} failed` : state.message}
          </span>
        </div>
        {isError && (
          <>
            <div className="mt-1 text-[10px] text-tagma-muted-dim leading-relaxed">
              {errorHint(state.kind)}
            </div>
            <pre className="mt-2 px-2 py-1.5 bg-black/50 border border-tagma-error/20 text-tagma-error/90 text-[9px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {state.message}
            </pre>
          </>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 text-tagma-muted-dim hover:text-tagma-text text-[16px] leading-none w-5 h-5 flex items-center justify-center"
        title="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
