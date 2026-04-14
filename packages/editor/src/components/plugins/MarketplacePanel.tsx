import {
  AlertCircle, AlertTriangle, Calendar, Check, Download, Loader2, Package, Search, Store, Trash2, TrendingUp,
} from 'lucide-react';
import type { MarketplaceEntry, PluginCategory } from '../../api/client';
import { errorHint, formatDownloads } from './plugin-errors';
import type { PluginActionState } from './PluginsPage';
import {
  ActionButton,
  BusyLabel,
  Chip,
  MetaChip,
  PLUGIN_CARD_GRID_CLASSES,
  PluginCardShell,
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
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-tagma-border bg-tagma-surface/30">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tagma-muted pointer-events-none" />
          <input
            type="text"
            className="field-input w-full pl-8 text-[11px]"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search the plugin marketplace…"
          />
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-tagma-muted px-2">
          <Store size={12} />
          <span>npm · keywords:tagma-plugin</span>
        </div>
      </div>

      {upstreamWarning && (
        <div className="shrink-0 mx-4 mt-3 px-3 py-2 bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-300">
          <div className="flex items-start gap-2">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">Partial results</div>
              <div className="text-tagma-muted">
                The npm registry reported an error — the list below may be incomplete. Try
                <button
                  onClick={onRetry}
                  className="mx-1 underline decoration-dotted underline-offset-2 hover:text-amber-200"
                >
                  refreshing
                </button>
                in a moment.
              </div>
              <pre className="mt-1 px-1.5 py-1 bg-black/40 border border-amber-500/20 text-amber-300 text-[9px] font-mono whitespace-pre-wrap break-words max-h-16 overflow-y-auto">
                {upstreamWarning}
              </pre>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted gap-2">
            <Loader2 size={24} className="animate-spin opacity-70" />
            <p className="text-[11px]">Searching npm…</p>
          </div>
        ) : loadError ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-error gap-2">
            <AlertCircle size={24} className="opacity-70" />
            <p className="text-[11px]">{loadError}</p>
            <button
              onClick={onRetry}
              className="px-2 py-1 text-[10px] bg-tagma-bg border border-tagma-border hover:border-tagma-accent transition-colors"
            >
              Retry
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-tagma-muted gap-2">
            <Package size={32} className="opacity-30" />
            <p className="text-[11px]">
              {query
                ? `No ${category === 'all' ? '' : `${category.replace(/s$/, '')} `}plugins match "${query}"`
                : category === 'all'
                  ? 'No plugins found in the marketplace.'
                  : `No ${category} plugins found in the marketplace.`}
            </p>
            <p className="text-[10px] text-tagma-muted/70">
              Plugin authors tag packages with <code className="font-mono">keywords: ["tagma-plugin"]</code> in <code className="font-mono">package.json</code>.
            </p>
            <button
              onClick={onRetry}
              className="mt-1 px-2 py-1 text-[10px] bg-tagma-bg border border-tagma-border hover:border-tagma-accent transition-colors"
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
                installed={installedNames.has(entry.name) || declaredSet.has(entry.name)}
                actionState={actionState}
                onInstall={() => onInstall(entry.name)}
                onUninstall={() => onUninstall(entry.name)}
              />
            ))}
          </div>
        )}
      </div>

      {actionBannerVisible && (
        <div className="shrink-0 mx-4 mb-3">
          <ActionBanner state={actionState} onDismiss={onDismissAction} />
        </div>
      )}
    </div>
  );
}

function MarketplaceCard({
  entry,
  installed,
  actionState,
  onInstall,
  onUninstall,
}: {
  entry: MarketplaceEntry;
  installed: boolean;
  actionState: PluginActionState;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const isBusy = actionState.type === 'loading' && actionState.name === entry.name;
  const busyAction = isBusy ? actionState.action : null;
  const disabled = actionState.type === 'loading';
  const publishDate = formatPublishDate(entry.date);

  const header = (
    <>
      <span className="text-[12px] font-mono text-tagma-text truncate">{entry.name}</span>
      <span className="text-[10px] text-tagma-muted shrink-0">v{entry.version}</span>
      {entry.weeklyDownloads !== null && (
        <MetaChip title="Weekly downloads">
          <TrendingUp size={9} />
          {formatDownloads(entry.weeklyDownloads)}
        </MetaChip>
      )}
    </>
  );

  const chips = (
    <>
      <Chip variant="accent">{entry.category}</Chip>
      <Chip variant="neutral" mono>{entry.type}</Chip>
      {installed && <Chip variant="success">installed</Chip>}
      {publishDate && (
        <MetaChip
          title={entry.date ? `Last publish: ${new Date(entry.date).toLocaleString()}` : undefined}
        >
          <Calendar size={9} />
          {publishDate}
        </MetaChip>
      )}
      {entry.author && (
        <span className="text-[9px] text-tagma-muted truncate">by {entry.author}</span>
      )}
    </>
  );

  const actions = isBusy ? (
    <BusyLabel label={busyActionLabel(busyAction)} />
  ) : installed ? (
    <ActionButton
      variant="danger"
      icon={<Trash2 size={11} />}
      label="Uninstall"
      onClick={onUninstall}
      disabled={disabled}
    />
  ) : (
    <ActionButton
      variant="primary"
      icon={<Download size={11} />}
      label="Install"
      onClick={onInstall}
      disabled={disabled}
    />
  );

  return (
    <PluginCardShell
      header={header}
      description={entry.description}
      chips={chips}
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
  const colorClass = isError
    ? 'bg-tagma-error/10 border-tagma-error/30 text-tagma-error'
    : 'bg-green-500/10 border-green-500/30 text-green-400';

  return (
    <div className={`px-3 py-2 border text-[10px] ${colorClass}`}>
      <div className="flex items-start gap-2">
        <Icon size={12} className="shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <span className="font-mono truncate">{state.name}</span>
            {isError && (
              <span className="text-tagma-muted">— {capitalize(state.action)} failed</span>
            )}
          </div>
          {isError ? (
            <>
              <div className="mt-0.5 text-tagma-muted">{errorHint(state.kind)}</div>
              <pre className="mt-1 px-1.5 py-1 bg-black/40 border border-tagma-error/20 text-tagma-error text-[9px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {state.message}
              </pre>
            </>
          ) : (
            <div className="text-tagma-muted mt-0.5">{state.message}</div>
          )}
        </div>
        <button onClick={onDismiss} className="text-tagma-muted hover:text-tagma-text shrink-0" title="Dismiss">
          &times;
        </button>
      </div>
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
