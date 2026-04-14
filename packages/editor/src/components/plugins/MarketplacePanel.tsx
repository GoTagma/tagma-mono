import {
  AlertCircle, AlertTriangle, Calendar, Check, Download, Loader2, Package, Search, Store, Trash2, TrendingUp,
} from 'lucide-react';
import type { MarketplaceEntry, PluginCategory } from '../../api/client';
import { errorHint, formatDownloads } from './plugin-errors';
import type { PluginActionState } from './PluginsPage';
import {
  ActionButton,
  BusyLabel,
  MetaBullet,
  MetaItem,
  PLUGIN_CARD_GRID_CLASSES,
  PluginCardShell,
  StatusBadge,
} from './plugin-card';

interface MarketplacePanelProps {
  entries: readonly MarketplaceEntry[];
  loading: boolean;
  loadError: string | null;
  upstreamWarning: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  category: 'all' | PluginCategory;
  installedNames: ReadonlySet<string>;
  declaredSet: ReadonlySet<string>;
  actionState: PluginActionState;
  onInstall: (name: string) => void;
  onUninstall: (name: string) => void;
  onDismissAction: () => void;
  onRetry: () => void;
}

/**
 * Stateless marketplace browser. Every piece of state — entries, loading,
 * errors, current action — is owned by PluginsPage and flows in as props.
 *
 * The search box writes straight into the parent's committed query (no
 * local debounce) because filtering is now a pure client-side pass over
 * the cached "All" list — recomputing on every keystroke is free and any
 * debounce would only add latency for no network-traffic reason.
 *
 * Install and Uninstall fire immediately on click — no confirmation dialog —
 * because the user is already inside the editor's Plugins page and the
 * button label explicitly states the action.
 */
