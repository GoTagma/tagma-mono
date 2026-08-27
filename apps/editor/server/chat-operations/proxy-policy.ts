import { CHAT_OPERATION_V2_PROTOCOL_VERSION } from './types.js';
import { sanitizeForwardedOpencodeDirectory } from '../opencode-proxy.js';

// Keep this lightweight policy independent of the mutable service graph. The
// service parity tests pin the same exact trusted environment key.
const CHAT_OPERATION_V2_SHADOW_ENV = 'TAGMA_CHAT_OPERATION_V2_SHADOW';
export const CHAT_OPERATION_V2_PRODUCTION_CUTOVER_ENV =
  'TAGMA_CHAT_OPERATION_V2_PRODUCTION_CUTOVER';
export const CHAT_OPERATION_V2_PRODUCTION_CUTOVER_VALUE = '2';
export const CHAT_OPERATION_V2_INTERNAL_MUTATIONS_ENV =
  'TAGMA_CHAT_OPERATION_V2_INTERNAL_MUTATIONS';
export const CHAT_OPERATION_V2_INTERNAL_MUTATIONS_VALUE = '2';

export const CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH = Object.freeze({
  protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
  code: 'chat_operation_protocol_mismatch' as const,
  kind: 'chat_operation_protocol_mismatch' as const,
  problem: 'unsupported_protocol_version' as const,
  error: 'Raw OpenCode mutations are unavailable in Chat Operation V2 production mode.',
});

export type ChatOperationV2ProxyHandshake =
  | {
      readonly chatOperationProtocolVersion: typeof CHAT_OPERATION_V2_PROTOCOL_VERSION;
      readonly chatOperationMode: 'production';
    }
  | {
      readonly chatOperationProtocolVersion: null;
      readonly chatOperationMode: 'legacy';
    };

export interface EvaluateChatOperationV2RendererProxyPolicyInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly method: string;
  /** OpenCode-relative request target, including an optional query string. */
  readonly requestUrl: string;
}

export interface SanitizeChatOperationV2RendererProxyRequestUrlInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestUrl: string;
  /** Canonical Host-authenticated workspace `.tagma` root. */
  readonly tagmaRoot: string;
}

export type ChatOperationV2RendererProxyPolicyDecision =
  | { readonly kind: 'legacy_passthrough' }
  | { readonly kind: 'allow_read' }
  | { readonly kind: 'allow_provider_auth' }
  | {
      readonly kind: 'reject_protocol_mismatch';
      readonly status: 426;
      readonly body: typeof CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH;
    };

export type ChatOperationV2RendererProxyRequestUrlDecision =
  | {
      readonly kind: 'allow_request_url';
      readonly requestUrl: string;
      readonly canonicalDirectory?: string;
    }
  | Extract<ChatOperationV2RendererProxyPolicyDecision, { kind: 'reject_protocol_mismatch' }>;

const LEGACY_PASSTHROUGH = Object.freeze({ kind: 'legacy_passthrough' as const });
const ALLOW_READ = Object.freeze({ kind: 'allow_read' as const });
const ALLOW_PROVIDER_AUTH = Object.freeze({ kind: 'allow_provider_auth' as const });
const REJECT_PROTOCOL_MISMATCH = Object.freeze({
  kind: 'reject_protocol_mismatch' as const,
  status: 426 as const,
  body: CHAT_OPERATION_V2_PROXY_PROTOCOL_MISMATCH,
});

const PRODUCTION_HANDSHAKE = Object.freeze({
  chatOperationProtocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
  chatOperationMode: 'production' as const,
});
const LEGACY_HANDSHAKE = Object.freeze({
  chatOperationProtocolVersion: null,
  chatOperationMode: 'legacy' as const,
});

