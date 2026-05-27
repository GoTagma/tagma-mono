import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X as XIcon,
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { discoverModels, REDACTED_API_KEY } from '../../api/custom-providers';
import type {
  ConfigScope,
  CustomProviderDef,
  CustomProviderEntry,
  CustomProviderModelDef,
} from '../../api/custom-providers';
import { usePipelineStore } from '../../store/pipeline-store';

/**
 * Sentinel apiKey value the renderer writes when the user leaves the API key
 * field blank for local endpoints. opencode treats a provider as "connected"
 * only when an apiKey is set somewhere in its merged view; for local services
 * like Ollama or LM Studio the actual value is meaningless (those servers
 * ignore the Authorization header). Mirrors `NO_AUTH_REQUIRED_SENTINEL` on the
 * server — kept as a literal here so the modal stays self-contained.
 */
const NO_AUTH_REQUIRED_SENTINEL = 'no-auth-required';

function isRedactedCredential(value: string): boolean {
  return value === REDACTED_API_KEY;
}

const NPM_PACKAGES = [
  {
    value: '@ai-sdk/openai-compatible',
    label: 'OpenAI-compatible',
    hint: 'Default. Works with Ollama, LM Studio, OpenRouter, vLLM, etc.',
  },
  {
    value: '@ai-sdk/openai',
    label: 'OpenAI native',
    hint: 'For services that use the new /v1/responses API surface.',
  },
] as const;

interface ModelRow {
  id: string;
  name: string;
  context: string;
  output: string;
  /** Advanced model-level config fields preserved from hand-written OpenCode config. */
  extra?: Record<string, unknown>;
}

interface FormState {
  id: string;
  name: string;
  npm: string;
  baseURL: string;
  apiKey: string;
  headers: Array<{ key: string; value: string }>;
  models: ModelRow[];
  scope: ConfigScope;
  /** Advanced provider-level config fields preserved from hand-written OpenCode config. */
  providerExtra?: Record<string, unknown>;
  /** Advanced provider-level options preserved from hand-written OpenCode config. */
  optionExtra?: Record<string, unknown>;
}

const BLANK_FORM: FormState = {
  id: '',
  name: '',
  npm: '@ai-sdk/openai-compatible',
  baseURL: '',
  apiKey: '',
  headers: [],
  models: [{ id: '', name: '', context: '', output: '' }],
  scope: 'global',
};

/**
 * Quick-start templates pre-fill the form for the most common cases. The user
 * can edit anything afterward — these are just sane defaults so configuring
 * a local Ollama instance is two clicks instead of typing fifteen fields.
 */
type Template = {
  id: string;
  label: string;
  hint: string;
  apply: (current: FormState) => FormState;
};

/**
 * Build a template that pre-fills the form for a given local LLM server. All
 * the supported servers speak the OpenAI-compatible shape, so the only thing
 * that varies is id/name/baseURL — factored out to keep the list readable.
 */
function localTemplate(args: {
  id: string;
  label: string;
  displayName: string;
  baseURL: string;
  hint: string;
}): Template {
  return {
    id: args.id,
    label: args.label,
    hint: args.hint,
    apply: (current) => ({
      ...current,
      id: current.id || args.id,
      name: args.displayName,
      npm: '@ai-sdk/openai-compatible',
      baseURL: args.baseURL,
      apiKey: '',
      models:
        current.models.length > 0
          ? current.models
          : [{ id: '', name: '', context: '', output: '' }],
    }),
  };
}

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    label: 'Blank',
    hint: 'Start from scratch.',
    apply: () => ({ ...BLANK_FORM }),
  },
  localTemplate({
    id: 'ollama',
    label: 'Ollama',
    displayName: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    hint: 'Local Ollama server on :11434.',
  }),
  localTemplate({
    id: 'lmstudio',
    label: 'LM Studio',
    displayName: 'LM Studio (local)',
    baseURL: 'http://localhost:1234/v1',
    hint: "LM Studio's server on :1234.",
  }),
  localTemplate({
    id: 'vllm',
    label: 'vLLM',
    displayName: 'vLLM (local)',
    baseURL: 'http://localhost:8000/v1',
    hint: 'vLLM server on :8000.',
  }),
  localTemplate({
    id: 'localai',
    label: 'LocalAI',
    displayName: 'LocalAI (local)',
    baseURL: 'http://localhost:8080/v1',
    hint: 'LocalAI server on :8080.',
  }),
  localTemplate({
    id: 'exo',
    label: 'Exo',
    displayName: 'Exo (local)',
    baseURL: 'http://localhost:52415/v1',
    hint: 'Exo cluster on :52415.',
  }),
];

