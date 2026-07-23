const REVISION_BYPASS_PREFIXES = [
  '/api/plugins/',
  '/api/fs/',
  '/api/state/events',
  '/api/state/reload',
  '/api/opencode/',
  '/api/python-agent/detect',
  '/api/python-agent/install-plan',
  '/api/python-agent/validate',
  '/api/secrets',
  '/api/chat-bridge/',
  '/api/editor/',
  '/api/sidecar/',
  '/api/release/',
  '/api/run/',
  '/api/workspace/compile',
  '/api/workspace/drop',
  '/api/workspace/workflows',
  '/api/workspace/yaml-edit-lock',
  // Chat stages are an isolated branch. Only a successful finalize mutates
  // the live workspace, and that service advances revision itself.
  '/api/workspace/chat-yaml-stage/',
  // Export copies the current pipeline + layout to an external directory.
  // It does not change the editor's in-memory pipeline/layout, so collaborators
  // should not see a revision bump for it.
  '/api/export-file',
] as const;

const REVISION_ADVANCING_BYPASS_PATHS = new Set([
  '/api/state/reload',
  '/api/workspace/chat-yaml-stage/finalize',
  '/api/plugins/import-local',
]);

export function bypassesRevisionCheck(path: string): boolean {
  return REVISION_BYPASS_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Requests in this sequence either use the server's If-Match middleware or
 * advance the same workspace revision explicitly while bypassing it.
 */
export function participatesInWorkspaceRevisionSequence(
  path: string,
  method: string | undefined,
): boolean {
  const normalizedMethod = (method ?? 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) return false;
  return !bypassesRevisionCheck(path) || REVISION_ADVANCING_BYPASS_PATHS.has(path);
}