const MAX_REQUEST_TARGET_CHARS = 16 * 1024;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$/;
const READ_METHODS = new Set(['GET', 'HEAD']);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Exact, finite read surface used by the pinned OpenCode 1.18.18 renderer clients. */
const EXACT_READ_PATHS = new Set([
  '/global/config',
  '/global/health',
  '/global/event',
  '/event',
  '/project',
  '/project/current',
  '/config',
  '/config/providers',
  '/experimental/capabilities',
  '/experimental/tool',
  '/experimental/tool/ids',
  '/path',
  '/vcs',
  '/vcs/status',
  '/vcs/diff',
  '/vcs/diff/raw',
  '/command',
  '/provider',
  '/provider/auth',
  '/agent',
  '/skill',
  '/mcp',
  '/lsp',
  '/formatter',
  '/session',
  '/session/status',
  '/api/health',
  '/api/location',
  '/api/agent',
  '/api/session',
  '/api/session/active',
  '/api/model',
  '/api/provider',
  '/api/command',
  '/api/skill',
  '/api/event',
]);

function canonicalRequestPath(requestUrl: string): string | null {
  if (
    typeof requestUrl !== 'string' ||
    requestUrl.length === 0 ||
    requestUrl.length > MAX_REQUEST_TARGET_CHARS ||
    hasControlCharacter(requestUrl) ||
    requestUrl.includes('#')
  ) {
    return null;
  }
  const queryIndex = requestUrl.indexOf('?');
  const path = queryIndex === -1 ? requestUrl : requestUrl.slice(0, queryIndex);
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.length === 1 ||
    path.endsWith('/') ||
    path.includes('//') ||
    path.includes('\\') ||
    path.includes('%')
  ) {
    return null;
  }
  const segments = path.slice(1).split('/');
  if (
    segments.some(
      (segment) => segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment),
    )
  ) {
    return null;
  }
  return path;
}

function isReadPath(path: string): boolean {
  if (EXACT_READ_PATHS.has(path)) return true;
  const segments = path.slice(1).split('/');

  if (segments[0] === 'project') {
    return segments.length === 2 || (segments.length === 3 && segments[2] === 'directories');
  }

  if (segments[0] === 'session') {
    if (segments.length === 2) return true;
    if (
      segments.length === 3 &&
      (segments[2] === 'children' ||
        segments[2] === 'todo' ||
        segments[2] === 'diff' ||
        segments[2] === 'message')
    ) {
      return true;
    }
    return segments.length === 4 && segments[2] === 'message';
  }

  if (segments[0] === 'api' && segments[1] === 'provider') {
    return segments.length === 3;
  }

  if (segments[0] === 'api' && segments[1] === 'session') {
    if (segments.length === 3) return true;
    if (
      segments.length === 4 &&
      (segments[3] === 'context' ||
        segments[3] === 'history' ||
        segments[3] === 'event' ||
        segments[3] === 'message')
    ) {
      return true;
    }
    return segments.length === 5 && segments[3] === 'message';
  }

  return false;
}

function isProviderAuthMutation(method: string, path: string): boolean {
  const segments = path.slice(1).split('/');
  if (
    segments.length === 2 &&
    segments[0] === 'auth' &&
    (method === 'PUT' || method === 'DELETE')
  ) {
    return true;
  }
  return (
    method === 'POST' &&
    segments.length === 4 &&
    segments[0] === 'provider' &&
    segments[2] === 'oauth' &&
    (segments[3] === 'authorize' || segments[3] === 'callback')
  );
}

export function isChatOperationV2ProductionCutover(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    env[CHAT_OPERATION_V2_SHADOW_ENV] === '1' &&
    env[CHAT_OPERATION_V2_PRODUCTION_CUTOVER_ENV] === CHAT_OPERATION_V2_PRODUCTION_CUTOVER_VALUE
  );
}

export function chatOperationV2ProxyHandshake(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChatOperationV2ProxyHandshake {
  return isChatOperationV2ProductionCutover(env) ? PRODUCTION_HANDSHAKE : LEGACY_HANDSHAKE;
}

/**
 * Shadow alone is read-only. Mutations require either the exact internal
 * Phase-2 gate or the exact production cutover gate, always with shadow on.
 */
export function isChatOperationV2MutationSurfaceEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (env[CHAT_OPERATION_V2_SHADOW_ENV] !== '1') return false;
  return (
    env[CHAT_OPERATION_V2_INTERNAL_MUTATIONS_ENV] === CHAT_OPERATION_V2_INTERNAL_MUTATIONS_VALUE ||
    isChatOperationV2ProductionCutover(env)
  );
}