export function MarketplacePanel({
  entries,
  loading,
  loadError,
  upstreamWarning,
  query,
  onQueryChange,
  category,
  installedNames,
  declaredSet,
  actionState,
  onInstall,
  onUninstall,
  onDismissAction,
  onRetry,
}: MarketplacePanelProps) {
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
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search the npm marketplace…"
            />
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-tagma-muted-dim tracking-[0.14em] uppercase">
            <Store size={11} />
            <span>npm · tagma-plugin</span>
          </div>
        </div>
      </div>

      {upstreamWarning && (
        <div className="shrink-0 mx-6 mt-4 relative flex items-start gap-3 px-4 py-3 bg-tagma-warning/5 border border-tagma-warning/30">
          <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-tagma-warning" aria-hidden="true" />
          <AlertTriangle size={13} className="shrink-0 mt-0.5 text-tagma-warning" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-medium text-tagma-warning tracking-wide">Partial results</div>
            <div className="text-[10px] text-tagma-muted-dim leading-relaxed mt-0.5">
              The npm registry reported an error — the list below may be incomplete. Try
              <button
                onClick={onRetry}
                className="mx-1 underline decoration-dotted underline-offset-2 text-tagma-warning hover:text-tagma-accent"
              >
                refreshing
              </button>
              in a moment.
            </div>
            <pre className="mt-2 px-2 py-1.5 bg-black/50 border border-tagma-warning/20 text-tagma-warning/90 text-[9px] font-mono whitespace-pre-wrap break-words max-h-16 overflow-y-auto">
              {upstreamWarning}
            </pre>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted-dim gap-3">
            <Loader2 size={26} className="animate-spin opacity-70" />
            <p className="text-[11px] tracking-wide">Searching npm…</p>
          </div>
        ) : loadError ? (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            <AlertCircle size={28} className="text-tagma-error opacity-70" />
            <p className="text-[11px] tracking-wide text-tagma-error">{loadError}</p>
            <button
              onClick={onRetry}
              className="mt-1 px-3 py-1.5 text-[11px] tracking-wide uppercase text-tagma-muted hover:text-tagma-accent border border-tagma-border hover:border-tagma-accent transition-colors"
            >
              Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted-dim gap-3">
            <Package size={36} className="opacity-30" />
            <p className="text-[11px] tracking-wide text-tagma-muted">
              {query
                ? `No ${category === 'all' ? '' : `${category.replace(/s$/, '')} `}plugins match "${query}"`
                : category === 'all'
                  ? 'No plugins found in the marketplace.'
                  : `No ${category} plugins found in the marketplace.`}
            </p>
            <p className="text-[10px] text-tagma-muted-dim max-w-sm text-center leading-relaxed">
              Plugin authors tag packages with <code className="font-mono text-tagma-muted">keywords: ["tagma-plugin"]</code> in <code className="font-mono text-tagma-muted">package.json</code>.
            </p>
            <button
              onClick={onRetry}
              className="mt-1 px-3 py-1.5 text-[11px] tracking-wide uppercase text-tagma-muted hover:text-tagma-accent border border-tagma-border hover:border-tagma-accent transition-colors"
            >
              Retry search
            </button>
          </div>
        ) : (
          <div className={PLUGIN_CARD_GRID_CLASSES}>
            {entries.map((entry) => (
              <MarketplaceCard
                key={entry.name}
                entry={entry}
                installed={installedNames.has(entry.name)}
                declared={declaredSet.has(entry.name)}
                actionState={actionState}
                onInstall={() => onInstall(entry.name)}
                onUninstall={() => onUninstall(entry.name)}
              />
            ))}
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

function MarketplaceCard({
  entry,
  installed,
  declared,
  actionState,
  onInstall,
  onUninstall,
}: {
  entry: MarketplaceEntry;
  installed: boolean;
  declared: boolean;
  actionState: PluginActionState;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const isBusy = actionState.type === 'loading' && actionState.name === entry.name;
  const busyAction = isBusy ? actionState.action : null;
  const disabled = actionState.type === 'loading';
  const publishDate = formatPublishDate(entry.date);
  const downloads = entry.weeklyDownloads !== null ? formatDownloads(entry.weeklyDownloads) : null;

  // Three-state badge:
  //   • installed              → green "Installed"
  //   • declared but missing   → red "Missing" (YAML references the plugin
  //                              but it isn't on disk — same signal Local
  //                              shows, so the two tabs stay consistent)
  //   • neither                → no badge (fresh marketplace entry)
  // The `declared` flag no longer masquerades as "installed"; it only
  // influences the card accent and the Missing-vs-nothing branch here.
  const statuses = installed
    ? <StatusBadge variant="installed" />
    : declared
      ? <StatusBadge variant="missing" />
      : null;

  // Inline meta ticker: downloads · date · author, separated by small
  // bullets. The `compactItems` helper skips missing values and keeps
  // the bullet pattern right even when some fields are null.
  const metaItems: React.ReactNode[] = [];
  if (downloads) {
    metaItems.push(
      <MetaItem key="dl" title="Weekly downloads">
        <TrendingUp size={10} />
        <span>{downloads}/wk</span>
      </MetaItem>,
    );
  }
  if (publishDate) {
    metaItems.push(
      <MetaItem
        key="date"
        title={entry.date ? `Last publish: ${new Date(entry.date).toLocaleString()}` : undefined}
      >
        <Calendar size={10} />
        <span>{publishDate}</span>
      </MetaItem>,
    );
  }
  if (entry.author) {
    metaItems.push(
      <MetaItem key="author">
        <span>by {entry.author}</span>
      </MetaItem>,
    );
  }

  const meta = metaItems.length > 0 ? (
    <>
      {metaItems.map((item, i) => (
        <span key={`meta-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <MetaBullet />}
          {item}
        </span>
      ))}
    </>
  ) : null;

  const actions = isBusy ? (
    <BusyLabel label={busyActionLabel(busyAction)} />
  ) : installed ? (
    <ActionButton
      variant="danger"
      icon={<Trash2 size={12} />}
      label="Uninstall"
      onClick={onUninstall}
      disabled={disabled}
    />
  ) : (
    <ActionButton
      variant="primary"
      icon={<Download size={12} />}
      label="Install"
      onClick={onInstall}
      disabled={disabled}
    />
  );

  return (
    <PluginCardShell
      category={entry.category}
      accent={declared}
      name={entry.name}
      version={entry.version}
      typeLabel={entry.type}
      description={entry.description}
      statuses={statuses}
      meta={meta}
      actions={actions}
    />
  );
}

function busyActionLabel(action: string | null): string {
  switch (action) {
    case 'install': return 'Installing…';
    case 'uninstall': return 'Uninstalling…';
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

function formatPublishDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
