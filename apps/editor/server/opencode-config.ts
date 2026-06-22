/**
 * Read/write opencode config files for Tagma's embedded OpenCode process.
 *
 * The embedded process is intentionally isolated from the user's normal
 * OpenCode home. We expose two workspace-local scopes:
 *
 *   - `global`    maps to
 *                   `<workDir>/.tagma/.opencode-runtime/config/opencode/opencode.json`.
 *   - `workspace` maps to `<workDir>/.tagma/opencode.json`. Lives inside the
 *                   workspace's own `.tagma/` directory so it co-locates with
 *                   pipelines and the existing `.opencode/agents/` seed; teams
 *                   can commit it to share an internal endpoint.
 *
 * Atomicity + sanitization:
 *   - Read-modify-write the whole JSON document, then reduce it to Tagma's
 *     safe embedded subset before it touches disk.
 *   - `atomicWriteFileSync` (path-utils.ts) stages to a tmp file then renames
 *     into place so a crash mid-write never leaves opencode reading a
 *     truncated file.
 *
 * Tagma's panel surfaces every safe entry under `provider.{}` from these two
 * workspace-local files. User-global OpenCode configuration is ignored.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from './path-utils.js';
import { classifyModelStability } from '../shared/opencode-model-stability.js';

export type ConfigScope = 'global' | 'workspace';

/**
 * Per-model entry under `provider.<id>.models`. Limit fields are optional —
 * opencode/models.dev fills sensible defaults when omitted, and Ollama users
 * generally don't know the exact context size for whatever quantization they
 * have pulled.
 */
export interface CustomProviderModelDef {
  /** Display name shown in the model picker. */
  name?: string;
  limit?: {
    context?: number;
    output?: number;
  };
  /**
   * OpenCode also accepts advanced per-model settings, including per-model
   * `npm` overrides for mixed endpoint setups and package-specific `options`.
   * Keep unknown JSON fields so a UI edit does not silently erase them.
   */
  [key: string]: unknown;
}

/**
 * One provider entry written into the opencode config under `provider.<id>`.
 * Mirrors the opencode docs' shape — opencode passes `options` straight to
 * the chosen `npm` package (default `@ai-sdk/openai-compatible`).
 *
 * `apiKey` accepts plain strings or env-var refs (`{env:OPENROUTER_KEY}`);
 * leave undefined for services that don't require a key (Ollama).
 */
export interface CustomProviderDef {
  /** Display name shown in the picker / connect dialog. */
  name: string;
  /** AI-SDK package the model client is built from. */
  npm: string;
  options: {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
  models: Record<string, CustomProviderModelDef>;
  [key: string]: unknown;
}

/** Wire shape returned to / accepted from the renderer. */
export interface CustomProviderEntry {
  id: string;
  scope: ConfigScope;
  def: CustomProviderDef;
}

/**
 * Distinguishes user-facing input errors (400) from internal failures (500)
 * at the route layer. Avoids regex-matching error messages to classify them.
 */
export class CustomProviderValidationError extends Error {
  override readonly name = 'CustomProviderValidationError';
}

export const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';
const EMBEDDED_RUNTIME_DIR = '.opencode-runtime';

/**
 * Sentinel apiKey written into config when the user registers an OpenAI-
 * compatible provider that needs no auth (Ollama, LM Studio, etc.). With this
 * present, opencode reports the provider in `connected[]` and the Connect
 * dialog renders its "Connected" badge — without it, keyless providers would
 * appear under "Available" forever, which lies about the actual state.
 *
 * @ai-sdk/openai-compatible will pass this as `Authorization: Bearer <value>`
 * on every request; Ollama / LM Studio ignore the header. For real services
 * that strict-check Authorization, the user should provide a real key
 * instead of leaving the field blank.
 */
export const NO_AUTH_REQUIRED_SENTINEL = 'no-auth-required';

/**
 * Sentinel returned to the renderer in place of a real apiKey. The wire
 * shape keeps `apiKey: string` so existing UI doesn't have to branch on
 * undefined; an explicit redacted marker makes "this provider has a key,
 * but you can't read it" obvious in logs and dev tools.
 */
export const REDACTED_API_KEY = '__redacted__';

/**
 * Allowlist for the OpenCode provider `npm` field. Self-served custom
 * providers must opt into a known scope/package — we intentionally do not
 * let arbitrary npm packages flow through the editor's provider config,
 * because OpenCode loads them at runtime and a malicious entry would be
 * equivalent to local code execution. The allowlist is intentionally short
 * — adding an entry should require a security review.
 */
export const ALLOWED_PROVIDER_NPM_PACKAGES: ReadonlySet<string> = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
  '@ai-sdk/mistral',
  '@ai-sdk/cohere',
  '@ai-sdk/groq',
  '@ai-sdk/together',
  '@ai-sdk/xai',
  '@ai-sdk/cerebras',
  '@ai-sdk/deepseek',
  '@ai-sdk/perplexity',
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/azure',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/replicate',
  'ollama-ai-provider',
  'ollama-ai-provider-v2',
]);

