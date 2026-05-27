import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  X as XIcon,
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ProviderCatalogEntry } from '../../store/chat-store';
import type {
  AuthPrompt,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
} from '../../api/opencode-chat';
import type { CustomProviderEntry } from '../../api/custom-providers';
import { openExternalUrl } from '../../desktop';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import { CustomProviderModal } from './CustomProviderModal';

/**
 * Provider connect dialog — the GUI equivalent of opencode's CLI `/connect`.
 *
 * Renders the full provider catalog (anything opencode knows about — the
 * models.dev universe + opencode-zen + user-configured entries), with the
 * "Connected" badge driven by opencode's own `connected[]` list from
 * `GET /provider`. Each row offers whatever auth flows opencode registered
 * for that provider (OAuth / WellKnown for a handful), falling back to a
 * generic API-key input for the long tail — see `ProviderCatalogEntry`.
 *
 * Visuals follow the editor's dialog conventions: `.panel-header` + `.panel-title`
 * for the top bar, `.btn-primary` for the trailing Done, `.field-input` +
 * `.chip-xs` for the input/pill patterns, and the left-bar accent used
 * elsewhere (see LocalPanel's auto-load-error banner) to mark connected rows.
 */
export function ProviderConnectDialog() {
  const open = useChatStore((s) => s.connectOpen);
  const close = useChatStore((s) => s.closeConnect);
  const catalog = useChatStore((s) => s.providerCatalog);
  const refreshCatalog = useChatStore((s) => s.refreshProviderCatalog);
  const customProviders = useChatStore((s) => s.customProviders);
  const sending = useChatStore((s) => s.sending);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const blocked = sending || yamlEditLocked;

  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // The "Add custom" / "Edit" modal lives inside this dialog so it tears down
  // with the right dock. `editingEntry === null` distinguishes the two modes:
  //   - { customModalOpen: true, editingEntry: null } → create new
  //   - { customModalOpen: true, editingEntry: <entry> } → edit in place
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<CustomProviderEntry | null>(null);

  // Map of provider id → custom-provider entry, used to flag rows that this
  // dialog can edit/delete (vs. built-in models.dev entries where editing
  // would be meaningless). When the same id exists in both global and
  // workspace scope, the workspace entry wins (consistent with opencode's
  // merge precedence — project config overrides global).
  const customById = useMemo(() => {
    const map = new Map<string, CustomProviderEntry>();
    for (const entry of customProviders) {
      const existing = map.get(entry.id);
      if (!existing || (existing.scope === 'global' && entry.scope === 'workspace')) {
        map.set(entry.id, entry);
      }
    }
    return map;
  }, [customProviders]);

  // Refresh + reset query on open. Bootstrap seeded the catalog; refreshing
  // guards against a long session outlasting an opencode upgrade that added
  // new providers. Focus the search box on the next tick so the conditional
  // <input> has definitely mounted.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    refreshCatalog().catch(() => {
      /* surfaced via per-provider errors if a later write fails */
    });
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open, refreshCatalog]);

  // Keep Escape working even when focus is outside an <input> — the backdrop
  // click already closes, but users reach for Escape first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Partition + filter in one pass. Alphabetical within each group so the
  // order doesn't jitter across refreshes.
  const { connected, available } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (e: ProviderCatalogEntry) => {
      if (!q) return true;
      if (e.id.toLowerCase().includes(q)) return true;
      if (e.name.toLowerCase().includes(q)) return true;
      return e.env.some((v) => v.toLowerCase().includes(q));
    };
    const byName = (a: ProviderCatalogEntry, b: ProviderCatalogEntry) =>
      a.name.localeCompare(b.name);
    const connected: ProviderCatalogEntry[] = [];
    const available: ProviderCatalogEntry[] = [];
    for (const entry of catalog) {
      if (!matches(entry)) continue;
      (entry.connected ? connected : available).push(entry);
    }
    connected.sort(byName);
    available.sort(byName);
    return { connected, available };
  }, [catalog, query]);

  const totalCount = catalog.length;
  const visibleCount = connected.length + available.length;
  const isEmptyCatalog = totalCount === 0;
  const hasNoMatch = !isEmptyCatalog && visibleCount === 0;

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60"
      onClick={close}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[600px] max-w-[92vw] max-h-[80vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Connect providers"
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <Plug size={14} className="text-tagma-muted shrink-0" />
            <h2 className="panel-title truncate">Connect providers</h2>
            {totalCount > 0 && (
              <span className="text-[10px] font-mono text-tagma-muted-dim tracking-wider ml-1">
                {connected.length}/{totalCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setEditingEntry(null);
                setCustomModalOpen(true);
              }}
              disabled={blocked}
              title="Register a local Ollama, LM Studio, or other OpenAI-compatible endpoint"
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
            >
              <Plus size={10} />
              Add custom
            </button>
            <button
              onClick={close}
              className="p-1 text-tagma-muted hover:text-tagma-text"
              aria-label="Close dialog"
            >
              <XIcon size={14} />
            </button>
          </div>
        </div>

        {totalCount > 8 && (
          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-tagma-border">
            <Search size={12} className="text-tagma-muted-dim shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${totalCount} providers — name, id, or env var`}
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[11px] font-mono text-tagma-text placeholder:text-tagma-muted/50"
              style={{ boxShadow: 'none' }}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="shrink-0 p-0.5 text-tagma-muted hover:text-tagma-text"
                aria-label="Clear search"
                title="Clear search"
              >
                <XIcon size={12} />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isEmptyCatalog && (
            <div className="px-4 py-10 flex flex-col items-center gap-2 text-tagma-muted-dim">
              <Plug size={24} className="opacity-40" />
              <p className="text-[11px] font-mono text-tagma-muted">
                opencode reports no configurable providers.
              </p>
              <p className="text-[10px] font-mono">
                The catalog failed to load — try reopening the chat panel.
              </p>
            </div>
          )}
          {hasNoMatch && (
            <div className="px-4 py-10 flex flex-col items-center gap-2 text-tagma-muted-dim">
              <Search size={22} className="opacity-40" />
              <p className="text-[11px] font-mono">
                No providers match <span className="text-tagma-text">“{query}”</span>.
              </p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                className="text-[10px] font-mono text-tagma-muted hover:text-tagma-text underline"
              >
                Clear search
              </button>
            </div>
          )}

          {connected.length > 0 && (
            <Section title="Connected" count={connected.length}>
              {connected.map((entry) => (
                <ProviderRow
                  key={entry.id}
                  entry={entry}
                  blocked={blocked}
                  customEntry={customById.get(entry.id) ?? null}
                  onEditCustom={(target) => {
                    setEditingEntry(target);
                    setCustomModalOpen(true);
                  }}
                />
              ))}
            </Section>
          )}
          {available.length > 0 && (
            <Section title="Available" count={available.length}>
              {available.map((entry) => (
                <ProviderRow
                  key={entry.id}
                  entry={entry}
                  blocked={blocked}
                  customEntry={customById.get(entry.id) ?? null}
                  onEditCustom={(target) => {
                    setEditingEntry(target);
                    setCustomModalOpen(true);
                  }}
                />
              ))}
            </Section>
          )}
        </div>

        <div className="px-4 py-3 border-t border-tagma-border flex items-center justify-between gap-3">
          <div className="text-[10px] font-mono text-tagma-muted-dim truncate">
            Stored locally by opencode. No restart required.
          </div>
          <button onClick={close} className="btn-primary">
            Done
          </button>
        </div>
      </div>

      <CustomProviderModal
        open={customModalOpen}
        editing={editingEntry}
        onClose={() => {
          setCustomModalOpen(false);
          setEditingEntry(null);
        }}
      />
    </div>,
    document.body,
  );
}

/**
 * Section grouping — matches the editor's typical "uppercase tracking-wider
 * muted" small-caps label used in panels (e.g. EditorSettingsPanel's
 * WarnBox / success-box sections, DialogModal's detail groupings).
 */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="px-4 pt-3 pb-1.5 flex items-center gap-2 border-b border-tagma-border/30">
        <span className="text-[10px] font-mono font-medium text-tagma-muted uppercase tracking-wider">
          {title}
        </span>
        <span className="text-[10px] font-mono text-tagma-muted-dim">· {count}</span>
      </div>
      <div>{children}</div>
    </section>
  );
}

