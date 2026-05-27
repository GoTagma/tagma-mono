import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  type SecretEntry,
  type SecretsListResult,
  type WorkspaceYamlEntry,
} from '../../api/client';
import { viewportH, viewportW } from '../../utils/zoom';
import { subscribeDesktopZoom } from '../../desktop';
import { ConfirmDialog } from './ConfirmDialog';

interface SecretsManagerPanelProps {
  workDir: string;
  currentYamlPath: string | null;
  onClose: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'saving' }
  | { kind: 'deleting'; id: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; message: string };

export function computeSecretsManagerBounds(viewport: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(0, Math.min(680, Math.floor(viewport.width - 32))),
    height: Math.max(0, Math.min(Math.floor(viewport.height * 0.84), viewport.height - 32)),
  };
}

// Exported for unit tests: the secrets backend keys pipeline bindings by the
// workspace-relative path (forward slashes, no leading "./"), and accepts the
// same form on write. This must produce a string byte-identical to the
// server's `workspaceRelativePath`, or binding selection/labels silently fail.
export function toWorkspaceRelative(workDir: string, absPath: string | null): string | null {
  if (!workDir || !absPath) return null;
  const root = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = absPath.replace(/\\/g, '/');
  if (!target.toLowerCase().startsWith(root.toLowerCase() + '/')) return null;
  return target.slice(root.length + 1);
}

interface BindingDisplay {
  primary: string;
  secondary: string;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function pipelineDisplayName(entry: WorkspaceYamlEntry): string {
  const pipelineName = entry.pipelineName?.trim();
  return pipelineName || entry.name || basename(entry.path);
}

function bindingDisplayForPath(path: string, yamls: readonly WorkspaceYamlEntry[]): BindingDisplay {
  const entry = yamls.find((item) => item.path === path);
  if (!entry) return { primary: basename(path), secondary: path };
  return { primary: pipelineDisplayName(entry), secondary: entry.path };
}

function secretBindingDisplay(
  secret: Pick<SecretEntry, 'scope' | 'pipelinePath'>,
  yamls: readonly WorkspaceYamlEntry[],
): BindingDisplay {
  if (secret.scope === 'pipeline' && secret.pipelinePath) {
    return bindingDisplayForPath(secret.pipelinePath, yamls);
  }
  return { primary: 'Workspace', secondary: 'All pipelines' };
}

function bindingConfirmLabel(display: BindingDisplay): string {
  return `${display.primary} (${display.secondary})`;
}

function withoutSecret(result: SecretsListResult, id: string): SecretsListResult {
  return {
    ...result,
    secrets: result.secrets.filter((secret) => secret.id !== id),
  };
}

export function SecretsManagerPanel({
  workDir,
  currentYamlPath,
  onClose,
}: SecretsManagerPanelProps) {
  const [data, setData] = useState<SecretsListResult | null>(null);
  const [yamls, setYamls] = useState<WorkspaceYamlEntry[]>([]);
  const [envName, setEnvName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPipelinePaths, setSelectedPipelinePaths] = useState<string[]>([]);
  const [bindingOpen, setBindingOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SecretEntry | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [bounds, setBounds] = useState(() =>
    computeSecretsManagerBounds({ width: viewportW(), height: viewportH() }),
  );
  const currentRel = useMemo(
    () => toWorkspaceRelative(workDir, currentYamlPath),
    [workDir, currentYamlPath],
  );
  const busy = status.kind === 'loading' || status.kind === 'saving' || status.kind === 'deleting';
  const backendAvailable = data?.backend.available ?? false;
  const bindingDisabled = !backendAvailable || busy;
  const sortedYamls = useMemo(
    () =>
      [...yamls].sort(
        (a, b) =>
          pipelineDisplayName(a).localeCompare(pipelineDisplayName(b)) ||
          a.path.localeCompare(b.path),
      ),
    [yamls],
  );
  const selectedPathSet = useMemo(() => new Set(selectedPipelinePaths), [selectedPipelinePaths]);
  const selectedBindingDisplay = useMemo<BindingDisplay>(() => {
    if (selectedPipelinePaths.length === 0) {
      return { primary: 'Workspace', secondary: 'All pipelines' };
    }
    if (selectedPipelinePaths.length === 1) {
      return bindingDisplayForPath(selectedPipelinePaths[0], yamls);
    }
    const first = bindingDisplayForPath(selectedPipelinePaths[0], yamls);
    const extraCount = selectedPipelinePaths.length - 1;
    return {
      primary: `${selectedPipelinePaths.length} pipelines selected`,
      secondary: `${first.primary} - ${first.secondary}${extraCount > 0 ? ` + ${extraCount} more` : ''}`,
    };
  }, [selectedPipelinePaths, yamls]);

  const load = async () => {
    if (!workDir) {
      setStatus({ kind: 'error', message: 'Open a workspace before configuring secrets.' });
      return;
    }
    setStatus({ kind: 'loading' });
    try {
      const [secrets, workspaceYamls] = await Promise.all([
        api.listSecrets(),
        api.listWorkspaceYamls(),
      ]);
      setData(secrets);
      // `WorkspaceYamlEntry.path` arrives absolute, but the secrets backend
      // stores and returns pipeline bindings workspace-relative (and accepts
      // them in that form on write). Normalize entries to the same relative
      // shape here so binding selection, the "current pipeline" preselect, and
      // configured-secret labels all compare against one representation
      // instead of silently never matching.
      const relativizedYamls = workspaceYamls.entries.map((entry) => {
        const rel = toWorkspaceRelative(workDir, entry.path);
        return rel ? { ...entry, path: rel } : entry;
      });
      setYamls(relativizedYamls);
      if (currentRel && relativizedYamls.some((entry) => entry.path === currentRel)) {
        setSelectedPipelinePaths([currentRel]);
      } else {
        setSelectedPipelinePaths([]);
      }
      setStatus({ kind: 'idle' });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to load secrets',
      });
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workDir, currentRel]);