const PLAINTEXT_SECRET_PREFIXES = [
  'sk-',
  'sk_live_',
  'sk_test_',
  'pk_live_',
  'rk_live_',
  'ghp_',
  'github_pat_',
  'gho_',
  'ghs_',
  'ghu_',
  'ghr_',
  'xoxb-',
  'xoxp-',
  'xapp-',
  'AKIA',
  'AIza',
  'glpat-',
  'npm_',
];

function looksLikePlaintextSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === NO_AUTH_REQUIRED_SENTINEL) return false;
  if (trimmed.startsWith('{env:') && trimmed.endsWith('}')) return false;
  return PLAINTEXT_SECRET_PREFIXES.some((p) => trimmed.startsWith(p));
}

function isEnvReference(value: string): boolean {
  return /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

function isWorkspaceSafeCredentialValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === NO_AUTH_REQUIRED_SENTINEL || isEnvReference(trimmed);
}

function previewApiKey(apiKey: string | undefined): string | null {
  if (!apiKey) return null;
  if (apiKey === NO_AUTH_REQUIRED_SENTINEL) return null;
  // {env:VAR} references are not secrets — surface them so the user can see
  // which env var is in play.
  if (apiKey.startsWith('{env:') && apiKey.endsWith('}')) return apiKey;
  if (apiKey.length <= 8) return apiKey.slice(0, 2) + '…';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/**
 * Header names that always carry credentials. We redact these unconditionally
 * even when their on-disk value looks innocuous — a user staring at a
 * "X-API-Key: hello" should still not have it shown back to them via an API.
 * Match is case-insensitive substring so vendor-specific spellings
 * (`x-api-key`, `X-Anthropic-API-Key`, `X-Goog-API-Key`, `Proxy-Authorization`,
 * etc.) all funnel through the same path.
 */
const SENSITIVE_HEADER_PATTERNS = [
  'authorization',
  'auth-token',
  'api-key',
  'api-token',
  'apikey',
  'apitoken',
  'bearer',
  'cookie',
  'x-token',
  'x-key',
  'session',
  'secret',
];

function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p));
}

interface RedactedHeader {
  /** Always `REDACTED_API_KEY` for sensitive headers, the raw value otherwise. */
  readonly value: string;
  readonly redacted: boolean;
  readonly preview: string | null;
  readonly kind: 'plaintext' | 'env' | 'sentinel' | null;
}

function redactHeaderValue(name: string, value: string): RedactedHeader {
  const env = value.startsWith('{env:') && value.endsWith('}');
  const sentinel = value === NO_AUTH_REQUIRED_SENTINEL;
  const sensitive = isSensitiveHeaderName(name) || looksLikePlaintextSecret(value);
  if (!sensitive && !env) {
    return { value, redacted: false, preview: value, kind: null };
  }
  let kind: 'plaintext' | 'env' | 'sentinel' = 'plaintext';
  if (sentinel) kind = 'sentinel';
  else if (env) kind = 'env';
  return {
    value: REDACTED_API_KEY,
    redacted: true,
    preview: previewApiKey(value),
    kind,
  };
}

/**
 * Strip credentials out of a provider definition before it crosses the
 * sidecar/renderer boundary. The renderer never has a legitimate need for
 * the raw key — it only needs to know whether one is set so the UI can show
 * "Connected" vs "Add key", and the prefix/suffix preview helps the user
 * confirm which key is in place.
 *
 * Both `options.apiKey` AND any sensitive entries in `options.headers` (e.g.
 * Authorization, x-api-key, custom enterprise tokens) are replaced with the
 * `REDACTED_API_KEY` sentinel. Round-tripping that sentinel via PUT
 * preserves the on-disk value — see validateCustomProvider for the merge.
 */