/**
 * One provider row. Connected rows get the left-bar accent used elsewhere
 * (see LocalPanel's auto-load-error banner) so success state is legible at a
 * glance without introducing a new visual pattern.
 *
 * Connected rows also expose a Disconnect action (= `opencode auth logout`).
 * Method blocks stay rendered either way, so users can rotate a key without
 * disconnecting first.
 *
 * Custom-config-backed rows (`customEntry !== null`) take a different shape:
 * the auth flow is the modal that wrote the config, so we suppress the
 * built-in API-key / OAuth blocks (they'd write to opencode's auth.json and
 * fight the config file for source-of-truth) and instead expose Edit /
 * Delete buttons that round-trip through the modal + DELETE route. The
 * "Custom" scope chip replaces the generic "Connected" badge so users know
 * which entries this dialog can manage in place.
 */
function ProviderRow({
  entry,
  blocked,
  customEntry,
  onEditCustom,
}: {
  entry: ProviderCatalogEntry;
  blocked: boolean;
  customEntry: CustomProviderEntry | null;
  onEditCustom: (target: CustomProviderEntry) => void;
}) {
  // Keep env pills capped — some providers (vertex, bedrock) list 4+ env
  // vars and the row gets cluttered. Show first two, hide the rest behind a
  // `+N` pill with a title tooltip so the info is still accessible.
  const envPills = entry.env.slice(0, 2);
  const envOverflow = entry.env.length > envPills.length ? entry.env.length - envPills.length : 0;
  const isCustom = customEntry !== null;

  return (
    <div
      className={`relative border-b border-tagma-border/30 last:border-b-0 ${
        entry.connected ? 'bg-tagma-ready/5' : ''
      }`}
    >
      {entry.connected && (
        <span
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-tagma-ready"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-mono font-medium text-tagma-text">{entry.name}</span>
          <span className="chip-xs border-tagma-border text-tagma-muted-dim font-normal">
            {entry.id}
          </span>
          {isCustom && (
            <span
              className="chip-xs border-tagma-accent/40 text-tagma-accent uppercase tracking-wider"
              title={
                customEntry!.scope === 'workspace'
                  ? "Defined in this workspace's .tagma/opencode.json"
                  : "Defined in this workspace's embedded OpenCode runtime"
              }
            >
              Custom · {customEntry!.scope === 'global' ? 'embedded' : 'workspace'}
            </span>
          )}
          {!isCustom &&
            envPills.map((v) => (
              <span
                key={v}
                className="chip-xs border-tagma-border/60 text-tagma-muted-dim font-normal"
              >
                {v}
              </span>
            ))}
          {!isCustom && envOverflow > 0 && (
            <span
              className="chip-xs border-tagma-border/60 text-tagma-muted-dim font-normal"
              title={entry.env.slice(envPills.length).join(', ')}
            >
              +{envOverflow}
            </span>
          )}
        </div>
        {isCustom ? (
          <CustomProviderActions
            customEntry={customEntry!}
            blocked={blocked}
            onEdit={() => onEditCustom(customEntry!)}
          />
        ) : (
          entry.connected && <DisconnectButton providerId={entry.id} blocked={blocked} />
        )}
        <StatusBadge connected={entry.connected} />
      </div>
      {!isCustom && (
        <div className="px-4 pb-3 space-y-2">
          {entry.methods.map((method, idx) => (
            <MethodBlock
              key={`${entry.id}-${idx}`}
              providerId={entry.id}
              method={method}
              methodIdx={idx}
              blocked={blocked}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Edit + Delete actions for a row backed by an opencode.json `provider:` entry.
 * Delete is two-step (click → confirm) to prevent accidental loss of a
 * carefully-typed model list.
 */
function CustomProviderActions({
  customEntry,
  blocked,
  onEdit,
}: {
  customEntry: CustomProviderEntry;
  blocked: boolean;
  onEdit: () => void;
}) {
  const deleteCustomProvider = useChatStore((s) => s.deleteCustomProvider);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the "click again to confirm" state if the user looks away — keeps
  // a stale red button from sitting there waiting for a misclick.
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 4_000);
    return () => window.clearTimeout(t);
  }, [confirming]);

  const handleDelete = async (): Promise<void> => {
    if (working || blocked) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await deleteCustomProvider(customEntry.id, customEntry.scope);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onEdit}
        disabled={blocked || working}
        title="Edit this custom provider"
        className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
      >
        <Pencil size={9} />
        Edit
      </button>
      <button
        type="button"
        onClick={handleDelete}
        disabled={blocked || working}
        title={confirming ? 'Click again to confirm deletion' : 'Remove this custom provider entry'}
        className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono border disabled:opacity-40 transition-colors ${
          confirming
            ? 'text-tagma-error border-tagma-error/60 bg-tagma-error/8 hover:bg-tagma-error/15'
            : 'text-tagma-muted hover:text-tagma-error border-tagma-border/60 hover:border-tagma-error/60'
        }`}
      >
        {working ? <Loader2 size={9} className="animate-spin" /> : <Trash2 size={9} />}
        {confirming ? 'Confirm' : 'Delete'}
      </button>
      {error && (
        <span
          className="text-[10px] font-mono text-tagma-error/90 truncate max-w-[160px]"
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function DisconnectButton({ providerId, blocked }: { providerId: string; blocked: boolean }) {
  const removeProviderAuth = useChatStore((s) => s.removeProviderAuth);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async () => {
    if (working || blocked) return;
    setWorking(true);
    setError(null);
    try {
      await removeProviderAuth(providerId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handle}
        disabled={working || blocked}
        title="Disconnect (remove stored credential)"
        className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
      >
        {working ? <Loader2 size={9} className="animate-spin" /> : <LogOut size={9} />}
        Disconnect
      </button>
      {error && (
        <span
          className="text-[10px] font-mono text-tagma-error/90 truncate max-w-[160px]"
          title={error}
        >
          {error}
        </span>
      )}
    </>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  if (connected) {
    return (
      <span className="chip-xs border-tagma-ready/40 text-tagma-ready uppercase tracking-wider">
        <CheckCircle2 size={9} />
        Connected
      </span>
    );
  }
  return (
    <span className="chip-xs border-tagma-border/60 text-tagma-muted-dim uppercase tracking-wider font-normal">
      Not configured
    </span>
  );
}

/**
 * One row per auth method. Kept in its own component so the local state for
 * an in-flight OAuth flow (authorize envelope, pending code) doesn't mix with
 * the API-key flow on the same provider — each renders independently with
 * its own spinner and error.
 *
 * `method.prompts` (opencode 1.14.x) is handed down so each row can render
 * its pre-auth questions (e.g. Cloudflare's accountId, GitHub Copilot's
 * deploymentType) inline before the credential input or Sign-in button.
 */
function MethodBlock({
  providerId,
  method,
  methodIdx,
  blocked,
}: {
  providerId: string;
  method: ProviderAuthMethod;
  methodIdx: number;
  blocked: boolean;
}) {
  if (method.type === 'api') {
    return (
      <ApiKeyRow
        providerId={providerId}
        label={method.label}
        prompts={method.prompts}
        blocked={blocked}
      />
    );
  }
  if (method.type === 'oauth') {
    return (
      <OauthRow
        providerId={providerId}
        label={method.label}
        methodIdx={methodIdx}
        prompts={method.prompts}
        blocked={blocked}
      />
    );
  }
  // Forward-compat: a future method type (`wellknown` etc) falls through to
  // this stub rather than crashing. Show something so users know an option
  // exists upstream that this UI hasn't learned yet.
  return (
    <div className="text-[10px] font-mono text-tagma-muted-dim italic">
      Unsupported auth method: {(method as { type: string }).type} — use the opencode CLI.
    </div>
  );
}

/**
 * Evaluate an auth prompt's `when` gate against the current answer map. Today
 * the server only emits `op: "eq"`; unknown ops fall open (show the prompt)
 * so a future extension doesn't silently hide a required field.
 */
function isPromptVisible(prompt: AuthPrompt, answers: Record<string, string>): boolean {
  if (!prompt.when) return true;
  if (prompt.when.op === 'eq') {
    return answers[prompt.when.key] === prompt.when.value;
  }
  return true;
}

/**
 * Shared hook for the "prompts[]" state pattern used by both API-key and
 * OAuth rows.
 *
 *   - `answers` is the full map (we keep hidden answers around so a user
 *     toggling a `select` back-and-forth doesn't lose the text they typed
 *     into a now-hidden text prompt).
 *   - `visible` is re-derived on every answer change so `when` gates react
 *     immediately.
 *   - `visibleAnswers` is what to SEND — answers filtered to currently
 *     visible prompts. Sending hidden answers would be surprising (e.g.
 *     `enterpriseUrl` leaking when `deploymentType === "github.com"`).
 *   - `allFilled` is the submit gate: every visible prompt must be non-empty.
 */
function useAuthPrompts(prompts: AuthPrompt[] | undefined) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const visible = useMemo(() => {
    if (!prompts?.length) return [] as AuthPrompt[];
    return prompts.filter((p) => isPromptVisible(p, answers));
  }, [prompts, answers]);
  const setAnswer = useCallback((key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }, []);
  const reset = useCallback(() => setAnswers({}), []);
  const allFilled = visible.every((p) => (answers[p.key] ?? '').trim() !== '');
  const visibleAnswers = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of visible) {
      const v = answers[p.key];
      if (v !== undefined && v !== '') out[p.key] = v;
    }
    return out;
  }, [visible, answers]);
  return { answers, visible, setAnswer, allFilled, visibleAnswers, reset };
}

/**
 * Renders the visible subset of an auth method's prompts. Kept presentational
 * — state lives in the parent via `useAuthPrompts`, so the submit button can
 * read `allFilled` and `visibleAnswers` from the same source of truth.
 */
function PromptsSection({
  prompts,
  answers,
  setAnswer,
}: {
  prompts: AuthPrompt[];
  answers: Record<string, string>;
  setAnswer: (key: string, value: string) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {prompts.map((p) => {
        const value = answers[p.key] ?? '';
        if (p.type === 'text') {
          return (
            <div key={p.key} className="flex flex-col gap-1">
              <label className="field-label">{p.message}</label>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setAnswer(p.key, e.target.value)}
                placeholder={p.placeholder ?? ''}
                className="field-input"
              />
            </div>
          );
        }
        if (p.type === 'select') {
          return (
            <div key={p.key} className="flex flex-col gap-1">
              <label className="field-label">{p.message}</label>
              <div className="flex flex-wrap gap-1.5">
                {p.options.map((opt) => {
                  const active = value === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setAnswer(p.key, opt.value)}
                      title={opt.hint}
                      className={`inline-flex flex-col items-start px-2 py-1 text-[10px] font-mono border transition-colors ${
                        active
                          ? 'border-tagma-ready/60 bg-tagma-ready/10 text-tagma-text'
                          : 'border-tagma-border/60 text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/60'
                      }`}
                    >
                      <span>{opt.label}</span>
                      {opt.hint && (
                        <span className="text-tagma-muted-dim text-[9px]">{opt.hint}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

function ApiKeyRow({
  providerId,
  label,
  prompts,
  blocked,
}: {
  providerId: string;
  label: string;
  prompts?: AuthPrompt[];
  blocked: boolean;
}) {
  const setProviderApiKey = useChatStore((s) => s.setProviderApiKey);
  const { visible, answers, setAnswer, allFilled, visibleAnswers, reset } = useAuthPrompts(prompts);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async () => {
    const key = value.trim();
    if (!key || !allFilled || saving || blocked) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setProviderApiKey(providerId, key, visibleAnswers);
      setValue('');
      reset();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <PromptsSection prompts={visible} answers={answers} setAnswer={setAnswer} />
      <div className="flex flex-col gap-1">
        <label className="field-label flex items-center gap-1">
          <KeyRound size={9} />
          {label}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={blocked}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!blocked) void submit();
              }
            }}
            placeholder="Paste key and press Enter"
            className="field-input flex-1"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim() || !allFilled || saving || blocked}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving && <Loader2 size={10} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
      {error && <InlineError message={error} />}
      {saved && !error && (
        <div className="flex items-center gap-1 text-[10px] font-mono text-tagma-ready">
          <CheckCircle2 size={10} />
          Saved — models should appear in the picker.
        </div>
      )}
    </div>
  );
}

function OauthRow({
  providerId,
  label,
  methodIdx,
  prompts,
  blocked,
}: {
  providerId: string;
  label: string;
  methodIdx: number;
  prompts?: AuthPrompt[];
  blocked: boolean;
}) {
  const startProviderOauth = useChatStore((s) => s.startProviderOauth);
  const completeProviderOauth = useChatStore((s) => s.completeProviderOauth);
  const refreshAfterExternal = useChatStore((s) => s.refreshProvidersAfterExternalAuth);
  const { visible, answers, setAnswer, allFilled, visibleAnswers, reset } = useAuthPrompts(prompts);

  const [auth, setAuth] = useState<ProviderAuthAuthorization | null>(null);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState<'start' | 'complete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (working || !allFilled || blocked) return;
    setWorking('start');
    setError(null);
    try {
      const result = await startProviderOauth(providerId, methodIdx, visibleAnswers);
      setAuth(result);
      openExternalUrl(result.url);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(null);
    }
  };

  const complete = async () => {
    if (!auth || working || blocked) return;
    const trimmed = code.trim();
    if (!trimmed) return;
    if (blocked) return;
    setWorking('complete');
    setError(null);
    try {
      await completeProviderOauth(providerId, methodIdx, trimmed);
      setAuth(null);
      setCode('');
      reset();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(null);
    }
  };

  const finishAuto = async () => {
    if (blocked) return;
    setWorking('complete');
    setError(null);
    try {
      await refreshAfterExternal();
      setAuth(null);
      reset();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setWorking(null);
    }
  };

  const cancel = () => {
    setAuth(null);
    setCode('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {!auth && visible.length > 0 && (
        <PromptsSection prompts={visible} answers={answers} setAnswer={setAnswer} />
      )}
      <div className="flex items-center justify-between gap-2">
        <label className="field-label flex items-center gap-1 mb-0">
          <LogIn size={9} />
          {label}
        </label>
        {!auth && (
          <button
            type="button"
            onClick={start}
            disabled={working === 'start' || !allFilled || blocked}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-1 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
          >
            {working === 'start' ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <ExternalLink size={10} />
            )}
            Sign in
          </button>
        )}
      </div>

      {auth && (
        <div className="relative flex flex-col gap-1.5 pl-3 py-1.5 bg-tagma-elevated border border-tagma-border/60">
          <span
            className="absolute left-0 top-0 bottom-0 w-[2px] bg-tagma-muted/50"
            aria-hidden="true"
          />
          {auth.instructions && (
            <div className="pr-2 text-[10px] font-mono text-tagma-muted whitespace-pre-wrap break-words">
              {auth.instructions}
            </div>
          )}
          <button
            type="button"
            onClick={() => openExternalUrl(auth.url)}
            className="self-start flex items-center gap-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text underline underline-offset-2"
            title={auth.url}
          >
            <ExternalLink size={10} />
            Re-open sign-in page
          </button>

          {auth.method === 'code' ? (
            <div className="flex items-center gap-2 pr-2">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                disabled={blocked}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!blocked) void complete();
                  }
                }}
                placeholder="Paste authorization code"
                className="field-input flex-1"
              />
              <button
                type="button"
                onClick={complete}
                disabled={!code.trim() || working === 'complete' || blocked}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
              >
                {working === 'complete' && <Loader2 size={10} className="animate-spin" />}
                Complete
              </button>
              <button
                type="button"
                onClick={cancel}
                className="shrink-0 px-2 py-1.5 text-[11px] font-mono text-tagma-muted-dim hover:text-tagma-text transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            // "auto" mode: opencode captures the redirect in its own loopback
            // listener, so we can't observe completion. The "Done" button
            // forces a providers refresh when the user comes back; cancel
            // clears the in-flight state if they changed their mind.
            <div className="flex items-center gap-2 pr-2">
              <button
                type="button"
                onClick={finishAuto}
                disabled={working === 'complete' || blocked}
                className="inline-flex items-center gap-1 px-3 py-1 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
              >
                {working === 'complete' ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <RefreshCcw size={10} />
                )}
                I've completed sign-in
              </button>
              <button
                type="button"
                onClick={cancel}
                className="px-2 py-1 text-[11px] font-mono text-tagma-muted-dim hover:text-tagma-text transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono break-words">
        <AlertCircle size={10} className="shrink-0 mt-[1px]" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