/**
 * Provider IDs used by opencode's built-in models.dev catalog. Matching one of
 * these is allowed (the entry just overrides the built-in shape) but worth
 * surfacing so the user makes the choice deliberately.
 *
 * Kept as a small literal set — there's no public list-of-builtin-ids endpoint
 * and the catalog is large; we cover the obvious foot-guns here.
 */
const BUILTIN_IDS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'google',
  'groq',
  'openrouter',
  'azure',
  'bedrock',
  'vertex',
  'mistral',
  'deepseek',
  'alibaba',
  'cohere',
  'xai',
  'opencode',
  'opencode-zen',
]);

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Decide whether the entered baseURL points at a local LLM server. Drives
 * which connection-test affordance appears: local URLs surface "Detect
 * models" (anonymous probe of `/models`); cloud URLs surface "Verify"
 * next to the API key (authenticated ping). When the user is mid-typing
 * and the URL doesn't fully parse yet, fall back to a permissive hostname
 * sniff so the affordance doesn't flip-flop on every keystroke.
 */
function isLocalBaseURL(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return isLocalHost(u.hostname);
  } catch {
    /* fall through to permissive sniff */
  }
  const hostMatch = trimmed.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([a-z0-9.-]+)/i);
  return hostMatch ? isLocalHost(hostMatch[1]) : false;
}