export function redactProviderApiKey(def: CustomProviderDef): CustomProviderDef & {
  hasApiKey?: boolean;
  apiKeyPreview?: string | null;
  apiKeyKind?: 'plaintext' | 'env' | 'sentinel' | null;
  headerPreview?: Record<
    string,
    { redacted: boolean; preview: string | null; kind: 'plaintext' | 'env' | 'sentinel' | null }
  >;
} {
  const { apiKey, headers } = def.options;
  let hasApiKey = false;
  let apiKeyPreview: string | null = null;
  let apiKeyKind: 'plaintext' | 'env' | 'sentinel' | null = null;
  const nextOptions: typeof def.options = { ...def.options };
  if (apiKey !== undefined && apiKey !== '') {
    hasApiKey = true;
    if (apiKey === NO_AUTH_REQUIRED_SENTINEL) apiKeyKind = 'sentinel';
    else if (apiKey.startsWith('{env:') && apiKey.endsWith('}')) apiKeyKind = 'env';
    else apiKeyKind = 'plaintext';
    apiKeyPreview = previewApiKey(apiKey);
    nextOptions.apiKey = REDACTED_API_KEY;
  }

  let headerPreview:
    | Record<
        string,
        { redacted: boolean; preview: string | null; kind: 'plaintext' | 'env' | 'sentinel' | null }
      >
    | undefined;
  if (headers && Object.keys(headers).length > 0) {
    const redactedHeaders: Record<string, string> = {};
    headerPreview = {};
    for (const [name, value] of Object.entries(headers)) {
      const r = redactHeaderValue(name, value);
      redactedHeaders[name] = r.value;
      headerPreview[name] = { redacted: r.redacted, preview: r.preview, kind: r.kind };
    }
    nextOptions.headers = redactedHeaders;
  }

  return {
    ...def,
    options: nextOptions,
    hasApiKey,
    apiKeyPreview,
    apiKeyKind,
    ...(headerPreview ? { headerPreview } : {}),
  };
}

export interface EmbeddedOpencodeRuntimePaths {
  root: string;
  home: string;
  configDir: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  appData: string;
  localAppData: string;
  globalConfigPath: string;
  workspaceConfigPath: string;
}

/**
 * Private home/config/cache locations for one embedded OpenCode process.
 * Data/state intentionally resolve to the user's normal OpenCode data roots
 * so provider login state can be reused while config/plugin/agent discovery
 * stays isolated.
 */
export function resolveOpencodeRuntimePaths(tagmaCwd: string): EmbeddedOpencodeRuntimePaths {
  const root = join(tagmaCwd, EMBEDDED_RUNTIME_DIR);
  const configHome = join(root, 'config');
  const configDir = join(configHome, 'opencode');
  return {
    root,
    home: join(root, 'home'),
    configDir,
    configHome,
    dataHome: resolveUserDataHome(),
    stateHome: resolveUserStateHome(),
    cacheHome: join(root, 'cache'),
    appData: join(root, 'appdata'),
    localAppData: join(root, 'localappdata'),
    globalConfigPath: join(configDir, 'opencode.json'),
    workspaceConfigPath: join(tagmaCwd, 'opencode.json'),
  };
}

function resolveUserDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share');
}

function resolveUserStateHome(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  return xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
}

export function resolveEmbeddedOpencodeGlobalConfigPath(workDir: string): string {
  return resolveOpencodeRuntimePaths(join(workDir, '.tagma')).globalConfigPath;
}

export function resolveOpencodeGlobalConfigPath(workDir: string): string {
  return resolveEmbeddedOpencodeGlobalConfigPath(workDir);
}

/**
 * Workspace-scoped config lives next to the seed agent file so Tagma's
 * footprint stays contained within `.tagma/`. opencode walks from cwd
 * (`<workDir>/.tagma/`) upward, so this file is the first one it finds.
 */
export function resolveOpencodeWorkspaceConfigPath(workDir: string): string {
  return join(workDir, '.tagma', 'opencode.json');
}

function pathForScope(scope: ConfigScope, workDir: string | null): string {
  if (!workDir) {
    throw new CustomProviderValidationError(
      'OpenCode provider configuration requires an open workspace.',
    );
  }
  if (scope === 'global') return resolveOpencodeGlobalConfigPath(workDir);
  return resolveOpencodeWorkspaceConfigPath(workDir);
}

