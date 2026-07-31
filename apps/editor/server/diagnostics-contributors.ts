import { createDiagnosticsContributorRegistry } from '../shared/diagnostics-contributors.js';
import type { DiagnosticsContributor } from '../shared/diagnostics-contributors.js';
import type { WorkspaceState } from './workspace-state.js';

export interface ServerDiagnosticsContributorContext {
  workspaceKey: string | null;
  workspace: WorkspaceState | null;
}

const registry = createDiagnosticsContributorRegistry<ServerDiagnosticsContributorContext>({
  maxDepth: 12,
  maxArrayItems: 200,
  maxObjectKeys: 200,
  maxStringChars: 32_768,
});

/**
 * Register sidecar feature state for the stable diagnostics context. Provider
 * code is never invoked during ordinary editor execution.
 */
export function registerServerDiagnosticsContributor(
  id: string,
  contributor: DiagnosticsContributor<ServerDiagnosticsContributorContext>,
): () => void {
  return registry.register(id, contributor);
}

export function collectServerDiagnosticsContributors(
  context: ServerDiagnosticsContributorContext,
): Record<string, unknown> {
  return registry.collect(context);
}
