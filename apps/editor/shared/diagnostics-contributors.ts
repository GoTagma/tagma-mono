import { sanitizeDiagnosticValue, type DiagnosticsSanitizeOptions } from './diagnostics.js';

export type DiagnosticsContributor<TContext> = (context: TContext) => unknown;

export interface DiagnosticsContributorRegistry<TContext> {
  register(id: string, contributor: DiagnosticsContributor<TContext>): () => void;
  collect(context: TContext): Record<string, unknown>;
}

const CONTRIBUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * Create a lazy diagnostics extension registry. Registering a provider never
 * invokes it; providers run only when an enabled diagnostics request collects
 * a snapshot. Replacement and failure isolation keep this extension point
 * from becoming a dependency of the feature's normal execution path.
 */
export function createDiagnosticsContributorRegistry<TContext>(
  sanitizeOptions: DiagnosticsSanitizeOptions = {},
): DiagnosticsContributorRegistry<TContext> {
  const contributors = new Map<string, DiagnosticsContributor<TContext>>();

  return {
    register(id, contributor) {
      if (!CONTRIBUTOR_ID_PATTERN.test(id) || typeof contributor !== 'function') {
        return () => {};
      }
      contributors.set(id, contributor);
      return () => {
        if (contributors.get(id) === contributor) contributors.delete(id);
      };
    },

    collect(context) {
      const snapshot: Record<string, unknown> = {};
      for (const [id, contributor] of [...contributors.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 100)) {
        try {
          snapshot[id] = sanitizeDiagnosticValue(contributor(context), sanitizeOptions);
        } catch (error) {
          snapshot[id] = sanitizeDiagnosticValue({ error }, sanitizeOptions);
        }
      }
      return snapshot;
    },
  };
}
