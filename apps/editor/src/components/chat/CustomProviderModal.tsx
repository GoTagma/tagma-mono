import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  Pencil,
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
import {
  customProviderProbeRequest,
  isCurrentCustomProviderProbeRequest,
} from './custom-provider-probe-request';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';
import { useModalBackdropDismiss } from '../modal-backdrop-dismiss';
import {
  addReasoningVariant,
  blankModelReasoningDraft,
  enableRecommendedReasoning,
  hasOpenCodeGeneratedReasoningOverrides,
  parseModelReasoningConfig,
  reasoningProfileMismatch,
  removeReasoningVariant,
  resetToOpenCodeGeneratedReasoningDefaults,
  restorableDisabledReasoningVariantCount,
  resolveLocalReasoningProviderHint,
  resolveModelReasoningIdentity,
  resolveOpenCodeGeneratedReasoningVariantIds,
  resolveReasoningProfile,
  restoreDisabledReasoningVariants,
  serializeModelReasoningConfig,
  setReasoningEnabled,
  setOpenCodeGeneratedVariantsExact,
  touchReasoningDraftForIdentityChange,
  updateReasoningVariant,
  validateReasoningDraft,
} from './custom-provider-reasoning';
import type { ModelReasoningDraft } from './custom-provider-reasoning';

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

export interface ModelRow {
  id: string;
  name: string;
  context: string;
  output: string;
  reasoning: ModelReasoningDraft;
  reasoningOpen: boolean;
  /** Advanced model-level config fields preserved from hand-written OpenCode config. */
  extra?: Record<string, unknown>;
}