function decodeQueryComponent(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    return hasControlCharacter(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function isPathLikeQueryKey(key: string): boolean {
  const compact = key.replace(/[-_.]/g, '').toLowerCase();
  if (compact === 'roots') return false;
  return (
    compact === 'cwd' ||
    compact === 'dir' ||
    compact === 'file' ||
    compact === 'filename' ||
    compact === 'workspace' ||
    compact.endsWith('path') ||
    compact.endsWith('directory') ||
    compact.endsWith('root')
  );
}

/**
 * Canonicalize the only filesystem-bearing query accepted in production.
 * Header and query directory authority use the same realpath/symlink fence.
 */
export function sanitizeChatOperationV2RendererProxyRequestUrl(
  input: SanitizeChatOperationV2RendererProxyRequestUrlInput,
): ChatOperationV2RendererProxyRequestUrlDecision {
  if (!isChatOperationV2ProductionCutover(input.env ?? process.env)) {
    return { kind: 'allow_request_url', requestUrl: input.requestUrl };
  }

  const path = canonicalRequestPath(input.requestUrl);
  if (path === null) return REJECT_PROTOCOL_MISMATCH;
  const queryIndex = input.requestUrl.indexOf('?');
  if (queryIndex === -1) return { kind: 'allow_request_url', requestUrl: path };
  const rawQuery = input.requestUrl.slice(queryIndex + 1);
  if (!rawQuery) return REJECT_PROTOCOL_MISMATCH;

  const canonical = new URLSearchParams();
  const seenKeys = new Set<string>();
  for (const field of rawQuery.split('&')) {
    if (!field) return REJECT_PROTOCOL_MISMATCH;
    const equalsIndex = field.indexOf('=');
    const rawKey = equalsIndex === -1 ? field : field.slice(0, equalsIndex);
    const rawValue = equalsIndex === -1 ? '' : field.slice(equalsIndex + 1);
    const key = decodeQueryComponent(rawKey);
    const value = decodeQueryComponent(rawValue);
    if (!key || rawKey !== key || value === null || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
      return REJECT_PROTOCOL_MISMATCH;
    }
    const keyIdentity = key.toLowerCase();
    if (seenKeys.has(keyIdentity)) return REJECT_PROTOCOL_MISMATCH;
    seenKeys.add(keyIdentity);

    if (keyIdentity === 'directory') {
      if (key !== 'directory' || !value) return REJECT_PROTOCOL_MISMATCH;
      try {
        const sanitized = sanitizeForwardedOpencodeDirectory(
          encodeURIComponent(value),
          input.tagmaRoot,
        );
        if (sanitized === null) return REJECT_PROTOCOL_MISMATCH;
        const canonicalDirectory = decodeURIComponent(sanitized);
        canonical.append(key, canonicalDirectory);
      } catch {
        return REJECT_PROTOCOL_MISMATCH;
      }
      continue;
    }
    if (isPathLikeQueryKey(key)) return REJECT_PROTOCOL_MISMATCH;
    canonical.append(key, value);
  }

  const requestUrl = `${path}?${canonical.toString()}`;
  const canonicalDirectory = canonical.get('directory');
  return canonicalDirectory === null
    ? { kind: 'allow_request_url', requestUrl }
    : { kind: 'allow_request_url', requestUrl, canonicalDirectory };
}

/**
 * Fence only renderer traffic that enters through the same-origin raw proxy.
 * Host-owned V2 adapters use their authenticated loopback SDK directly and do
 * not traverse this compatibility boundary.
 */
export function evaluateChatOperationV2RendererProxyPolicy(
  input: EvaluateChatOperationV2RendererProxyPolicyInput,
): ChatOperationV2RendererProxyPolicyDecision {
  if (!isChatOperationV2ProductionCutover(input.env ?? process.env)) {
    return LEGACY_PASSTHROUGH;
  }

  const method =
    typeof input.method === 'string' && /^[A-Za-z]+$/.test(input.method)
      ? input.method.toUpperCase()
      : null;
  const path = canonicalRequestPath(input.requestUrl);
  if (method === null || path === null) return REJECT_PROTOCOL_MISMATCH;
  if (READ_METHODS.has(method) && isReadPath(path)) return ALLOW_READ;
  if (isProviderAuthMutation(method, path)) return ALLOW_PROVIDER_AUTH;
  return REJECT_PROTOCOL_MISMATCH;
}
