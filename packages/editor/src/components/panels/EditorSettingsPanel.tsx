import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  X,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  RefreshCw,
  Moon,
  Sun,
  Download,
} from 'lucide-react';
import {
  api,
  type EditorInfo,
  type EditorSettings,
  type OpencodeInfo,
  type PluginDeclaredResult,
  type PluginRefreshResult,
  type PluginRegistry,
} from '../../api/client';
import { viewportH } from '../../utils/zoom';
import { useTheme, type Theme } from '../../hooks/use-theme';

interface EditorSettingsPanelProps {
  workDir: string;
  onRegistryUpdate: (registry: PluginRegistry) => void;
  onClose: () => void;
}

type ApplyStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: PluginRefreshResult }
  | { kind: 'error'; message: string };

export function EditorSettingsPanel({
  workDir,
  onRegistryUpdate,
  onClose,
}: EditorSettingsPanelProps) {
  const [settings, setSettings] = useState<EditorSettings | null>(null);
  const [declared, setDeclared] = useState<PluginDeclaredResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyStatus, setApplyStatus] = useState<ApplyStatus>({ kind: 'idle' });
  const maxH = useMemo(() => Math.floor(viewportH() * 0.8), []);

  const hasWorkspace = workDir.length > 0;
  const { theme, setTheme } = useTheme();

  const refreshDeclared = useCallback(async () => {
    if (!hasWorkspace) return;
    try {
      const next = await api.getDeclaredPlugins();
      setDeclared(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to scan workspace plugins');
    }
  }, [hasWorkspace]);

  // Initial load: fetch settings + declared snapshot in parallel so the
  // panel can render the toggle and the workspace-wide preview in one shot.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.allSettled([api.getEditorSettings(), api.getDeclaredPlugins()])
      .then(([settingsRes, declaredRes]) => {
        if (cancelled) return;
        if (settingsRes.status === 'fulfilled') {
          setSettings(settingsRes.value);
        } else {
          setError(
            settingsRes.reason instanceof Error
              ? settingsRes.reason.message
              : 'Failed to load editor settings',
          );
        }
        if (declaredRes.status === 'fulfilled') {
          setDeclared(declaredRes.value);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = async <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
    if (!settings) return;
    if (!hasWorkspace) {
      setError('Open a workspace before changing editor settings.');
      return;
    }
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await api.updateEditorSettings({ [key]: value } as Partial<EditorSettings>);
      setSettings(saved);
    } catch (e) {
      setSettings(previous);
      setError(e instanceof Error ? e.message : 'Failed to save editor settings');
    } finally {
      setSaving(false);
    }
  };

  const handleApply = async () => {
    if (!hasWorkspace) return;
    setApplyStatus({ kind: 'running' });
    try {
      const result = await api.refreshPlugins();
      onRegistryUpdate(result.registry);
      setApplyStatus({ kind: 'done', result });
      // Refresh the read-only preview so the install/missing chips reflect
      // the new on-disk state without the user having to reopen the panel.
      await refreshDeclared();
    } catch (e) {
      setApplyStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to apply',
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[520px] flex flex-col animate-fade-in"
        style={{ maxHeight: maxH }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <h2 className="panel-title">Editor Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!hasWorkspace && (
            <WarnBox>
              Open a workspace first — editor settings are stored per workspace in{' '}
              <code>.tagma/editor-settings.json</code>.
            </WarnBox>
          )}

          {error && <ErrorBox>{error}</ErrorBox>}

          {/* Appearance lives outside the workspace-settings gate because theme
              is a global user preference (persisted in localStorage), not part
              of .tagma/editor-settings.json — it should be tweakable even
              with no workspace open. */}
          <div>
            <label className="field-label">Appearance</label>
            <ThemePicker theme={theme} onChange={setTheme} />
          </div>

          {/* Editor hot-update panel. Lives above OpencodeSection because
              the editor itself is the more impactful update — a stale dist
              may be missing bug fixes in the panels the user is looking at
              right now. Outside the workspace gate for the same reason as
              OpenCode: the dist lives globally under userData. */}
          <EditorUpdateSection />

          {/* OpenCode CLI panel. Also outside the workspace gate — the binary
              lives globally on disk (bundled in resources/ + userData overlay),
              not per-workspace. Rendered even without a workspace so users
              can update on first launch before picking one. */}
          <OpencodeSection />

          {loading && (
            <div className="flex items-center gap-2 text-[11px] text-tagma-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          )}

          {settings && (
            <>
              <div>
                <label className="field-label">Plugins</label>
                <ToggleRow
                  label="Auto-install declared plugins"
                  description="When opening this workspace, automatically install plugins listed in any of its YAML files (.tagma/*.yaml → pipeline.plugins) if they aren't already in node_modules. Off by default — auto-pulling npm packages is convenient for trusted personal workspaces but a security smell elsewhere."
                  checked={settings.autoInstallDeclaredPlugins}
                  disabled={!hasWorkspace || saving}
                  onChange={(v) => updateField('autoInstallDeclaredPlugins', v)}
                />
              </div>

              <div>
                <label className="field-label">Apply to this workspace</label>
                <div className="border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
                  <DeclaredPreview declared={declared} />

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handleApply}
                      disabled={!hasWorkspace || applyStatus.kind === 'running'}
                      className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
                      title="Re-scan all YAMLs in this workspace and install/load any missing plugins."
                    >
                      {applyStatus.kind === 'running' ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <RefreshCw size={11} />
                      )}
                      Apply Now
                    </button>
                    {!settings.autoInstallDeclaredPlugins && (
                      <span className="text-[9px] text-tagma-muted">
                        (toggle is off — Apply will only load already-installed plugins)
                      </span>
                    )}
                  </div>

                  <ApplyResult status={applyStatus} />
                </div>
              </div>
            </>
          )}

          <div className="border-t border-tagma-border" />

          <div className="text-[10px] text-tagma-muted font-mono">
            Stored in <code>.tagma/editor-settings.json</code>
            {saving ? ' · saving…' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

type EditorUpdateFetchStatus =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: EditorInfo }
  | { kind: 'error'; message: string };

type EditorUpdateApplyStatus =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'error'; message: string };

function EditorUpdateSection() {
  const [status, setStatus] = useState<EditorUpdateFetchStatus>({ kind: 'loading' });
  const [applyStatus, setApplyStatus] = useState<EditorUpdateApplyStatus>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const info = await api.getEditorInfo();
      setStatus({ kind: 'loaded', info });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to read editor update status',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpdate = useCallback(async () => {
    setApplyStatus({ kind: 'updating' });
    try {
      const result = await api.updateEditor();
      setApplyStatus({ kind: 'done', version: result.version });
      // New dist is live in userData; a window reload swaps to it without
      // touching the sidecar. Give the "installed vX" toast a beat to render
      // before the page blanks out, so the user sees the success state.
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setApplyStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Editor update failed',
      });
    }
  }, []);

  return (
    <div>
      <label className="field-label">Editor Updates</label>
      <div className="border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
        {status.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[11px] text-tagma-muted">
            <Loader2 size={12} className="animate-spin" /> Reading editor update status…
          </div>
        )}
        {status.kind === 'error' && (
          <div className="text-[10px] text-tagma-error font-mono">{status.message}</div>
        )}
        {status.kind === 'loaded' && (
          <EditorUpdateRows
            info={status.info}
            onRefresh={refresh}
            onUpdate={handleUpdate}
            applyStatus={applyStatus}
          />
        )}
      </div>
    </div>
  );
}