export interface FormState {
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

function blankModelRow(): ModelRow {
  return {
    id: '',
    name: '',
    context: '',
    output: '',
    reasoning: blankModelReasoningDraft(),
    reasoningOpen: false,
  };
}

function isPristineBlankModelRow(model: ModelRow): boolean {
  return (
    model.id.trim() === '' &&
    model.name.trim() === '' &&
    model.context.trim() === '' &&
    model.output.trim() === '' &&
    (!model.extra || Object.keys(model.extra).length === 0) &&
    !model.reasoning.enabled &&
    model.reasoning.variants.length === 0 &&
    !model.reasoning.managesGeneratedVariants &&
    model.reasoning.removedVariantIds.length === 0 &&
    Object.keys(model.reasoning.originalModel).length === 0 &&
    !model.reasoning.dirty
  );
}

const BLANK_FORM: FormState = {
  id: '',
  name: '',
  npm: '@ai-sdk/openai-compatible',
  baseURL: '',
  apiKey: '',
  headers: [],
  models: [blankModelRow()],
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
      models: current.models.length > 0 ? current.models : [blankModelRow()],
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
    if (key === 'name' || key === 'limit' || key === 'reasoning' || key === 'variants') continue;
    extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function modelReasoningConfig(model: CustomProviderModelDef): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(model, 'reasoning')) config.reasoning = model.reasoning;
  if (Object.prototype.hasOwnProperty.call(model, 'variants')) config.variants = model.variants;
  return config;
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
  const models: ModelRow[] = Object.entries(def.models).map(([id, m]) => {
    const extra = modelExtraConfig(m);
    const identity = resolveModelReasoningIdentity(extra ?? {}, def.npm, id);
    const providerHint = resolveLocalReasoningProviderHint(entry.id, def.name, def.options.baseURL);
    const reasoning = parseModelReasoningConfig(
      modelReasoningConfig(m),
      identity.npm,
      identity.modelId,
      identity.releaseDate,
      identity.apiModelId,
      providerHint,
    );
    return {
      id,
      name: m.name ?? '',
      context: m.limit?.context !== undefined ? String(m.limit.context) : '',
      output: m.limit?.output !== undefined ? String(m.limit.output) : '',
      reasoning,
      reasoningOpen: reasoning.enabled,
      extra,
    };
  });
  return {
    id: entry.id,
    name: def.name,
    npm: def.npm,
    baseURL: def.options.baseURL,
    apiKey,
    headers,
    models: models.length > 0 ? models : [blankModelRow()],
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
    const reasoningIdentity = resolveModelReasoningIdentity(m.extra ?? {}, form.npm, id);
    const entry: CustomProviderModelDef = {
      ...(m.extra ?? {}),
      ...serializeModelReasoningConfig(
        m.reasoning,
        reasoningIdentity.npm,
        reasoningIdentity.modelId,
        resolveLocalReasoningProviderHint(form.id, form.name, form.baseURL),
        reasoningIdentity.releaseDate,
        reasoningIdentity.apiModelId,
      ),
    };
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

export function validateCustomProviderForm(form: FormState, isEdit: boolean): string | null {
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
  const incompleteModel = form.models.find(
    (model) => !model.id.trim() && !isPristineBlankModelRow(model),
  );
  if (incompleteModel) return 'Every configured model needs a model id.';
  const validModels = form.models.filter((m) => m.id.trim().length > 0);
  if (validModels.length === 0) return 'Add at least one model.';
  const modelIds = new Set<string>();
  for (const m of validModels) {
    const modelId = m.id.trim();
    if (modelIds.has(modelId)) return `Duplicate model id "${modelId}".`;
    modelIds.add(modelId);
    if (m.context.trim() && !(Number(m.context) > 0)) {
      return `Model "${m.id}" has an invalid context limit.`;
    }
    if (m.output.trim() && !(Number(m.output) > 0)) {
      return `Model "${m.id}" has an invalid output limit.`;
    }
    const reasoningIssues = validateReasoningDraft(m.reasoning, m.name.trim() || m.id.trim());
    if (reasoningIssues[0]) return reasoningIssues[0].message;
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
  blocked?: boolean;
  onClose: () => void;
}

export function CustomProviderModal({
  open,
  editing,
  blocked = false,
  onClose,
}: CustomProviderModalProps) {
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
  const modalRef = useModalFocusTrap<HTMLDivElement>();
  const backdropDismissHandlers = useModalBackdropDismiss(onClose);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const modalRunRef = useRef(0);
  const latestFormRef = useRef(form);

  useEffect(() => {
    latestFormRef.current = form;
  }, [form]);

  // Re-seed local form state every time the modal (re)opens for a new target.
  // Without this, closing-then-reopening for a different entry would show
  // stale fields from the previous edit until the user touched something.
  useEffect(() => {
    modalRunRef.current += 1;
    if (!open) {
      setSaving(false);
      setDetecting(false);
      setVerifying(false);
      return;
    }
    setForm(initialForm);
    setError(null);
    setDetectMsg(null);
    setVerifyMsg(null);
    setSaving(false);
    setDetecting(false);
    setVerifying(false);
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
    setForm((prev) => {
      const next = tpl.apply(prev);
      const previousHint = resolveLocalReasoningProviderHint(prev.id, prev.name, prev.baseURL);
      const nextHint = resolveLocalReasoningProviderHint(next.id, next.name, next.baseURL);
      if (next.npm === prev.npm && nextHint === previousHint) return next;
      return {
        ...next,
        models: next.models.map((model) => ({
          ...model,
          reasoning: touchReasoningDraftForIdentityChange(
            model.reasoning,
            resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, model.id, previousHint),
            resolveModelReasoningIdentity(model.extra ?? {}, next.npm, model.id, nextHint),
          ),
        })),
      };
    });
    setDetectMsg(null);
    setVerifyMsg(null);
  };

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateProviderIdentity = (key: 'id' | 'name' | 'baseURL', value: string): void => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      const previousHint = resolveLocalReasoningProviderHint(prev.id, prev.name, prev.baseURL);
      const nextHint = resolveLocalReasoningProviderHint(next.id, next.name, next.baseURL);
      return {
        ...next,
        models: prev.models.map((model) => ({
          ...model,
          reasoning: touchReasoningDraftForIdentityChange(
            model.reasoning,
            resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, model.id, previousHint),
            resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, model.id, nextHint),
          ),
        })),
      };
    });
  };

  const updateNpm = (npm: string): void => {
    setForm((prev) => {
      const providerHint = resolveLocalReasoningProviderHint(prev.id, prev.name, prev.baseURL);
      return {
        ...prev,
        npm,
        models: prev.models.map((model) => ({
          ...model,
          reasoning: touchReasoningDraftForIdentityChange(
            model.reasoning,
            resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, model.id, providerHint),
            resolveModelReasoningIdentity(model.extra ?? {}, npm, model.id, providerHint),
          ),
        })),
      };
    });
  };

  const updateModel = (idx: number, patch: Partial<ModelRow>): void => {
    setForm((prev) => {
      const models = prev.models.slice();
      models[idx] = { ...models[idx], ...patch };
      return { ...prev, models };
    });
  };

  const updateModelId = (idx: number, id: string): void => {
    setForm((prev) => {
      const models = prev.models.slice();
      const model = models[idx];
      if (!model) return prev;
      const providerHint = resolveLocalReasoningProviderHint(prev.id, prev.name, prev.baseURL);
      models[idx] = {
        ...model,
        id,
        reasoning: touchReasoningDraftForIdentityChange(
          model.reasoning,
          resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, model.id, providerHint),
          resolveModelReasoningIdentity(model.extra ?? {}, prev.npm, id, providerHint),
        ),
      };
      return { ...prev, models };
    });
  };

  const updateModelReasoning = (
    idx: number,
    update: (reasoning: ModelReasoningDraft) => ModelReasoningDraft,
    open = true,
  ): void => {
    setForm((prev) => {
      const models = prev.models.slice();
      const model = models[idx];
      if (!model) return prev;
      models[idx] = {
        ...model,
        reasoning: update(model.reasoning),
        reasoningOpen: open ? true : model.reasoningOpen,
      };
      return { ...prev, models };
    });
  };

  const addModelRow = (): void => {
    setForm((prev) => ({
      ...prev,
      models: [...prev.models, blankModelRow()],
    }));
  };

  const removeModelRow = (idx: number): void => {
    setForm((prev) => {
      const models = prev.models.filter((_, i) => i !== idx);
      return {
        ...prev,
        models: models.length > 0 ? models : [blankModelRow()],
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

  const currentDetectApiKey = (apiKey: string): string | undefined => {
    const key = apiKey.trim();
    return key && !isRedactedCredential(key) ? key : undefined;
  };

  const handleDetect = async (): Promise<void> => {
    if (detecting || !form.baseURL.trim()) return;
    const request = customProviderProbeRequest(
      modalRunRef.current,
      form.baseURL,
      currentDetectApiKey(form.apiKey),
    );
    setDetecting(true);
    setDetectMsg(null);
    try {
      // Pass apiKey through when it's filled — most local servers ignore the
      // Authorization header, but a few (e.g. vLLM started with --api-key)
      // require it, and forwarding the user's value avoids a confusing 401.
      const { models, endpoint, format } = await discoverModels(
        request.baseURL,
        request.apiKey ?? undefined,
      );
      if (
        !isCurrentCustomProviderProbeRequest(
          request,
          modalRunRef.current,
          latestFormRef.current.baseURL,
          currentDetectApiKey(latestFormRef.current.apiKey),
        )
      ) {
        return;
      }
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
          .map((m) => ({ ...blankModelRow(), id: m.id, name: m.name ?? '' }));
        const cleaned = prev.models.filter((m) => !isPristineBlankModelRow(m));
        return { ...prev, models: [...cleaned, ...additions] };
      });
      setDetectMsg(
        `Imported ${models.length} model${models.length === 1 ? '' : 's'} via ${endpoint}.`,
      );
    } catch (err) {
      if (
        isCurrentCustomProviderProbeRequest(
          request,
          modalRunRef.current,
          latestFormRef.current.baseURL,
          currentDetectApiKey(latestFormRef.current.apiKey),
        )
      ) {
        setDetectMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (modalRunRef.current === request.runId) setDetecting(false);
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
    const request = customProviderProbeRequest(
      modalRunRef.current,
      form.baseURL,
      form.apiKey.trim() || undefined,
    );
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
      const { models, endpoint } = await discoverModels(
        request.baseURL,
        request.apiKey ?? undefined,
      );
      if (
        !isCurrentCustomProviderProbeRequest(
          request,
          modalRunRef.current,
          latestFormRef.current.baseURL,
          latestFormRef.current.apiKey.trim() || undefined,
        )
      ) {
        return;
      }
      setVerifyMsg({
        kind: 'ok',
        text: `Connected via ${endpoint} — ${models.length} model${
          models.length === 1 ? '' : 's'
        } reachable.`,
      });
    } catch (err) {
      if (
        isCurrentCustomProviderProbeRequest(
          request,
          modalRunRef.current,
          latestFormRef.current.baseURL,
          latestFormRef.current.apiKey.trim() || undefined,
        )
      ) {
        setVerifyMsg({
          kind: 'warn',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (modalRunRef.current === request.runId) setVerifying(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    if (saving || blocked) return;
    const runId = modalRunRef.current;
    const id = (isEdit ? editing!.id : form.id).trim();
    const validationError = validateCustomProviderForm(form, isEdit);
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
      if (modalRunRef.current !== runId) return;
      onClose();
    } catch (err) {
      if (modalRunRef.current === runId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (modalRunRef.current === runId) setSaving(false);
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
  const customHeadersId = 'custom-provider-custom-headers';
  const providerIdWarningId = 'custom-provider-id-warning';
  const workspaceKeyWarningId = 'custom-provider-workspace-key-warning';
  const modelLimitControlIds = form.models
    .map((_, idx) => `custom-provider-model-${idx}-limits`)
    .join(' ');

  return createPortal(
    <div
      className="modal-viewport-backdrop fixed inset-0 z-[230] flex items-center justify-center"
      {...backdropDismissHandlers}
    >
      <div
        ref={modalRef}
        className="modal-viewport-shell modal-tone-accent flex w-full max-w-[600px] flex-col border"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="custom-provider-modal-title"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="panel-header">
          <div className="flex items-center gap-2 min-w-0">
            {isEdit ? (
              <Pencil size={14} className="text-tagma-accent shrink-0" />
            ) : (
              <Plus size={14} className="text-tagma-accent shrink-0" />
            )}
            <h2 id="custom-provider-modal-title" className="panel-title truncate">
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

        <div className="modal-viewport-body space-y-4 px-4 py-3">
          {!isEdit && (
            <div
              role="group"
              aria-labelledby="custom-provider-template-label"
              className="flex items-center gap-2"
            >
              <span id="custom-provider-template-label" className="field-label !mb-0">
                Template
              </span>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => applyTemplate(tpl.id)}
                    title={tpl.hint}
                    className="px-2 py-1 text-[10px] font-mono border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/60 transition-colors"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="custom-provider-id" className="field-label">
                Provider ID
              </label>
              <input
                id="custom-provider-id"
                ref={idInputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.id}
                disabled={isEdit}
                onChange={(e) => updateProviderIdentity('id', e.target.value.toLowerCase())}
                placeholder="e.g. ollama, lmstudio, llama.cpp"
                aria-describedby={idCollision || builtinCollision ? providerIdWarningId : undefined}
                className={`field-input ${isEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
              />
              {idCollision && (
                <InlineHint id={providerIdWarningId} kind="warn" role="alert">
                  An entry with this id already exists — saving will overwrite it.
                </InlineHint>
              )}
              {builtinCollision && !idCollision && (
                <InlineHint id={providerIdWarningId} kind="warn" role="alert">
                  This id matches a built-in opencode provider — your config will override it.
                </InlineHint>
              )}
            </div>
            <div>
              <label htmlFor="custom-provider-name" className="field-label">
                Display name
              </label>
              <input
                id="custom-provider-name"
                ref={nameInputRef}
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.name}
                onChange={(e) => updateProviderIdentity('name', e.target.value)}
                placeholder="Ollama (local)"
                className="field-input"
              />
            </div>
          </div>

          <fieldset>
            <legend className="field-label">SDK package</legend>
            <div className="flex flex-col gap-1.5">
              {NPM_PACKAGES.map((pkg) => {
                const active = form.npm === pkg.value;
                return (
                  <button
                    key={pkg.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => updateNpm(pkg.value)}
                    className={`flex flex-col items-start text-left px-2 py-1.5 border transition-colors ${
                      active
                        ? 'border-tagma-accent/60 bg-tagma-accent/10'
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
          </fieldset>

          <div>
            <label htmlFor="custom-provider-base-url" className="field-label">
              Base URL
            </label>
            <div className="flex items-stretch gap-2">
              <input
                id="custom-provider-base-url"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={form.baseURL}
                onChange={(e) => updateProviderIdentity('baseURL', e.target.value)}
                placeholder="http://localhost:11434/v1"
                className="field-input flex-1 min-w-0"
              />
              {showDetectButton && (
                <button
                  type="button"
                  onClick={handleDetect}
                  disabled={detecting || !form.baseURL.trim()}
                  title="Probe the base URL for models — tries /v1/models, falls back to /api/tags"
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
            <div role="status" aria-live="polite" aria-atomic="true">
              {detecting ? (
                <p className="sr-only">Detecting models.</p>
              ) : (
                detectMsg && (
                  <InlineHint kind={detectMsg.startsWith('Imported') ? 'ok' : 'warn'}>
                    {detectMsg}
                  </InlineHint>
                )
              )}
            </div>
          </div>

          <div>
            <label
              htmlFor="custom-provider-api-key"
              className="field-label flex items-center gap-1"
            >
              <KeyRound size={9} />
              API key
              <span className="text-tagma-muted-dim normal-case tracking-normal font-normal">
                (leave blank for local servers)
              </span>
            </label>
            <div className="flex items-stretch gap-2">
              <input
                id="custom-provider-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={isRedactedCredential(form.apiKey) ? '' : form.apiKey}
                onChange={(e) => updateField('apiKey', e.target.value)}
                aria-describedby={showWorkspaceKeyWarning ? workspaceKeyWarningId : undefined}
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
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 text-[11px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
            <div role="status" aria-live="polite" aria-atomic="true">
              {verifying ? (
                <p className="sr-only">Verifying provider connection.</p>
              ) : (
                verifyMsg && (
                  <InlineHint kind={verifyMsg.kind}>
                    {verifyMsg.kind === 'ok' && (
                      <CheckCircle2 size={10} className="inline-block mr-1 align-text-bottom" />
                    )}
                    {verifyMsg.text}
                  </InlineHint>
                )
              )}
            </div>
            {showWorkspaceKeyWarning && (
              <InlineHint id={workspaceKeyWarningId} kind="warn" role="alert">
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

          <fieldset>
            <legend className="field-label">Scope</legend>
            <div className="flex flex-col gap-1.5 sm:flex-row">
              <ScopeButton
                active={form.scope === 'global'}
                onClick={() => updateField('scope', 'global')}
                label="Embedded runtime"
                hint=".tagma/.opencode-runtime/config/opencode/opencode.json"
                ariaDescribedBy={showWorkspaceKeyWarning ? workspaceKeyWarningId : undefined}
                disabled={isEdit && editing!.scope !== 'global'}
              />
              <ScopeButton
                active={form.scope === 'workspace'}
                onClick={() => updateField('scope', 'workspace')}
                label="This workspace"
                hint=".tagma/opencode.json - commit to share with team"
                ariaDescribedBy={showWorkspaceKeyWarning ? workspaceKeyWarningId : undefined}
                disabled={(isEdit && editing!.scope !== 'workspace') || !workspaceAvailable}
              />
            </div>
            {isEdit && (
              <p className="mt-1 text-[10px] font-mono text-tagma-muted-dim">
                Scope is locked while editing. Delete and re-create to move between scopes.
              </p>
            )}
          </fieldset>

          <div>
            <button
              type="button"
              aria-expanded={showHeaders}
              aria-controls={showHeaders ? customHeadersId : undefined}
              onClick={() => setShowHeaders((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
            >
              {showHeaders ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              Custom headers ({form.headers.length})
            </button>
            {showHeaders && (
              <div id={customHeadersId} className="mt-2 space-y-1.5">
                {form.headers.map((h, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={h.key}
                      onChange={(e) => updateHeader(idx, { key: e.target.value })}
                      placeholder="Header-Name"
                      aria-label={`Custom header ${idx + 1} name`}
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
                      aria-label={`Value for custom header ${h.key.trim() || idx + 1}`}
                      className="field-input flex-1 min-w-0"
                    />
                    <button
                      type="button"
                      onClick={() => removeHeaderRow(idx)}
                      title="Remove header"
                      aria-label={`Remove custom header ${h.key.trim() || idx + 1}`}
                      className="shrink-0 w-5 p-1 text-tagma-muted hover:text-tagma-error"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addHeaderRow}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
                >
                  <Plus size={10} />
                  Add header
                </button>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="field-label !mb-0">Models</span>
              <button
                type="button"
                aria-expanded={showAdvanced}
                aria-controls={showAdvanced ? modelLimitControlIds : undefined}
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
              >
                {showAdvanced ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Show context / output limits
              </button>
            </div>
            <div className="mt-1.5 space-y-1.5">
              {form.models.map((m, idx) => {
                const providerHint = resolveLocalReasoningProviderHint(
                  form.id,
                  form.name,
                  form.baseURL,
                );
                const reasoningIdentity = resolveModelReasoningIdentity(
                  m.extra ?? {},
                  form.npm,
                  m.id,
                );
                const profile = resolveReasoningProfile(
                  reasoningIdentity.npm,
                  reasoningIdentity.modelId,
                  providerHint,
                  reasoningIdentity.releaseDate,
                  reasoningIdentity.apiModelId,
                );
                const generatedVariantIds = resolveOpenCodeGeneratedReasoningVariantIds(
                  reasoningIdentity.npm,
                  reasoningIdentity.modelId,
                  reasoningIdentity.releaseDate,
                  reasoningIdentity.apiModelId,
                  providerHint,
                );
                const warning = reasoningProfileMismatch(
                  m.reasoning,
                  reasoningIdentity.npm,
                  reasoningIdentity.modelId,
                  providerHint,
                  reasoningIdentity.releaseDate,
                  reasoningIdentity.apiModelId,
                );
                const restorableVariantCount = restorableDisabledReasoningVariantCount(m.reasoning);
                const canUseOpenCodeDefaults = hasOpenCodeGeneratedReasoningOverrides(
                  m.reasoning,
                  reasoningIdentity.npm,
                  reasoningIdentity.modelId,
                  reasoningIdentity.releaseDate,
                  reasoningIdentity.apiModelId,
                  providerHint,
                );
                const reasoningIssues = validateReasoningDraft(
                  m.reasoning,
                  m.name.trim() || m.id.trim() || `Model ${idx + 1}`,
                );
                const disclosureId = `custom-provider-model-${idx}-reasoning`;
                const checkboxId = `${disclosureId}-enabled`;
                const exactListId = `${disclosureId}-exact-list`;
                return (
                  <fieldset
                    key={idx}
                    className="space-y-1.5 border-b border-tagma-border/40 pb-1.5"
                  >
                    <legend className="sr-only">Model {m.id.trim() || idx + 1}</legend>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={m.id}
                        onChange={(e) => updateModelId(idx, e.target.value)}
                        placeholder="model id (e.g. llama3.1:8b)"
                        aria-label={`Model ${idx + 1} id`}
                        className="field-input w-[40%]"
                      />
                      <input
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={m.name}
                        onChange={(e) => updateModel(idx, { name: e.target.value })}
                        placeholder="display name (optional)"
                        aria-label={`Model ${idx + 1} display name`}
                        className="field-input flex-1 min-w-0"
                      />
                      <button
                        type="button"
                        onClick={() => removeModelRow(idx)}
                        title="Remove model"
                        aria-label={`Remove model ${m.id.trim() || idx + 1}`}
                        className="shrink-0 w-5 p-1 text-tagma-muted hover:text-tagma-error"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {showAdvanced && (
                      <div
                        id={`custom-provider-model-${idx}-limits`}
                        className="flex items-center gap-1.5 pl-2"
                      >
                        <input
                          type="number"
                          min="0"
                          autoComplete="off"
                          value={m.context}
                          onChange={(e) => updateModel(idx, { context: e.target.value })}
                          placeholder="context tokens"
                          aria-label={`Model ${m.id.trim() || idx + 1} context tokens`}
                          className="field-input w-[40%]"
                        />
                        <input
                          type="number"
                          min="0"
                          autoComplete="off"
                          value={m.output}
                          onChange={(e) => updateModel(idx, { output: e.target.value })}
                          placeholder="output tokens"
                          aria-label={`Model ${m.id.trim() || idx + 1} output tokens`}
                          className="field-input flex-1 min-w-0"
                        />
                        <span className="shrink-0 w-5" aria-hidden="true" />
                      </div>
                    )}

                    <button
                      type="button"
                      aria-expanded={m.reasoningOpen}
                      aria-controls={m.reasoningOpen ? disclosureId : undefined}
                      onClick={() => updateModel(idx, { reasoningOpen: !m.reasoningOpen })}
                      className="flex items-center gap-1 pl-2 text-[10px] font-mono text-tagma-muted hover:text-tagma-text transition-colors"
                    >
                      {m.reasoningOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      <Brain size={10} />
                      {m.reasoning.enabled
                        ? m.reasoning.variants.length > 0
                          ? `Adjustable thinking · ${m.reasoning.variants.length} explicit variant${m.reasoning.variants.length === 1 ? '' : 's'}`
                          : generatedVariantIds.length > 0 && !m.reasoning.managesGeneratedVariants
                            ? 'Adjustable thinking · OpenCode defaults'
                            : 'Adjustable thinking · no active variants'
                        : 'Adjustable thinking off'}
                      {warning && <AlertCircle size={10} className="text-tagma-warning" />}
                    </button>

                    {warning && !m.reasoningOpen && (
                      <p
                        role="status"
                        aria-live="polite"
                        className="ml-2 text-[9px] font-mono text-tagma-warning/90"
                      >
                        {warning.message}
                      </p>
                    )}

                    {m.reasoningOpen && (
                      <div
                        id={disclosureId}
                        className="ml-2 space-y-2 border-l border-tagma-border/60 pl-2 pb-1"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label
                            htmlFor={checkboxId}
                            className="inline-flex items-center gap-1.5 text-[10px] font-mono text-tagma-text"
                          >
                            <input
                              id={checkboxId}
                              type="checkbox"
                              checked={m.reasoning.enabled}
                              onChange={(e) =>
                                updateModelReasoning(idx, (reasoning) =>
                                  setReasoningEnabled(
                                    reasoning,
                                    e.target.checked,
                                    reasoningIdentity.npm,
                                    reasoningIdentity.modelId,
                                    providerHint,
                                    reasoningIdentity.releaseDate,
                                    reasoningIdentity.apiModelId,
                                  ),
                                )
                              }
                            />
                            Configurable reasoning for{' '}
                            {m.name.trim() || m.id.trim() || 'this model'}
                          </label>
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {restorableVariantCount > 0 && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateModelReasoning(idx, restoreDisabledReasoningVariants)
                                }
                                className="px-2 py-1 text-[9px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
                              >
                                Restore {restorableVariantCount} disabled variant
                                {restorableVariantCount === 1 ? '' : 's'}
                              </button>
                            )}
                            {canUseOpenCodeDefaults && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateModelReasoning(idx, (reasoning) =>
                                    resetToOpenCodeGeneratedReasoningDefaults(
                                      reasoning,
                                      reasoningIdentity.npm,
                                      reasoningIdentity.modelId,
                                      reasoningIdentity.releaseDate,
                                      reasoningIdentity.apiModelId,
                                      providerHint,
                                    ),
                                  )
                                }
                                className="px-2 py-1 text-[9px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
                              >
                                Reset to OpenCode defaults
                              </button>
                            )}
                            {profile && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateModelReasoning(idx, (reasoning) =>
                                    enableRecommendedReasoning(
                                      reasoning,
                                      reasoningIdentity.npm,
                                      reasoningIdentity.modelId,
                                      providerHint,
                                      reasoningIdentity.releaseDate,
                                      reasoningIdentity.apiModelId,
                                    ),
                                  )
                                }
                                className="px-2 py-1 text-[9px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
                              >
                                Use {profile.label} recommendations
                              </button>
                            )}
                          </div>
                        </div>

                        <p className="text-[9px] font-mono text-tagma-muted-dim">
                          Variant IDs appear in Chat. Each JSON object is merged into the selected
                          model request options. Recommendations are advisory because endpoint and
                          model versions can support different values. Turning this off retains the
                          JSON as disabled entries. Use the explicit restore action to reactivate
                          them later; the editor never guesses whether a tombstone was intentional.
                        </p>

                        {m.reasoning.enabled && generatedVariantIds.length > 0 && (
                          <div className="space-y-0.5">
                            <label
                              htmlFor={exactListId}
                              className="inline-flex items-center gap-1.5 text-[9px] font-mono text-tagma-text"
                            >
                              <input
                                id={exactListId}
                                type="checkbox"
                                checked={m.reasoning.managesGeneratedVariants}
                                onChange={(e) =>
                                  updateModelReasoning(idx, (reasoning) =>
                                    setOpenCodeGeneratedVariantsExact(
                                      reasoning,
                                      e.target.checked,
                                      reasoningIdentity.npm,
                                      reasoningIdentity.modelId,
                                      reasoningIdentity.releaseDate,
                                      reasoningIdentity.apiModelId,
                                      providerHint,
                                    ),
                                  )
                                }
                              />
                              Only show the variants listed here
                            </label>
                            <p className="pl-5 text-[9px] font-mono text-tagma-muted-dim">
                              When unchecked, other generated variants not listed here remain
                              available. Variants you explicitly remove stay disabled until Reset to
                              OpenCode defaults. Check this to disable every missing generated
                              variant.
                            </p>
                          </div>
                        )}

                        {m.reasoning.enabled && m.reasoning.variants.length === 0 && (
                          <p role="status" className="text-[9px] font-mono text-tagma-muted">
                            {generatedVariantIds.length > 0 && m.reasoning.managesGeneratedVariants
                              ? 'This exact list is empty. All OpenCode-generated variants will be disabled; add a row to keep an active choice.'
                              : generatedVariantIds.length > 0
                                ? 'No explicit variants are configured. OpenCode provides model defaults; add a row to override or add one choice, or use the exact-list option above to hide generated choices.'
                                : 'No variants are configured or generated for this model. Add the exact variant IDs and request-options JSON documented by the endpoint.'}
                          </p>
                        )}

                        {!m.reasoning.enabled && reasoningIssues[0] && (
                          <p role="alert" className="text-[9px] font-mono text-tagma-error">
                            Re-enable reasoning to fix the retained variant:{' '}
                            {reasoningIssues[0].message}
                          </p>
                        )}

                        {m.reasoning.enabled && (
                          <div className="space-y-1.5">
                            {m.reasoning.variants.map((variant, variantIndex) => {
                              const idIssue = reasoningIssues.find(
                                (issue) =>
                                  issue.index === variantIndex && issue.field === 'variant-id',
                              );
                              const optionsIssue = reasoningIssues.find(
                                (issue) =>
                                  issue.index === variantIndex && issue.field === 'variant-options',
                              );
                              const idIssueId = `${disclosureId}-variant-${variantIndex}-id-issue`;
                              const optionsIssueId = `${disclosureId}-variant-${variantIndex}-options-issue`;
                              return (
                                <div
                                  key={variantIndex}
                                  className="grid grid-cols-[minmax(90px,0.35fr)_minmax(0,1fr)_20px] items-start gap-1.5"
                                >
                                  <input
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={variant.id}
                                    onChange={(e) =>
                                      updateModelReasoning(idx, (reasoning) =>
                                        updateReasoningVariant(reasoning, variantIndex, {
                                          id: e.target.value,
                                        }),
                                      )
                                    }
                                    placeholder="variant id"
                                    aria-label={`Reasoning variant ${variantIndex + 1} id for ${m.id || `model ${idx + 1}`}`}
                                    aria-invalid={!!idIssue}
                                    aria-describedby={idIssue ? idIssueId : undefined}
                                    className="field-input"
                                  />
                                  <textarea
                                    rows={2}
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={variant.optionsText}
                                    onChange={(e) =>
                                      updateModelReasoning(idx, (reasoning) =>
                                        updateReasoningVariant(reasoning, variantIndex, {
                                          optionsText: e.target.value,
                                        }),
                                      )
                                    }
                                    placeholder={'{"reasoningEffort":"low"}'}
                                    aria-label={`Request options JSON for reasoning variant ${variant.id || variantIndex + 1}`}
                                    aria-invalid={!!optionsIssue}
                                    aria-describedby={optionsIssue ? optionsIssueId : undefined}
                                    className="field-input min-h-12 resize-y font-mono"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateModelReasoning(idx, (reasoning) =>
                                        removeReasoningVariant(reasoning, variantIndex),
                                      )
                                    }
                                    title="Remove reasoning variant"
                                    aria-label={`Remove reasoning variant ${variant.id || variantIndex + 1}`}
                                    className="w-5 p-1 text-tagma-muted hover:text-tagma-error"
                                  >
                                    <Trash2 size={11} />
                                  </button>
                                  {idIssue && (
                                    <p
                                      id={idIssueId}
                                      role="alert"
                                      className="col-span-3 text-[9px] font-mono text-tagma-error"
                                    >
                                      {idIssue.message}
                                    </p>
                                  )}
                                  {optionsIssue && (
                                    <p
                                      id={optionsIssueId}
                                      role="alert"
                                      className="col-span-3 text-[9px] font-mono text-tagma-error"
                                    >
                                      {optionsIssue.message}
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                            <button
                              type="button"
                              onClick={() =>
                                updateModelReasoning(idx, (reasoning) =>
                                  addReasoningVariant(reasoning),
                                )
                              }
                              className="inline-flex items-center gap-1 px-2 py-1 text-[9px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
                            >
                              <Plus size={9} />
                              Add variant
                            </button>
                          </div>
                        )}

                        {reasoningIssues.find((issue) => issue.field === 'variants') && (
                          <p role="alert" className="text-[9px] font-mono text-tagma-error">
                            {reasoningIssues.find((issue) => issue.field === 'variants')?.message}
                          </p>
                        )}
                        {warning && (
                          <p
                            role="status"
                            aria-live="polite"
                            className="text-[9px] font-mono text-tagma-warning/90"
                          >
                            {warning.message}
                          </p>
                        )}
                      </div>
                    )}
                  </fieldset>
                );
              })}
              <button
                type="button"
                onClick={addModelRow}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-tagma-muted hover:text-tagma-text border border-tagma-border hover:border-tagma-muted/60 transition-colors"
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
            <div role="alert" className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
              <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono break-words">
                <AlertCircle size={10} className="shrink-0 mt-[1px]" />
                <span>{error}</span>
              </div>
            </div>
          )}
        </div>

        <div className="modal-viewport-footer flex items-center justify-end gap-2 border-t border-tagma-border px-4 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || blocked}
            className="btn-primary min-w-24 justify-center"
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
  ariaDescribedBy,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  ariaDescribedBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-describedby={ariaDescribedBy}
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-start text-left px-2 py-1.5 border transition-colors flex-1 ${
        active
          ? 'border-tagma-accent/60 bg-tagma-accent/10'
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
  id,
  role,
}: {
  kind: 'info' | 'warn' | 'ok';
  children: React.ReactNode;
  id?: string;
  role?: 'alert' | 'status';
}) {
  const tone =
    kind === 'warn'
      ? 'text-tagma-warning/90'
      : kind === 'ok'
        ? 'text-tagma-ready'
        : 'text-tagma-muted-dim';
  return (
    <p
      id={id}
      role={role}
      aria-atomic={role ? 'true' : undefined}
      className={`mt-1 text-[10px] font-mono ${tone} break-words`}
    >
      {children}
    </p>
  );
}