function isLocalHost(host: string): boolean {
  const raw = host.trim().toLowerCase();
  const h = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  // RFC1918 private IPv4 ranges — covers LAN-hosted inference servers
  // (e.g. someone exposing Ollama at 192.168.1.10:11434).
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

function modelExtraConfig(model: CustomProviderModelDef): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(model)) {
    if (key === 'name' || key === 'limit') continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function providerOptionExtraConfig(
  options: CustomProviderDef['options'],
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'baseURL' || key === 'apiKey' || key === 'headers') continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function providerExtraConfig(def: CustomProviderEntry['def']): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  const reserved = new Set([
    'name',
    'npm',
    'options',
    'models',
    // Renderer-only redaction metadata added by the server response. These
    // describe secrets; they are not OpenCode config fields and must not be
    // written back into opencode.json.
    'hasApiKey',
    'apiKeyPreview',
    'apiKeyKind',
    'headerPreview',
  ]);
  for (const [key, value] of Object.entries(def)) {
    if (reserved.has(key)) continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function entryToFormState(entry: CustomProviderEntry): FormState {
  const def = entry.def;
  // Strip the keyless sentinel out of the visible apiKey field so editing
  // an Ollama-style entry shows an empty input (round-trip preserves the
  // sentinel — the form's submit handler re-applies it when blank).
  const apiKey =
    def.options.apiKey === REDACTED_API_KEY
      ? REDACTED_API_KEY
      : def.options.apiKey && def.options.apiKey !== NO_AUTH_REQUIRED_SENTINEL
        ? def.options.apiKey
        : '';
  const headers = def.options.headers
    ? Object.entries(def.options.headers).map(([key, value]) => ({ key, value }))
    : [];
  const models: ModelRow[] = Object.entries(def.models).map(([id, m]) => ({
    id,
    name: m.name ?? '',
    context: m.limit?.context !== undefined ? String(m.limit.context) : '',
    output: m.limit?.output !== undefined ? String(m.limit.output) : '',
    extra: modelExtraConfig(m),
  }));
  return {
    id: entry.id,
    name: def.name,
    npm: def.npm,
    baseURL: def.options.baseURL,
    apiKey,
    headers,
    models: models.length > 0 ? models : [{ id: '', name: '', context: '', output: '' }],
    scope: entry.scope,
    providerExtra: providerExtraConfig(def),
    optionExtra: providerOptionExtraConfig(def.options),
  };
}

function formStateToDef(form: FormState): CustomProviderDef {
  const headers: Record<string, string> = {};
  for (const h of form.headers) {
    const k = h.key.trim();
    const v = h.value.trim();
    if (k && v) headers[k] = v;
  }
  const models: Record<string, CustomProviderModelDef> = {};
  for (const m of form.models) {
    const id = m.id.trim();
    if (!id) continue;
    const entry: CustomProviderModelDef = { ...(m.extra ?? {}) };
    if (m.name.trim()) entry.name = m.name.trim();
    const limit: NonNullable<CustomProviderModelDef['limit']> = {};
    const ctx = Number(m.context);
    if (m.context.trim() && Number.isFinite(ctx) && ctx > 0) limit.context = ctx;
    const out = Number(m.output);
    if (m.output.trim() && Number.isFinite(out) && out > 0) limit.output = out;
    if (Object.keys(limit).length > 0) entry.limit = limit;
    models[id] = entry;
  }
  // Use the keyless sentinel only for local-style endpoints. For cloud
  // providers that authenticate via custom headers, injecting an arbitrary
  // Authorization: Bearer no-auth-required header can make otherwise-valid
  // requests fail. Users can still type `no-auth-required` explicitly when
  // they want that exact OpenCode connection marker.
  const rawApiKey = form.apiKey.trim();
  const apiKey =
    rawApiKey === REDACTED_API_KEY
      ? REDACTED_API_KEY
      : rawApiKey === '' && isLocalBaseURL(form.baseURL)
        ? NO_AUTH_REQUIRED_SENTINEL
        : rawApiKey;
  return {
    ...(form.providerExtra ?? {}),
    name: form.name.trim(),
    npm: form.npm.trim(),
    options: {
      ...(form.optionExtra ?? {}),
      baseURL: form.baseURL.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    models,
  };
}

function validate(form: FormState, isEdit: boolean): string | null {
  if (!isEdit && !ID_RE.test(form.id)) {
    return 'Provider id must be lowercase alphanumerics, dots, dashes, or underscores (and start with one).';
  }
  if (!form.name.trim()) return 'Display name is required.';
  if (!form.npm.trim()) return 'Pick an AI-SDK package.';
  const baseURL = form.baseURL.trim();
  if (!baseURL) return 'Base URL is required.';
  try {
    const u = new URL(baseURL);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://';
    }
  } catch {
    return 'Base URL is not a valid URL.';
  }
  const validModels = form.models.filter((m) => m.id.trim().length > 0);
  if (validModels.length === 0) return 'Add at least one model.';
  for (const m of validModels) {
    if (m.context.trim() && !(Number(m.context) > 0)) {
      return `Model "${m.id}" has an invalid context limit.`;
    }
    if (m.output.trim() && !(Number(m.output) > 0)) {
      return `Model "${m.id}" has an invalid output limit.`;
    }
  }
  for (const h of form.headers) {
    if (h.key.trim() && !h.value.trim()) {
      return `Header "${h.key}" has no value.`;
    }
    if (!h.key.trim() && h.value.trim()) {
      return `A header value is set without a name.`;
    }
  }
  return null;
}

interface CustomProviderModalProps {
  open: boolean;
  /** Existing entry being edited, or `null` for "create new". */
  editing: CustomProviderEntry | null;
  onClose: () => void;
}

export function CustomProviderModal({ open, editing, onClose }: CustomProviderModalProps) {
  const saveCustomProvider = useChatStore((s) => s.saveCustomProvider);
  const customProviders = useChatStore((s) => s.customProviders);
  const workDir = usePipelineStore((s) => s.workDir);
  const workspaceAvailable = !!workDir;

  const isEdit = !!editing;
  const initialForm = useMemo<FormState>(() => {
    if (editing) return entryToFormState(editing);
    return { ...BLANK_FORM };
  }, [editing]);

  const [form, setForm] = useState<FormState>(initialForm);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHeaders, setShowHeaders] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const idInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Re-seed local form state every time the modal (re)opens for a new target.
  // Without this, closing-then-reopening for a different entry would show
  // stale fields from the previous edit until the user touched something.
  useEffect(() => {
    if (!open) return;
    setForm(initialForm);
    setError(null);
    setDetectMsg(null);
    setVerifyMsg(null);
    setShowAdvanced(false);
    setShowHeaders(initialForm.headers.length > 0);
    const t = window.setTimeout(() => {
      if (isEdit) nameInputRef.current?.focus();
      else idInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, initialForm, isEdit]);

  // Escape closes the modal — matches the parent dialog's behavior so
  // keyboard users don't have to think about which layer they're in.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const providerIdInput = form.id.trim().toLowerCase();
  const idCollision =
    !isEdit &&
    providerIdInput &&
    customProviders.some((p) => p.id.toLowerCase() === providerIdInput);
  const builtinCollision = !isEdit && providerIdInput && BUILTIN_IDS.has(providerIdInput);

  const applyTemplate = (templateId: string): void => {
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setForm((prev) => tpl.apply(prev));
    setDetectMsg(null);
    setVerifyMsg(null);
  };

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateModel = (idx: number, patch: Partial<ModelRow>): void => {
    setForm((prev) => {
      const models = prev.models.slice();
      models[idx] = { ...models[idx], ...patch };
      return { ...prev, models };
    });
  };

  const addModelRow = (): void => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, { id: '', name: '', context: '', output: '' }],
    }));
  };

  const removeModelRow = (idx: number): void => {
    setForm((prev) => {
      const models = prev.models.filter((_, i) => i !== idx);
      return {
        ...prev,
        models: models.length > 0 ? models : [{ id: '', name: '', context: '', output: '' }],
      };
    });
  };

  const updateHeader = (idx: number, patch: Partial<{ key: string; value: string }>): void => {
    setForm((prev) => {
      const headers = prev.headers.slice();
      headers[idx] = { ...headers[idx], ...patch };
      return { ...prev, headers };
    });
  };

  const addHeaderRow = (): void => {
    setForm((prev) => ({ ...prev, headers: [...prev.headers, { key: '', value: '' }] }));
  };

  const removeHeaderRow = (idx: number): void => {
    setForm((prev) => ({ ...prev, headers: prev.headers.filter((_, i) => i !== idx) }));
  };

  const handleDetect = async (): Promise<void> => {
    if (detecting || !form.baseURL.trim()) return;
    setDetecting(true);
    setDetectMsg(null);
    try {
      // Pass apiKey through when it's filled — most local servers ignore the
      // Authorization header, but a few (e.g. vLLM started with --api-key)
      // require it, and forwarding the user's value avoids a confusing 401.
      const apiKey =
        form.apiKey.trim() && !isRedactedCredential(form.apiKey.trim())
          ? form.apiKey.trim()
          : undefined;
      const { models, endpoint, format } = await discoverModels(form.baseURL.trim(), apiKey);
      if (models.length === 0) {
        // Different servers want different actions for "no models loaded": for
        // Ollama you need to `ollama pull`; for LM Studio / vLLM you need to
        // load a model in their UI. Pick the message based on which shape
        // actually answered so the hint is useful instead of generic.
        setDetectMsg(
          format === 'ollama'
            ? 'Server returned no models — pull one first (e.g. `ollama pull llama3.1:8b`).'
            : 'Server returned no models — load one in the server UI / CLI first.',
        );
        return;
      }
      // Merge into form: keep any rows the user already typed (matched by id),
      // append discovered rows that aren't present yet. Avoids clobbering an
      // edit-in-progress when the user clicks Detect mid-edit.
      setForm((prev) => {
        const existingIds = new Set(
          prev.models.map((m) => m.id.trim()).filter((id) => id.length > 0),
        );
        const additions: ModelRow[] = models
          .filter((m) => !existingIds.has(m.id))
          .map((m) => ({ id: m.id, name: m.name, context: '', output: '' }));
        const cleaned = prev.models.filter((m) => m.id.trim().length > 0);
        return { ...prev, models: [...cleaned, ...additions] };
      });
      setDetectMsg(
        `Imported ${models.length} model${models.length === 1 ? '' : 's'} via ${endpoint}.`,
      );
    } catch (err) {
      setDetectMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  };

  /**
   * Authenticated ping for cloud providers. Intentionally calls the same
   * server endpoint as Detect Models but without merging the response into
   * the form — the user's manual model list shouldn't be clobbered by the
   * 200+ entries that endpoints like OpenRouter return. Surfaces 401 / 404
   * / timeout via the aggregated upstream error so the user can tell auth
   * problems from URL typos.
   */
  const handleVerify = async (): Promise<void> => {
    if (verifying || !form.baseURL.trim()) return;
    setVerifying(true);
    setVerifyMsg(null);
    try {
      if (isRedactedCredential(form.apiKey.trim())) {
        setVerifyMsg({
          kind: 'warn',
          text: 'Saved keys are redacted in the renderer. Re-enter the key to verify this provider.',
        });
        return;
      }
      const apiKey = form.apiKey.trim() || undefined;
      const { models, endpoint } = await discoverModels(form.baseURL.trim(), apiKey);
      setVerifyMsg({
        kind: 'ok',
        text: `Connected via ${endpoint} — ${models.length} model${
          models.length === 1 ? '' : 's'
        } reachable.`,
      });
    } catch (err) {
      setVerifyMsg({
        kind: 'warn',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (saving) return;
    const id = (isEdit ? editing!.id : form.id).trim();
    const validationError = validate(form, isEdit);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!workspaceAvailable) {
      setError('Custom providers need an open workspace.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveCustomProvider(id, form.scope, formStateToDef(form));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const showWorkspaceKeyWarning =
    form.scope === 'workspace' &&
    form.apiKey.trim() !== '' &&
    !isRedactedCredential(form.apiKey.trim()) &&
    form.apiKey.trim() !== NO_AUTH_REQUIRED_SENTINEL &&
    !form.apiKey.trim().startsWith('{env:');

  // Detect Models is shown for local servers (where /models works without
  // auth) and for the still-empty initial state (so the affordance doesn't
  // flicker into existence as the user starts typing). Cloud URLs hide it
  // in favor of Verify next to the API key.
  const baseURLEmpty = form.baseURL.trim() === '';
  const baseURLIsLocal = isLocalBaseURL(form.baseURL);
  const showDetectButton = baseURLEmpty || baseURLIsLocal;
  const showVerifyButton = !baseURLEmpty && !baseURLIsLocal;

  return createPortal(
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? 'Edit custom provider' : 'Add custom provider'}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            <Plus size={14} className="text-tagma-muted shrink-0" />
            <h2 className="panel-title truncate">
              {isEdit ? `Edit “${editing!.id}”` : 'Add custom provider'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close dialog"
          >
            <XIcon size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {!isEdit && (
            <div className="flex items-center gap-2">
              <span className="field-label !mb-0">Template</span>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => applyTemplate(tpl.id)}
                    title={tpl.hint}
                    className="px-2 py-1 text-[10px] font-mono border border-tagma-border/60 text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/60 transition-colors"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Provider ID</label>
              <input
                ref={idInputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.id}
                disabled={isEdit}
                onChange={(e) => updateField('id', e.target.value.toLowerCase())}
                placeholder="e.g. ollama, lmstudio, llama.cpp"
                className={`field-input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
              />
              {idCollision && (
                <InlineHint kind="warn">
                  An entry with this id already exists — saving will overwrite it.
                </InlineHint>
              )}
              {builtinCollision && !idCollision && (
                <InlineHint kind="warn">
                  This id matches a built-in opencode provider — your config will override it.
                </InlineHint>
              )}
            </div>
            <div>
              <label className="field-label">Display name</label>
              <input
                ref={nameInputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="Ollama (local)"
                className="field-input"
              />
            </div>
          </div>

          <div>
            <label className="field-label">SDK package</label>
            <div className="flex flex-col gap-1.5">
              {NPM_PACKAGES.map((pkg) => {
                const active = form.npm === pkg.value;
                return (
                  <button
                    key={pkg.value}
                    type="button"
                    onClick={() => updateField('npm', pkg.value)}
                    className={`flex flex-col items-start text-left px-2 py-1.5 border transition-colors ${
                      active
                        ? 'border-tagma-ready/60 bg-tagma-ready/10'
                        : 'border-tagma-border/60 hover:border-tagma-muted/60'
                    }`}
                  >
                    <span
                      className={`text-[11px] font-mono ${active ? 'text-tagma-text' : 'text-tagma-muted'}`}
                    >
                      {pkg.label}
                      <span className="ml-1.5 text-tagma-muted-dim">({pkg.value})</span>
                    </span>
                    <span className="text-[10px] text-tagma-muted-dim">{pkg.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="field-label">Base URL</label>
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.baseURL}
                onChange={(e) => updateField('baseURL', e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="field-input flex-1 min-w-0"
              />
              {showDetectButton && (
                <button
                  type="button"
                  onClick={handleDetect}
                  disabled={detecting || !form.baseURL.trim()}
                  title="Probe the base URL for models — tries /v1/models, falls back to /api/tags"
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
                >
                  {detecting ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Search size={11} />
                  )}
                  Detect models
                </button>
              )}
            </div>
            {detectMsg && (
              <InlineHint kind={detectMsg.startsWith('Imported') ? 'ok' : 'warn'}>
                {detectMsg}
              </InlineHint>
            )}
          </div>

          <div>
            <label className="field-label flex items-center gap-1">
              <KeyRound size={9} />
              API key
              <span className="text-tagma-muted-dim normal-case tracking-normal font-normal">
                (leave blank for local servers)
              </span>
            </label>
            <div className="flex items-stretch gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={isRedactedCredential(form.apiKey) ? '' : form.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                placeholder={
                  isRedactedCredential(form.apiKey)
                    ? `${editing?.def.apiKeyPreview ?? 'Saved key'} - leave blank to keep`
                    : 'sk-... or {env:OPENROUTER_API_KEY}'
                }
                className="field-input flex-1 min-w-0"
              />
              {showVerifyButton && (
                <button
                  type="button"
                  onClick={handleVerify}
                  disabled={verifying || !form.baseURL.trim()}
                  title="Ping the base URL with this API key — confirms the URL is reachable and the key is accepted"
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors"
                >
                  {verifying ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ShieldCheck size={11} />
                  )}
                  Verify
                </button>
              )}
            </div>
            {verifyMsg && (
              <InlineHint kind={verifyMsg.kind}>
                {verifyMsg.kind === 'ok' && (
                  <CheckCircle2 size={10} className="inline-block mr-1 align-text-bottom" />
                )}
                {verifyMsg.text}
              </InlineHint>
            )}
            {showWorkspaceKeyWarning && (
              <InlineHint kind="warn">
                Plain-text keys are not saved in workspace scope. Use
                <code> {'{env:VAR_NAME}'} </code> or save this provider in embedded-runtime scope.
              </InlineHint>
            )}
            {isRedactedCredential(form.apiKey) && (
              <InlineHint kind="ok">
                A saved key is set. Leave this field blank to keep it.
              </InlineHint>
            )}
          </div>

          <div>
            <label className="field-label">Scope</label>
            <div className="flex gap-1.5">
              <ScopeButton
                active={form.scope === 'global'}
                onClick={() => updateField('scope', 'global')}
                label="Embedded runtime"
                hint=".tagma/.opencode-runtime/config/opencode/opencode.json"
                disabled={isEdit && editing!.scope !== 'global'}
              />
              <ScopeButton
                active={form.scope === 'workspace'}
                onClick={() => updateField('scope', 'workspace')}
                label="This workspace"
                hint=".tagma/opencode.json - commit to share with team"
                disabled={(isEdit && editing!.scope !== 'workspace') || !workspaceAvailable}
              />
            </div>
            {isEdit && (
              <p className="mt-1 text-[10px] font-mono text-tagma-muted-dim">
                Scope is locked while editing. Delete and re-create to move between scopes.
              </p>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowHeaders((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
            >
              {showHeaders ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              Custom headers ({form.headers.length})
            </button>
            {showHeaders && (
              <div className="mt-2 space-y-1.5">
                {form.headers.map((h, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={h.key}
                      onChange={(e) => updateHeader(idx, { key: e.target.value })}
                      placeholder="Header-Name"
                      className="field-input w-[40%]"
                    />
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={isRedactedCredential(h.value) ? '' : h.value}
                      onChange={(e) => updateHeader(idx, { value: e.target.value })}
                      placeholder={
                        isRedactedCredential(h.value) ? 'saved - leave blank to keep' : 'value'
                      }
                      className="field-input flex-1 min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeHeaderRow(idx)}
                      title="Remove header"
                      className="shrink-0 p-1 text-tagma-muted hover:text-tagma-error"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addHeaderRow}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-muted/60 transition-colors"
                >
                  <Plus size={10} />
                  Add header
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="field-label !mb-0">Models</label>
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
              >
                {showAdvanced ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Show context / output limits
              </button>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {form.models.map((m, idx) => (
                <div key={idx} className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={m.id}
                      onChange={(e) => updateModel(idx, { id: e.target.value })}
                      placeholder="model id (e.g. llama3.1:8b)"
                      className="field-input w-[42%]"
                    />
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={m.name}
                      onChange={(e) => updateModel(idx, { name: e.target.value })}
                      placeholder="display name (optional)"
                      className="field-input flex-1 min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeModelRow(idx)}
                      title="Remove model"
                      className="shrink-0 p-1 text-tagma-muted hover:text-tagma-error"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {showAdvanced && (
                    <div className="flex items-center gap-1.5 pl-2">
                      <input
                        type="number"
                        min="0"
                        autoComplete="off"
                        value={m.context}
                        onChange={(e) => updateModel(idx, { context: e.target.value })}
                        placeholder="context tokens"
                        className="field-input w-[42%]"
                      />
                      <input
                        type="number"
                        min="0"
                        autoComplete="off"
                        value={m.output}
                        onChange={(e) => updateModel(idx, { output: e.target.value })}
                        placeholder="output tokens"
                        className="field-input flex-1 min-w-0"
                      />
                      <span className="shrink-0 w-[20px]" aria-hidden="true" />
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addModelRow}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-muted/60 transition-colors"
              >
                <Plus size={10} />
                Add model
              </button>
            </div>
          </div>

          <InlineHint kind="info">
            Tip: For Ollama tool-calling, set <code>num_ctx</code> to 16k+ on the model in Ollama
            (the default 2k truncates tool results).
          </InlineHint>

          {error && (
            <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
              <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono break-words">
                <AlertCircle size={10} className="shrink-0 mt-[1px]" />
                <span>{error}</span>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-tagma-border flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="min-w-[100px] px-3 py-1 text-[11px] text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 transition-colors text-center"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="btn-primary w-auto min-w-[100px] justify-center text-center"
          >
            {saving && <Loader2 size={11} className="animate-spin" />}
            {isEdit ? 'Save changes' : 'Create provider'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start text-left px-2 py-1.5 border transition-colors flex-1 ${
        active
          ? 'border-tagma-ready/60 bg-tagma-ready/10'
          : 'border-tagma-border/60 hover:border-tagma-muted/60'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <span className={`text-[11px] font-mono ${active ? 'text-tagma-text' : 'text-tagma-muted'}`}>
        {label}
      </span>
      <span className="text-[10px] text-tagma-muted-dim">{hint}</span>
    </button>
  );
}

function InlineHint({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'ok';
  children: React.ReactNode;
}) {
  const tone =
    kind === 'warn'
      ? 'text-tagma-warning/90'
      : kind === 'ok'
        ? 'text-tagma-ready'
        : 'text-tagma-muted-dim';
  return <p className={`mt-1 text-[10px] font-mono ${tone} break-words`}>{children}</p>;
}
