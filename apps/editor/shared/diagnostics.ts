export const DIAGNOSTICS_PROTOCOL_VERSION = 1 as const;

export interface DiagnosticsSanitizeOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringChars?: number;
}

export interface DiagnosticsConnection {
  protocolVersion: typeof DIAGNOSTICS_PROTOCOL_VERSION;
  baseUrl: string;
  token: string;
  workspaceKey: string | null;
}

export type DiagnosticsSessionStatus =
  | { enabled: false }
  | {
      enabled: true;
      sessionId: string;
      enabledAt: number;
      workspaceKey: string | null;
      connection: DiagnosticsConnection;
    };

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RendererDiagnosticLog {
  timestamp: number;
  level: DiagnosticLogLevel;
  message: string;
}

export interface RendererDiagnosticsReport {
  instanceId: string;
  workspaceKey: string | null;
  capturedAt: number;
  snapshot: unknown;
  logs: RendererDiagnosticLog[];
}

const DEFAULT_OPTIONS: Required<DiagnosticsSanitizeOptions> = {
  maxDepth: 8,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxStringChars: 16_384,
};

const SENSITIVE_KEYS = new Set([
  'authorization',
  'password',
  'passwd',
  'apikey',
  'accesskey',
  'secret',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'cookie',
  'setcookie',
  'privatekey',
  'opencodeserverpassword',
  'tagmaauthtoken',
]);

function normalizedKey(key: string): string {
  return key.replace(/[-_\s]/g, '').toLowerCase();
}

function sensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

/**
 * Remove common credential forms from human-readable logs. This is a
 * best-effort safety boundary, not a claim that arbitrary user-authored text
 * can be proven secret-free.
 */
export function redactDiagnosticText(input: string): string {
  return input
    .replace(
      /(\bAuthorization\s*[:=]\s*)(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      '$1$2 [REDACTED]',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /(\b(?:[A-Za-z0-9_]*(?:API[_-]?KEY|PASSWORD|PASSWD|SECRET|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY)[A-Za-z0-9_]*)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk-(?:proj-)?|xox[baprs]-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}\b/g,
      '[REDACTED]',
    );
}

function boundedString(value: string, maxChars: number): string {
  const redacted = redactDiagnosticText(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…[truncated ${redacted.length - maxChars} chars]`;
}

function sanitizeInner(
  value: unknown,
  key: string | null,
  depth: number,
  options: Required<DiagnosticsSanitizeOptions>,
  seen: WeakSet<object>,
): unknown {
  if (key !== null && sensitiveKey(key)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedString(value, options.maxStringChars);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (depth >= options.maxDepth) return { __truncatedDepth: true };
  if (seen.has(value)) return { __circular: true };
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return sanitizeInner(
      {
        name: value.name,
        message: value.message,
        stack: value.stack ?? null,
      },
      key,
      depth,
      options,
      seen,
    );
  }
  if (value instanceof Map) {
    return sanitizeInner(
      Array.from(value.entries()),
      key,
      depth,
      options,
      seen,
    );
  }
  if (value instanceof Set) {
    return sanitizeInner(Array.from(value.values()), key, depth, options, seen);
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, options.maxArrayItems)
      .map((item) => sanitizeInner(item, null, depth + 1, options, seen));
    if (value.length > options.maxArrayItems) {
      kept.push({ __truncatedItems: value.length - options.maxArrayItems });
    }
    return kept;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [entryKey, entryValue] of entries.slice(0, options.maxObjectKeys)) {
    const sanitized = sanitizeInner(entryValue, entryKey, depth + 1, options, seen);
    if (sanitized !== undefined) output[entryKey] = sanitized;
  }
  if (entries.length > options.maxObjectKeys) {
    output.__truncatedKeys = entries.length - options.maxObjectKeys;
  }
  return output;
}

export function sanitizeDiagnosticValue(
  value: unknown,
  options: DiagnosticsSanitizeOptions = {},
): unknown {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  return sanitizeInner(value, null, 0, resolved, new WeakSet<object>()) ?? null;
}