function EditorUpdateRows({
  info,
  onRefresh,
  onUpdate,
  applyStatus,
}: {
  info: EditorInfo;
  onRefresh: () => void;
  onUpdate: () => void;
  applyStatus: EditorUpdateApplyStatus;
}) {
  const updating = applyStatus.kind === 'updating';
  // "disabled" is a configuration state, not an error — no manifest URL means
  // the build was packaged without an update endpoint wired up. Distinct from
  // "can't reach the manifest host", which surfaces as latestVersion=null.
  const disabled = !info.manifestUrl;

  const updateButtonTitle = disabled
    ? 'Editor updates are disabled in this build (no manifest URL configured).'
    : !info.canUpdate
      ? 'Editor updates are only available when running under the desktop app.'
      : !info.updateAvailable
        ? 'Editor is already at the latest version.'
        : `Download editor ${info.latestVersion} and swap in without a restart`;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] font-mono">
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-text">
          {info.activeVersion ?? <span className="text-tagma-warning">not found</span>}
        </span>
        <span className="text-tagma-muted">Bundled</span>
        <span className="text-tagma-muted-dim">
          {info.bundledVersion ?? '(dev mode — none shipped)'}
        </span>
        {info.userInstalledVersion && (
          <>
            <span className="text-tagma-muted">Hot-update override</span>
            <span className="text-tagma-muted-dim">{info.userInstalledVersion}</span>
          </>
        )}
        <span className="text-tagma-muted">Channel</span>
        <span className="text-tagma-muted-dim">{info.channel ?? 'stable'}</span>
        <span className="text-tagma-muted">Latest</span>
        <span className={info.updateAvailable ? 'text-tagma-accent' : 'text-tagma-muted-dim'}>
          {disabled
            ? '(updates disabled)'
            : (info.latestVersion ?? '(manifest unreachable)')}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onUpdate}
          disabled={disabled || !info.canUpdate || !info.updateAvailable || updating}
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          title={updateButtonTitle}
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {updating
            ? 'Updating…'
            : info.updateAvailable && info.latestVersion
              ? `Update to ${info.latestVersion}`
              : 'Up to date'}
        </button>
        <button
          onClick={onRefresh}
          disabled={updating}
          className="btn-ghost"
          title="Re-check the release manifest"
        >
          <RefreshCw size={11} /> Check again
        </button>
        {info.releaseNotesUrl && info.updateAvailable && (
          <a
            href={info.releaseNotesUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-tagma-muted hover:text-tagma-text underline"
          >
            Release notes
          </a>
        )}
      </div>

      {applyStatus.kind === 'done' && (
        <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
            <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
            <span>
              Installed editor {applyStatus.version}. Reloading to apply…
            </span>
          </div>
        </div>
      )}
      {applyStatus.kind === 'error' && (
        <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
            <span>{applyStatus.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

type OpencodeStatus =
  | { kind: 'loading' }
  | { kind: 'loaded'; info: OpencodeInfo }
  | { kind: 'error'; message: string };

type OpencodeUpdateStatus =
  | { kind: 'idle' }
  | { kind: 'updating' }
  | { kind: 'done'; version: string }
  | { kind: 'error'; message: string };

function OpencodeSection() {
  const [status, setStatus] = useState<OpencodeStatus>({ kind: 'loading' });
  const [updateStatus, setUpdateStatus] = useState<OpencodeUpdateStatus>({ kind: 'idle' });

  const refresh = useCallback(async () => {
    setStatus({ kind: 'loading' });
    try {
      const info = await api.getOpencodeInfo();
      setStatus({ kind: 'loaded', info });
    } catch (e) {
      setStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed to read OpenCode status',
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUpdate = useCallback(async () => {
    setUpdateStatus({ kind: 'updating' });
    try {
      const result = await api.updateOpencode();
      setUpdateStatus({ kind: 'done', version: result.version });
      // Re-read info so the "update available" banner reflects the new state.
      // Any errors here are non-fatal — the update already succeeded.
      await refresh();
    } catch (e) {
      setUpdateStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : 'Update failed',
      });
    }
  }, [refresh]);

  return (
    <div>
      <label className="field-label">OpenCode CLI</label>
      <div className="border border-tagma-border bg-tagma-bg p-2.5 space-y-2">
        {status.kind === 'loading' && (
          <div className="flex items-center gap-2 text-[11px] text-tagma-muted">
            <Loader2 size={12} className="animate-spin" /> Reading OpenCode status…
          </div>
        )}
        {status.kind === 'error' && (
          <div className="text-[10px] text-tagma-error font-mono">{status.message}</div>
        )}
        {status.kind === 'loaded' && (
          <OpencodeInfoRows
            info={status.info}
            onRefresh={refresh}
            onUpdate={handleUpdate}
            updateStatus={updateStatus}
          />
        )}
      </div>
    </div>
  );
}

function OpencodeInfoRows({
  info,
  onRefresh,
  onUpdate,
  updateStatus,
}: {
  info: OpencodeInfo;
  onRefresh: () => void;
  onUpdate: () => void;
  updateStatus: OpencodeUpdateStatus;
}) {
  // The "active" version displayed next to the CLI is whatever the PATH
  // actually resolves to right now (userData override wins, then bundled).
  // runningVersion is the most honest signal because it survives a missing
  // bundled version in dev mode — fall back to userInstalled/bundled only
  // when the probe didn't fire.
  const activeVersion =
    info.runningVersion ?? info.userInstalledVersion ?? info.bundledVersion ?? null;
  const updating = updateStatus.kind === 'updating';

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10px] font-mono">
        <span className="text-tagma-muted">Running</span>
        <span className="text-tagma-text">
          {activeVersion ?? <span className="text-tagma-warning">not found</span>}
        </span>
        <span className="text-tagma-muted">Bundled</span>
        <span className="text-tagma-muted-dim">
          {info.bundledVersion ?? '(dev mode — none shipped)'}
        </span>
        {info.userInstalledVersion && (
          <>
            <span className="text-tagma-muted">User override</span>
            <span className="text-tagma-muted-dim">{info.userInstalledVersion}</span>
          </>
        )}
        <span className="text-tagma-muted">Latest on npm</span>
        <span className={info.updateAvailable ? 'text-tagma-accent' : 'text-tagma-muted-dim'}>
          {info.latestVersion ?? '(registry unreachable)'}
        </span>
        <span className="text-tagma-muted">Target</span>
        <span className="text-tagma-muted-dim">
          {info.platform}/{info.arch}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onUpdate}
          disabled={!info.canUpdate || !info.updateAvailable || updating}
          className="flex items-center gap-1.5 text-[11px] px-2.5 py-1 border border-tagma-accent/50 text-tagma-accent hover:bg-tagma-accent/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-colors"
          title={
            !info.canUpdate
              ? 'Updates are only available when running under the desktop app.'
              : !info.updateAvailable
                ? 'OpenCode is already at the latest version.'
                : `Download opencode ${info.latestVersion} for ${info.platform}/${info.arch}`
          }
        >
          {updating ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {updating
            ? 'Updating…'
            : info.updateAvailable && info.latestVersion
              ? `Update to ${info.latestVersion}`
              : 'Up to date'}
        </button>
        <button
          onClick={onRefresh}
          disabled={updating}
          className="btn-ghost"
          title="Re-check the registry"
        >
          <RefreshCw size={11} /> Check again
        </button>
      </div>

      {updateStatus.kind === 'done' && (
        <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
            <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
            <span>Installed opencode {updateStatus.version} into your profile.</span>
          </div>
        </div>
      )}
      {updateStatus.kind === 'error' && (
        <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
            <span>{updateStatus.message}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function DeclaredPreview({ declared }: { declared: PluginDeclaredResult | null }) {
  if (!declared) {
    return <div className="text-[10px] text-tagma-muted">Scanning workspace YAMLs…</div>;
  }
  if (declared.declared.length === 0) {
    return (
      <div className="text-[10px] text-tagma-muted">
        No plugins declared in any YAML under <code>.tagma/</code> in this workspace.
      </div>
    );
  }
  const installedSet = new Set(declared.installed);
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] text-tagma-muted">
        {declared.declared.length} declared plugin{declared.declared.length !== 1 ? 's' : ''}
        {' across all YAMLs · '}
        <span className="text-tagma-success">{declared.installed.length} installed</span>
        {' · '}
        <span className={declared.missing.length > 0 ? 'text-tagma-warning' : 'text-tagma-muted'}>
          {declared.missing.length} missing
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {declared.declared.map((name) => {
          const isInstalled = installedSet.has(name);
          return (
            <span
              key={name}
              className={
                'text-[9px] font-mono px-1.5 py-0.5 border ' +
                (isInstalled
                  ? 'text-tagma-success border-tagma-success/40 bg-tagma-success/5'
                  : 'text-tagma-warning border-tagma-warning/40 bg-tagma-warning/5')
              }
              title={isInstalled ? 'Installed' : 'Missing — click Apply Now to install'}
            >
              {name}
            </span>
          );
        })}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function ToggleRow({ label, description, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <label
      className={`flex items-start gap-3 px-2.5 py-2 border border-tagma-border bg-tagma-bg ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-tagma-border/80'}`}
    >
      <input
        type="checkbox"
        className="mt-[2px] accent-tagma-accent"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-tagma-text">{label}</div>
        <div className="text-[10px] text-tagma-muted mt-0.5 leading-snug">{description}</div>
      </div>
    </label>
  );
}

interface ThemePickerProps {
  theme: Theme;
  onChange: (next: Theme) => void;
}

function ThemePicker({ theme, onChange }: ThemePickerProps) {
  const options: Array<{ value: Theme; label: string; icon: ReactNode }> = [
    { value: 'dark', label: 'Dark', icon: <Moon size={12} /> },
    { value: 'light', label: 'Light', icon: <Sun size={12} /> },
  ];
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={
              'flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[11px] border transition-colors ' +
              (active
                ? 'border-tagma-accent text-tagma-accent bg-tagma-accent/10'
                : 'border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-border/80 bg-tagma-bg')
            }
            aria-pressed={active}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ApplyResult({ status }: { status: ApplyStatus }) {
  if (status.kind === 'idle' || status.kind === 'running') return null;

  if (status.kind === 'error') {
    return (
      <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
        <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
          <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
          <span>{status.message}</span>
        </div>
      </div>
    );
  }

  const { result } = status;
  const installedCount = result.installed.length;
  const loadedCount = result.loaded.length;
  const missingCount = result.missing.length;
  const errorCount = result.errors.length;
  const declaredCount = result.declared.length;
  const nothingHappened = installedCount === 0 && loadedCount === 0 && errorCount === 0;

  return (
    <div className="space-y-1.5">
      <div className="bg-tagma-success/8 border border-tagma-success/30 px-2 py-1.5">
        <div className="flex items-start gap-1.5 text-[10px] text-tagma-success/90 font-mono">
          <CheckCircle2 size={10} className="text-tagma-success shrink-0 mt-[1px]" />
          <div className="space-y-0.5">
            {installedCount > 0 && (
              <div>
                Installed {installedCount}: {result.installed.join(', ')}
              </div>
            )}
            {loadedCount > 0 && (
              <div>
                Loaded {loadedCount}: {result.loaded.join(', ')}
              </div>
            )}
            {nothingHappened && missingCount === 0 && (
              <div>
                {declaredCount === 0
                  ? 'No plugins declared in this workspace.'
                  : 'All declared plugins were already installed and loaded.'}
              </div>
            )}
          </div>
        </div>
      </div>
      {missingCount > 0 && (
        <div className="bg-tagma-warning/8 border border-tagma-warning/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-warning/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-warning shrink-0 mt-[1px]" />
            <div className="space-y-0.5">
              <div>
                Still missing ({missingCount}): {result.missing.join(', ')}
              </div>
              {!result.settings.autoInstallDeclaredPlugins && (
                <div className="text-tagma-warning/70">
                  Turn on "Auto-install declared plugins" to install them.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {errorCount > 0 && (
        <div className="bg-tagma-error/8 border border-tagma-error/30 px-2 py-1.5">
          <div className="flex items-start gap-1.5 text-[10px] text-tagma-error/90 font-mono">
            <AlertTriangle size={10} className="text-tagma-error shrink-0 mt-[1px]" />
            <div className="space-y-0.5">
              {result.errors.map((err, i) => (
                <div key={`${err.name}-${i}`}>
                  <span className="text-tagma-error">{err.name}:</span> {err.message}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
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
