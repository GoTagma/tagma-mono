import type { PluginErrorKind } from '../../api/client';

/**
 * Shared error helpers for the Plugins page. Extracted from the old
 * PluginManager modal so both the Installed and Marketplace panels can
 * classify upstream errors with the same logic and surface the same hints.
 *
 * The server now tags every plugin-API error with a `kind` field; these
 * helpers prefer that tag and only fall back to substring matching for
 * older server responses that don't ship one.
 */
export type ErrorKind = PluginErrorKind;

const ERROR_KINDS: ReadonlySet<ErrorKind> = new Set([
  'network',
  'permission',
  'version',
  'notfound',
  'invalid',
  'unknown',
]);

export function classifyError(err: unknown, message: string): ErrorKind {
  const declared = (err as { kind?: unknown } | null | undefined)?.kind;
  if (typeof declared === 'string' && ERROR_KINDS.has(declared as ErrorKind)) {
    return declared as ErrorKind;
  }
  const m = message.toLowerCase();
  if (m.includes('refusing') || m.includes('invalid plugin name') || m.includes('outside')) {
    return 'invalid';
  }
  if (m.includes('integrity') || m.includes('shasum')) return 'version';
  if (
    m.includes('enotfound') ||
    m.includes('etimedout') ||
    m.includes('econnrefused') ||
    m.includes('network') ||
    m.includes('fetch failed')
  ) {
    return 'network';
  }
  if (m.includes('eacces') || m.includes('eperm') || m.includes('permission denied')) {
    return 'permission';
  }
  if (
    m.includes('etarget') ||
    m.includes('eresolve') ||
    m.includes('version') ||
    m.includes('peer dep')
  ) {
    return 'version';
  }
  if (m.includes('e404') || m.includes('not found') || m.includes('404')) {
    return 'notfound';
  }
  return 'unknown';
}

export function errorHint(kind: ErrorKind): string {
  switch (kind) {
    case 'network':
      return 'Network error — check your connection or proxy settings.';
    case 'permission':
      return 'Permission denied — check write access to the working directory.';
    case 'version':
      return 'Version / integrity issue — the package could not be verified or resolved.';
    case 'notfound':
      return 'Package not found on the registry.';
    case 'invalid':
      return 'Plugin name rejected — must be a scoped @tagma/* or tagma-plugin-* package.';
    case 'unknown':
      return 'See details below.';
  }
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return 'Unknown error';
  }
}

/**
 * Format an integer plugin download count with a human-friendly suffix.
 * Mirrors the npm web UI convention so users can compare at a glance.
 */
export function formatDownloads(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
