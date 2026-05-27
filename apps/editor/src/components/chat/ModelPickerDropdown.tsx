import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, ChevronDown, Plug, Search, X } from 'lucide-react';
import type { Provider } from '../../api/opencode-chat';
import { FloatingPanel } from './FloatingPanel';

export interface ModelPickerValue {
  providerID: string;
  modelID: string;
}

export interface ModelPickerOption {
  id: string;
  value: string;
  label: string;
  status: string;
  context: number;
  reasoning: boolean;
}

export interface ModelPickerGroup {
  provider: Provider;
  providerLabel: string;
  models: ModelPickerOption[];
}

export function parseModelPickerValue(value: string | null | undefined): ModelPickerValue | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

export function buildModelPickerGroups(
  providers: readonly Provider[],
  query: string,
): ModelPickerGroup[] {
  const q = query.trim().toLowerCase();
  return providers
    .map((provider) => {
      const providerLabel = provider.name?.trim() || provider.id;
      const allModels = Object.values(provider.models ?? {}).map((model) => ({
        id: model.id,
        value: `${provider.id}/${model.id}`,
        label: model.name?.trim() || model.id,
        status: model.status,
        context: model.limit.context,
        reasoning: model.capabilities.reasoning,
      }));
      if (!q) return { provider, providerLabel, models: allModels };
      const providerHit =
        provider.id.toLowerCase().includes(q) || providerLabel.toLowerCase().includes(q);
      const models = providerHit
        ? allModels
        : allModels.filter(
            (model) =>
              model.id.toLowerCase().includes(q) || model.label.toLowerCase().includes(q),
          );
      return { provider, providerLabel, models };
    })
    .filter((group) => group.models.length > 0);
}

export function modelPickerLabel(
  providers: readonly Provider[],
  value: ModelPickerValue | null,
  placeholder: string,
  fallbackLabel?: string,
): string {
  if (!value) return fallbackLabel?.trim() || placeholder;
  const provider = providers.find((entry) => entry.id === value.providerID);
  const model = provider?.models[value.modelID];
  const providerLabel = provider?.name ?? value.providerID;
  const modelLabel = model?.name ?? value.modelID;
  return `${providerLabel} / ${modelLabel}`;
}

export function ModelPickerDropdown({
  providers,
  value,
  onSelect,
  disabled = false,
  placeholder = 'Pick model',
  fallbackLabel,
  showManageProviders = false,
  onManageProviders,
  buttonClassName = '',
  emptyText = 'No providers configured.',
}: {
  providers: readonly Provider[];
  value: ModelPickerValue | null;
  onSelect: (value: ModelPickerValue) => void;
  disabled?: boolean;
  placeholder?: string;
  fallbackLabel?: string;
  showManageProviders?: boolean;
  onManageProviders?: () => void;
  buttonClassName?: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const label = useMemo(
    () => modelPickerLabel(providers, value, placeholder, fallbackLabel),
    [fallbackLabel, placeholder, providers, value],
  );
  const groups = useMemo(() => buildModelPickerGroups(providers, query), [providers, query]);
  const totalModels = useMemo(
    () => providers.reduce((count, provider) => count + Object.keys(provider.models).length, 0),
    [providers],
  );
  const visibleCount = groups.reduce((count, group) => count + group.models.length, 0);
  const showFilter = totalModels > 5;
  const hasNoMatch = query.trim() !== '' && visibleCount === 0;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={`flex items-center gap-1 px-1.5 h-[22px] border border-tagma-border/70 text-[10px] font-mono text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted disabled:hover:border-tagma-border/70 transition-colors min-w-0 ${buttonClassName}`}
        title={label}
        aria-label="Open model picker"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        width={320}
        maxHeight={420}
      >
        {providers.length === 0 ? (
          <div className="px-3 py-4 text-[10px] font-mono text-tagma-muted">
            {emptyText}
          </div>
        ) : (
          <>
            {showFilter && (
              <div className="shrink-0 flex items-center gap-1.5 px-2 py-1.5 bg-tagma-bg border-b border-tagma-border">
                <Search size={11} className="text-tagma-muted-dim shrink-0" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && query) {
                      event.preventDefault();
                      event.stopPropagation();
                      setQuery('');
                    }
                  }}
                  placeholder={`Filter ${totalModels} models...`}
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[10px] font-mono text-tagma-text placeholder:text-tagma-muted/50"
                  style={{ boxShadow: 'none' }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                    className="shrink-0 p-0.5 text-tagma-muted hover:text-tagma-text transition-colors"
                    aria-label="Clear filter"
                    title="Clear filter"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {hasNoMatch && (
                <div className="px-3 py-6 flex flex-col items-center gap-1.5 text-tagma-muted-dim">
                  <Search size={16} className="opacity-40" />
                  <p className="text-[10px] font-mono">
                    No models match <span className="text-tagma-text">"{query}"</span>.
                  </p>
                </div>
              )}
              {groups.map((group) => (
                <section key={group.provider.id}>
                  <div className="sticky top-0 z-10 px-2 pt-2 pb-1 flex items-center gap-1.5 bg-tagma-bg border-b border-tagma-border/30">
                    <span className="text-[9px] font-mono font-medium text-tagma-muted uppercase tracking-wider truncate">
                      {group.providerLabel}
                    </span>
                    <span className="text-[9px] font-mono text-tagma-muted-dim">
                      - {group.models.length}
                    </span>
                  </div>
                  {group.models.map((model) => {
                    const active =
                      value?.providerID === group.provider.id && value.modelID === model.id;
                    return (
                      <button
                        key={model.value}
                        type="button"
                        onClick={() => {
                          onSelect({ providerID: group.provider.id, modelID: model.id });
                          setOpen(false);
                        }}
                        className={`w-full flex items-center gap-1.5 text-left pl-3 pr-2 py-1.5 text-[10px] font-mono hover:bg-tagma-border/30 transition-colors ${
                          active ? 'text-tagma-text bg-tagma-border/20' : 'text-tagma-muted'
                        }`}
                        title={`${model.id} - status: ${model.status} - context: ${model.context.toLocaleString()}`}
                      >
                        <span
                          className={`shrink-0 ${active ? 'text-tagma-ready' : 'text-tagma-muted/25'}`}
                        >
                          *
                        </span>
                        <span className="flex-1 truncate">{model.label}</span>
                        {model.reasoning && (
                          <Brain size={9} className="shrink-0 text-tagma-muted/70" />
                        )}
                        {model.status !== 'active' && (
                          <span className="shrink-0 text-[8px] text-tagma-muted/60 uppercase tracking-wider">
                            {model.status}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
            {showManageProviders && onManageProviders && (
              <div className="shrink-0 border-t border-tagma-border/50 bg-tagma-bg">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onManageProviders();
                  }}
                  className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-mono text-tagma-muted hover:text-tagma-text hover:bg-tagma-border/30 transition-colors"
                >
                  <Plug size={10} />
                  <span>Manage providers...</span>
                </button>
              </div>
            )}
          </>
        )}
      </FloatingPanel>
    </>
  );
}