  useEffect(() => {
    if (bindingDisabled) setBindingOpen(false);
  }, [bindingDisabled]);

  const togglePipelinePath = (path: string) => {
    setSelectedPipelinePaths((paths) =>
      paths.includes(path) ? paths.filter((item) => item !== path) : [...paths, path],
    );
  };

  const save = async () => {
    if (!backendAvailable || busy) return;
    const trimmedEnvName = envName.trim();
    if (!trimmedEnvName) {
      setStatus({ kind: 'error', message: 'Enter an environment variable name.' });
      return;
    }
    if (!value) {
      setStatus({ kind: 'error', message: 'Enter the secret value.' });
      return;
    }
    setStatus({ kind: 'saving' });
    try {
      const bindingPaths: Array<string | null> =
        selectedPipelinePaths.length > 0 ? [...new Set(selectedPipelinePaths)] : [null];
      const trimmedDescription = description.trim() || null;
      await Promise.all(
        bindingPaths.map((pipelinePath) =>
          api.upsertSecret({
            envName: trimmedEnvName,
            value,
            pipelinePath,
            description: trimmedDescription,
          }),
        ),
      );
      setValue('');
      setDescription('');
      setStatus({
        kind: 'done',
        message:
          bindingPaths.length === 1
            ? `${trimmedEnvName} saved.`
            : `${trimmedEnvName} saved to ${bindingPaths.length} pipelines.`,
      });
      const next = await api.listSecrets();
      setData(next);
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to save secret',
      });
    }
  };

  const remove = async (secret: SecretEntry) => {
    if (busy) return;
    setDeleteTarget(null);
    setStatus({ kind: 'deleting', id: secret.id });
    try {
      await api.deleteSecret(secret.id);
      setData((current) => (current ? withoutSecret(current, secret.id) : current));
      setStatus({ kind: 'done', message: `${secret.envName} deleted.` });
      try {
        const next = await api.listSecrets();
        setData(withoutSecret(next, secret.id));
      } catch {
        // Keep the optimistic deletion visible even if the refresh fails.
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to delete secret',
      });
    }
  };

  const secrets = data?.secrets ?? [];
  const deleteTargetBinding = deleteTarget ? secretBindingDisplay(deleteTarget, yamls) : null;

  useEffect(() => {
    const recalc = () =>
      setBounds(computeSecretsManagerBounds({ width: viewportW(), height: viewportH() }));
    window.addEventListener('resize', recalc);
    const unsubscribe = subscribeDesktopZoom(recalc);
    return () => {
      window.removeEventListener('resize', recalc);
      unsubscribe();
    };
  }, []);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onClick={onClose}
      >
        <div
          className="bg-tagma-surface border border-tagma-border shadow-panel flex flex-col animate-fade-in"
          style={{ width: bounds.width, height: bounds.height, maxHeight: bounds.height }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="panel-header">
            <div className="flex items-center gap-2">
              <KeyRound size={14} className="text-tagma-accent" />
              <h2 className="panel-title">Secrets Manager</h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
            {!workDir && <WarnBox>Open a workspace before configuring pipeline secrets.</WarnBox>}

            {data && (
              <div
                className={`px-2.5 py-2 border ${
                  data.backend.available
                    ? 'border-tagma-success/30 bg-tagma-success/5'
                    : 'border-tagma-warning/30 bg-tagma-warning/8'
                }`}
              >
                <div className="flex items-start gap-2">
                  {data.backend.available ? (
                    <ShieldCheck size={12} className="text-tagma-success shrink-0 mt-[1px]" />
                  ) : (
                    <AlertTriangle size={12} className="text-tagma-warning shrink-0 mt-[1px]" />
                  )}
                  <div className="min-w-0">
                    <div className="text-[11px] text-tagma-text">
                      {data.backend.available
                        ? 'OS credential backend active'
                        : 'OS credential backend unavailable'}
                    </div>
                    <div className="text-[10px] text-tagma-muted leading-snug">
                      {data.backend.message}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {status.kind === 'error' && <ErrorBox>{status.message}</ErrorBox>}
            {status.kind === 'done' && <SuccessBox>{status.message}</SuccessBox>}

            <div className="border border-tagma-border bg-tagma-bg p-3 space-y-3">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <div>
                  <div className="field-label">Variable</div>
                  <input
                    id="secret-env-name"
                    className="w-full px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text font-mono"
                    value={envName}
                    disabled={!backendAvailable || busy}
                    placeholder="OPENAI_API_KEY"
                    aria-label="Variable"
                    onChange={(e) => setEnvName(e.target.value)}
                  />
                </div>
                <div>
                  <div className="field-label">Value</div>
                  <input
                    id="secret-value"
                    type="password"
                    autoComplete="off"
                    className="w-full px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text font-mono"
                    value={value}
                    disabled={!backendAvailable || busy}
                    aria-label="Value"
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
                <div
                  className="relative col-span-2"
                  onBlur={(e) => {
                    const next = e.relatedTarget;
                    if (!(next instanceof Node) || !e.currentTarget.contains(next)) {
                      setBindingOpen(false);
                    }
                  }}
                >
                  <div className="field-label">Binding</div>
                  <button
                    id="secret-pipeline-button"
                    type="button"
                    className="w-full h-[50px] px-2.5 py-2 bg-tagma-surface border border-tagma-border text-left flex items-center gap-3 hover:border-tagma-accent/40 disabled:hover:border-tagma-border disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    disabled={bindingDisabled}
                    aria-haspopup="listbox"
                    aria-expanded={bindingOpen}
                    aria-label="Binding"
                    onClick={() => setBindingOpen((open) => !open)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11px] text-tagma-text truncate">
                        {selectedBindingDisplay.primary}
                      </span>
                      <span className="block text-[9px] text-tagma-muted font-mono truncate mt-0.5">
                        {selectedBindingDisplay.secondary}
                      </span>
                    </span>
                    <ChevronDown
                      size={12}
                      className={`text-tagma-muted shrink-0 transition-transform ${
                        bindingOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {bindingOpen && !bindingDisabled && (
                    <div
                      role="listbox"
                      aria-multiselectable="true"
                      className="absolute left-0 right-0 z-[60] mt-1 max-h-64 overflow-y-auto border border-tagma-border bg-tagma-surface shadow-panel divide-y divide-tagma-border/50"
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={selectedPipelinePaths.length === 0}
                        className="w-full flex items-start gap-2.5 px-2.5 py-2 text-left hover:bg-tagma-elevated/50 transition-colors"
                        onClick={() => {
                          setSelectedPipelinePaths([]);
                          setBindingOpen(false);
                        }}
                      >
                        <span
                          className={`mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center border ${
                            selectedPipelinePaths.length === 0
                              ? 'border-tagma-accent bg-tagma-accent/15 text-tagma-accent'
                              : 'border-tagma-border text-transparent'
                          }`}
                          aria-hidden="true"
                        >
                          <Check size={9} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] text-tagma-text truncate">
                            Workspace
                          </span>
                          <span className="block text-[9px] text-tagma-muted font-mono truncate">
                            All pipelines
                          </span>
                        </span>
                      </button>
                      {sortedYamls.map((entry) => {
                        const selected = selectedPathSet.has(entry.path);
                        return (
                          <button
                            key={entry.path}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className="w-full flex items-start gap-2.5 px-2.5 py-2 text-left hover:bg-tagma-elevated/50 transition-colors"
                            onClick={() => togglePipelinePath(entry.path)}
                          >
                            <span
                              className={`mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center border ${
                                selected
                                  ? 'border-tagma-accent bg-tagma-accent/15 text-tagma-accent'
                                  : 'border-tagma-border text-transparent'
                              }`}
                              aria-hidden="true"
                            >
                              <Check size={9} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] text-tagma-text truncate">
                                {pipelineDisplayName(entry)}
                              </span>
                              <span className="block text-[9px] text-tagma-muted font-mono truncate">
                                {entry.path}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="col-span-2">
                  <div className="field-label">Note</div>
                  <input
                    id="secret-description"
                    className="w-full px-2 py-1 bg-tagma-surface border border-tagma-border text-[11px] text-tagma-text"
                    value={description}
                    disabled={!backendAvailable || busy}
                    placeholder="Used by deploy.publish"
                    aria-label="Note"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void save()}
                  disabled={!backendAvailable || busy}
                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {status.kind === 'saving' ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Plus size={11} />
                  )}
                  Save Secret
                </button>
                <button
                  onClick={() => void load()}
                  disabled={busy}
                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-border text-tagma-text hover:bg-tagma-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {status.kind === 'loading' ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RefreshCw size={11} />
                  )}
                  Refresh
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 flex flex-col">
              <div className="field-label">Configured Secrets</div>
              {status.kind === 'loading' && (
                <div className="flex items-center gap-2 text-[11px] text-tagma-muted">
                  <Loader2 size={12} className="animate-spin" /> Loading...
                </div>
              )}
              {status.kind !== 'loading' && secrets.length === 0 && (
                <div className="text-[10px] text-tagma-muted border border-tagma-border bg-tagma-bg px-2.5 py-2">
                  No secrets are configured for this workspace.
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto pr-1 space-y-2">
                {secrets.map((secret) => {
                  const binding = secretBindingDisplay(secret, yamls);
                  return (
                    <div
                      key={secret.id}
                      className="border border-tagma-border bg-tagma-bg px-2.5 py-2 flex items-start gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-tagma-text font-mono">
                            {secret.envName}
                          </span>
                          <span
                            className={`text-[9px] px-1.5 py-0.5 border ${
                              secret.hasValue
                                ? 'text-tagma-success border-tagma-success/40 bg-tagma-success/5'
                                : 'text-tagma-warning border-tagma-warning/40 bg-tagma-warning/5'
                            }`}
                          >
                            {secret.hasValue ? 'stored' : 'missing'}
                          </span>
                        </div>
                        <div className="mt-1 min-w-0">
                          <div className="text-[10px] text-tagma-muted truncate">
                            {binding.primary}
                          </div>
                          <div className="text-[9px] text-tagma-muted font-mono break-all">
                            {binding.secondary}
                          </div>
                        </div>
                        {secret.description && (
                          <div className="mt-1 text-[10px] text-tagma-muted leading-snug">
                            {secret.description}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => setDeleteTarget(secret)}
                        disabled={busy}
                        className="p-1 text-tagma-muted hover:text-tagma-error transition-colors disabled:opacity-40"
                        aria-label={`Delete ${secret.envName}`}
                        title="Delete secret"
                      >
                        {status.kind === 'deleting' && status.id === secret.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Trash2 size={13} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="text-[10px] text-tagma-muted font-mono border-t border-tagma-border pt-3">
              Metadata is stored in <code>.tagma/secrets.json</code>; secret values are stored in
              the OS credential backend.
            </div>
          </div>
        </div>
      </div>
      {deleteTarget && deleteTargetBinding && (
        <ConfirmDialog
          title="Delete Secret"
          message={
            <div className="space-y-2">
              <div>
                Delete <span className="font-mono">{deleteTarget.envName}</span> from{' '}
                {bindingConfirmLabel(deleteTargetBinding)}?
              </div>
              <div className="border border-tagma-border bg-tagma-bg px-2.5 py-2">
                <div className="text-[10px] text-tagma-text truncate">
                  {deleteTargetBinding.primary}
                </div>
                <div className="text-[9px] text-tagma-muted font-mono break-all">
                  {deleteTargetBinding.secondary}
                </div>
              </div>
            </div>
          }
          confirmLabel="Delete Secret"
          onConfirm={() => void remove(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}

function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-warning/8 border border-tagma-warning/30 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-warning/90 font-mono">
        <AlertTriangle size={10} className="text-tagma-warning shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-error/8 border border-tagma-error/30 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
        <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}

function SuccessBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tagma-success/8 border border-tagma-success/30 px-2.5 py-1.5">
      <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
        <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
        <span>{children}</span>
      </div>
    </div>
  );
}
