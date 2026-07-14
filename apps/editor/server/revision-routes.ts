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

export function bypassesRevisionCheck(path: string): boolean {
  return REVISION_BYPASS_PREFIXES.some((prefix) => path.startsWith(prefix));
}
