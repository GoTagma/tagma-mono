function normalizeWorkspaceKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  const windowsPath = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
  return windowsPath ? normalized.toLowerCase() : normalized;
}

export function isChatYamlResultInActiveWorkspace(args: {
  resultWorkspaceKey: string | null | undefined;
  activeWorkspaceKey: string | null | undefined;
}): boolean {
  const activeWorkspaceKey = normalizeWorkspaceKey(args.activeWorkspaceKey);
  if (!activeWorkspaceKey) return false;
  if (args.resultWorkspaceKey === undefined) return true;
  return normalizeWorkspaceKey(args.resultWorkspaceKey) === activeWorkspaceKey;
}