export interface RawConfig {
  $schema?: unknown;
  provider?: unknown;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeExtraConfigKey(key: string): boolean {
  return key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
}

function preserveJsonObjectExtras(
  raw: Record<string, unknown>,
  reserved: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (reserved.has(key) || !isSafeExtraConfigKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function sanitizeModelExtras(raw: Record<string, unknown>): Record<string, unknown> {
  const extra = preserveJsonObjectExtras(raw, new Set(['name', 'limit']));
  const npm = extra.npm;
  if (typeof npm === 'string') {
    const pkg = npm.trim();
    if (pkg && ALLOWED_PROVIDER_NPM_PACKAGES.has(pkg)) extra.npm = pkg;
    else delete extra.npm;
  }
  return extra;
}

function sanitizeProviderOptionExtras(raw: Record<string, unknown>): Record<string, unknown> {
  const extra = preserveJsonObjectExtras(raw, new Set(['baseURL', 'apiKey', 'headers']));
  for (const key of ['timeout', 'chunkTimeout']) {
    const value = extra[key];
    if (value !== undefined && value !== false && typeof value !== 'number') delete extra[key];
  }
  if (extra.setCacheKey !== undefined && typeof extra.setCacheKey !== 'boolean') {
    delete extra.setCacheKey;
  }
  return extra;
}

const PROVIDER_EXTRA_RESERVED_KEYS = new Set([
  'name',
  'npm',
  'options',
  'models',
  // Renderer-only metadata returned by redactProviderApiKey(). These describe
  // secrets and should never be persisted back into opencode.json.
  'hasApiKey',
  'apiKeyPreview',
  'apiKeyKind',
  'headerPreview',
]);

function sanitizeProviderExtras(raw: Record<string, unknown>): Record<string, unknown> {
  return preserveJsonObjectExtras(raw, PROVIDER_EXTRA_RESERVED_KEYS);
}

function validateProviderExtras(raw: Record<string, unknown>): Record<string, unknown> {
  return preserveJsonObjectExtras(raw, PROVIDER_EXTRA_RESERVED_KEYS);
}

function validateProviderOptionExtras(raw: Record<string, unknown>): Record<string, unknown> {
  const extra = preserveJsonObjectExtras(raw, new Set(['baseURL', 'apiKey', 'headers']));
  for (const key of ['timeout', 'chunkTimeout']) {
    const value = extra[key];
    if (value === undefined) continue;
    if (value !== false && !(typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      throw new CustomProviderValidationError(
        `\`options.${key}\` must be a positive number of milliseconds, or false to disable.`,
      );
    }
  }
  if (extra.setCacheKey !== undefined && typeof extra.setCacheKey !== 'boolean') {
    throw new CustomProviderValidationError('`options.setCacheKey` must be a boolean.');
  }
  return extra;
}

/**
 * Parse a config file. Returns an empty object when the file is missing or
 * its contents aren't a JSON object — both are normal "no custom config yet"
 * states and should not error the caller.
 *
 * A malformed-but-present file still throws: silently overwriting it would
 * destroy whatever the user (or their other tooling) put there.
 */
function readConfigAt(path: string): RawConfig {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Refusing to read opencode config through symlink: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `opencode config at ${path} is not valid JSON — fix it by hand before adding custom providers. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`opencode config at ${path} must be a JSON object, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Persist a config file. Always re-stamps `$schema` so a freshly created file
 * gets editor autocomplete, but never touches unrelated top-level keys.
 *
 * Stable key ordering (`$schema` first, then alphabetical) keeps the file
 * diff-friendly when users put it under version control.
 */
function writeConfigAt(path: string, next: RawConfig): void {
  mkdirSync(dirname(path), { recursive: true });

  const ordered: RawConfig = { $schema: OPENCODE_SCHEMA_URL };
  const keys = Object.keys(next)
    .filter((k) => k !== '$schema')
    .sort();
  for (const k of keys) ordered[k] = next[k];

  atomicWriteFileSync(path, JSON.stringify(ordered, null, 2) + '\n');
}

function sanitizeEmbeddedConfig(raw: RawConfig): RawConfig {
  const provider: Record<string, CustomProviderDef> = {};
  const blockedModelRefs = new Set<string>();
  if (isPlainObject(raw.provider)) {
    for (const [id, value] of Object.entries(raw.provider)) {
      const def = coerceProviderDef(value);
      const normalizedId = normalizeCustomProviderId(id);
      if (def && PROVIDER_ID_RE.test(normalizedId)) {
        const filtered = filterBlockedCustomProviderDef(normalizedId, def, blockedModelRefs);
        if (filtered) provider[normalizedId] = filtered;
      }
    }
  }

  const out: RawConfig = {
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
  };
  if (
    typeof raw.model === 'string' &&
    raw.model.trim() &&
    !blockedModelRefs.has(modelRefKeyFromString(raw.model))
  ) {
    out.model = raw.model;
  }
  if (
    typeof raw.small_model === 'string' &&
    raw.small_model.trim() &&
    !blockedModelRefs.has(modelRefKeyFromString(raw.small_model))
  ) {
    out.small_model = raw.small_model;
  }
  if (Object.keys(provider).length > 0) out.provider = provider;
  return out;
}

function modelRefKey(providerID: string, modelID: string): string {
  return `${providerID.trim().toLowerCase()}/${modelID.trim().toLowerCase()}`;
}

function modelRefKeyFromString(value: string): string {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return '';
  return modelRefKey(value.slice(0, slash), value.slice(slash + 1));
}

function filterBlockedCustomProviderDef(
  providerID: string,
  def: CustomProviderDef,
  blockedModelRefs: Set<string>,
): CustomProviderDef | null {
  const providerForClassification = { ...def, id: providerID };
  const models: Record<string, CustomProviderModelDef> = {};
  let changed = false;

  for (const [modelID, model] of Object.entries(def.models)) {
    const modelForClassification = { ...model, id: modelID };
    if (
      classifyModelStability(providerForClassification, modelForClassification, modelID).status ===
      'blocked'
    ) {
      blockedModelRefs.add(modelRefKey(providerID, modelID));
      changed = true;
      continue;
    }
    models[modelID] = model;
  }

  if (Object.keys(models).length === 0) return null;
  return changed ? { ...def, models } : def;
}

function readSanitizedConfigAt(path: string): RawConfig {
  return sanitizeEmbeddedConfig(readConfigAt(path));
}

function writeEmbeddedConfigAt(path: string, next: RawConfig): void {
  writeConfigAt(path, sanitizeEmbeddedConfig(next));
}

function writeRuntimeIgnoreFile(paths: EmbeddedOpencodeRuntimePaths): void {
  atomicWriteFileSync(join(paths.root, '.gitignore'), '*\n!.gitignore\n');
}

/**
 * Default chunk timeout for streaming responses. If no chunk arrives within
 * this window after streaming has started, opencode aborts the request. This
 * catches upstream connections that die mid-stream without closing the TCP
 * socket. 5 minutes is generous enough for reasoning models that pause between
 * thinking chunks, while still catching genuinely dead connections.
 *
 * Users can override per-provider in their config (set to `false` to disable).
 * Only applied when the user hasn't explicitly set `chunkTimeout` themselves.
 */
const DEFAULT_CHUNK_TIMEOUT_MS = 300_000; // 5 minutes

export function buildEmbeddedOpencodeRuntimeConfig(paths: EmbeddedOpencodeRuntimePaths): RawConfig {
  const out: RawConfig = {
    $schema: OPENCODE_SCHEMA_URL,
    plugin: [],
  };
  for (const cfg of [
    readSanitizedConfigAt(paths.globalConfigPath),
    readSanitizedConfigAt(paths.workspaceConfigPath),
  ]) {
    if (typeof cfg.model === 'string' && cfg.model.trim()) out.model = cfg.model;
    if (typeof cfg.small_model === 'string' && cfg.small_model.trim()) {
      out.small_model = cfg.small_model;
    }
    if (isPlainObject(cfg.provider)) {
      out.provider = {
        ...(isPlainObject(out.provider) ? out.provider : {}),
        ...cfg.provider,
      };
    }
  }
  // Apply default chunkTimeout to all providers that haven't set their own.
  // This catches dead upstream connections during streaming without interfering
  // with legitimate long thinking times (chunkTimeout only fires after the
  // first chunk has arrived).
  if (isPlainObject(out.provider)) {
    for (const provider of Object.values(out.provider)) {
      if (isPlainObject(provider) && isPlainObject(provider.options)) {
        if (provider.options.chunkTimeout === undefined) {
          provider.options = { ...provider.options, chunkTimeout: DEFAULT_CHUNK_TIMEOUT_MS };
        }
      }
    }
  }
  return out;
}

export function prepareEmbeddedOpencodeRuntime(tagmaCwd: string): EmbeddedOpencodeRuntimePaths {
  const paths = resolveOpencodeRuntimePaths(tagmaCwd);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.configHome, { recursive: true });
  mkdirSync(paths.cacheHome, { recursive: true });
  mkdirSync(paths.appData, { recursive: true });
  mkdirSync(paths.localAppData, { recursive: true });
  writeRuntimeIgnoreFile(paths);

  const globalConfig = existsSync(paths.globalConfigPath)
    ? readSanitizedConfigAt(paths.globalConfigPath)
    : {};
  writeEmbeddedConfigAt(paths.globalConfigPath, globalConfig);

  const workspaceConfig = existsSync(paths.workspaceConfigPath)
    ? readSanitizedConfigAt(paths.workspaceConfigPath)
    : {};
  writeEmbeddedConfigAt(paths.workspaceConfigPath, workspaceConfig);

  return paths;
}

/**
 * Return every entry currently present under `provider.{}` in either scope.
 * The renderer renders both lists so users can see the full merged picture
 * opencode will load. We don't try to distinguish "Tagma-written" from
 * "user-hand-edited" — the panel manages all of them uniformly.
 *
 * If both scopes define the same id, both are returned (with their respective
 * scope tag) — that mirrors the on-disk reality and lets the user see the
 * conflict explicitly. opencode's merge resolves it at runtime.
 */
export function listCustomProviders(workDir: string | null): CustomProviderEntry[] {
  const out: CustomProviderEntry[] = [];

  const collectFromScope = (scope: ConfigScope): void => {
    let path: string;
    try {
      path = pathForScope(scope, workDir);
    } catch {
      return;
    }
    let cfg: RawConfig;
    try {
      cfg = readConfigAt(path);
    } catch (err) {
      console.warn(`[opencode-config] Failed to read ${scope} config at ${path}:`, err);
      return;
    }
    if (!isPlainObject(cfg.provider)) return;
    for (const [id, raw] of Object.entries(cfg.provider)) {
      const def = coerceProviderDef(raw);
      if (def) out.push({ id, scope, def });
    }
  };

  if (workDir) {
    collectFromScope('global');
    collectFromScope('workspace');
  }

  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'workspace' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Validate + normalize an arbitrary JSON value pulled from disk into a
 * `CustomProviderDef`. Returns `null` when the entry is too malformed to
 * render — better to drop it from the panel than to render placeholders that
 * confuse the user about what opencode will actually load.
 */
function coerceProviderDef(raw: unknown): CustomProviderDef | null {
  if (!isPlainObject(raw)) return null;
  const npm = typeof raw.npm === 'string' ? raw.npm : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  const opts = isPlainObject(raw.options) ? raw.options : null;
  const baseURL = opts && typeof opts.baseURL === 'string' ? opts.baseURL : null;
  if (!npm || !name || !baseURL) return null;

  const providerExtras = sanitizeProviderExtras(raw);
  const apiKey = opts && typeof opts.apiKey === 'string' ? opts.apiKey : undefined;
  const optionExtras = opts ? sanitizeProviderOptionExtras(opts) : {};
  const headers =
    opts && isPlainObject(opts.headers)
      ? Object.fromEntries(
          Object.entries(opts.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;

  const models: Record<string, CustomProviderModelDef> = {};
  if (isPlainObject(raw.models)) {
    for (const [id, m] of Object.entries(raw.models)) {
      if (!isPlainObject(m)) continue;
      const entry: CustomProviderModelDef = sanitizeModelExtras(m);
      if (typeof m.name === 'string') entry.name = m.name;
      if (isPlainObject(m.limit)) {
        const limit: NonNullable<CustomProviderModelDef['limit']> = {};
        if (typeof m.limit.context === 'number') limit.context = m.limit.context;
        if (typeof m.limit.output === 'number') limit.output = m.limit.output;
        if (Object.keys(limit).length > 0) entry.limit = limit;
      }
      models[id] = entry;
    }
  }

  return {
    ...providerExtras,
    name,
    npm,
    options: {
      ...optionExtras,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    },
    models,
  };
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeCustomProviderId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Validate caller-supplied input before it touches disk. Mirrors the modal's
 * client-side checks so the server doesn't trust them — keeps malformed
 * payloads (or curl-from-the-shell users) from corrupting the config. All
 * failures throw `CustomProviderValidationError` so the route layer can
 * map them to 400 cleanly.
 *
 * `options.scope` controls a few extra checks:
 *   - For `workspace` scope (commit-able) we refuse plaintext-looking
 *     secrets (`sk-…`, `ghp_…`, etc.) so a team config can't accidentally
 *     ship a real key into Git. Use `{env:VAR}` instead.
 *   - For both scopes the npm field must come from
 *     `ALLOWED_PROVIDER_NPM_PACKAGES`. OpenCode loads the package at
 *     runtime, so an arbitrary npm dep is equivalent to local code execution.
 *   - `existingApiKey` is the value currently on disk; when the caller
 *     submits the `REDACTED_API_KEY` sentinel we substitute the disk value
 *     so editing other fields doesn't blank a real key.
 */
export interface ValidateCustomProviderOptions {
  scope: ConfigScope;
  /** Existing on-disk apiKey, if any — used to round-trip the redacted sentinel. */
  existingApiKey?: string | undefined;
  /**
   * Existing on-disk headers, if any. Same redaction round-trip as apiKey:
   * a header value submitted as `REDACTED_API_KEY` is replaced with the
   * value currently on disk (under the same header name). New header
   * names cannot use the sentinel — that has nothing to round-trip to.
   */
  existingHeaders?: Record<string, string> | undefined;
}

export function validateCustomProvider(
  id: string,
  def: unknown,
  options: ValidateCustomProviderOptions,
): CustomProviderDef {
  const normalizedId = typeof id === 'string' ? normalizeCustomProviderId(id) : '';
  if (!PROVIDER_ID_RE.test(normalizedId)) {
    throw new CustomProviderValidationError(
      'Provider id must be lowercase alphanumerics, dots, dashes, or underscores (and start with one).',
    );
  }
  if (!isPlainObject(def)) {
    throw new CustomProviderValidationError('Provider definition must be a JSON object.');
  }
  const npm = typeof def.npm === 'string' ? def.npm.trim() : '';
  const name = typeof def.name === 'string' ? def.name.trim() : '';
  if (!npm) {
    throw new CustomProviderValidationError(
      'Provider `npm` is required (e.g. "@ai-sdk/openai-compatible").',
    );
  }
  if (!ALLOWED_PROVIDER_NPM_PACKAGES.has(npm)) {
    throw new CustomProviderValidationError(
      `Provider \`npm\` "${npm}" is not in the allowlist. ` +
        `Allowed packages: ${[...ALLOWED_PROVIDER_NPM_PACKAGES].sort().join(', ')}.`,
    );
  }
  if (!name) {
    throw new CustomProviderValidationError('Provider display name is required.');
  }

  const providerExtras = validateProviderExtras(def);
  const opts = isPlainObject(def.options) ? def.options : null;
  const baseURL = opts && typeof opts.baseURL === 'string' ? opts.baseURL.trim() : '';
  if (!baseURL) throw new CustomProviderValidationError('`options.baseURL` is required.');
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('baseURL must be http:// or https://');
    }
  } catch (err) {
    throw new CustomProviderValidationError(
      `\`options.baseURL\` is not a valid URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const optionExtras = opts ? validateProviderOptionExtras(opts) : {};

  let apiKey: string | undefined =
    opts && typeof opts.apiKey === 'string' ? opts.apiKey : undefined;
  // Round-trip the redacted sentinel: GET returned `REDACTED_API_KEY`, so a
  // PUT round-tripping it back means "keep what's on disk". Reject if the
  // caller pretends to know the redacted value when no key is on disk yet.
  if (apiKey === REDACTED_API_KEY) {
    if (options.existingApiKey === undefined) {
      throw new CustomProviderValidationError(
        '`options.apiKey` cannot be the redacted sentinel for a new provider — paste the real key.',
      );
    }
    apiKey = options.existingApiKey;
  }
  if (apiKey !== undefined) {
    // No control characters in apiKey — would let a caller smuggle extra
    // headers when this gets used as `Authorization: Bearer <apiKey>`.
    if (/[\r\n\0]/.test(apiKey)) {
      throw new CustomProviderValidationError(
        '`options.apiKey` contains invalid control characters.',
      );
    }
    if (options.scope === 'workspace' && !isWorkspaceSafeCredentialValue(apiKey)) {
      throw new CustomProviderValidationError(
        'Refusing to write a plaintext API key into the workspace config (which may be committed). ' +
          'Use a `{env:VAR}` reference, `no-auth-required`, or save this provider in the global scope.',
      );
    }
  }
  let headers: Record<string, string> | undefined;
  if (opts && isPlainObject(opts.headers)) {
    const entries = Object.entries(opts.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    const merged: Record<string, string> = {};
    for (const [headerName, rawValue] of entries) {
      if (typeof headerName !== 'string' || headerName.trim() === '') {
        throw new CustomProviderValidationError('Header names must be non-empty strings.');
      }
      // Reject control characters in either name or value — both are
      // header-injection vectors when this gets sent over the wire.
      if (/[\r\n\0]/.test(headerName) || /[\r\n\0]/.test(rawValue)) {
        throw new CustomProviderValidationError(
          `Header "${headerName}" contains invalid control characters.`,
        );
      }
      let value = rawValue;
      if (value === REDACTED_API_KEY) {
        const onDisk = options.existingHeaders?.[headerName];
        if (onDisk === undefined) {
          throw new CustomProviderValidationError(
            `Header "${headerName}" cannot be the redacted sentinel for a new entry — paste the real value.`,
          );
        }
        value = onDisk;
      }
      // Apply the same plaintext-secret refusal in workspace scope: a header
      // is the same blast radius as apiKey for a committed config.
      if (
        options.scope === 'workspace' &&
        (isSensitiveHeaderName(headerName) || looksLikePlaintextSecret(value))
      ) {
        if (!isWorkspaceSafeCredentialValue(value)) {
          throw new CustomProviderValidationError(
            `Refusing to write plaintext credential into workspace config under header "${headerName}". ` +
              `Use a \`{env:VAR}\` reference, or save this provider in the global scope.`,
          );
        }
      }
      merged[headerName] = value;
    }
    headers = merged;
  }

  if (!isPlainObject(def.models) || Object.keys(def.models).length === 0) {
    throw new CustomProviderValidationError('At least one model is required.');
  }
  const models: Record<string, CustomProviderModelDef> = {};
  for (const [modelId, raw] of Object.entries(def.models)) {
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new CustomProviderValidationError('Each model needs a non-empty id.');
    }
    if (!isPlainObject(raw)) {
      throw new CustomProviderValidationError(`Model "${modelId}" must be an object.`);
    }
    const entry: CustomProviderModelDef = preserveJsonObjectExtras(raw, new Set(['name', 'limit']));
    if (typeof entry.npm === 'string') {
      const pkg = entry.npm.trim();
      if (!ALLOWED_PROVIDER_NPM_PACKAGES.has(pkg)) {
        throw new CustomProviderValidationError(
          `Model "${modelId}" uses npm package "${pkg}", which is not in the allowlist. ` +
            `Allowed packages: ${[...ALLOWED_PROVIDER_NPM_PACKAGES].sort().join(', ')}.`,
        );
      }
      entry.npm = pkg;
    }
    if (typeof raw.name === 'string' && raw.name.trim() !== '') entry.name = raw.name.trim();
    if (isPlainObject(raw.limit)) {
      const limit: NonNullable<CustomProviderModelDef['limit']> = {};
      if (typeof raw.limit.context === 'number' && raw.limit.context > 0) {
        limit.context = raw.limit.context;
      }
      if (typeof raw.limit.output === 'number' && raw.limit.output > 0) {
        limit.output = raw.limit.output;
      }
      if (Object.keys(limit).length > 0) entry.limit = limit;
    }
    models[modelId.trim()] = entry;
  }

  return {
    ...providerExtras,
    name,
    npm,
    options: {
      ...optionExtras,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    },
    models,
  };
}

/**
 * Read the apiKey + headers currently stored for `id` under `scope` so the
 * route layer can round-trip the redacted sentinels. Returns
 * `{apiKey: undefined, headers: undefined}` when the provider does not
 * exist yet.
 */
export function readExistingProviderSecrets(
  scope: ConfigScope,
  workDir: string | null,
  id: string,
): { apiKey: string | undefined; headers: Record<string, string> | undefined } {
  let path: string;
  try {
    path = pathForScope(scope, workDir);
  } catch {
    return { apiKey: undefined, headers: undefined };
  }
  let cfg: RawConfig;
  try {
    cfg = readConfigAt(path);
  } catch {
    return { apiKey: undefined, headers: undefined };
  }
  if (!isPlainObject(cfg.provider)) return { apiKey: undefined, headers: undefined };
  const normalized = normalizeCustomProviderId(id);
  const entry = cfg.provider[normalized] ?? cfg.provider[id];
  if (!isPlainObject(entry)) return { apiKey: undefined, headers: undefined };
  const opts = isPlainObject(entry.options) ? entry.options : null;
  if (!opts) return { apiKey: undefined, headers: undefined };
  const apiKey = typeof opts.apiKey === 'string' ? opts.apiKey : undefined;
  let headers: Record<string, string> | undefined;
  if (isPlainObject(opts.headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers)) {
      if (typeof v === 'string') out[k] = v;
    }
    if (Object.keys(out).length > 0) headers = out;
  }
  return { apiKey, headers };
}

/**
 * Back-compat shim — older call sites still ask for just the apiKey.
 * Prefer `readExistingProviderSecrets` for new code.
 */
export function readExistingProviderApiKey(
  scope: ConfigScope,
  workDir: string | null,
  id: string,
): string | undefined {
  let path: string;
  try {
    path = pathForScope(scope, workDir);
  } catch {
    return undefined;
  }
  let cfg: RawConfig;
  try {
    cfg = readConfigAt(path);
  } catch {
    return undefined;
  }
  if (!isPlainObject(cfg.provider)) return undefined;
  const normalized = normalizeCustomProviderId(id);
  const entry = cfg.provider[normalized] ?? cfg.provider[id];
  if (!isPlainObject(entry)) return undefined;
  const opts = isPlainObject(entry.options) ? entry.options : null;
  if (!opts) return undefined;
  return typeof opts.apiKey === 'string' ? opts.apiKey : undefined;
}

/**
 * Insert or replace a single provider entry in the chosen scope. Other
 * entries under `provider.{}` are left exactly as they were on disk,
 * including any keys we don't recognize — opencode may add new fields and
 * we don't want to truncate them.
 */
export function upsertCustomProvider(
  scope: ConfigScope,
  workDir: string | null,
  id: string,
  def: CustomProviderDef,
): void {
  const path = pathForScope(scope, workDir);
  const cfg = readConfigAt(path);
  const provider: Record<string, unknown> = isPlainObject(cfg.provider) ? { ...cfg.provider } : {};
  provider[normalizeCustomProviderId(id)] = def;
  writeEmbeddedConfigAt(path, { ...cfg, provider });
}

/**
 * Remove the entry from the chosen scope. Returns `true` when something was
 * actually removed — lets the route distinguish 404 from 200.
 */
export function removeCustomProvider(
  scope: ConfigScope,
  workDir: string | null,
  id: string,
): boolean {
  const path = pathForScope(scope, workDir);
  const cfg = readConfigAt(path);
  if (!isPlainObject(cfg.provider)) return false;
  const normalizedId = normalizeCustomProviderId(id);
  const key = normalizedId in cfg.provider ? normalizedId : id;
  if (!(key in cfg.provider)) return false;
  const provider = { ...cfg.provider };
  delete provider[key];
  writeEmbeddedConfigAt(path, { ...cfg, provider });
  return true;
}
