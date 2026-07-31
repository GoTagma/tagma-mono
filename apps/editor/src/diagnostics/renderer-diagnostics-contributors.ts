import { createDiagnosticsContributorRegistry } from '../../shared/diagnostics-contributors.js';
import type { DiagnosticsContributor } from '../../shared/diagnostics-contributors.js';

export interface RendererDiagnosticsContributorContext {
  workspaceKey: string | null;
  capturedAt: number;
}

const registry = createDiagnosticsContributorRegistry<RendererDiagnosticsContributorContext>({
  maxDepth: 10,
  maxArrayItems: 100,
  maxObjectKeys: 150,
  maxStringChars: 16_384,
});

/**
 * Register feature-owned renderer state without coupling the diagnostics
 * bridge to that feature. Providers remain idle until diagnostics is active.
 */
export function registerRendererDiagnosticsContributor(
  id: string,
  contributor: DiagnosticsContributor<RendererDiagnosticsContributorContext>,
): () => void {
  return registry.register(id, contributor);
}

export function collectRendererDiagnosticsContributors(
  context: RendererDiagnosticsContributorContext,
): Record<string, unknown> {
  return registry.collect(context);
}
